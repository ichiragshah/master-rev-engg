const fetch = require('node-fetch');
const {
  linkRecipientChatId,
  getClientByChatId,
  getRecipientsByClientId,
  setClientActive,
} = require('./db');
const { PLATFORMS } = require('./platforms');

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
    const linked = await linkRecipientChatId(tgUsername, chatId);
    if (linked) {
      await sendMessage(chatId,
        `Linked! Your Telegram is now connected.\n\nCommands:\n/status - View your config\n/pause - Pause alerts\n/resume - Resume alerts`
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
    const platformLabel = PLATFORMS[client.platform]?.name || client.platform || 'Winner7';
    const recipients = await getRecipientsByClientId(client.id);
    const recipientLines = recipients.map(r => {
      const linked = r.telegram_chat_id ? 'linked' : 'pending /start';
      return `  @${r.telegram_username} (${linked})`;
    }).join('\n');
    await sendMessage(chatId,
      `<b>Your Settings</b>\nPlatform: ${platformLabel}\nUser: ${client.username}\nSports: ${client.sports || 'All'}\nBook View: ${client.book_view || 'Total Book'}\nStatus: ${status}\n\n<b>Alert Recipients:</b>\n${recipientLines}`
    );
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

function fmt(n) {
  return '₹' + Math.abs(Math.round(n)).toLocaleString('en-IN');
}

function exposureAlert(client, totalExposure, prevExposure, markets) {
  const diff = prevExposure != null ? totalExposure - prevExposure : null;
  const changeStr = diff != null
    ? `📈 Change          <b>${diff >= 0 ? '+' : ''}${fmt(diff)}</b>\n`
    : '';

  const timeStr = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', hour12: true,
    weekday: 'short', day: '2-digit', month: 'short',
  });

  let marketLines = '';
  if (markets && markets.length > 0) {
    markets.slice(0, 3).forEach(m => {
      marketLines += `\n🏏 <b>${m.eventName}</b>  •  ${m.marketName}\n`;
      m.runners.forEach(r => {
        const icon = r.exposure >= 0 ? '✅' : '🔴';
        const sign = r.exposure >= 0 ? '+' : '-';
        marketLines += `   ${r.name.padEnd(20)} ${sign}${fmt(r.exposure)}  ${icon}\n`;
      });
    });
    marketLines += '━━━━━━━━━━━━━━━━━━━━';
  }

  const platformLabel = PLATFORMS[client.platform]?.name || client.platform || 'Winner7';

  return `🚨 <b>EXPOSURE ALERT</b>

👤 ${client.username}  •  ${platformLabel}  •  ${client.book_view || 'Total Book'}
━━━━━━━━━━━━━━━━━━━━
💰 Net Exposure    <b>${fmt(totalExposure)}</b>
${changeStr}━━━━━━━━━━━━━━━━━━━━
${marketLines}
🕐 ${timeStr}`;
}

module.exports = { setWebhook, sendMessage, handleUpdate, exposureAlert };
