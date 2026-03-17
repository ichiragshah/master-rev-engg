const fetch = require('node-fetch');
const {
  updateClientChatId,
  getClientByChatId,
  updateClientConfig,
  setClientActive,
} = require('./db');

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const API = () => `https://api.telegram.org/bot${BOT_TOKEN()}`;

async function setWebhook(appUrl) {
  const url = `${appUrl}/telegram-webhook`;
  const res = await fetch(`${API()}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, allowed_updates: ['message'] }),
  });
  const json = await res.json();
  console.log(`[Telegram] Webhook set: ${json.ok ? url : json.description}`);
  return json;
}

async function sendMessage(chatId, text) {
  try {
    await fetch(`${API()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      }),
    });
  } catch (err) {
    console.error(`[Telegram] Send failed to ${chatId}:`, err.message);
  }
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const tgUsername = msg.from.username || '';

  if (text === '/start') {
    const linked = await updateClientChatId(tgUsername, chatId);
    if (linked) {
      await sendMessage(chatId,
        `Linked! Your Telegram is now connected.\n\nCommands:\n/status - View your config\n/threshold <amount> - Set alert threshold\n/alerts exposure|markets|all - Alert type\n/sports all|cricket|tennis|soccer - Sports filter\n/book total|mypt - Book view\n/pause - Pause alerts\n/resume - Resume alerts`
      );
    } else {
      await sendMessage(chatId,
        `Could not find your account. Please register at the website first with your Telegram username: <b>${tgUsername}</b>`
      );
    }
    return;
  }

  const client = await getClientByChatId(chatId);
  if (!client) {
    await sendMessage(chatId, 'You are not registered. Please register at the website first, then send /start.');
    return;
  }

  if (text === '/status') {
    const status = client.active ? 'Active' : 'Paused';
    const alertLabels = {
      'exposure_only': 'Net Exposure Only',
      'exposure_and_markets': 'Exposure + Markets',
      'all': 'Everything',
    };
    await sendMessage(chatId,
      `<b>Your Settings</b>\nUser: ${client.username}\nThreshold: Rs ${client.threshold.toLocaleString('en-IN')}\nAlerts: ${alertLabels[client.alert_type] || client.alert_type}\nSports: ${client.sports || 'All'}\nBook View: ${client.book_view || 'Total Book'}\nStatus: ${status}`
    );
    return;
  }

  if (text.startsWith('/threshold')) {
    const parts = text.split(/\s+/);
    const amount = parseInt(parts[1], 10);
    if (isNaN(amount) || amount < 0) {
      await sendMessage(chatId, 'Usage: /threshold <amount>\nMinimum: 0');
      return;
    }
    await updateClientConfig(chatId, 'threshold', amount);
    await sendMessage(chatId, `Threshold updated to Rs ${amount.toLocaleString('en-IN')}`);
    return;
  }

  if (text.startsWith('/alerts')) {
    const parts = text.split(/\s+/);
    const type = parts[1];
    const typeMap = {
      'exposure': 'exposure_only',
      'markets': 'exposure_and_markets',
      'all': 'all',
    };
    if (!type || !typeMap[type]) {
      await sendMessage(chatId, 'Usage:\n/alerts exposure\n/alerts markets\n/alerts all');
      return;
    }
    await updateClientConfig(chatId, 'alert_type', typeMap[type]);
    await sendMessage(chatId, `Alert type set to: <b>${typeMap[type]}</b>`);
    return;
  }

  if (text.startsWith('/sports')) {
    const parts = text.split(/\s+/);
    const sport = (parts[1] || '').toLowerCase();
    const sportsMap = {
      'all': 'All',
      'cricket': 'Cricket',
      'tennis': 'Tennis',
      'soccer': 'Soccer',
    };
    if (!sport || !sportsMap[sport]) {
      await sendMessage(chatId, 'Usage:\n/sports all\n/sports cricket\n/sports tennis\n/sports soccer');
      return;
    }
    await updateClientConfig(chatId, 'sports', sportsMap[sport]);
    await sendMessage(chatId, `Sports filter set to: <b>${sportsMap[sport]}</b>`);
    return;
  }

  if (text.startsWith('/book')) {
    const parts = text.split(/\s+/);
    const view = (parts[1] || '').toLowerCase();
    const bookMap = {
      'total': 'Total Book',
      'mypt': 'My PT',
    };
    if (!view || !bookMap[view]) {
      await sendMessage(chatId, 'Usage:\n/book total - Total Book\n/book mypt - My PT');
      return;
    }
    await updateClientConfig(chatId, 'book_view', bookMap[view]);
    await sendMessage(chatId, `Book view set to: <b>${bookMap[view]}</b>`);
    return;
  }

  if (text === '/pause') {
    await setClientActive(chatId, false);
    await sendMessage(chatId, 'Alerts paused. Send /resume to restart.');
    return;
  }

  if (text === '/resume') {
    await setClientActive(chatId, true);
    await sendMessage(chatId, 'Alerts resumed!');
    return;
  }

  await sendMessage(chatId, 'Unknown command. Send /status for help.');
}

module.exports = { setWebhook, sendMessage, handleUpdate };
