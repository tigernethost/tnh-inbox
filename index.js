const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const cors = require('cors');
const Database = require('better-sqlite3');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json());

// ── Constants ────────────────────────────────────────────────────────────────
const DISCORD = 'https://discord.com/api/webhooks/1480032171145171046/unwQrsbszoZC9l35RHfkBrK0B5YDBPihQtxV0aUdCorHyajvxMsBmyalkQeKptUI1c4X';
const WHMCS_URL = 'https://tigernethost.com/portal/includes/api.php';
const MGR_URL = 'http://accounting-corpo.tigernethost.com:8080/api2/VElHRVJORVRIT1NUIDIwMjU';
const TELEGRAM_TOKEN = '8225869241:AAFeO_a1nRFs4rTo_U4kTyjQasT9q8_Lv08';
const BOT_USERNAME = 'TigerAIAssist_bot';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── SQLite ───────────────────────────────────────────────────────────────────
const db = new Database('/tmp/tnh_inbox.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS group_links (
    chat_id TEXT PRIMARY KEY,
    chat_title TEXT,
    email TEXT,
    whmcs_client_id TEXT,
    client_name TEXT,
    linked_by TEXT,
    linked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS pending_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    action_type TEXT,
    action_data TEXT,
    requested_by TEXT,
    status TEXT DEFAULT 'awaiting_confirmation',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS message_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    chat_title TEXT,
    from_name TEXT,
    from_username TEXT,
    message TEXT,
    direction TEXT DEFAULT 'inbound',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS agent_handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    client_name TEXT,
    reason TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS conversation_state (
    chat_id TEXT PRIMARY KEY,
    mode TEXT DEFAULT 'ai',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Helpers ──────────────────────────────────────────────────────────────────
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

const sendTelegram = async (chatId, text, extra = {}) => {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: chatId, text, parse_mode: 'Markdown', ...extra
  }).catch(e => console.error('Telegram send error:', e.message));
};

const notifyDiscord = async (embed) => {
  await axios.post(DISCORD, { username: 'TigerAI — Telegram', embeds: [embed] })
    .catch(e => console.log('Discord error:', e.message));
};

const saveMessage = (chatId, chatTitle, fromName, fromUsername, message, direction = 'inbound') => {
  db.prepare(`INSERT INTO message_history (chat_id, chat_title, from_name, from_username, message, direction)
    VALUES (?, ?, ?, ?, ?, ?)`).run(String(chatId), chatTitle, fromName, fromUsername, message, direction);
};

