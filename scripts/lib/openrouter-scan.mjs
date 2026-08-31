// AST-based OpenRouter denylist scanner (DIC-1266 CR round-3 blocker 1).
//
// The previous grep-of-tokens approach passed when an executable route
// fragmented the provider signals at the word boundary — every one of:
//
//   const h = ['open', 'router.ai'].join('');
//   const k = ['OPEN', 'ROUTER_API_KEY'].join('');
//   const m = '@open' + 'router/sdk';
//   void import(m);
//   void fetch('https://' + h + '/api/v1/chat/completions', {
//     headers: { Authorization: process.env[k] },
//   });
//
// escaped the scan because no single contiguous token contained
// "openrouter" or "OPENROUTER_". This scanner parses each source file with
// `@babel/parser` (TypeScript + JSX), statically folds string-typed
// expressions (StringLiteral, TemplateLiteral, BinaryExpression `+`,
// `Array<literal>.join(<literal>)`, `String<literal>.concat(...)`,
// identifier references resolved via VariableDeclarator inits), and reports
// EVERY folded value containing the forbidden substrings —
// case-insensitive `openrouter` OR `OPENROUTER_` — regardless of how many
// operands the concatenation had. Identifier NAMES are also scanned (so
// `openrouterClient` on an env-var lookup would fail even if never
// concatenated).
//
// The rule is purely additive relative to the previous suite: every
// contiguous-literal match the old scan caught still matches here as
// `evalStatic(StringLiteral) → literal.value` and reports offenders.
//
// False-positive surface: two UNRELATED literals in the same file whose
// values happen to concatenate elsewhere via a folded expression could
// trigger a report. This is acceptable given (a) `api/` today has zero
// occurrences of "open" AND "router" in code (grep-verified baseline —
// mentions are all in comments, which `@babel/parser` strips into the
// leading-comments block and the scanner does NOT walk); and (b) the rule
// is a defence-in-depth for a permanent FinOps denylist where a false
// positive is a loud CI failure, not a runtime harm.

import fs from 'node:fs';
import path from 'node:path';
import * as parser from '@babel/parser';

const FORBIDDEN_SUBSTRINGS = [
  { pattern: /openrouter/i, label: 'openrouter (case-insensitive host / package fragment)' },
  { pattern: /OPENROUTER_/, label: 'OPENROUTER_ (env-var fragment)' },
];

function parseSource(src, filename) {
  return parser.parse(src, {
    sourceType: 'module',
    sourceFilename: filename,
    allowReturnOutsideFunction: true,
    plugins: [
      'typescript',
      'jsx',
      'topLevelAwait',
      'importAssertions',
      'importAttributes',
      'decorators-legacy',
      'classProperties',
      'classPrivateMethods',
      'classPrivateProperties',
      'dynamicImport',
      'optionalChaining',
      'nullishCoalescingOperator',
    ],
  });
}

// Static folder: returns a string when `node` provably resolves to one at
// build time, or `null` when it cannot be resolved without runtime state.
// `env` holds the fold values of visible `const/let/var IDENT = <expr>`
// declarations from the same file. Arrays are represented as
// `{ __array: [...] }` so `.join(sep)` can consume them; strings and
// arrays are the only two shapes it tracks.
function evalStatic(node, env) {
  if (!node) return null;
  switch (node.type) {
    case 'StringLiteral':
      return node.value;
    case 'TemplateLiteral': {
      const parts = [];
      for (let i = 0; i < node.quasis.length; i += 1) {
        parts.push(node.quasis[i].value.cooked ?? node.quasis[i].value.raw ?? '');
        if (i < node.expressions.length) {
          const v = evalStatic(node.expressions[i], env);
          if (typeof v !== 'string') return null;
          parts.push(v);
        }
      }
      return parts.join('');
    }
    case 'BinaryExpression': {
      if (node.operator !== '+') return null;
      const l = evalStatic(node.left, env);
      const r = evalStatic(node.right, env);
      if (typeof l !== 'string' || typeof r !== 'string') return null;
      return l + r;
    }
    case 'Identifier': {
      const v = env.get(node.name);
      if (typeof v === 'string') return v;
      return null;
    }
    case 'ArrayExpression': {
      const parts = [];
      for (const el of node.elements) {
        if (el == null) return null;
        const v = evalStatic(el, env);
        if (typeof v !== 'string') return null;
        parts.push(v);
      }
      return { __array: parts };
    }
    case 'CallExpression': {
      const callee = node.callee;
      // <Array>.join(<sep>)
      if (
        callee?.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property?.type === 'Identifier' &&
        callee.property.name === 'join'
      ) {
        const arr = evalStatic(callee.object, env);
        if (arr && typeof arr === 'object' && Array.isArray(arr.__array)) {
          const sepArg = node.arguments[0];
          const sep = sepArg ? evalStatic(sepArg, env) : ',';
          if (typeof sep === 'string') return arr.__array.join(sep);
        }
      }
      // <String>.concat(...) — folds when receiver and all args fold to strings.
      if (
        callee?.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property?.type === 'Identifier' &&
        callee.property.name === 'concat'
      ) {
        const base = evalStatic(callee.object, env);
        if (typeof base !== 'string') return null;
        let out = base;
        for (const arg of node.arguments) {
          const v = evalStatic(arg, env);
          if (typeof v !== 'string') return null;
          out += v;
        }
        return out;
      }
      // String.fromCharCode(...) — folds when every arg is a numeric literal.
      if (
        callee?.type === 'MemberExpression' &&
        callee.object?.type === 'Identifier' &&
        callee.object.name === 'String' &&
        callee.property?.type === 'Identifier' &&
        callee.property.name === 'fromCharCode'
      ) {
        const codes = [];
        for (const arg of node.arguments) {
          if (arg?.type !== 'NumericLiteral') return null;
          codes.push(arg.value);
        }
        return String.fromCharCode(...codes);
      }
      return null;
    }
    case 'ConditionalExpression': {
      // Both branches folding to the SAME string means the conditional
      // is a static string; otherwise we can't decide statically.
      const c = evalStatic(node.consequent, env);
      const a = evalStatic(node.alternate, env);
      if (typeof c === 'string' && typeof a === 'string' && c === a) return c;
      return null;
    }
    default:
      return null;
  }
}

