/**
 * Web→Node Serverless handler adapter (DIC-891 / DIC-893).
 *
 * The auth functions are authored as Web-standard `(Request) => Response`
 * handlers, but Vercel runs them under the classic Node.js Serverless runtime,
 * which invokes `(req, res)` and expects the handler to WRITE to `res`. A
 * Web-standard handler that merely returns a `Response` never writes `res`, so
 * the invocation either hangs to the maxDuration timeout (DIC-890: zero-byte 40s
 * `/api/auth/me`) or — once any code touches Node's relative `req.url` through
 * `new URL()` — throws and surfaces as an opaque `FUNCTION_INVOCATION_FAILED`
 * 500 with no JSON body (DIC-893). This is the same failure mode that made
 * `api/search.ts` unusable ("Node runtime functions timeout on this project").
 *
 * This adapter bridges the two runtimes: it reconstructs a Web `Request` from the
 * Node request (rebuilding the absolute URL the Web `Request` requires from the
 * `host` header, since `req.url` is relative) and writes the resulting Web
 * `Response` back onto `res`. A boundary `catch` guarantees no throw can ever
 * escape as an unstructured platform 500 — the contract requires structured JSON.
 *
 * Only the HTTP boundary changes; every handler's verification / identity /
 * session logic is untouched, so all existing invariants and their regressions
 * still hold.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

type WebHandler = (req: Request) => Response | Promise<Response>;

function headerValue(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(', ') : v;
}

function toWebRequest(req: VercelRequest): Request {
  const proto = headerValue(req.headers['x-forwarded-proto']) || 'https';
  const host = headerValue(req.headers.host) || 'localhost';
  // Node hands us a relative `req.url`; the Web `Request` needs an absolute URL.
  const url = new URL(req.url || '/', `${proto}://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    const v = headerValue(value as string | string[] | undefined);
    if (v !== undefined) headers.set(key, v);
  }

  const method = (req.method || 'GET').toUpperCase();
  let body: BodyInit | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const raw = req.body;
    if (raw !== undefined && raw !== null) {
      if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
        // Raw body preserved verbatim so an inner `req.json()` on malformed input
        // still throws and the handler can return its structured `invalid_json`.
        body = raw as BodyInit;
      } else {
        // Vercel's JSON body parser hands us an already-parsed object; the inner
        // handler re-reads it via `req.json()`, so re-serialize it losslessly.
        body = JSON.stringify(raw);
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      }
    }
  }
  return new Request(url.toString(), { method, headers, body });
}

async function writeWebResponse(res: VercelResponse, webRes: Response): Promise<void> {
  res.status(webRes.status);
  webRes.headers.forEach((value, key) => {
    // Let the Node layer recompute framing headers to match the bytes it sends.
    if (key === 'content-length' || key === 'transfer-encoding') return;
    res.setHeader(key, value);
  });
  const text = await webRes.text();
  res.send(text);
}

export function toNodeHandler(handler: WebHandler) {
  return async function nodeHandler(req: VercelRequest, res: VercelResponse): Promise<void> {
    try {
      const webRes = await handler(toWebRequest(req));
      await writeWebResponse(res, webRes);
    } catch {
      // A Web handler should already fail closed with a structured Response; this
      // is the last line of defense so an unexpected throw becomes structured
      // JSON 500 instead of an opaque FUNCTION_INVOCATION_FAILED. Never leak
      // internals.
      if (!res.headersSent) {
        res.status(500);
        res.setHeader('content-type', 'application/json');
        res.send(JSON.stringify({ error: 'internal_error' }));
      } else {
        res.end();
      }
    }
  };
}