const getGroupLink = (chatId) => db.prepare('SELECT * FROM group_links WHERE chat_id = ?').get(String(chatId));
const getChatMode = (chatId) => db.prepare('SELECT mode FROM conversation_state WHERE chat_id = ?').get(String(chatId))?.mode || 'ai';
const setChatMode = (chatId, mode) => db.prepare('INSERT OR REPLACE INTO conversation_state (chat_id, mode, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(String(chatId), mode);
const getPHTime = () => new Date().toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' });

// ── Fetch client context for AI ───────────────────────────────────────────
async function getClientContext(clientId) {
  try {
    const [invData, domData] = await Promise.allSettled([
      whmcs({ action: 'GetInvoices', userid: clientId, status: 'Unpaid', limitnum: '5' }),
      whmcs({ action: 'GetClientsDomains', clientid: clientId, limitnum: '10' }),
    ]);

    const invoices = invData.value?.invoices?.invoice || [];
    const domains = domData.value?.domains?.domain || [];

    let context = '';
    if (invoices.length > 0) {
      context += `UNPAID INVOICES:\n` + invoices.map(i =>
        `- Invoice #${i.id}: ${i.currencyprefix || '₱'}${parseFloat(i.total).toFixed(2)}, Due: ${i.duedate}`
      ).join('\n') + '\n\n';
    } else {
      context += `UNPAID INVOICES: None\n\n`;
    }

    if (domains.length > 0) {
      context += `ACTIVE DOMAINS:\n` + domains.map(d =>
        `- ${d.domainname} (expires: ${d.expirydate}, status: ${d.status})`
      ).join('\n');
    } else {
      context += `ACTIVE DOMAINS: None on record`;
    }

    return context;
  } catch (e) {
    return 'Unable to fetch client data at this time.';
  }
}

// ── Get recent conversation history for AI context ───────────────────────
function getRecentHistory(chatId, limit = 10) {
  return db.prepare(`
    SELECT from_name, message, direction, created_at
    FROM message_history WHERE chat_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(String(chatId), limit).reverse();
}

// ── Detect if client wants a human agent ─────────────────────────────────
function wantsHumanAgent(text) {
  const triggers = [
    'agent', 'human', 'person', 'representative', 'rep', 'staff',
    'support team', 'real person', 'talk to someone', 'speak to someone',
    'i need help', 'this is wrong', 'frustrated', 'not helpful',
    'useless', 'escalate', 'manager', 'supervisor',
    'tao', 'tawo', 'makipag-usap', 'hindi kaya', 'di kaya'
  ];
  const lower = text.toLowerCase();
  return triggers.some(t => lower.includes(t));
}

// ── Detect if client is confirming a pending action ──────────────────────
function isConfirmation(text) {
  const lower = text.toLowerCase().trim();
  const yes = ['yes', 'yes.', 'confirm', 'proceed', 'go ahead', 'oo', 'sige', 'sure', 'ok', 'okay'];
  const no = ['no', 'no.', 'cancel', 'stop', 'huwag', 'hindi', 'nope'];
  if (yes.some(w => lower === w)) return 'yes';
  if (no.some(w => lower === w)) return 'no';
  return null;
}

// ── Handle pending action confirmation ───────────────────────────────────
async function handleConfirmation(chatId, clientName, confirmed) {
  const action = db.prepare(`SELECT * FROM pending_actions WHERE chat_id = ? AND status = 'awaiting_confirmation'
    ORDER BY created_at DESC LIMIT 1`).get(String(chatId));
  if (!action) return null; // No pending action, let AI handle it

  if (!confirmed) {
    db.prepare(`UPDATE pending_actions SET status = 'cancelled' WHERE id = ?`).run(action.id);
    return `No problem! Your request has been cancelled. No changes were made. Is there anything else I can help you with?`;
  }

  const actionData = JSON.parse(action.action_data);
  db.prepare(`UPDATE pending_actions SET status = 'confirmed' WHERE id = ?`).run(action.id);

  if (action.action_type === 'domain_purchase') {
    await notifyDiscord({
      title: `✅ Domain Purchase CONFIRMED — Please Process`, color: 0x22c55e,
      description: `**${clientName}** confirmed domain registration.`,
      fields: [{ name: 'Domain', value: actionData.domainName, inline: true }, { name: 'Action ID', value: `#${action.id}`, inline: true }],
      footer: { text: `Confirmed · ${getPHTime()} PHT` }
    });
    return `Your domain registration request for *${actionData.domainName}* has been submitted! 🎉\n\nOur team will contact you shortly with pricing and next steps. Thank you!`;
  }

  if (action.action_type === 'remove_invoice_item') {
    await notifyDiscord({
      title: `✅ Invoice Item Removal CONFIRMED`, color: 0x22c55e,
      description: `**${clientName}** confirmed. Macky, please process in WHMCS.`,
      fields: [
        { name: 'Invoice', value: `#${actionData.invoiceId}`, inline: true },
        { name: 'Item', value: actionData.itemDesc, inline: true },
        { name: 'Amount', value: `₱${actionData.amount}`, inline: true }
      ],
      footer: { text: `Confirmed · ${getPHTime()} PHT` }
    });
    return `Got it! Your request to remove *${actionData.itemDesc}* from Invoice #${actionData.invoiceId} has been submitted. Our billing team will update your invoice shortly.`;
  }

  return `Your request has been confirmed and submitted to our team!`;
}