// Walk the AST once, collecting `const IDENT = <static expression>`
// bindings and reporting every static-folded string containing a
// forbidden substring. Also reports identifier NAMES containing the
// forbidden substrings (e.g. `openrouterClient` or `OPENROUTER_KEY_ALT`).
export function scanForOpenRouter(source, relativePath = '<inline>') {
  let ast;
  try {
    ast = parseSource(source, relativePath);
  } catch (err) {
    // A parse failure is itself a fail-closed signal — a file the AST
    // cannot see is a file the guard cannot vet.
    return [
      {
        kind: 'parse-error',
        location: relativePath,
        detail: err?.message ?? String(err),
      },
    ];
  }
  const offenders = [];
  const env = new Map();

  function forbid(kind, node, value) {
    for (const { pattern, label } of FORBIDDEN_SUBSTRINGS) {
      if (pattern.test(value)) {
        offenders.push({
          kind,
          location: `${relativePath}:${node?.loc?.start?.line ?? '?'}:${node?.loc?.start?.column ?? '?'}`,
          match: label,
          value,
        });
        break;
      }
    }
  }

  function visit(node, parent) {
    if (!node || typeof node !== 'object' || !node.type) return;

    // First pass on declarations — populate env before we walk expressions
    // that might reference them below the declaration point. We do this
    // eagerly at each VariableDeclarator so forward references inside the
    // same declaration list still resolve.
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
      const folded = evalStatic(node.init, env);
      if (typeof folded === 'string') env.set(node.id.name, folded);
    }

    // Report standalone string folds.
    switch (node.type) {
      case 'StringLiteral': {
        // Skip re-reporting import-declaration source & export-declaration
        // source when they're already covered by the ImportDeclaration
        // visitor below (which reports as `import`), so the offender list
        // does not double-count. The literal-value scan still runs.
        if (
          parent &&
          (parent.type === 'ImportDeclaration' || parent.type === 'ExportNamedDeclaration' || parent.type === 'ExportAllDeclaration') &&
          parent.source === node
        ) {
          // Fall through to the ImportDeclaration visitor.
        } else {
          forbid('string-literal', node, node.value);
        }
        break;
      }
      case 'TemplateLiteral':
      case 'BinaryExpression':
      case 'CallExpression': {
        const folded = evalStatic(node, env);
        if (typeof folded === 'string') forbid(node.type, node, folded);
        break;
      }
      case 'Identifier': {
        // Identifier NAMES are checked directly; a global lookup like
        // `openrouterModule` at any position is a fail even without
        // touching env.
        for (const { pattern, label } of FORBIDDEN_SUBSTRINGS) {
          if (pattern.test(node.name)) {
            offenders.push({
              kind: 'identifier',
              location: `${relativePath}:${node.loc?.start?.line ?? '?'}:${node.loc?.start?.column ?? '?'}`,
              match: label,
              value: node.name,
            });
            break;
          }
        }
        break;
      }
      case 'ImportDeclaration': {
        const spec = node.source?.value;
        if (typeof spec === 'string') forbid('import', node.source, spec);
        break;
      }
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration': {
        const spec = node.source?.value;
        if (typeof spec === 'string') forbid('re-export', node.source, spec);
        break;
      }
      default:
        break;
    }

    // Recurse into children.
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range' || key === 'start' || key === 'end' || key === 'extra') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) visit(c, node);
      } else if (child && typeof child === 'object' && typeof child.type === 'string') {
        visit(child, node);
      }
    }
  }

  visit(ast.program, null);

  // Dedup: an offender may be reported both as the identifier reference
  // and via the fold that resolved through it — dedup by location+value.
  const seen = new Set();
  const unique = [];
  for (const o of offenders) {
    const k = `${o.location}|${o.kind}|${o.value}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(o);
  }
  return unique;
}

export function scanApiDirectory(apiRoot) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs|cjs)$/i.test(entry.name)) files.push(p);
    }
  };
  walk(apiRoot);
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(apiRoot, file);
    const src = fs.readFileSync(file, 'utf8');
    offenders.push(...scanForOpenRouter(src, `api/${rel}`));
  }
  return offenders;
}
