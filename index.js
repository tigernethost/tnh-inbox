const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const DISCORD = 'https://discord.com/api/webhooks/1480032171145171046/unwQrsbszoZC9l35RHfkBrK0B5YDBPihQtxV0aUdCorHyajvxMsBmyalkQeKptUI1c4X';
const WHMCS_URL = 'https://tigernethost.com/portal/includes/api.php';
const MGR_URL = 'http://accounting-corpo.tigernethost.com:8080/api2/VElHRVJORVRIT1NUIDIwMjU';

const whmcs = async (params) => {
  const body = new URLSearchParams({
    identifier: '8DpVTMuD6wrBPsvjPsDiBRT1ESts76x0',
    secret: 'kJfGJEIElY8zjsd0sGRWut0TZdVUJNUy',
    accesskey: 'TNHClaudeAI2026',
    responsetype: 'json',
    ...params
  });
  const { data } = await axios.post(WHMCS_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  return data;
};

async function sendMorningBriefing() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-PH', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Asia/Manila'
  });
  const timeStr = now.toLocaleTimeString('en-PH', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Manila'
  });

  console.log(`[${timeStr}] Sending morning briefing...`);

  try {
    // WHMCS unpaid invoices
    const inv = await whmcs({ action: 'GetInvoices', status: 'Unpaid', limitnum: '200' });
    const allInv = inv?.invoices?.invoice || [];
    const overdue = allInv.filter(i => new Date(i.duedate) < now).slice(0, 5);
    const soon = allInv.filter(i => {
      const d = new Date(i.duedate);
      return d >= now && d <= new Date(now.getTime() + 30 * 86400000);
    }).slice(0, 5);

    // Manager.io invoices + quotes
    let mgrUnpaid = [], mgrTotal = 0, mgrQuotes = [];
    try {
      const mr = await axios.get(`${MGR_URL}/index?model=SalesInvoice`, { timeout: 8000 });
      mgrUnpaid = (mr.data || []).filter(i => !i.Void && i.AmountDue > 0);
      mgrTotal = mgrUnpaid.reduce((s, i) => s + (i.AmountDue || 0), 0);
      const qr = await axios.get(`${MGR_URL}/index?model=SalesQuote`, { timeout: 8000 });
      mgrQuotes = (qr.data || []).filter(q => q.Status !== 'Converted' && q.Status !== 'Declined');
    } catch (e) {
      console.log('Manager.io unavailable:', e.message);
    }

    const fields = [
      {
        name: '📊 WHMCS',
        value: `Unpaid: **${allInv.length}**\nDue in 30 days: **${soon.length}**`,
        inline: true
      },
      {
        name: '🧾 Manager.io',
        value: `Invoices: **${mgrUnpaid.length}**\nTotal: **₱${mgrTotal.toLocaleString('en-PH')}**`,
        inline: true
      }
    ];

    if (mgrQuotes.length > 0) {
      fields.push({
        name: '📋 Pending Quotes',
        value: `**${mgrQuotes.length}** quotes awaiting approval`,
        inline: true
      });
    }
    if (overdue.length > 0) {
      fields.push({
        name: '⚠️ Overdue Invoices',
        value: overdue.map(i =>
          `• #${i.id} — ${i.currencyprefix || '₱'}${parseFloat(i.total).toFixed(2)} (Due: ${i.duedate})`
        ).join('\n'),
        inline: false
      });
    }
    if (soon.length > 0) {
      fields.push({
        name: '📅 Due in 30 Days',
        value: soon.map(i =>
          `• #${i.id} — ${i.currencyprefix || '₱'}${parseFloat(i.total).toFixed(2)} (Due: ${i.duedate})`
        ).join('\n'),
        inline: false
      });
    }

    await axios.post(DISCORD, {
      username: 'Claude AI — TNH Morning Briefing',
      embeds: [{
        title: `☀️ Good Morning, Macky! — ${dateStr}`,
        description: 'Daily automated business briefing for **Tigernethost OPC**.',
        color: 0xf7c948,
        fields,
        footer: { text: `inbox.tigernethost.com · ${timeStr} PHT · Node ${process.version}` }
      }]
    });

    console.log(`✅ Briefing sent at ${timeStr}`);
    return { success: true, whmcsUnpaid: allInv.length, mgrTotal, overdueCount: overdue.length };
  } catch (err) {
    console.error('❌ Briefing error:', err.message);
    return { success: false, error: err.message };
  }
}

// ⏰ Every day at 7:00 AM Philippine Time
cron.schedule('0 7 * * *', () => {
  console.log('⏰ Scheduled morning briefing triggered');
  sendMorningBriefing();
}, { timezone: 'Asia/Manila' });

// Routes
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'inbox.tigernethost.com',
    nodeVersion: process.version,
    time: new Date().toISOString(),
    nextBriefing: '7:00 AM PHT daily'
  });
});

app.get('/briefing/send', async (req, res) => {
  const result = await sendMorningBriefing();
  res.json(result);
});

