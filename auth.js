const { decrypt } = require('./crypto');
const { updateClientToken } = require('./db');
const { getPlatform } = require('./platforms');
const { proxyPost } = require('./proxy-fetch');

async function login(username, password, platformName) {
  const platform = getPlatform(platformName);

  const res = await proxyPost(
    platform.loginUrl,
    platform.loginBody(username, password),
    null,
    platformName
  );

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`[Auth] Non-JSON response (${res.status}):`, text.slice(0, 200));
    throw new Error('Platform API unavailable - please try again later');
  }

  return platform.extractToken(json);
}

async function ensureToken(client) {
  const now = Math.floor(Date.now() / 1000);
  const tenMinutes = 10 * 60;

  if (client.token && client.token_expiry && (client.token_expiry - now) > tenMinutes) {
    return { token: client.token, userId: client.user_id };
  }

  const platformName = client.platform || 'winner7';
  const platform = getPlatform(platformName);
  console.log(`[Auth] Re-logging in ${client.username} (${platformName})`);
  const password = decrypt(client.password_enc);
  const { token, userId: loginUserId, exp } = await login(client.username, password, platformName);

  let userId = loginUserId;
  if (!userId && platform.userDetailsUrl) {
    try {
      const udRes = await proxyPost(
        platform.userDetailsUrl,
        platform.userDetailsBody(),
        platform.authHeader(token),
        platformName
      );
      const udJson = await udRes.json();
      userId = platform.extractUserId(udJson);
      console.log(`[Auth] Fetched userId for ${client.username} (${platformName}): ${userId}`);
    } catch (err) {
      console.error(`[Auth] getOneUser failed for ${client.username}: ${err.message}`);
    }
  }

  await updateClientToken(client.username, platformName, token, exp, userId);
  return { token, userId };
}

module.exports = { login, ensureToken };
