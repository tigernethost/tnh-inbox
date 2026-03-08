const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ── Constants ────────────────────────────────────────────────────────────────
const DISCORD = 'https://discord.com/api/webhooks/1480032171145171046/unwQrsbszoZC9l35RHfkBrK0B5YDBPihQtxV0aUdCorHyajvxMsBmyalkQeKptUI1c4X';
const WHMCS_URL = 'https://tigernethost.com/portal/includes/api.php';
const MGR_URL = 'http://accounting-corpo.tigernethost.com:8080/api2/VElHRVJORVRIT1NUIDIwMjU';
const TELEGRAM_TOKEN = '8225869241:AAFeO_a1nRFs4rTo_U4kTyjQasT9q8_Lv08';
const BOT_USERNAME = 'TigerAIAssist_bot';

// ── SQLite Database ──────────────────────────────────────────────────────────
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
  });
};

const notifyDiscord = async (embed) => {
  await axios.post(DISCORD, { username: 'TigerAI — Telegram', embeds: [embed] })
    .catch(e => console.log('Discord error:', e.message));
};

const saveMessage = (chatId, chatTitle, fromName, fromUsername, message, direction = 'inbound') => {
  db.prepare(`INSERT INTO message_history (chat_id, chat_title, from_name, from_username, message, direction)
    VALUES (?, ?, ?, ?, ?, ?)`).run(chatId, chatTitle, fromName, fromUsername, message, direction);
};

const getGroupLink = (chatId) => db.prepare('SELECT * FROM group_links WHERE chat_id = ?').get(String(chatId));

const getPHTime = () => new Date().toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' });

// ── Action Handlers ──────────────────────────────────────────────────────────
async function handleCheckInvoices(clientId, clientName) {
  const data = await whmcs({ action: 'GetInvoices', userid: clientId, status: 'Unpaid', limitnum: '5' });
  const invoices = data?.invoices?.invoice || [];
  if (invoices.length === 0) return `✅ Great news, ${clientName}! You have *no outstanding invoices* at the moment.`;
  const list = invoices.map(i => `• Invoice #${i.id} — ${i.currencyprefix || '₱'}${parseFloat(i.total).toFixed(2)} (Due: ${i.duedate})`).join('\n');
  return `📋 *Your Unpaid Invoices:*\n\n${list}\n\n_Pay at: https://tigernethost.com/portal_`;
}

async function handleCheckDomains(clientId, clientName) {
  const data = await whmcs({ action: 'GetClientsDomains', clientid: clientId, limitnum: '10' });
  const domains = data?.domains?.domain || [];
  if (domains.length === 0) return `You currently have *no active domains*, ${clientName}.`;
  const list = domains.map(d => `• *${d.domainname}* — Expires: ${d.expirydate} (${d.status})`).join('\n');
  return `🌐 *Your Domains:*\n\n${list}`;
}

async function handleDomainPurchase(chatId, domainName, clientName) {
  const actionData = JSON.stringify({ domainName });
  db.prepare(`INSERT INTO pending_actions (chat_id, action_type, action_data, requested_by, status)
    VALUES (?, 'domain_purchase', ?, ?, 'awaiting_confirmation')`).run(String(chatId), actionData, clientName);
  const pendingId = db.prepare('SELECT last_insert_rowid() as id').get().id;

  await notifyDiscord({
    title: `🌐 Domain Purchase Request`, color: 0xa78bfa,
    description: `**${clientName}** wants to register a domain.`,
    fields: [{ name: 'Domain', value: domainName, inline: true }, { name: 'Action ID', value: `#${pendingId}`, inline: true }],
    footer: { text: `Awaiting customer confirmation · ${getPHTime()} PHT` }
  });

  return `🌐 *Domain Registration Request*\n\nYou'd like to register: *${domainName}*\n\n⚠️ Are you sure you want to continue?\n\nReply *YES* to confirm or *NO* to cancel.`;
}