// ── AI Response Engine ────────────────────────────────────────────────────
async function getAIResponse(chatId, userMessage, clientName, clientContext, history) {
  // Build conversation history for Claude
  const messages = [];

  // Add recent history
  for (const h of history.slice(-8)) {
    if (h.direction === 'inbound') {
      messages.push({ role: 'user', content: h.message });
    } else if (h.direction === 'outbound' && h.from_name === 'TigerAI Bot') {
      messages.push({ role: 'assistant', content: h.message });
    }
  }

  // Add current message
  messages.push({ role: 'user', content: userMessage });

  const systemPrompt = `You are a friendly and professional customer support agent for Tigernethost OPC, an IT services company in the Philippines specializing in cloud hosting, domain registration, IT consulting, and software development.

You are chatting with: ${clientName}

THEIR ACCOUNT DATA:
${clientContext}

YOUR PERSONALITY:
- Warm, helpful, and professional — like a real human support agent
- Use natural conversational language, not robotic responses
- You can use light Filipino phrases (po, salamat, etc.) naturally if appropriate
- Keep responses concise and clear
- Never say you are an AI or a bot — act like a human support agent named "Tig" from the Tigernethost team

WHAT YOU CAN HELP WITH:
- Invoice inquiries and balance checks (you have their data above)
- Domain expiry and status checks
- General hosting and IT questions
- Taking requests for domain purchases or invoice changes

FOR DOMAIN PURCHASES: When a client wants to buy a domain, confirm the domain name and then say you need their confirmation to proceed, ask "Would you like to confirm this request? Please reply YES to proceed or NO to cancel."

FOR INVOICE ITEM REMOVAL: When a client wants to remove an item, confirm the invoice number and item, then ask "Would you like to confirm this removal? Please reply YES to proceed or NO to cancel."

FOR THINGS YOU CAN'T RESOLVE: Be honest that you'll need to escalate to the team, but don't reveal you're an AI. Say something like "Let me flag this for our senior team" or "I'll need to check with our technical team on this one."

IMPORTANT: Keep responses SHORT (2-4 sentences max unless listing data). Be human. Be helpful.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: systemPrompt,
      messages
    });
    return response.content[0].text;
  } catch (e) {
    console.error('AI error:', e.message);
    return `Hi ${clientName}! Thanks for reaching out to Tigernethost. Our team has received your message and will get back to you shortly. For urgent concerns, email us at support@tigernethost.com`;
  }
}

// ── Human Handoff ─────────────────────────────────────────────────────────
async function triggerHumanHandoff(chatId, chatTitle, clientName, reason) {
  setChatMode(chatId, 'agent');

  db.prepare(`INSERT INTO agent_handoffs (chat_id, client_name, reason, status)
    VALUES (?, ?, ?, 'pending')`).run(String(chatId), clientName, reason);

  // Alert on Discord with full context
  const recentHistory = getRecentHistory(chatId, 5);
  const historyText = recentHistory.map(h =>
    `${h.direction === 'inbound' ? h.from_name : '🤖 Bot'}: ${h.message.slice(0, 80)}`
  ).join('\n');

  await notifyDiscord({
    title: `🚨 AGENT NEEDED — ${clientName}`,
    description: `A client is requesting to speak with a human agent.`,
    color: 0xff4444,
    fields: [
      { name: '👤 Client', value: clientName, inline: true },
      { name: '💬 Chat', value: chatTitle, inline: true },
      { name: '🕐 Time', value: `${getPHTime()} PHT`, inline: true },
      { name: '📝 Reason', value: reason, inline: false },
      { name: '📜 Recent Conversation', value: `\`\`\`\n${historyText || 'No history'}\n\`\`\``, inline: false },
    ],
    footer: { text: `Chat ID: ${chatId} · Agent mode ON — bot is paused` }
  });

  return `Of course! I'll connect you with one of our team members right away. Please hold on for a moment — someone from our team will be with you shortly. 😊\n\n_(Our team has been notified and will respond as soon as possible.)_`;
}

