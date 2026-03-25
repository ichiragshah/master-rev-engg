const { getActiveClientsForChatIds, updateClientToken, getRecipientChatIds } = require('./db');
const { ensureToken } = require('./auth');
const { sendMessage, exposureAlert, notifyAdmin } = require('./telegram');
const { proxyPost } = require('./proxy-fetch');
const { getPlatform } = require('./platforms');

const log = (level, msg, data = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, ctx: 'POLL', msg, ...data }));
const timeIST = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true, weekday: 'short', day: '2-digit', month: 'short' });

const POLL_INTERVAL = 30 * 1000;

const lastExposures = new Map();
const activePollers = new Set();

// Session tracking per chatId
const sessionState = new Map();
// Failure tracking per clientKey
const clientFailures = new Map();
// Last successful poll time per clientKey
const lastPollTimes = new Map();
// System health flag (set by server.js health check)
let systemHealthy = true;

function clientKey(client) {
  return `${client.platform || 'winner7'}:${client.username}`;
}

function initSessionState(chatId) {
  sessionState.set(chatId, { startTime: Date.now(), alertsSent: 0, peakExposure: 0 });
}

function getSessionState(chatId) {
  return sessionState.get(chatId) || null;
}

function resetSessionState(chatId) {
  sessionState.delete(chatId);
}

function isPollingActive(chatId) {
  return activePollers.has(chatId);
}

function getLastPollTime(key) {
  return lastPollTimes.get(key) || null;
}

function isSystemHealthy() {
  return systemHealthy;
}

function setSystemHealthy(healthy) {
  systemHealthy = healthy;
}