async function handleRemoveInvoiceItem(chatId, clientId, clientName, invoiceId, itemDesc) {
  const data = await whmcs({ action: 'GetInvoice', invoiceid: invoiceId });
  const invoice = data?.invoice;
  if (!invoice) return `❌ Invoice #${invoiceId} not found. Please check the number and try again.`;

  const items = invoice.items?.item || [];
  const item = itemDesc
    ? items.find(i => i.description?.toLowerCase().includes(itemDesc.toLowerCase()))
    : null;

  if (itemDesc && !item) {
    const itemList = items.map(i => `• ${i.description} — ₱${i.amount}`).join('\n');
    return `❌ Could not find *"${itemDesc}"* in Invoice #${invoiceId}.\n\n*Items in this invoice:*\n${itemList}\n\nPlease specify the exact item name.`;
  }

  const targetItem = item || items[0];
  if (!targetItem) return `❌ No items found in Invoice #${invoiceId}.`;

  const actionData = JSON.stringify({ invoiceId, itemId: targetItem.id, itemDesc: targetItem.description, amount: targetItem.amount });
  db.prepare(`INSERT INTO pending_actions (chat_id, action_type, action_data, requested_by, status)
    VALUES (?, 'remove_invoice_item', ?, ?, 'awaiting_confirmation')`).run(String(chatId), actionData, clientName);
  const pendingId = db.prepare('SELECT last_insert_rowid() as id').get().id;

  await notifyDiscord({
    title: `🗑️ Invoice Item Removal Request`, color: 0xff6b6b,
    description: `**${clientName}** wants to remove an item from Invoice #${invoiceId}.`,
    fields: [
      { name: 'Invoice', value: `#${invoiceId}`, inline: true },
      { name: 'Item', value: targetItem.description, inline: true },
      { name: 'Amount', value: `₱${targetItem.amount}`, inline: true },
      { name: 'Action ID', value: `#${pendingId}`, inline: true }
    ],
    footer: { text: `Awaiting customer confirmation · ${getPHTime()} PHT` }
  });

  return `🗑️ *Remove Invoice Item*\n\nFrom Invoice #${invoiceId}:\n• *${targetItem.description}*\n  Amount: ₱${targetItem.amount}\n\n⚠️ Are you sure you want to continue?\n\nReply *YES* to confirm or *NO* to cancel.`;
}

async function handleConfirmation(chatId, clientName, confirmed) {
  const action = db.prepare(`SELECT * FROM pending_actions WHERE chat_id = ? AND status = 'awaiting_confirmation'
    ORDER BY created_at DESC LIMIT 1`).get(String(chatId));
  if (!action) return `There's nothing pending to confirm. How can I help you?`;

  if (!confirmed) {
    db.prepare(`UPDATE pending_actions SET status = 'cancelled' WHERE id = ?`).run(action.id);
    return `❌ Request cancelled. No changes were made.\n\nIs there anything else I can help you with?`;
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
    return `✅ *Domain registration confirmed!*\n\nYour request for *${actionData.domainName}* has been submitted.\n\nOur team will process this and follow up with pricing and next steps.\n\n📧 billing@tigernethost.com`;
  }

  if (action.action_type === 'remove_invoice_item') {
    await notifyDiscord({
      title: `✅ Invoice Item Removal CONFIRMED — Please Process`, color: 0x22c55e,
      description: `**${clientName}** confirmed item removal. Macky, please process in WHMCS.`,
      fields: [
        { name: 'Invoice', value: `#${actionData.invoiceId}`, inline: true },
        { name: 'Item', value: actionData.itemDesc, inline: true },
        { name: 'Amount', value: `₱${actionData.amount}`, inline: true },
        { name: 'Action ID', value: `#${action.id}`, inline: true }
      ],
      footer: { text: `Confirmed · ${getPHTime()} PHT` }
    });
    return `✅ *Request submitted!*\n\nYour request to remove *${actionData.itemDesc}* from Invoice #${actionData.invoiceId} is confirmed.\n\nOur billing team will update your invoice shortly.`;
  }

  return `✅ Confirmed and submitted to our team!`;
}

