const express = require('express');
const path = require('path');
const { initDB, registerClient, addRecipients, getAllClients } = require('./db');
const { encrypt } = require('./crypto');
const { setWebhook, handleUpdate } = require('./telegram');
const { startPoller } = require('./poller');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Registration
app.post('/register', async (req, res) => {
  try {
    const { name, username, password, telegram_username, telegram_usernames, threshold, alert_type, sports, book_view, platform } = req.body;

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

    const password_enc = encrypt(password);

    const client = await registerClient({
      name: name || username,
      username,
      password_enc,
      telegram_username: rawUsernames[0],
      threshold: parseInt(threshold, 10) || 50000,
      alert_type: alert_type || 'exposure_only',
      sports: sports || 'All',
      book_view: book_view || 'Total Book',
      platform: selectedPlatform,
    });

    // Store all recipients in alert_recipients table
    await addRecipients(client.id, rawUsernames);

    const botUsername = process.env.BOT_USERNAME || 'your_bot';
    const plural = rawUsernames.length > 1 ? `All ${rawUsernames.length} users need to` : 'Now';
    res.json({
      success: true,
      message: `Registered! ${plural} message @${botUsername} on Telegram and send /start to link.`,
    });
  } catch (err) {
    console.error('[Register] Error:', err.message);
    res.status(500).json({ success: false, message: 'Registration failed. Please try again.' });
  }
});

// Telegram webhook
app.post('/telegram-webhook', (req, res) => {
  res.sendStatus(200);
  handleUpdate(req.body).catch(err => {
    console.error('[Webhook] Error:', err.message);
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
      console.warn('[Startup] No APP_URL set, skipping webhook setup');
    }

    startPoller();

    app.listen(PORT, () => {
      console.log(`[Server] Running on port ${PORT}`);
    });
  } catch (err) {
    console.error('[Startup] Fatal error:', err);
    process.exit(1);
  }
}

start();
