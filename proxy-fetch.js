const fetch = require('node-fetch');
const { BROWSER_HEADERS } = require('./headers');

const PROXY_URL = process.env.CF_PROXY_URL;
const PROXY_SECRET = process.env.CF_PROXY_SECRET;
const USE_PROXY = PROXY_URL && PROXY_SECRET;

async function proxyPost(targetUrl, body, extraHeaders) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

  if (USE_PROXY) {
    const headers = {
      'Content-Type': 'application/json',
      'x-proxy-secret': PROXY_SECRET,
      'x-target-url': targetUrl,
    };
    if (extraHeaders) Object.assign(headers, extraHeaders);

    return fetch(PROXY_URL, { method: 'POST', headers, body: bodyStr });
  }

  // Direct call with browser headers
  const headers = { ...BROWSER_HEADERS, 'Content-Type': 'application/json' };
  if (extraHeaders) Object.assign(headers, extraHeaders);

  return fetch(targetUrl, { method: 'POST', headers, body: bodyStr });
}

module.exports = { proxyPost };