// ── Smart Message Router ─────────────────────────────────────────────────────
async function routeMessage(chatId, text, clientId, clientName) {
  const lower = text.toLowerCase().trim();

  // Confirmation
  if (['yes', 'yes.', 'confirm', 'proceed', 'oo', 'sige'].includes(lower)) {
    return await handleConfirmation(chatId, clientName, true);
  }
  if (['no', 'no.', 'cancel', 'huwag', 'hindi'].includes(lower)) {
    return await handleConfirmation(chatId, clientName, false);
  }

  // Remove invoice item
  if ((lower.includes('remove') || lower.includes('delete') || lower.includes('cancel')) && lower.includes('invoice')) {
    const invoiceMatch = text.match(/#?(\d+)/);
    const invoiceId = invoiceMatch ? invoiceMatch[1] : null;
    if (!invoiceId) return `Please include the invoice number.\n\nExample: _"Remove SMS addon from invoice #1234"_`;
    const itemDesc = text.replace(/remove|delete|cancel|from|invoice|#?\d+/gi, '').trim();
    return await handleRemoveInvoiceItem(chatId, clientId, clientName, invoiceId, itemDesc);
  }

  // Invoice / balance check
  if (lower.includes('invoice') || lower.includes('balance') || lower.includes('how much') || lower.includes('utang') || lower.includes('bill')) {
    return await handleCheckInvoices(clientId, clientName);
  }

  // Domain purchase
  if ((lower.includes('buy') || lower.includes('register') || lower.includes('purchase') || lower.includes('kumuha')) && lower.includes('domain')) {
    const domainMatch = text.match(/[\w-]+\.(com|net|org|ph|co\.ph|com\.ph|info|biz|online|site|app)/i);
    if (domainMatch) return await handleDomainPurchase(chatId, domainMatch[0], clientName);
    return `Which domain would you like to register?\n\nExample: _"I want to buy mycompany.com"_`;
  }

  // Domain check
  if (lower.includes('domain')) {
    return await handleCheckDomains(clientId, clientName);
  }

  // Support request
  if (lower.includes('support') || lower.includes('issue') || lower.includes('problem') || lower.includes('not working') || lower.includes('hindi gumagana')) {
    await notifyDiscord({
      title: `🛠️ Support Request`, color: 0xf7c948,
      description: text,
      fields: [{ name: 'Client', value: clientName, inline: true }, { name: 'Chat ID', value: String(chatId), inline: true }],
      footer: { text: `${getPHTime()} PHT` }
    });
    return `🛠️ *Support request received!*\n\nHi ${clientName}, our team has been notified and will respond *within 24 hours*.\n\nFor urgent concerns:\n📧 support@tigernethost.com`;
  }

  // Greeting
  if (lower.match(/^(hi|hello|good morning|good afternoon|good evening|hey|kumusta|kamusta)$/)) {
    return `👋 Hello, *${clientName}*! How can I help you today?\n\nHere's what I can do for you:\n• 📋 Check your invoices\n• 🌐 View your domains\n• 🛒 Register a new domain\n• 🗑️ Remove an invoice item\n• 🛠️ Submit a support request\n\nJust tell me what you need! 😊`;
  }

  // Default - forward to Macky
  await notifyDiscord({
    title: `💬 Message Needs Reply`, color: 0x6b7280,
    description: text,
    fields: [{ name: 'Client', value: clientName, inline: true }, { name: 'Chat', value: String(chatId), inline: true }],
    footer: { text: `${getPHTime()} PHT · Needs manual reply` }
  });
  return `Thank you, *${clientName}*! I've forwarded your message to our team and they'll get back to you shortly.\n\n📧 support@tigernethost.com`;
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

    // ── Admin Commands ──────────────────────────────────────────
    if (cleanText.startsWith('/link ')) {
      const email = cleanText.replace('/link', '').trim();
      if (!email.includes('@')) { await sendTelegram(chatId, `❌ Usage: /link client@email.com`); return; }

      const result = await whmcs({ action: 'GetClients', search: email, limitnum: '1' });
      const client = result?.clients?.client?.[0];
      if (!client) { await sendTelegram(chatId, `❌ No client found with email *${email}* in WHMCS.`); return; }

      const clientName = `${client.firstname} ${client.lastname}`.trim() || client.companyname || email;
      db.prepare(`INSERT OR REPLACE INTO group_links (chat_id, chat_title, email, whmcs_client_id, client_name, linked_by)
        VALUES (?, ?, ?, ?, ?, ?)`).run(chatId, chatTitle, email, String(client.id), clientName, `${from} ${username}`);

      await sendTelegram(chatId, `✅ *Group linked!*\n\n👤 *${clientName}*\n📧 ${email}\n🆔 WHMCS #${client.id}\n\nClients can now check invoices, domains, and more!`);
      await notifyDiscord({ title: `🔗 Group Linked`, color: 0x22c55e, fields: [{ name: 'Group', value: chatTitle, inline: true }, { name: 'Client', value: clientName, inline: true }, { name: 'Email', value: email, inline: true }], footer: { text: `Linked by ${from} · ${getPHTime()} PHT` } });
      return;
    }

    if (cleanText === '/unlink') {
      db.prepare('DELETE FROM group_links WHERE chat_id = ?').run(chatId);
      await sendTelegram(chatId, `✅ Group unlinked.`);
      return;
    }

    if (cleanText === '/status') {
      const link = getGroupLink(chatId);
      if (link) await sendTelegram(chatId, `🔗 *Linked to:* ${link.client_name}\n📧 ${link.email}\n🆔 WHMCS #${link.whmcs_client_id}`);
      else await sendTelegram(chatId, `❌ Not linked. Admin use: /link client@email.com`);
      return;
    }

    if (cleanText === '/history') {
      const rows = db.prepare(`SELECT from_name, message, direction, created_at FROM message_history WHERE chat_id = ? ORDER BY created_at DESC LIMIT 10`).all(chatId);
      if (!rows.length) { await sendTelegram(chatId, `No history yet.`); return; }
      const list = rows.reverse().map(r => `[${r.created_at.slice(11, 16)}] ${r.direction === 'inbound' ? r.from_name : '🤖'}: ${r.message.slice(0, 50)}`).join('\n');
      await sendTelegram(chatId, `📜 *Recent History:*\n\`\`\`\n${list}\n\`\`\``);
      return;
    }

    if (cleanText === '/help' || cleanText === '/start') {
      const link = getGroupLink(chatId);
      if (link) {
        await sendTelegram(chatId, `👋 Hello! I'm *TigerAI* from *Tigernethost OPC*.\n\nYou can ask me:\n• _"Check my invoices"_\n• _"Show my domains"_\n• _"I want to buy mysite.com"_\n• _"Remove SMS addon from invoice #1234"_\n• _"I have a support issue"_`);
      } else {
        await sendTelegram(chatId, `👋 Hi! I'm *TigerAI* from *Tigernethost OPC*.\n\n📧 support@tigernethost.com\n🌐 tigernethost.com`);
      }
      return;
    }

    // ── Client Actions ──────────────────────────────────────────
    const link = getGroupLink(chatId);
    if (!link) {
      await sendTelegram(chatId, `👋 Hi ${from}! I'm *TigerAI* from *Tigernethost OPC*.\n\n📧 support@tigernethost.com\n🌐 tigernethost.com`);
      return;
    }

    // Forward to Discord
    await notifyDiscord({
      title: isGroup ? `💬 ${chatTitle}` : `📨 DM — ${from}`,
      description: cleanText, color: 0x229ED9,
      fields: [{ name: 'From', value: `${from} ${username}`, inline: true }, { name: 'Client', value: link.client_name, inline: true }, { name: 'Time', value: `${getPHTime()} PHT`, inline: true }],
      footer: { text: `@${BOT_USERNAME} · WHMCS #${link.whmcs_client_id}` }
    });

    const reply = await routeMessage(chatId, cleanText, link.whmcs_client_id, link.client_name);
    await sendTelegram(chatId, reply);
    saveMessage(chatId, chatTitle, 'TigerAI Bot', BOT_USERNAME, reply, 'outbound');

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
    const linkedGroups = db.prepare('SELECT COUNT(*) as count FROM group_links').get();
    const fields = [
      { name: '📊 WHMCS', value: `Unpaid: **${allInv.length}**\nDue soon: **${soon.length}**`, inline: true },
      { name: '🧾 Manager.io', value: `Invoices: **${mgrUnpaid.length}**\nTotal: **₱${mgrTotal.toLocaleString('en-PH')}**`, inline: true },
      { name: '🤖 Bot', value: `Linked GCs: **${linkedGroups.count}**`, inline: true },
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
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'inbox.tigernethost.com', nodeVersion: process.version, time: new Date().toISOString(), nextBriefing: '7:00 AM PHT daily', linkedGroups: db.prepare('SELECT COUNT(*) as c FROM group_links').get().c, totalMessages: db.prepare('SELECT COUNT(*) as c FROM message_history').get().c, pendingActions: db.prepare("SELECT COUNT(*) as c FROM pending_actions WHERE status='awaiting_confirmation'").get().c });
});
app.get('/briefing/send', async (req, res) => res.json(await sendMorningBriefing()));
app.get('/groups', (req, res) => res.json({ groups: db.prepare('SELECT * FROM group_links ORDER BY linked_at DESC').all() }));
app.get('/history/:chatId', (req, res) => res.json({ messages: db.prepare('SELECT * FROM message_history WHERE chat_id = ? ORDER BY created_at DESC LIMIT 50').all(req.params.chatId) }));
app.post('/webhook/:platform', (req, res) => { console.log(`[${req.params.platform}]`, JSON.stringify(req.body).slice(0, 200)); res.json({ received: true }); });
app.get('/webhook/:platform', (req, res) => { const { 'hub.challenge': c, 'hub.mode': m } = req.query; if (m === 'subscribe' && c) return res.send(c); res.json({ status: 'ready' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ inbox.tigernethost.com on port ${PORT} · Node ${process.version}`);
  console.log(`⏰ Morning briefing: 7:00 AM PHT daily`);
});