// Telegram bot handler
const TELEGRAM_TOKEN = '8225869241:AAFeO_a1nRFs4rTo_U4kTyjQasT9q8_Lv08';

const sendTelegram = async (chatId, text) => {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown'
  });
};

app.post('/webhook/telegram', async (req, res) => {
  res.json({ ok: true }); // Always respond immediately to Telegram
  try {
    const update = req.body;
    const msg = update.message;
    if (!msg) return;

    const chatId = msg.chat.id;
    const chatType = msg.chat.type; // 'private', 'group', 'supergroup', 'channel'
    const chatTitle = msg.chat.title || 'Direct Message';
    const from = msg.from?.first_name || 'Unknown';
    const username = msg.from?.username ? `@${msg.from.username}` : '';
    const text = msg.text || '';
    const time = new Date().toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' });

    const isGroup = chatType === 'group' || chatType === 'supergroup';
    const isPrivate = chatType === 'private';

    // In groups, only respond when tagged @TigerAIAssist_bot or on /commands
    const botMentioned = text.includes('@TigerAIAssist_bot');
    const isCommand = text.startsWith('/');
    const cleanText = text.replace('@TigerAIAssist_bot', '').trim();

    console.log(`[Telegram][${chatType}] ${from} ${username} in "${chatTitle}": ${text}`);

    // Always forward ALL messages to Discord
    await axios.post(DISCORD, {
      username: 'TigerAI — Telegram',
      embeds: [{
        title: isGroup ? `💬 Group Message — ${chatTitle}` : `📨 Direct Message`,
        description: text || '[non-text message]',
        color: isGroup ? 0x22c55e : 0x229ED9,
        fields: [
          { name: 'From', value: `${from} ${username}`, inline: true },
          { name: 'Chat', value: isGroup ? chatTitle : 'Private', inline: true },
          { name: 'Time', value: `${time} PHT`, inline: true }
        ],
        footer: { text: `@TigerAIAssist_bot · Chat ID: ${chatId}` }
      }]
    }).catch(e => console.log('Discord forward error:', e.message));

    // In groups: only reply if tagged or it's a command
    if (isGroup && !botMentioned && !isCommand) return;

    // Determine what to reply to
    const replyText = isGroup ? cleanText : text;
    const lower = replyText.toLowerCase();

    // Build reply
    let reply = '';
    if (lower === '/start' || lower === 'hi' || lower === 'hello' || lower === '') {
      reply = isGroup
        ? `👋 Hello! I'm *TigerAI*, the assistant bot of *Tigernethost OPC*.\n\nTag me anytime with @TigerAIAssist_bot to get help!\n\n• Cloud Hosting\n• Domain Registration\n• IT Consulting\n• Software Development`
        : `👋 Hello ${from}! Welcome to *Tigernethost OPC*.\n\nHow can we help you today?\n\n• Cloud Hosting\n• Domain Registration\n• IT Consulting\n• Software Development\n\nType your inquiry and our team will get back to you shortly.`;
    } else if (lower.includes('price') || lower.includes('cost') || lower.includes('quote')) {
      reply = `💰 Thank you for your interest!\n\nPlease visit our website for pricing:\n🌐 https://tigernethost.com\n\nOr send us your requirements and we'll prepare a custom quote for you.`;
    } else if (lower.includes('support') || lower.includes('help') || lower.includes('issue') || lower.includes('problem')) {
      reply = `🛠️ *Support Request Received*\n\nWe've noted your concern and our team has been notified.\n\nExpected response time: *within 24 hours*\n\nFor urgent concerns:\n📧 support@tigernethost.com`;
    } else if (lower.includes('invoice') || lower.includes('payment') || lower.includes('billing')) {
      reply = `💳 *Billing Inquiry*\n\nThank you, ${from}. Our billing team has been notified and will follow up with you shortly.\n\n📧 billing@tigernethost.com\n🌐 https://tigernethost.com/portal`;
    } else {
      reply = `✅ *Message received!*\n\nThank you, ${from}. Our team at *Tigernethost OPC* has been notified and will respond shortly.\n\n📧 support@tigernethost.com\n🌐 tigernethost.com`;
    }

    await sendTelegram(chatId, reply);

  } catch (err) {
    console.error('[Telegram] Handler error:', err.message);
  }
});

// Webhook receiver for other platforms (Viber, Facebook)
app.post('/webhook/:platform', (req, res) => {
  const { platform } = req.params;
  console.log(`[${platform}] Webhook:`, JSON.stringify(req.body).slice(0, 300));
  res.json({ received: true, platform, timestamp: new Date().toISOString() });
});

app.get('/webhook/:platform', (req, res) => {
  const { platform } = req.params;
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && challenge) {
    console.log(`[${platform}] Webhook verified`);
    return res.send(challenge);
  }
  res.json({ platform, status: 'webhook endpoint ready' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ inbox.tigernethost.com running on port ${PORT}`);
  console.log(`⏰ Morning briefing scheduled: 7:00 AM PHT daily`);
  console.log(`📦 Node.js ${process.version}`);
});
