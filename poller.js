const { getActiveClientsForChatIds, updateClientToken, getRecipientChatIds } = require('./db');
const { ensureToken } = require('./auth');
const { sendMessage, exposureAlert, notifyAdmin } = require('./telegram');
const { proxyPost, proxyGet } = require('./proxy-fetch');
const { getPlatform } = require('./platforms');

const log = (level, msg, data = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, ctx: 'POLL', msg, ...data }));
const timeIST = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true, weekday: 'short', day: '2-digit', month: 'short' });

function formatDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${totalMin}m`;
}

function fmt(n) {
  return '₹' + Math.abs(Math.round(n)).toLocaleString('en-IN');
}

const POLL_INTERVAL = 60 * 1000;
const MAX_SESSION_MS = 8 * 60 * 60 * 1000;

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

function getLastExposure(key) {
  return lastExposures.has(key) ? lastExposures.get(key) : null;
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

function getActivePollerIds() {
  return [...activePollers];
}

async function fetchMarkets(token, client) {
  const platformName = client.platform || 'winner7';
  const platform = getPlatform(platformName);

  const url = typeof platform.marketsUrl === 'function'
    ? platform.marketsUrl(client)
    : platform.marketsUrl;

  if (platform.marketsMethod === 'GET') {
    const authHeaders = { ...platform.authHeader(token) };
    if (platform.marketsExtraHeaders) Object.assign(authHeaders, platform.marketsExtraHeaders(client));
    const res = await proxyGet(url, authHeaders, platformName);
    return res.json();
  }

  const res = await proxyPost(url, platform.marketsBody(client, token), platform.authHeader(token), platformName);
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

async function fetchPremiumMarkets(token, client) {
  const platformName = client.platform || 'winner7';
  const platform = getPlatform(platformName);

  const res = await proxyPost(
    platform.premiumMarketsUrl,
    platform.premiumMarketsBody(client),
    platform.authHeader(token),
    platformName
  );
  return res.json();
}

// Core fetch logic — returns { totalExposure, markets, success, error }
async function fetchClientExposure(client, { skipFancyIfZero = false } = {}) {
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
    if (platform.isSessionExpired?.(mkData) || mkData.isLoggedOut || mkData.customStatus === 4000 || mkData.message?.includes('Session Has Expired')) {
      log('INFO', 'Session expired, re-login', { username: client.username, platform: platformName });
      await updateClientToken(client.username, platformName, null, null, null);
      const fresh = await ensureToken({ ...client, token: null, token_expiry: null });
      token = fresh.token;
      userId = fresh.userId;
      mkData = await fetchMarkets(fresh.token, client);
      log('INFO', 'Retry response', { username: client.username, platform: platformName, responseBody: JSON.stringify(mkData).slice(0, 2000) });
    }

    const regularMarkets = platform.parseMarkets(mkData, client);
    const regularExposure = regularMarkets.reduce((sum, m) => sum + m.netExposure, 0);

    // Skip fancy markets fetch when regular exposure is 0 and unchanged
    let fancyMarkets = [];
    const key = clientKey(client);
    const prevExposure = lastExposures.get(key);
    const shouldSkipFancy = skipFancyIfZero && regularExposure === 0 && prevExposure === 0;

    const effectiveUserId = userId || client.user_id;
    if (platform.fancyMarketsUrl && effectiveUserId && !shouldSkipFancy) {
      try {
        const fancyClient = { ...client, user_id: effectiveUserId };
        const fancyData = await fetchFancyMarkets(token, fancyClient);
        log('INFO', 'Fancy response', { username: client.username, platform: platformName, responseBody: JSON.stringify(fancyData).slice(0, 2000) });
        fancyMarkets = platform.parseFancyMarkets(fancyData);
      } catch (err) {
        log('ERROR', 'Fancy fetch failed', { username: client.username, platform: platformName, error: err.message });
      }
    } else if (shouldSkipFancy) {
      log('INFO', 'Fancy fetch skipped (zero exposure)', { username: client.username, platform: platformName });
    }

    // Fetch premium bookmaker markets (Winner7 artemis endpoint)
    let premiumMarkets = [];
    if (platform.premiumMarketsUrl && !shouldSkipFancy) {
      try {
        const premiumData = await fetchPremiumMarkets(token, client);
        log('INFO', 'Premium response', { username: client.username, platform: platformName, responseBody: JSON.stringify(premiumData).slice(0, 2000) });
        premiumMarkets = platform.parsePremiumMarkets(premiumData);
      } catch (err) {
        log('ERROR', 'Premium fetch failed', { username: client.username, platform: platformName, error: err.message });
      }
    }

    const allMarkets = [...regularMarkets, ...fancyMarkets, ...premiumMarkets];
    const totalExposure = allMarkets.reduce((sum, m) => sum + m.netExposure, 0);

    log('INFO', 'Exposure parsed', { username: client.username, platform: platformName, exposure: totalExposure, marketCount: allMarkets.length });

    return { totalExposure, markets: allMarkets, success: true, error: null };
  } catch (err) {
    return { totalExposure: 0, markets: [], success: false, error: err.message };
  }
}

async function triggerAutoStop(chatId, reason) {
  if (!activePollers.has(chatId)) return;
  activePollers.delete(chatId);

  const session = sessionState.get(chatId) || {};
  const duration = session.startTime ? Date.now() - session.startTime : 0;

  const reasonMsg = {
    daily_1am: 'Daily auto-stop at 1:00 AM.',
    max_duration: 'Session exceeded 8 hours.',
  }[reason] || reason;

  const msg =
    `🏁 <b>Auto-stopped</b>\n` +
    `${reasonMsg}\n\n` +
    `⏱ Duration: ${formatDuration(duration)}\n` +
    `💰 Peak: ${fmt(session.peakExposure || 0)}\n` +
    `🚨 Alerts sent: ${session.alertsSent || 0}\n\n` +
    `Send /chalu to start receiving exposure alerts when the match is live.`;

  await sendMessage(chatId, msg);
  await notifyAdmin(
    `🏁 <b>Auto-stopped</b>  •  reason: ${reason}\n` +
    `💬 chat: ${chatId}\n` +
    `⏱ ${formatDuration(duration)}  •  ` +
    `peak: ${fmt(session.peakExposure || 0)}\n` +
    `🕐 ${timeIST()}`
  );

  resetSessionState(chatId);
  log('INFO', 'Auto-stopped', { chatId, reason, duration: formatDuration(duration) });
}

async function pollClient(client) {
  const key = clientKey(client);
  const platformName = client.platform || 'winner7';
  const start = Date.now();

  const result = await fetchClientExposure(client, { skipFancyIfZero: true });

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
  const absExposure = Math.abs(result.totalExposure);
  const threshold = client.threshold ?? 0;
  const meetsThreshold = absExposure >= threshold;
  const isFirstPoll = prev == null;
  const changed = !isFirstPoll && result.totalExposure !== prev;

  // Always store exposure (needed for /status cached values)
  lastExposures.set(key, result.totalExposure);

  if (isFirstPoll) {
    log('INFO', 'First poll, storing baseline', { username: client.username, platform: platformName, exposure: result.totalExposure, threshold });
  } else if (meetsThreshold && changed) {
    const alertText = exposureAlert(client, result.totalExposure, prev, result.markets);
    log('INFO', 'Alert fired', { username: client.username, platform: platformName, exposure: result.totalExposure, prev, threshold, delta: result.totalExposure - prev });

    await Promise.allSettled(chatIds.map(cid => sendMessage(cid, alertText)));

    // Increment alertsSent for active sessions
    for (const cid of chatIds) {
      const session = sessionState.get(cid);
      if (session) session.alertsSent++;
    }

    await notifyAdmin(`📊 Alert: ${client.username} (${platformName}) — exposure ${fmt(result.totalExposure)} (threshold ${fmt(threshold)})`);
  } else {
    log('INFO', 'Alert skipped', { username: client.username, platform: platformName, exposure: result.totalExposure, prev, threshold, meetsThreshold, changed });
  }
  log('INFO', 'Cycle complete', { username: client.username, platform: platformName, durationMs: Date.now() - start });
}

async function pollAll() {
  if (activePollers.size === 0) return;

  // 8-hour cap check
  for (const chatId of [...activePollers]) {
    const session = sessionState.get(chatId);
    if (session && (Date.now() - session.startTime) > MAX_SESSION_MS) {
      await triggerAutoStop(chatId, 'max_duration');
    }
  }

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
  getLastExposure,
  isSystemHealthy,
  setSystemHealthy,
  getActivePollerCount,
  getActivePollerIds,
  fetchClientExposure,
  triggerAutoStop,
};
