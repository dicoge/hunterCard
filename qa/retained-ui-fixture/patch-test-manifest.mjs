#!/usr/bin/env node
/**
 * LOCAL PROPOSAL (2026-11-09) — test-client manifest patch for the SYNTHETIC retained-UI fixture build.
 *
 * Runs ONLY inside the ephemeral CI build checkout, AFTER `expo prebuild`, on the GENERATED
 * android/app/src/main/AndroidManifest.xml. It is never applied to product source (no config plugin,
 * no app.config change, no backdoor). It makes exactly two attribute changes on the single
 * <application> start tag:
 *   android:allowBackup -> "false"   (replaced if "true"/"false", inserted if absent)
 *   android:testOnly    =  "true"    (inserted; refused if already present)
 * and refuses on any other shape (0 or 2+ <application> tags, android:debuggable present, an
 * unexpected allowBackup value, a missing android namespace). The before/after sha256 and the change
 * list are recorded to a NEW file.
 *
 *   node patch-test-manifest.mjs --apply <path>/AndroidManifest.xml --record <new file.json>
 * Import / no arguments: no read, no write.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class ManifestRefusal extends Error {}
const refuse = (m) => { throw new ManifestRefusal(m); };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ANDROID_NS = 'xmlns:android="http://schemas.android.com/apk/res/android"';

export function patchManifestText(text) {
  if (typeof text !== 'string' || !text.includes(ANDROID_NS)) refuse('manifest lacks the android namespace');
  const starts = [...text.matchAll(/<application\b/g)];
  if (starts.length !== 1) refuse(`expected exactly one <application> tag, found ${starts.length}`);
  const at = starts[0].index;
  const end = text.indexOf('>', at);
  if (end < 0) refuse('unterminated <application> tag');
  let tag = text.slice(at, end);
  if (/\bandroid:testOnly\s*=/.test(tag)) refuse('android:testOnly already present; refusing to patch twice');
  if (/\bandroid:debuggable\s*=/.test(tag)) refuse('android:debuggable present; a debuggable test client is not wanted');
  const changes = [];
  const backup = [...tag.matchAll(/\bandroid:allowBackup\s*=\s*"([^"]*)"/g)];
  if (backup.length > 1) refuse('android:allowBackup repeated');
  if (/\bandroid:allowBackup\s*=\s*'/.test(tag)) refuse('unexpected android:allowBackup quoting');
  if (backup.length === 1) {
    if (!['true', 'false'].includes(backup[0][1])) refuse(`unexpected android:allowBackup value ${backup[0][1]}`);
    tag = tag.replace(backup[0][0], 'android:allowBackup="false"');
    changes.push({ attribute: 'android:allowBackup', before: backup[0][1], after: 'false' });
  } else {
    tag = tag.replace('<application', '<application android:allowBackup="false"');
    changes.push({ attribute: 'android:allowBackup', before: 'absent', after: 'false' });
  }
  tag = tag.replace('<application', '<application android:testOnly="true"');
  changes.push({ attribute: 'android:testOnly', before: 'absent', after: 'true' });
  const out = text.slice(0, at) + tag + text.slice(end);
  return { text: out, changes, beforeSha256: sha256(text), afterSha256: sha256(out) };
}

export function main(argv, io = { out: process.stdout, err: process.stderr }) {
  if (argv.length !== 4 || argv[0] !== '--apply' || argv[2] !== '--record') {
    io.err.write('refused: usage --apply <AndroidManifest.xml> --record <new record.json>\n');
    return 2;
  }
  try {
    const file = path.resolve(argv[1]);
    const record = path.resolve(argv[3]);
    if (path.basename(file) !== 'AndroidManifest.xml') refuse('target must be an AndroidManifest.xml');
    if (!file.endsWith(path.join('android', 'app', 'src', 'main', 'AndroidManifest.xml'))) refuse('target must be the generated android/app/src/main manifest');
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile() || st.size > (1 << 20)) refuse('target must be a regular file under 1 MiB');
    if (fs.existsSync(record)) refuse('record file already exists');
    const r = patchManifestText(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, r.text, 'utf8');
    fs.writeFileSync(record, `${JSON.stringify({ file: 'android/app/src/main/AndroidManifest.xml', changes: r.changes,
      beforeSha256: r.beforeSha256, afterSha256: r.afterSha256 }, null, 2)}\n`, { flag: 'wx' });
    io.out.write(`${JSON.stringify(r.changes)}\n`);
    return 0;
  } catch (e) {
    if (e instanceof ManifestRefusal || e?.code === 'ENOENT') { io.err.write(`refused: ${e.message}\n`); return 2; }
    throw e;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
