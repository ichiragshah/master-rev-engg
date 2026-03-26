const express = require('express');
const path = require('path');
const { pool, initDB, registerClient, addRecipients, getAllClients } = require('./db');
const { encrypt } = require('./crypto');
const { setWebhook, handleUpdate, notifyAdmin } = require('./telegram');
const { startPoller, setSystemHealthy, getActivePollerCount, getActivePollerIds, triggerAutoStop } = require('./poller');
const { proxyGet } = require('./proxy-fetch');

const log = (level, msg, data = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, ctx: 'SERVER', msg, ...data }));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), activePollers: getActivePollerCount() });
});

// Registration
app.post('/register', async (req, res) => {
  try {
    const { username, password, telegram_username, telegram_usernames, threshold, alert_type, sports, book_view, platform } = req.body;

    // Support both comma-separated telegram_usernames and single telegram_username
    const rawUsernames = telegram_usernames
      ? telegram_usernames.split(',').map(u => u.trim().replace('@', '')).filter(Boolean)
      : telegram_username
        ? [telegram_username.replace('@', '')]
        : [];

    if (!username || !password || rawUsernames.length === 0) {
      return res.status(400).json({ success: false, message: 'Username, password, and at least one Telegram username are required.' });
    }

    const validPlatforms = ['winner7', 'leoexch'];
    const selectedPlatform = validPlatforms.includes(platform) ? platform : 'winner7';

    log('INFO', 'Registration attempt', { username, platform: selectedPlatform });

    const password_enc = encrypt(password);

    const client = await registerClient({
      name: username,
      username,
      password_enc,
      telegram_username: rawUsernames[0],
      threshold: parseInt(threshold, 10) || 0,
      alert_type: alert_type || 'exposure_only',
      sports: sports || 'All',
      book_view: book_view || 'Total Book',
      platform: selectedPlatform,
    });

    // Store all recipients in alert_recipients table
    await addRecipients(client.id, rawUsernames);

    const botUsername = process.env.BOT_USERNAME || 'your_bot';
    const plural = rawUsernames.length > 1 ? `All ${rawUsernames.length} users need to` : 'Now';

    log('INFO', 'Registration success', { username, platform: selectedPlatform, clientId: client.id });
    await notifyAdmin(`🆕 New registration: ${username} (${selectedPlatform}) — TG: @${rawUsernames[0]}`);

    res.json({
      success: true,
      message: `Registered! ${plural} message @${botUsername} on Telegram and send /start to link.`,
    });
  } catch (err) {
    log('ERROR', 'Registration failed', { error: err.message });
    res.status(500).json({ success: false, message: 'Registration failed. Please try again.' });
  }
});

// Telegram webhook
app.post('/telegram-webhook', (req, res) => {
  res.sendStatus(200);
  handleUpdate(req.body).catch(err => {
    log('ERROR', 'Webhook handler error', { error: err.message });
  });
});

// Admin: list all clients (no passwords)
app.get('/admin/clients', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  getAllClients()
    .then(clients => res.json({ clients }))
    .catch(err => res.status(500).json({ error: err.message }));
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// System health check
let lastHealthState = true;

async function systemHealthCheck() {
  let dbOk = false;
  let proxyOk = false;

  try {
    await pool.query('SELECT 1');
    dbOk = true;
  } catch (err) {
    log('ERROR', 'Health: DB check failed', { error: err.message });
  }

  try {
    const res = await proxyGet('https://user-backend-api.playexchwin.com/api/maintenance/getMaintenanceStatus');
    proxyOk = res.ok || res.status < 500;
  } catch (err) {
    log('ERROR', 'Health: Proxy check failed', { error: err.message });
  }

  const activePollers = getActivePollerCount();
  const healthy = dbOk && proxyOk;

  setSystemHealthy(healthy);
  log('INFO', 'Health check', { db: dbOk, proxy: proxyOk, activePollers, healthy });

  // Alert on state transitions only
  if (lastHealthState && !healthy) {
    await notifyAdmin(`🔴 <b>System Degraded</b>\nDB: ${dbOk ? 'OK' : 'DOWN'} | Proxy: ${proxyOk ? 'OK' : 'DOWN'} | Pollers: ${activePollers}`);
  } else if (!lastHealthState && healthy) {
    await notifyAdmin(`🟢 <b>System Recovered</b>\nDB: OK | Proxy: OK | Pollers: ${activePollers}`);
  }
  lastHealthState = healthy;
}

// Daily auto-stop at 1:00 AM IST
function scheduleDailyStop() {
  function msUntil1amIST() {
    const now = new Date();
    // 1:00 AM IST = 19:30 UTC (previous day)
    const target = new Date(now);
    target.setUTCHours(19, 30, 0, 0);
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
    return target.getTime() - now.getTime();
  }

  async function runDailyStop() {
    const ids = getActivePollerIds();
    for (const chatId of ids) {
      await triggerAutoStop(chatId, 'daily_1am');
    }
    log('INFO', 'Daily 1am stop complete', { stopped: ids.length });
    setTimeout(runDailyStop, msUntil1amIST());
  }

  const ms = msUntil1amIST();
  setTimeout(runDailyStop, ms);
  log('INFO', 'Daily stop scheduled', { nextStopIn: `${Math.round(ms / 60000)}m`, nextStopAt: new Date(Date.now() + ms).toISOString() });
}

// Global error handlers
process.on('uncaughtException', (err) => {
  log('ERROR', 'Uncaught exception', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  log('ERROR', 'Unhandled rejection', { reason: String(reason) });
});

// Startup
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await initDB();

    const appUrl = process.env.APP_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
    if (appUrl) {
      const webhookUrl = appUrl.startsWith('http') ? appUrl : `https://${appUrl}`;
      await setWebhook(webhookUrl);
    } else {
      log('WARN', 'No APP_URL set, skipping webhook setup');
    }

    startPoller();
    scheduleDailyStop();

    app.listen(PORT, () => {
      log('INFO', 'Server started', { port: PORT, appUrl, botUsername: process.env.BOT_USERNAME });
    });

    // Health check: first at 30s, then every 5 min
    setTimeout(systemHealthCheck, 30_000);
    setInterval(systemHealthCheck, 5 * 60 * 1000);
  } catch (err) {
    log('ERROR', 'Fatal startup error', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

start();
