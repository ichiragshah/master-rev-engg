const { getAllActiveClients, updateClientToken, getRecipientChatIds } = require('./db');
const { ensureToken } = require('./auth');
const { sendMessage, exposureAlert } = require('./telegram');
const { proxyPost } = require('./proxy-fetch');
const { getPlatform } = require('./platforms');

const POLL_INTERVAL = 60 * 1000;

const lastExposures = new Map();

function clientKey(client) {
  return `${client.platform || 'winner7'}:${client.username}`;
}

async function fetchMarkets(token, client) {
  const platformName = client.platform || 'winner7';
  const platform = getPlatform(platformName);

  const res = await proxyPost(
    platform.marketsUrl,
    platform.marketsBody(client),
    platform.authHeader(token),
    platformName
  );
  return res.json();
}

async function fetchFancyMarkets(token, client) {
  const platformName = client.platform || 'winner7';
  const platform = getPlatform(platformName);

  const res = await proxyPost(
    platform.fancyMarketsUrl,
    platform.fancyMarketsBody(client),
    platform.authHeader(token),
    platformName
  );
  return res.json();
}

async function pollClient(client) {
  let token, userId;
  try {
    ({ token, userId } = await ensureToken(client));
  } catch (err) {
    console.error(`[Poller] Login failed for ${client.username} (${client.platform}): ${err.message}`);
    return;
  }

  const platformName = client.platform || 'winner7';
  const platform = getPlatform(platformName);

  try {
    let mkData = await fetchMarkets(token, client);
    console.log(`[Poller] ${client.username} (${platformName}) raw response:`, JSON.stringify(mkData).slice(0, 500));

    // Handle session expired — clear token and retry with fresh login
    if (mkData.isLoggedOut || mkData.customStatus === 4000 || mkData.message?.includes('Session Has Expired')) {
      console.log(`[Poller] Session expired for ${client.username} (${platformName}), re-logging in`);
      await updateClientToken(client.username, platformName, null, null, null);
      const fresh = await ensureToken({ ...client, token: null, token_expiry: null });
      mkData = await fetchMarkets(fresh.token, client);
      console.log(`[Poller] ${client.username} (${platformName}) retry response:`, JSON.stringify(mkData).slice(0, 500));
    }

    const regularMarkets = platform.parseMarkets(mkData);

    let fancyMarkets = [];
    const effectiveUserId = userId || client.user_id;
    if (platform.fancyMarketsUrl && effectiveUserId) {
      try {
        const fancyClient = { ...client, user_id: effectiveUserId };
        const fancyData = await fetchFancyMarkets(token, fancyClient);
        console.log(`[Poller] ${client.username} (${platformName}) fancy response:`, JSON.stringify(fancyData).slice(0, 500));
        fancyMarkets = platform.parseFancyMarkets(fancyData);
      } catch (err) {
        console.error(`[Poller] Fancy fetch failed for ${client.username}: ${err.message}`);
      }
    }

    const allMarkets = [...regularMarkets, ...fancyMarkets];
    const totalExposure = allMarkets.reduce((sum, m) => sum + m.netExposure, 0);

    const key = clientKey(client);
    const prev = lastExposures.get(key);
    const isNew = prev == null && totalExposure > 0;
    const changed = prev != null && totalExposure !== prev && totalExposure > 0;

    if (isNew || changed) {
      const alertText = exposureAlert(client, totalExposure, prev, allMarkets);
      const chatIds = await getRecipientChatIds(client.id);
      await Promise.allSettled(chatIds.map(cid => sendMessage(cid, alertText)));
    }
    lastExposures.set(key, totalExposure);
  } catch (err) {
    console.error(`[Poller] Fetch failed for ${client.username} (${platformName}): ${err.message}`);
  }
}

async function pollAll() {
  const clients = await getAllActiveClients();
  if (clients.length === 0) return;

  console.log(`[Poller] Polling ${clients.length} active client(s)`);
  await Promise.allSettled(clients.map(c => pollClient(c)));
}

function startPoller() {
  console.log(`[Poller] Starting, interval: ${POLL_INTERVAL / 1000}s`);
  pollAll();
  setInterval(pollAll, POLL_INTERVAL);
}

module.exports = { startPoller };