// ── Main Message Handler ──────────────────────────────────────────────────
async function handleClientMessage(chatId, chatTitle, text, from, username, link) {
  const clientName = link.client_name;
  const mode = getChatMode(chatId);

  // If in agent mode, just forward to Discord silently
  if (mode === 'agent') {
    await notifyDiscord({
      title: `💬 ${chatTitle} (Agent Mode)`,
      description: text, color: 0xff9800,
      fields: [
        { name: 'From', value: `${from} ${username}`, inline: true },
        { name: 'Client', value: clientName, inline: true },
        { name: 'Time', value: `${getPHTime()} PHT`, inline: true }
      ],
      footer: { text: `⚠️ Agent mode — bot is paused · Chat ID: ${chatId}` }
    });
    return null; // Don't send any bot reply
  }

  // Check if wants human agent
  if (wantsHumanAgent(text)) {
    return await triggerHumanHandoff(chatId, chatTitle, clientName, text);
  }

  // Check if confirming a pending action
  const confirmation = isConfirmation(text);
  if (confirmation) {
    const confirmResult = await handleConfirmation(chatId, clientName, confirmation === 'yes');
    if (confirmResult) return confirmResult;
    // No pending action — fall through to AI
  }

  // Get client context and history for AI
  const [clientContext, history] = await Promise.all([
    getClientContext(link.whmcs_client_id),
    Promise.resolve(getRecentHistory(chatId, 10))
  ]);

  // Get AI response
  const aiReply = await getAIResponse(chatId, text, clientName, clientContext, history);

  // Check if AI response contains a domain purchase or item removal request pattern
  // Save as pending action if needed
  const lowerText = text.toLowerCase();
  if ((lowerText.includes('buy') || lowerText.includes('register') || lowerText.includes('purchase')) && lowerText.includes('domain')) {
    const domainMatch = text.match(/[\w-]+\.(com|net|org|ph|co\.ph|com\.ph|info|biz|online|site|app)/i);
    if (domainMatch) {
      const actionData = JSON.stringify({ domainName: domainMatch[0] });
      db.prepare(`INSERT INTO pending_actions (chat_id, action_type, action_data, requested_by, status)
        VALUES (?, 'domain_purchase', ?, ?, 'awaiting_confirmation')`).run(String(chatId), actionData, clientName);
    }
  }

  if ((lowerText.includes('remove') || lowerText.includes('delete')) && lowerText.includes('invoice')) {
    const invoiceMatch = text.match(/#?(\d+)/);
    if (invoiceMatch) {
      const itemDesc = text.replace(/remove|delete|from|invoice|#?\d+/gi, '').trim();
      const invData = await whmcs({ action: 'GetInvoice', invoiceid: invoiceMatch[1] }).catch(() => null);
      const items = invData?.invoice?.items?.item || [];
      const item = itemDesc ? items.find(i => i.description?.toLowerCase().includes(itemDesc.toLowerCase())) : items[0];
      if (item) {
        const actionData = JSON.stringify({ invoiceId: invoiceMatch[1], itemId: item.id, itemDesc: item.description, amount: item.amount });
        db.prepare(`INSERT INTO pending_actions (chat_id, action_type, action_data, requested_by, status)
          VALUES (?, 'remove_invoice_item', ?, ?, 'awaiting_confirmation')`).run(String(chatId), actionData, clientName);
      }
    }
  }

  return aiReply;
}

// ── Telegram Webhook ─────────────────────────────────────────────────────────
app.post('/webhook/telegram', async (req, res) => {
  res.json({ ok: true });
  try {
    const msg = req.body.message;
    if (!msg || !msg.text) return;

    const chatId = String(msg.chat.id);
    const chatType = msg.chat.type;
    const chatTitle = msg.chat.title || 'Direct Message';
    const from = msg.from?.first_name || 'Unknown';
    const username = msg.from?.username ? `@${msg.from.username}` : '';
    const isGroup = chatType === 'group' || chatType === 'supergroup';
    const text = msg.text || '';
    const botMentioned = text.includes(`@${BOT_USERNAME}`);
    const isCommand = text.startsWith('/');

    // Groups: silent unless tagged or command
    if (isGroup && !botMentioned && !isCommand) {
      saveMessage(chatId, chatTitle, from, username, text, 'inbound');
      return;
    }

    const cleanText = text.replace(`@${BOT_USERNAME}`, '').trim();
    saveMessage(chatId, chatTitle, from, username, cleanText, 'inbound');

    // ── Admin Commands ─────────────────────────────────────────
    if (cleanText.startsWith('/link ')) {
      const email = cleanText.replace('/link', '').trim();
      if (!email.includes('@')) { await sendTelegram(chatId, `❌ Usage: /link client@email.com`); return; }
      const result = await whmcs({ action: 'GetClients', search: email, limitnum: '1' });
      const client = result?.clients?.client?.[0];
      if (!client) { await sendTelegram(chatId, `❌ No client found with email *${email}* in WHMCS.`); return; }
      const clientName = `${client.firstname} ${client.lastname}`.trim() || client.companyname || email;
      db.prepare(`INSERT OR REPLACE INTO group_links (chat_id, chat_title, email, whmcs_client_id, client_name, linked_by)
        VALUES (?, ?, ?, ?, ?, ?)`).run(chatId, chatTitle, email, String(client.id), clientName, `${from} ${username}`);
      setChatMode(chatId, 'ai');
      await sendTelegram(chatId, `✅ *Group linked!*\n\n👤 *${clientName}*\n📧 ${email}\n🆔 WHMCS #${client.id}\n\nAI assistant is now active for this group.`);
      await notifyDiscord({ title: `🔗 Group Linked`, color: 0x22c55e, fields: [{ name: 'Group', value: chatTitle, inline: true }, { name: 'Client', value: clientName, inline: true }, { name: 'Email', value: email, inline: true }], footer: { text: `Linked by ${from} · ${getPHTime()} PHT` } });
      return;
    }

    if (cleanText === '/unlink') {
      db.prepare('DELETE FROM group_links WHERE chat_id = ?').run(chatId);
      db.prepare('DELETE FROM conversation_state WHERE chat_id = ?').run(chatId);
      await sendTelegram(chatId, `✅ Group unlinked.`); return;
    }

    if (cleanText === '/status') {
      const link = getGroupLink(chatId);
      const mode = getChatMode(chatId);
      if (link) await sendTelegram(chatId, `🔗 *${link.client_name}*\n📧 ${link.email}\n🤖 Mode: *${mode === 'agent' ? '👤 Agent (bot paused)' : '🤖 AI Active'}*`);
      else await sendTelegram(chatId, `❌ Not linked. Use: /link client@email.com`);
      return;
    }

    // Resume AI mode (agent command)
    if (cleanText === '/resumeai' || cleanText === '/ai') {
      setChatMode(chatId, 'ai');
      await sendTelegram(chatId, `🤖 AI assistant is back online!`);
      await notifyDiscord({ title: `🤖 AI Mode Resumed`, color: 0x22c55e, fields: [{ name: 'Chat', value: chatTitle, inline: true }], footer: { text: getPHTime() + ' PHT' } });
      return;
    }

    if (cleanText === '/history') {
      const rows = getRecentHistory(chatId, 10);
      if (!rows.length) { await sendTelegram(chatId, `No history yet.`); return; }
      const list = rows.map(r => `[${r.created_at.slice(11, 16)}] ${r.direction === 'inbound' ? r.from_name : '🤖'}: ${r.message.slice(0, 50)}`).join('\n');
      await sendTelegram(chatId, `📜 *Recent History:*\n\`\`\`\n${list}\n\`\`\``);
      return;
    }

    if (cleanText === '/help' || cleanText === '/start') {
      const link = getGroupLink(chatId);
      if (link) {
        await sendTelegram(chatId, `👋 Hi! How can I help you today?\n\nYou can ask me about:\n• Your invoices and balance\n• Your domains\n• Buying a new domain\n• Removing an item from an invoice\n• Any support concerns\n\nJust type your question! 😊`);
      } else {
        await sendTelegram(chatId, `👋 Hi! I'm from the Tigernethost support team.\n\n📧 support@tigernethost.com\n🌐 tigernethost.com`);
      }
      return;
    }

    // ── Client Messages ────────────────────────────────────────
    const link = getGroupLink(chatId);
    if (!link) {
      await sendTelegram(chatId, `👋 Hi ${from}! Thanks for reaching out to Tigernethost.\n\n📧 support@tigernethost.com\n🌐 tigernethost.com`);
      return;
    }

    // Forward all messages to Discord
    const mode = getChatMode(chatId);
    await notifyDiscord({
      title: isGroup ? `💬 ${chatTitle}` : `📨 DM — ${from}`,
      description: cleanText,
      color: mode === 'agent' ? 0xff9800 : 0x229ED9,
      fields: [
        { name: 'From', value: `${from} ${username}`, inline: true },
        { name: 'Client', value: link.client_name, inline: true },
        { name: 'Mode', value: mode === 'agent' ? '👤 Agent' : '🤖 AI', inline: true }
      ],
      footer: { text: `${getPHTime()} PHT · @${BOT_USERNAME}` }
    });

    // Process message
    const reply = await handleClientMessage(chatId, chatTitle, cleanText, from, username, link);

    if (reply) {
      await sendTelegram(chatId, reply);
      saveMessage(chatId, chatTitle, 'TigerAI Bot', BOT_USERNAME, reply, 'outbound');
    }

  } catch (err) {
    console.error('[Telegram] Error:', err.message);
  }
});

// ── Morning Briefing ─────────────────────────────────────────────────────────
async function sendMorningBriefing() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Manila' });
  const timeStr = now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Manila' });
  try {
    const inv = await whmcs({ action: 'GetInvoices', status: 'Unpaid', limitnum: '200' });
    const allInv = inv?.invoices?.invoice || [];
    const overdue = allInv.filter(i => new Date(i.duedate) < now).slice(0, 5);
    const soon = allInv.filter(i => { const d = new Date(i.duedate); return d >= now && d <= new Date(now.getTime() + 30 * 86400000); }).slice(0, 5);
    let mgrUnpaid = [], mgrTotal = 0, mgrQuotes = [];
    try {
      const mr = await axios.get(`${MGR_URL}/index?model=SalesInvoice`, { timeout: 8000 });
      mgrUnpaid = (mr.data || []).filter(i => !i.Void && i.AmountDue > 0);
      mgrTotal = mgrUnpaid.reduce((s, i) => s + (i.AmountDue || 0), 0);
      const qr = await axios.get(`${MGR_URL}/index?model=SalesQuote`, { timeout: 8000 });
      mgrQuotes = (qr.data || []).filter(q => q.Status !== 'Converted' && q.Status !== 'Declined');
    } catch (e) { console.log('Manager.io:', e.message); }
    const linkedGroups = db.prepare('SELECT COUNT(*) as c FROM group_links').get().c;
    const pendingHandoffs = db.prepare("SELECT COUNT(*) as c FROM agent_handoffs WHERE status='pending'").get().c;
    const fields = [
      { name: '📊 WHMCS', value: `Unpaid: **${allInv.length}**\nDue soon: **${soon.length}**`, inline: true },
      { name: '🧾 Manager.io', value: `Invoices: **${mgrUnpaid.length}**\nTotal: **₱${mgrTotal.toLocaleString('en-PH')}**`, inline: true },
      { name: '🤖 Bot', value: `Linked GCs: **${linkedGroups}**\n⚠️ Pending handoffs: **${pendingHandoffs}**`, inline: true },
    ];
    if (mgrQuotes.length > 0) fields.push({ name: '📋 Quotes', value: `**${mgrQuotes.length}** pending`, inline: true });
    if (overdue.length > 0) fields.push({ name: '⚠️ Overdue', value: overdue.map(i => `• #${i.id} — ${i.currencyprefix || '₱'}${parseFloat(i.total).toFixed(2)} (${i.duedate})`).join('\n'), inline: false });
    if (soon.length > 0) fields.push({ name: '📅 Due Soon', value: soon.map(i => `• #${i.id} — ${i.currencyprefix || '₱'}${parseFloat(i.total).toFixed(2)} (${i.duedate})`).join('\n'), inline: false });
    await axios.post(DISCORD, { username: 'Claude AI — TNH Morning Briefing', embeds: [{ title: `☀️ Good Morning, Macky! — ${dateStr}`, description: 'Daily briefing for **Tigernethost OPC**.', color: 0xf7c948, fields, footer: { text: `inbox.tigernethost.com · ${timeStr} PHT · Node ${process.version}` } }] });
    console.log(`✅ Briefing sent at ${timeStr}`);
    return { success: true, whmcsUnpaid: allInv.length, mgrTotal, overdueCount: overdue.length };
  } catch (err) { return { success: false, error: err.message }; }
}

cron.schedule('0 7 * * *', () => sendMorningBriefing(), { timezone: 'Asia/Manila' });

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok', service: 'inbox.tigernethost.com', nodeVersion: process.version,
  time: new Date().toISOString(), nextBriefing: '7:00 AM PHT daily',
  linkedGroups: db.prepare('SELECT COUNT(*) as c FROM group_links').get().c,
  totalMessages: db.prepare('SELECT COUNT(*) as c FROM message_history').get().c,
  pendingHandoffs: db.prepare("SELECT COUNT(*) as c FROM agent_handoffs WHERE status='pending'").get().c
}));
app.get('/briefing/send', async (req, res) => res.json(await sendMorningBriefing()));
app.get('/groups', (req, res) => res.json({ groups: db.prepare('SELECT * FROM group_links ORDER BY linked_at DESC').all() }));
app.get('/history/:chatId', (req, res) => res.json({ messages: db.prepare('SELECT * FROM message_history WHERE chat_id = ? ORDER BY created_at DESC LIMIT 50').all(req.params.chatId) }));
app.get('/handoffs', (req, res) => res.json({ handoffs: db.prepare("SELECT * FROM agent_handoffs ORDER BY created_at DESC LIMIT 20").all() }));
app.post('/webhook/:platform', (req, res) => { console.log(`[${req.params.platform}]`, JSON.stringify(req.body).slice(0, 200)); res.json({ received: true }); });
app.get('/webhook/:platform', (req, res) => { const { 'hub.challenge': c, 'hub.mode': m } = req.query; if (m === 'subscribe' && c) return res.send(c); res.json({ status: 'ready' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ inbox.tigernethost.com on port ${PORT} · Node ${process.version}`);
  console.log(`🤖 AI-powered by Claude · ${ANTHROPIC_API_KEY ? 'API key loaded' : '⚠️ No API key'}`);
  console.log(`⏰ Morning briefing: 7:00 AM PHT daily`);
});
