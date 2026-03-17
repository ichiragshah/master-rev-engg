const { getAllActiveClients } = require('./db');
const { ensureToken } = require('./auth');
const { sendMessage } = require('./telegram');
const { proxyPost } = require('./proxy-fetch');

const EXPOSURE_URL = 'https://sportsbookbackend.playexchwin.com/api/Book/getMemberNetExposure';
const MARKETS_URL = 'https://netexposure.playexchwin.com/api/Book/getBooksForBackend';
const BETS_URL = 'https://artemis-bookmaker.playexchwin.com/api/bettickerMapping/getAllBetsForBetticker';

const POLL_INTERVAL = 60 * 1000;
const COOLDOWN = 5 * 60 * 1000;

// In-memory cooldown tracker: key -> last alert timestamp
const cooldowns = new Map();
// Last known exposure per client for change tracking
const lastExposures = new Map();

function cooldownKey(chatId, market) {
  return `${chatId}:${market}`;
}

function canAlert(chatId, market) {
  const key = cooldownKey(chatId, market);
  const last = cooldowns.get(key);
  if (!last) return true;
  return (Date.now() - last) > COOLDOWN;
}

function markAlerted(chatId, market) {
  cooldowns.set(cooldownKey(chatId, market), Date.now());
}

function istTime() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

function formatINR(n) {
  return Number(n).toLocaleString('en-IN');
}

async function fetchExposure(token, userId) {
  const res = await proxyPost(EXPOSURE_URL, { _id: userId, _accessToken: token });
  return res.json();
}

async function fetchMarkets(token, userId, client) {
  const res = await proxyPost(
    MARKETS_URL,
    {
      _accessToken: token,
      filter: {
        user: userId,
        eventname: 'All',
        level: 'Master',
        status: { $ne: 'Done' },
        eventType: client.sports || 'All',
        bookmakerSessionFlag: 'all',
        _accessToken: token,
      },
      selectedType: client.book_view || 'Total Book',
      page: 1,
    },
    { 'x-key-id': `Bearer ${token}` }
  );
  return res.json();
}

async function fetchBets(token) {
  const res = await proxyPost(
    BETS_URL,
    {
      currencyType: 'All',
      eventName: 'All',
      page: 1,
      subGame: 'All',
      marketType: 'All',
    },
    { 'x-key-id': `Bearer ${token}` }
  );
  return res.json();
}

async function pollClient(client) {
  let token, userId;
  try {
    ({ token, userId } = await ensureToken(client));
  } catch (err) {
    console.error(`[Poller] Login failed for ${client.username}: ${err.message}`);
    return;
  }

  const chatId = client.telegram_chat_id;
  const threshold = client.threshold;
  const alertType = client.alert_type;

  // 1. Net exposure check (all alert types)
  try {
    const expData = await fetchExposure(token, userId);
    const netExposure = expData.data?.netExposure ?? 0;

    if (Math.abs(netExposure) >= threshold && canAlert(chatId, 'total_exposure')) {
      const prev = lastExposures.get(client.username) ?? 0;
      const change = netExposure - prev;
      const changeStr = change >= 0 ? `+${formatINR(change)}` : formatINR(change);

      await sendMessage(chatId,
        `<b>Exposure Alert</b>\nNet Exposure: Rs ${formatINR(netExposure)}\nChange: ${changeStr}\nThreshold: Rs ${formatINR(threshold)}\nTime: ${istTime()}`
      );
      markAlerted(chatId, 'total_exposure');
    }
    lastExposures.set(client.username, netExposure);
  } catch (err) {
    console.error(`[Poller] Exposure fetch failed for ${client.username}: ${err.message}`);
  }

  // 2. Market breakdown (exposure_and_markets or all)
  if (alertType === 'exposure_and_markets' || alertType === 'all') {
    try {
      const mkData = await fetchMarkets(token, userId, client);
      const books = mkData.data || [];
      const overThreshold = books
        .filter(b => Math.abs(b.netExposure || 0) > threshold)
        .sort((a, b) => Math.abs(b.netExposure || 0) - Math.abs(a.netExposure || 0))
        .slice(0, 5);

      for (const market of overThreshold) {
        const marketKey = market.eventname || market.eventName || 'unknown';
        if (canAlert(chatId, `market_${marketKey}`)) {
          await sendMessage(chatId,
            `<b>Market Alert</b>\nEvent: ${marketKey}\nExposure: Rs ${formatINR(market.netExposure)}\nThreshold: Rs ${formatINR(threshold)}\nTime: ${istTime()}`
          );
          markAlerted(chatId, `market_${marketKey}`);
        }
      }
    } catch (err) {
      console.error(`[Poller] Markets fetch failed for ${client.username}: ${err.message}`);
    }
  }

  // 3. Large bets (all only)
  if (alertType === 'all') {
    try {
      const betData = await fetchBets(token);
      const bets = betData.data || [];
      for (const bet of bets) {
        const stake = bet.stake || bet.amount || 0;
        if (stake >= threshold) {
          const betKey = `bet_${bet._id || bet.id || Date.now()}`;
          if (canAlert(chatId, betKey)) {
            await sendMessage(chatId,
              `<b>Large Bet Alert</b>\nEvent: ${bet.eventName || 'N/A'}\nMarket: ${bet.marketName || bet.marketType || 'N/A'}\nStake: Rs ${formatINR(stake)}\nType: ${bet.betType || bet.type || 'N/A'}\nTime: ${istTime()}`
            );
            markAlerted(chatId, betKey);
          }
        }
      }
    } catch (err) {
      console.error(`[Poller] Bets fetch failed for ${client.username}: ${err.message}`);
    }
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
