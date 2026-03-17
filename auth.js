const { decrypt } = require('./crypto');
const { updateClientToken } = require('./db');
const { proxyPost } = require('./proxy-fetch');

const LOGIN_URL = 'https://user-backend-api.playexchwin.com/api/member/memberLogin';

function decodeJWT(token) {
  const payload = token.split('.')[1];
  const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
  return { userId: decoded._id, exp: decoded.exp };
}

async function login(username, password) {
  const res = await proxyPost(LOGIN_URL, {
    username,
    password,
    siteOrigin: 'playexch.co',
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`[Auth] Non-JSON response (${res.status}):`, text.slice(0, 200));
    throw new Error('Platform API unavailable - please try again later');
  }

  const memberData = json.data?.memberData;
  const accessToken = memberData?.accessToken?.[0];
  const newToken = json.data?.newToken;

  if (!accessToken && !newToken) {
    throw new Error(json.message || json.error || 'Login failed - no token returned');
  }

  // Use JWT accessToken for API calls; extract userId and expiry from it
  const token = accessToken || newToken;
  const userId = memberData?._id;
  let exp;

  // If token is a JWT, decode expiry from it
  if (token.includes('.')) {
    const decoded = decodeJWT(token);
    exp = decoded.exp;
  } else {
    // Non-JWT token (hex), set expiry to 24h from now
    exp = Math.floor(Date.now() / 1000) + 86400;
  }

  return { token, userId, exp };
}

async function ensureToken(client) {
  const now = Math.floor(Date.now() / 1000);
  const tenMinutes = 10 * 60;

  if (client.token && client.token_expiry && (client.token_expiry - now) > tenMinutes) {
    return { token: client.token, userId: client.user_id };
  }

  console.log(`[Auth] Re-logging in ${client.username}`);
  const password = decrypt(client.password_enc);
  const { token, userId, exp } = await login(client.username, password);
  await updateClientToken(client.username, token, exp, userId);

  return { token, userId };
}

module.exports = { login, ensureToken, decodeJWT };
