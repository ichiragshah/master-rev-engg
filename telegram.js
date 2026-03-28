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
    body: JSON.stringify({ url, allowed_updates: ['message', 'callback_query'] }),
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

async function sendMessageWithButtons(chatId, text, buttons) {
  try {
    await fetch(`${API()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      }),
    });
  } catch (err) {
    log('ERROR', 'Send with buttons failed', { chatId, error: err.message });
  }
}

async function answerCallbackQuery(callbackQueryId, text) {
  try {
    await fetch(`${API()}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch (err) {
    log('ERROR', 'Answer callback failed', { error: err.message });
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

function clientLabel(c) {
  const parts = [c.username];
  const meta = [c.upline, c.currency_type].filter(Boolean);
  if (meta.length > 0) parts.push(`(${meta.join(' - ')})`);
  return parts.join(' ');
}

function onboardingMessage() {
  return `<b>Welcome to Winner7 Monitor!</b>

<b>Commands:</b>
/chalu — Start monitoring
/khatam — Stop monitoring
/status — Live exposure + system info
/check — Same as /status
/credit — Client credit report
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
  // Handle callback queries (inline button presses)
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const data = cb.data || '';

    log('INFO', 'Callback received', { updateId: update.update_id, chatId, data });

    if (data.startsWith('credit:')) {
      const clientId = parseInt(data.split(':')[1], 10);
      await answerCallbackQuery(cb.id, 'Fetching...');
      await handleCreditFetch(chatId, clientId);
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim().replace(/@\w+/i, '');
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
      clientLines += `\n👤 <b>${clientLabel(c)}</b> — ${platformLabel}\n   Threshold: ${fmt(c.threshold)} | ${c.book_view || 'Total Book'} | ${c.sports || 'All'}`;
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
      clientLines += `\n👤 ${clientLabel(c)} — ${platformLabel}`;
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

      lines += `📊 <b>Status</b>  •  ${clientLabel(c)}  •  ${platformLabel}\n`;
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

  if (text === '/credit') {
    const clients = await getClientsByChatId(chatId);
    const supportedClients = clients.filter(c => {
      const p = PLATFORMS[c.platform || 'winner7'];
      return p && p.memberDataUrl;
    });

    if (supportedClients.length === 0) {
      await sendMessage(chatId, 'No accounts with credit report support linked.');
      return;
    }

    if (supportedClients.length === 1) {
      await handleCreditFetch(chatId, supportedClients[0].id);
    } else {
      const buttons = supportedClients.map(c => {
        const label = PLATFORMS[c.platform || 'winner7']?.name || c.platform;
        return [{ text: `${clientLabel(c)} (${label})`, callback_data: `credit:${c.id}` }];
      });
      await sendMessageWithButtons(chatId, 'Select a master account:', buttons);
    }

    log('INFO', 'Command handled', { chatId, command: '/credit', clientCount: winner7Clients.length });
    return;
  }

  await sendMessage(chatId, 'Unknown command.\n\n/chalu \u2014 Start monitoring\n/khatam \u2014 Stop monitoring\n/status \u2014 Live exposure\n/credit \u2014 Client credit report\n/ping \u2014 Check response time\n/help \u2014 All commands');
}

function formatClientReport(username, platform, clients, time, date, fmtNum) {
  let totalAvail = 0;
  let totalPnl = 0;
  let playerLines = '';

  for (let i = 0; i < clients.length; i++) {
    const m = clients[i];
    const pl = -m.winnings;
    totalAvail += m.availableCredit;
    totalPnl += pl;

    const plStr = pl === 0 ? '0' : (pl > 0 ? `+${fmtNum(pl)}` : `-${fmtNum(pl)}`);
    const plIcon = pl < 0 ? ' 🔴' : '';

    playerLines += `<b>${m.username}</b>\n`;
    playerLines += `💳 ${fmtNum(m.creditLimit)}  •  ✅ ${fmtNum(m.availableCredit)}  •  P&L: ${plStr}${plIcon}\n`;
    if (i < clients.length - 1) playerLines += '\n';
  }

  const totalPlStr = totalPnl === 0 ? '0' : (totalPnl > 0 ? `+${fmtNum(totalPnl)}` : `-${fmtNum(totalPnl)}`);
  const totalPlIcon = totalPnl < 0 ? ' 🔴' : '';

  return `👥 <b>${username}</b>  •  ${platform}  •  ${time}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    playerLines +
    `\n━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 Avail: ${fmtNum(totalAvail)}  •  P&L: ${totalPlStr}${totalPlIcon}\n` +
    `👥 ${clients.length} players  •  ${date}`;
}

async function handleCreditFetch(chatId, clientId) {
  const { pool } = require('./db');
  const { ensureToken } = require('./auth');
  const { proxyPost, proxyGet } = require('./proxy-fetch');

  const { rows } = await pool.query('SELECT * FROM clients WHERE id = $1', [clientId]);
  const c = rows[0];
  if (!c) {
    await sendMessage(chatId, 'Client not found.');
    return;
  }

  const platformName = c.platform || 'winner7';
  const platform = PLATFORMS[platformName];
  if (!platform.memberDataUrl) {
    await sendMessage(chatId, `Credit report not supported for ${platform.name || platformName}.`);
    return;
  }

  try {
    const { token } = await ensureToken(c);

    const url = typeof platform.memberDataUrl === 'function'
      ? platform.memberDataUrl(c)
      : platform.memberDataUrl;

    let res;
    if (platform.memberDataMethod === 'GET') {
      const headers = { ...platform.authHeader(token) };
      if (platform.memberDataExtraHeaders) Object.assign(headers, platform.memberDataExtraHeaders(c));
      res = await proxyGet(url, headers, platformName);
    } else {
      res = await proxyPost(url, platform.memberDataBody(c, token), platform.authHeader(token), platformName);
    }
    const json = res.json();
    const members = platform.parseMemberData(json);

    if (members.length === 0) {
      await sendMessage(chatId, `📊 <b>${clientLabel(c)}</b> — No players found`);
      return;
    }

    const now = new Date();
    const time = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }).toLowerCase();
    const date = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short' });
    const platformLabel = platform.name || c.platform || 'Winner7';
    const fmtNum = n => Math.abs(Math.round(n)).toLocaleString('en-IN');

    const msg = formatClientReport(clientLabel(c), platformLabel, members, time, date, fmtNum);

    await sendMessage(chatId, msg);
    log('INFO', 'Credit fetched', { chatId, username: c.username, playerCount: members.length });
  } catch (err) {
    await sendMessage(chatId, `📊 <b>${clientLabel(c)}</b> — Error: ${err.message}`);
    log('ERROR', 'Credit fetch failed', { chatId, username: c.username, error: err.message });
  }
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

👤 ${clientLabel(client)}  •  ${platformLabel}  •  ${client.book_view || 'Total Book'}
━━━━━━━━━━━━━━━━━━━━
💰 Net Exposure    <b>${fmt(totalExposure)}</b>
${changeStr}━━━━━━━━━━━━━━━━━━━━
${marketLines}
🕐 ${timeIST()}`;
}

module.exports = { setWebhook, sendMessage, handleUpdate, exposureAlert, notifyAdmin };
