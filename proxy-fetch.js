const fetch = require('node-fetch');

const PROXY_URL = process.env.CF_PROXY_URL || 'https://book-guard-proxy.botgrid.workers.dev';
const PROXY_SECRET = process.env.CF_PROXY_SECRET || 'bg-proxy-2026-secret';

async function proxyPost(targetUrl, body, extraHeaders) {
  const headers = {
    'Content-Type': 'application/json',
    'x-proxy-secret': PROXY_SECRET,
    'x-target-url': targetUrl,
  };

  if (extraHeaders) {
    Object.assign(headers, extraHeaders);
  }

  const res = await fetch(PROXY_URL, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  return res;
}

module.exports = { proxyPost };
