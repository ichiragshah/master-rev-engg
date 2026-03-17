const ALLOWED_HOSTS = [
  'user-backend-api.playexchwin.com',
  'sportsbookbackend.playexchwin.com',
  'netexposure.playexchwin.com',
  'artemis-bookmaker.playexchwin.com',
];

export default {
  async fetch(request, env) {
    // Only POST allowed
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Verify proxy secret
    const secret = request.headers.get('x-proxy-secret');
    if (secret !== env.PROXY_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Target URL passed in header
    const targetUrl = request.headers.get('x-target-url');
    if (!targetUrl) {
      return new Response('Missing x-target-url header', { status: 400 });
    }

    // Validate target host
    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      return new Response('Invalid target URL', { status: 400 });
    }

    if (!ALLOWED_HOSTS.includes(parsedUrl.hostname)) {
      return new Response('Target host not allowed', { status: 403 });
    }

    // Forward the request with browser-like headers
    const body = await request.text();
    const headers = new Headers({
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://backend.winner7.co',
      'Referer': 'https://backend.winner7.co/',
      'sec-ch-ua': '"Google Chrome";v="145", "Chromium";v="145", "Not:A-Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'cross-site',
    });

    // Copy x-key-id if present (for authenticated endpoints)
    const xKeyId = request.headers.get('x-key-id');
    if (xKeyId) {
      headers.set('x-key-id', xKeyId);
    }

    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body,
    });

    // Return upstream response
    const respBody = await upstream.text();
    return new Response(respBody, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
    });
  },
};
