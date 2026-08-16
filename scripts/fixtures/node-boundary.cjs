/**
 * Drives a Vercel Node-runtime function through the exact `(req, res)` boundary the
 * platform uses, then re-wraps what the handler wrote as a Web `Response` so tests
 * can keep asserting at the Web level (DIC-1043).
 *
 * Calling a route's default export with a Web `Request` would bypass the adapter and
 * hide the failure mode that took production down: a handler that returns a Response
 * without ever writing `res` hangs the invocation forever.
 */

/** A mock VercelResponse capturing what the handler writes. */
function buildRes() {
  return {
    _status: 200,
    _headers: {},
    _body: undefined,
    headersSent: false,
    status(code) {
      this._status = code;
      return this;
    },
    setHeader(k, v) {
      this._headers[k.toLowerCase()] = v;
      return this;
    },
    getHeader(k) {
      return this._headers[k.toLowerCase()];
    },
    json(obj) {
      this.setHeader('content-type', 'application/json');
      this._body = JSON.stringify(obj);
      this.headersSent = true;
      return this;
    },
    send(b) {
      this._body = b == null ? undefined : b;
      this.headersSent = true;
      return this;
    },
    end(b) {
      if (b != null) this._body = b;
      this.headersSent = true;
      return this;
    },
  };
}

/** Rebuild the Node request Vercel synthesizes, including its pre-parsed JSON body. */
async function toNodeRequest(request) {
  const url = new URL(request.url);
  const headers = {};
  request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  if (!headers.host) headers.host = url.host;

  let body;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const raw = await request.text();
    if (raw.length > 0) {
      if ((headers['content-type'] || '').includes('application/json')) {
        // Vercel's JSON body parser hands the function an already-parsed object;
        // unparseable input is passed through verbatim so `invalid_json` still
        // round-trips.
        try { body = JSON.parse(raw); } catch { body = raw; }
      } else {
        body = raw;
      }
    }
  }

  // Node hands the function a RELATIVE url — the detail that made the adapter necessary.
  return { method: request.method, url: url.pathname + url.search, headers, body };
}

const NULL_BODY_STATUS = new Set([204, 205, 304]);

async function invokeNodeHandler(nodeHandler, request) {
  const res = buildRes();
  await nodeHandler(await toNodeRequest(request), res);
  const body = NULL_BODY_STATUS.has(res._status) || res._body === undefined ? null : res._body;
  return new Response(body, { status: res._status, headers: res._headers });
}

/** Wrap a Node-runtime default export so it can be called with a Web `Request`. */
function asWebHandler(nodeHandler) {
  return (request) => invokeNodeHandler(nodeHandler, request);
}

module.exports = { asWebHandler, invokeNodeHandler };
