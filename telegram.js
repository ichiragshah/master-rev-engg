const fetch = require('node-fetch');
const {
  linkRecipientChatId,
  getClientByChatId,
  getClientsByChatId,
  getRecipientsByClientId,
  getLinkedClientCount,
} = require('./db');
const { PLATFORMS } = require('./platforms');

const log = (level, msg, data = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, ctx: 'TG', msg, ...data }));
const timeIST = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true, weekday: 'short', day: '2-digit', month: 'short' });

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const API = () => `https://api.telegram.org/bot${BOT_TOKEN()}`;

async function fetchWithTimeout(promise, ms = 5000) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), ms)
  );
  return Promise.race([promise, timeout]);
}

async function setWebhook(appUrl) {
  const url = `${appUrl}/telegram-webhook`;
  const res = await fetch(`${API()}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, allowed_updates: ['message'] }),
  });
  const json = await res.json();
  log('INFO', 'Webhook set', { url, ok: json.ok, description: json.description });
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
    log('INFO', 'Message sent', { chatId });
  } catch (err) {
    log('ERROR', 'Send failed', { chatId, error: err.message });
  }
}

async function notifyAdmin(message) {
  if (!process.env.ADMIN_CHAT_ID) return;
  await sendMessage(parseInt(process.env.ADMIN_CHAT_ID, 10), message);
}

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

function onboardingMessage() {
  return `<b>Welcome to Winner7 Monitor!</b>

<b>Commands:</b>
/chalu — Start monitoring
/khatam — Stop monitoring
/status — Live exposure + system info
/check — Same as /status
/ping — Check bot response time
/help — Show this message

<b>How it works:</b>
1. Register on the website with your betting username + Telegram handle
2. Send /start here to link your account
3. Send /chalu to begin monitoring
4. You'll get alerts when your exposure changes
5. Send /khatam to stop`;
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const tgUsername = msg.from.username || '';

  log('INFO', 'Webhook received', { updateId: update.update_id, chatId, command: text });

  if (text === '/start') {
    const linked = await linkRecipientChatId(tgUsername, chatId);
    if (linked) {
      log('INFO', 'Command handled', { chatId, command: '/start', username: tgUsername, linked: true });
      await sendMessage(chatId, onboardingMessage());
    } else {
      log('INFO', 'Command handled', { chatId, command: '/start', username: tgUsername, linked: false });
      await sendMessage(chatId,
        `Could not find your account.\n\nPlease register at the website first with your Telegram username: <b>@${tgUsername}</b>\n\nAfter registering, come back and send /start again.`
      );
    }
    return;
  }

  if (text === '/help') {
    await sendMessage(chatId, onboardingMessage());
    return;
  }

  if (text === '/ping') {
    const start = Date.now();
    await sendMessage(chatId, `🏓 Pong! ${Date.now() - start}ms\n🕐 ${timeIST()}`);
    return;
  }

  const client = await getClientByChatId(chatId);
  if (!client) {
    await sendMessage(chatId, 'You are not registered. Please register at the website first, then send /start.');
    return;
  }

  if (text === '/chalu') {
    const { startPolling, initSessionState } = require('./poller');
    startPolling(chatId);
    initSessionState(chatId);

    const clients = await getClientsByChatId(chatId);
    let clientLines = '';
    for (const c of clients) {
      const platformLabel = PLATFORMS[c.platform]?.name || c.platform || 'Winner7';
      clientLines += `\n👤 <b>${c.username}</b> — ${platformLabel}\n   Threshold: ${fmt(c.threshold)} | ${c.book_view || 'Total Book'} | ${c.sports || 'All'}`;
    }

    const response = `✅ <b>Monitoring Started</b>\n${clientLines}\n\n🕐 Started at ${timeIST()}\n⏱ Polling every 60s\n\nSend /khatam to stop.`;
    await sendMessage(chatId, response);

    log('INFO', 'Command handled', { chatId, command: '/chalu', clientCount: clients.length });
    await notifyAdmin(`▶️ Session started: chatId ${chatId} — ${clients.length} client(s) — ${timeIST()}`);
    return;
  }

  if (text === '/khatam') {
    const { stopPolling, getSessionState, resetSessionState } = require('./poller');
    const session = getSessionState(chatId);
    const clients = await getClientsByChatId(chatId);

    let summaryLines = '';
    if (session) {
      const duration = formatDuration(Date.now() - session.startTime);
      summaryLines = `\n⏱ Duration: ${duration}\n📊 Peak Exposure: ${fmt(session.peakExposure)}\n🔔 Alerts Sent: ${session.alertsSent}`;
    }

    let clientLines = '';
    for (const c of clients) {
      const platformLabel = PLATFORMS[c.platform]?.name || c.platform || 'Winner7';
      clientLines += `\n👤 ${c.username} — ${platformLabel}`;
    }

    stopPolling(chatId);
    resetSessionState(chatId);

    const response = `⏹ <b>Monitoring Stopped</b>${clientLines}${summaryLines}\n\n🕐 Ended at ${timeIST()}\nSend /chalu to restart.`;
    await sendMessage(chatId, response);

    log('INFO', 'Command handled', { chatId, command: '/khatam', clientCount: clients.length, alertsSent: session?.alertsSent });
    await notifyAdmin(`⏹ Session ended: chatId ${chatId} — ${clients.length} client(s) — duration ${session ? formatDuration(Date.now() - session.startTime) : 'n/a'} — alerts ${session?.alertsSent || 0}`);
    return;
  }

  if (text === '/status' || text === '/check') {
    const { fetchClientExposure, isPollingActive, getLastPollTime, clientKey, isSystemHealthy, getLastExposure } = require('./poller');
    const clients = await getClientsByChatId(chatId);

    if (clients.length === 0) {
      await sendMessage(chatId, 'No active clients linked to your account.');
      return;
    }

    const polling = isPollingActive(chatId);
    const healthy = isSystemHealthy();

    // Parallel fetch all clients with 5s timeout
    const results = await Promise.allSettled(
      clients.map(c => fetchWithTimeout(fetchClientExposure(c)))
    );

    let lines = '';
    for (let i = 0; i < clients.length; i++) {
      const c = clients[i];
      const platformLabel = PLATFORMS[c.platform]?.name || c.platform || 'Winner7';
      const key = clientKey(c);
      const lastPoll = getLastPollTime(key);
      const lastPollStr = lastPoll ? `${Math.round((Date.now() - lastPoll) / 1000)}s ago` : 'never';
      const recipients = await getRecipientsByClientId(c.id);
      const recipientStr = recipients.map(r => `@${r.telegram_username}`).join(', ');

      const r = results[i];
      let exposureLine;
      if (r.status === 'fulfilled' && r.value.success) {
        exposureLine = `💰 Exposure: <b>${fmt(r.value.totalExposure)}</b>`;
      } else {
        const cached = getLastExposure(key);
        if (cached !== null) {
          exposureLine = `💰 Exposure: <b>${fmt(cached)}</b> <i>(cached)</i>`;
        } else {
          exposureLine = `💰 Exposure: <i>unavailable</i>`;
        }
      }

      lines += `📊 <b>Status</b>  •  ${c.username}  •  ${platformLabel}\n`;
      lines += `━━━━━━━━━━━━━━━━━━━━\n`;
      lines += `${exposureLine}\n`;
      lines += `📈 Last poll: ${lastPollStr}\n`;
      lines += `🔄 Polling: ${polling ? 'Active' : 'Inactive'}\n`;
      lines += `━━━━━━━━━━━━━━━━━━━━\n`;
      lines += `⚙️ Threshold: ${fmt(c.threshold)}\n`;
      lines += `📊 Book: ${c.book_view || 'Total Book'}  •  ${c.sports || 'All'}\n`;
      lines += `🔔 Alerts: ${c.alert_type || 'exposure_only'}\n`;
      lines += `👥 Recipients: ${recipientStr || 'none'}\n`;

      if (i < clients.length - 1) lines += '\n';
    }

    lines += `\n🖥 System: ${healthy ? '✅ Healthy' : '⚠️ Degraded'}`;
    lines += `\n🕐 ${timeIST()}`;

    await sendMessage(chatId, lines);
    log('INFO', 'Command handled', { chatId, command: text, clientCount: clients.length });
    return;
  }

  await sendMessage(chatId, 'Unknown command.\n\n/chalu — Start monitoring\n/khatam — Stop monitoring\n/status — Live exposure\n/ping — Check response time\n/help — All commands');
}

function exposureAlert(client, totalExposure, prevExposure, markets) {
  const diff = prevExposure != null ? totalExposure - prevExposure : null;
  const changeStr = diff != null
    ? `📈 Change          <b>${diff >= 0 ? '+' : ''}${fmt(diff)}</b>\n`
    : '';

  const alertType = client.alert_type || 'exposure_only';
  let marketLines = '';

  // Include market breakdown based on alert_type
  if (alertType !== 'exposure_only' && markets && markets.length > 0) {
    const maxMarkets = alertType === 'all' ? markets.length : 3;
    markets.slice(0, maxMarkets).forEach(m => {
      if (m.runners.length === 0) {
        const icon = m.netExposure >= 0 ? '🔴' : '✅';
        marketLines += `\n🏏 <b>${m.eventName}</b>  •  ${m.marketName}  •  ${fmt(m.netExposure)} ${icon}\n`;
      } else {
        marketLines += `\n🏏 <b>${m.eventName}</b>  •  ${m.marketName}\n`;
        m.runners.forEach(r => {
          const icon = r.exposure >= 0 ? '✅' : '🔴';
          const sign = r.exposure >= 0 ? '+' : '-';
          marketLines += `   ${r.name.padEnd(20)} ${sign}${fmt(r.exposure)}  ${icon}\n`;
        });
      }
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
🕐 ${timeIST()}`;
}

module.exports = { setWebhook, sendMessage, handleUpdate, exposureAlert, notifyAdmin };