function getActivePollerCount() {
  return activePollers.size;
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

// Core fetch logic — returns { totalExposure, markets, success, error }
async function fetchClientExposure(client) {
  let token, userId;
  try {
    ({ token, userId } = await ensureToken(client));
  } catch (err) {
    return { totalExposure: 0, markets: [], success: false, error: `Login failed: ${err.message}` };
  }

  const platformName = client.platform || 'winner7';
  const platform = getPlatform(platformName);

  try {
    let mkData = await fetchMarkets(token, client);
    log('INFO', 'Raw response', { username: client.username, platform: platformName, responseBody: JSON.stringify(mkData).slice(0, 2000) });

    // Handle session expired
    if (mkData.isLoggedOut || mkData.customStatus === 4000 || mkData.message?.includes('Session Has Expired')) {
      log('INFO', 'Session expired, re-login', { username: client.username, platform: platformName });
      await updateClientToken(client.username, platformName, null, null, null);
      const fresh = await ensureToken({ ...client, token: null, token_expiry: null });
      token = fresh.token;
      userId = fresh.userId;
      mkData = await fetchMarkets(fresh.token, client);
      log('INFO', 'Retry response', { username: client.username, platform: platformName, responseBody: JSON.stringify(mkData).slice(0, 2000) });
    }

    const regularMarkets = platform.parseMarkets(mkData);

    let fancyMarkets = [];
    const effectiveUserId = userId || client.user_id;
    if (platform.fancyMarketsUrl && effectiveUserId) {
      try {
        const fancyClient = { ...client, user_id: effectiveUserId };
        const fancyData = await fetchFancyMarkets(token, fancyClient);
        log('INFO', 'Fancy response', { username: client.username, platform: platformName, responseBody: JSON.stringify(fancyData).slice(0, 2000) });
        fancyMarkets = platform.parseFancyMarkets(fancyData);
      } catch (err) {
        log('ERROR', 'Fancy fetch failed', { username: client.username, platform: platformName, error: err.message });
      }
    }

    const allMarkets = [...regularMarkets, ...fancyMarkets];
    const totalExposure = allMarkets.reduce((sum, m) => sum + m.netExposure, 0);

    log('INFO', 'Exposure parsed', { username: client.username, platform: platformName, exposure: totalExposure, marketCount: allMarkets.length });

    return { totalExposure, markets: allMarkets, success: true, error: null };
  } catch (err) {
    return { totalExposure: 0, markets: [], success: false, error: err.message };
  }
}

async function pollClient(client) {
  const key = clientKey(client);
  const platformName = client.platform || 'winner7';
  const start = Date.now();

  const result = await fetchClientExposure(client);

  if (!result.success) {
    // Track failures
    const failures = clientFailures.get(key) || { consecutiveFailures: 0, failureAlertSent: false };
    failures.consecutiveFailures++;
    clientFailures.set(key, failures);

    log('ERROR', 'Poll failed', { username: client.username, platform: platformName, error: result.error, attempt: failures.consecutiveFailures });

    if (failures.consecutiveFailures >= 3 && !failures.failureAlertSent) {
      const chatIds = await getRecipientChatIds(client.id);
      const failMsg = `⚠️ <b>POLLING ISSUE</b>\n\n${client.username} (${platformName}) — failed ${failures.consecutiveFailures} times in a row.\nError: ${result.error}\n\nWill keep retrying. If this persists, check credentials.\n🕐 ${timeIST()}`;
      await Promise.allSettled(chatIds.map(cid => sendMessage(cid, failMsg)));
      failures.failureAlertSent = true;

      await notifyAdmin(`⚠️ Poll failures: ${client.username} (${platformName}) — ${failures.consecutiveFailures} consecutive failures: ${result.error}`);
    }
    return;
  }

  // Success path
  const prevFailures = clientFailures.get(key);
  if (prevFailures && prevFailures.consecutiveFailures > 0) {
    // Recovery — first success after failures
    log('INFO', 'Recovery', { username: client.username, platform: platformName, resumedAfter: prevFailures.consecutiveFailures });
    const chatIds = await getRecipientChatIds(client.id);
    const recoveryMsg = `✅ <b>RECOVERED</b>\n\n${client.username} (${platformName}) is back online after ${prevFailures.consecutiveFailures} failed attempts.\n🕐 ${timeIST()}`;
    await Promise.allSettled(chatIds.map(cid => sendMessage(cid, recoveryMsg)));

    await notifyAdmin(`✅ Recovered: ${client.username} (${platformName}) after ${prevFailures.consecutiveFailures} failures`);
  }
  clientFailures.set(key, { consecutiveFailures: 0, failureAlertSent: false });

  lastPollTimes.set(key, Date.now());

  // Update peak exposure for all active chatIds linked to this client
  const chatIds = await getRecipientChatIds(client.id);
  for (const cid of chatIds) {
    const session = sessionState.get(cid);
    if (session && Math.abs(result.totalExposure) > Math.abs(session.peakExposure)) {
      session.peakExposure = result.totalExposure;
    }
  }

  // Check if alert needed
  const prev = lastExposures.get(key);
  const isNew = prev == null && result.totalExposure > 0;
  const changed = prev != null && result.totalExposure !== prev && result.totalExposure > 0;

  if (isNew || changed) {
    const alertText = exposureAlert(client, result.totalExposure, prev, result.markets);
    log('INFO', 'Alert fired', { username: client.username, platform: platformName, exposure: result.totalExposure, prev, delta: prev != null ? result.totalExposure - prev : null });

    await Promise.allSettled(chatIds.map(cid => sendMessage(cid, alertText)));

    // Increment alertsSent for active sessions
    for (const cid of chatIds) {
      const session = sessionState.get(cid);
      if (session) session.alertsSent++;
    }

    const fmtExp = n => '₹' + Math.abs(Math.round(n)).toLocaleString('en-IN');
    await notifyAdmin(`📊 Alert: ${client.username} (${platformName}) — exposure ${fmtExp(result.totalExposure)}`);
  } else {
    log('INFO', 'Alert skipped', { username: client.username, platform: platformName, exposure: result.totalExposure, prev });
  }

  lastExposures.set(key, result.totalExposure);
  log('INFO', 'Cycle complete', { username: client.username, platform: platformName, durationMs: Date.now() - start });
}

async function pollAll() {
  if (activePollers.size === 0) return;

  const chatIds = [...activePollers];
  const clients = await getActiveClientsForChatIds(chatIds);
  if (clients.length === 0) return;

  log('INFO', 'Cycle start', { activePollers: chatIds.length, clientCount: clients.length });
  await Promise.allSettled(clients.map(c => pollClient(c)));
}

function startPolling(chatId) {
  activePollers.add(chatId);
  log('INFO', 'Started polling', { chatId, activeCount: activePollers.size });
}

function stopPolling(chatId) {
  activePollers.delete(chatId);
  log('INFO', 'Stopped polling', { chatId, activeCount: activePollers.size });
}

function startPoller() {
  log('INFO', 'Poller starting', { intervalSec: POLL_INTERVAL / 1000 });
  setInterval(pollAll, POLL_INTERVAL);
}

module.exports = {
  startPoller,
  startPolling,
  stopPolling,
  clientKey,
  initSessionState,
  getSessionState,
  resetSessionState,
  isPollingActive,
  getLastPollTime,
  isSystemHealthy,
  setSystemHealthy,
  getActivePollerCount,
  fetchClientExposure,
};
