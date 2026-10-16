/**
 * The QA harness's outbound boundary (v41): the only requests it lets through are to
 * this machine. Decided on the PARSED URL — http/https, hostname exactly `localhost`
 * or `127.0.0.1`, no username/password — so look-alikes such as
 * `http://localhost.example/` or `http://localhost@external.example/` are refused.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

export function isLoopbackUrl(href) {
  let u;
  try { u = new URL(String(href)); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  return LOOPBACK_HOSTS.has(u.hostname);
}
