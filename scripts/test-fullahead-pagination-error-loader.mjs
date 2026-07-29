const mockUrl = 'mock:puppeteer';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'puppeteer') {
    return { url: mockUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === mockUrl) {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        export default {
          async launch() {
            const listeners = new Map();
            const page = {
              async setUserAgent() {},
              async setExtraHTTPHeaders() {},
              on(event, cb) { listeners.set(event, cb); },
              async goto() {
                const cb = listeners.get('request');
                if (cb) {
                  cb({ url: () => 'https://fullahead-buy.com/fetchRecords.php?app=38&apiToken=test-token' });
                }
              },
              async evaluate(fn, base, token) {
                const previousFetch = globalThis.fetch;
                globalThis.fetch = async () => ({
                  ok: false,
                  status: 503,
                  statusText: 'Service Unavailable',
                  async json() {
                    throw new Error('json() should not be called for non-2xx responses');
                  }
                });
                try {
                  return await fn(base, token);
                } finally {
                  globalThis.fetch = previousFetch;
                }
              }
            };
            return {
              async newPage() { return page; },
              async close() {}
            };
          }
        };
      `,
    };
  }
  return nextLoad(url, context);
}
