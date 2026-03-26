const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { getHeaders } = require('./headers');

const log = (level, msg, data = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, ctx: 'PROXY', msg, ...data }));

const RESIDENTIAL_PROXY = process.env.RESIDENTIAL_PROXY_URL;

function getAgent() {
  if (!RESIDENTIAL_PROXY) return undefined;
  return new HttpsProxyAgent(RESIDENTIAL_PROXY);
}

async function proxyPost(targetUrl, body, extraHeaders, platformName) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = { ...getHeaders(platformName), 'Content-Type': 'application/json' };
  if (extraHeaders) Object.assign(headers, extraHeaders);

  const agent = getAgent();
  const start = Date.now();

  try {
    const res = await fetch(targetUrl, { method: 'POST', headers, body: bodyStr, agent });
    const text = await res.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    log('INFO', 'POST complete', { url: targetUrl, status: res.status, bytes, durationMs: Date.now() - start, proxied: !!agent });
    return { ok: res.ok, status: res.status, json: () => JSON.parse(text), text: () => text, bytes, headers: res.headers };
  } catch (err) {
    log('ERROR', 'POST failed', { url: targetUrl, error: err.message, durationMs: Date.now() - start, proxied: !!agent });
    throw err;
  }
}

async function proxyGet(url, extraHeaders, platformName) {
  const headers = {};
  if (platformName) Object.assign(headers, getHeaders(platformName));
  if (extraHeaders) Object.assign(headers, extraHeaders);

  const agent = getAgent();
  const start = Date.now();

  try {
    const opts = { agent };
    if (Object.keys(headers).length > 0) opts.headers = headers;
    const res = await fetch(url, opts);
    const text = await res.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    log('INFO', 'GET complete', { url, status: res.status, bytes, durationMs: Date.now() - start, proxied: !!agent });
    return { ok: res.ok, status: res.status, json: () => JSON.parse(text), text: () => text, bytes, headers: res.headers };
  } catch (err) {
    log('ERROR', 'GET failed', { url, error: err.message, durationMs: Date.now() - start, proxied: !!agent });
    throw err;
  }
}

module.exports = { proxyPost, proxyGet };
