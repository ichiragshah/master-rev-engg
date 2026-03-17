const fetch = require('node-fetch');
const { decrypt } = require('./crypto');
const { updateClientToken } = require('./db');

const LOGIN_URL = 'https://user-backend-api.playexchwin.com/api/member/memberLogin';

function decodeJWT(token) {
  const payload = token.split('.')[1];
  const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
  return { userId: decoded._id, exp: decoded.exp };
}

async function login(username, password) {
  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Referer': 'https://backend.winner7.co/',
    },
    body: JSON.stringify({
      username,
      password,
      siteOrigin: 'playexch.co',
    }),
  });

  const json = await res.json();

  if (!json.data || !json.data.newToken) {
    throw new Error(json.message || 'Login failed - no token returned');
  }

  const token = json.data.newToken;
  const { userId, exp } = decodeJWT(token);

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
