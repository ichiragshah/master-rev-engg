const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { getHeaders } = require('./headers');

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
  if (agent) {
    console.log(`[Proxy] Routing via residential proxy`);
  }

  return fetch(targetUrl, { method: 'POST', headers, body: bodyStr, agent });
}

module.exports = { proxyPost };
