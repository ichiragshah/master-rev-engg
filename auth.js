const { decrypt } = require('./crypto');
const { updateClientToken } = require('./db');
const { getPlatform } = require('./platforms');
const { proxyPost } = require('./proxy-fetch');

const log = (level, msg, data = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, ctx: 'AUTH', msg, ...data }));

async function login(username, password, platformName) {
  const platform = getPlatform(platformName);

  log('INFO', 'Login attempt', { username, platform: platformName });

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
    log('ERROR', 'Non-JSON login response', { username, platform: platformName, status: res.status, responseBody: text.slice(0, 200) });
    throw new Error('Platform API unavailable - please try again later');
  }

  const result = platform.extractToken(json);
  log('INFO', 'Login success', { username, platform: platformName, userId: result.userId });
  return result;
}

async function ensureToken(client) {
  const now = Math.floor(Date.now() / 1000);
  const tenMinutes = 10 * 60;

  if (client.token && client.token_expiry && (client.token_expiry - now) > tenMinutes) {
    log('INFO', 'Token reused', { username: client.username, platform: client.platform || 'winner7' });
    return { token: client.token, userId: client.user_id };
  }

  const platformName = client.platform || 'winner7';
  const platform = getPlatform(platformName);
  log('INFO', 'Token refresh', { username: client.username, platform: platformName });
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
      log('INFO', 'Fetched userId', { username: client.username, platform: platformName, userId });
    } catch (err) {
      log('ERROR', 'getOneUser failed', { username: client.username, platform: platformName, error: err.message });
    }
  }

  await updateClientToken(client.username, platformName, token, exp, userId);
  return { token, userId };
}

module.exports = { login, ensureToken };
