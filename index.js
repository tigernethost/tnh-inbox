const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const cors = require('cors');
const Database = require('better-sqlite3');
const Anthropic = require('@anthropic-ai/sdk');
const { OpenAI } = require('openai');

const app = express();
app.use(cors());
app.use(express.json());

// ── Constants ────────────────────────────────────────────────────────────────
const DISCORD_WEBHOOK   = 'https://discord.com/api/webhooks/1480032171145171046/unwQrsbszoZC9l35RHfkBrK0B5YDBPihQtxV0aUdCorHyajvxMsBmyalkQeKptUI1c4X';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN;
const DISCORD_APP_ID    = '1480770715308527748';
const WHMCS_URL         = 'https://tigernethost.com/portal/includes/api.php';
const MGR_URL           = 'http://accounting-corpo.tigernethost.com:8080/api2/VElHRVJORVRIT1NUIDIwMjU';
const TELEGRAM_TOKEN    = '8225869241:AAFeO_a1nRFs4rTo_U4kTyjQasT9q8_Lv08';
const BOT_USERNAME      = 'TigerAIAssist_bot';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// DISCORD_COMMAND_CHANNEL — set this env var to your Discord channel ID
// The bot will listen to messages in that channel with prefix !ai or !tiger
const DISCORD_COMMAND_CHANNEL = process.env.DISCORD_COMMAND_CHANNEL || null;

// Google Calendar — handled via Claude connector proxy
// No OAuth needed! Claude.ai handles calendar operations and calls back to us.
const GCAL_CALENDAR     = process.env.GCAL_CALENDAR_ID || 'tigernethost@gmail.com';
const GCAL_WEBHOOK_SECRET = process.env.GCAL_WEBHOOK_SECRET || 'TNHCalendar2026';

// Zoom (Server-to-Server OAuth)
const ZOOM_ACCOUNT_ID    = process.env.ZOOM_ACCOUNT_ID    || 'eKCXh0p9S8CF3rdzoumV1A';
const ZOOM_CLIENT_ID     = process.env.ZOOM_CLIENT_ID     || 'NA1Vn2iHSQ2gL3L8hJI1vA';
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET || '9jQUsrBexobvfAX0hQPD4K2W1QW0Jz9U';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const USE_OPENAI = !ANTHROPIC_API_KEY || !!OPENAI_API_KEY; // use OpenAI if set

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY || 'placeholder' });
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ── SQLite ───────────────────────────────────────────────────────────────────
const db = new Database('/tmp/tnh_inbox.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS group_links (
    chat_id TEXT PRIMARY KEY, chat_title TEXT, email TEXT,
    whmcs_client_id TEXT, client_name TEXT, linked_by TEXT,
    linked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS pending_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT,
    action_type TEXT, action_data TEXT, requested_by TEXT,
    status TEXT DEFAULT 'awaiting_confirmation',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS message_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT,
    chat_title TEXT, from_name TEXT, from_username TEXT,
    message TEXT, direction TEXT DEFAULT 'inbound',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS agent_handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT,
    client_name TEXT, reason TEXT, status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS conversation_state (
    chat_id TEXT PRIMARY KEY, mode TEXT DEFAULT 'ai',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS discord_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT, user_id TEXT, username TEXT,
    command TEXT, result TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT,
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

const mgr = async (endpoint, method = 'GET', body = null) => {
  const config = {
    method, url: `${MGR_URL}${endpoint}`, timeout: 10000,
    auth: { username: 'administrator', password: 'MarkTNH01' }
  };
  if (body) config.data = body;
  const { data } = await axios(config);
  return data;
};

const getPHTime = () => new Date().toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' });
const getPHDate = () => new Date().toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Manila' });

const sendTelegram = async (chatId, text, extra = {}) => {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: chatId, text, parse_mode: 'Markdown', ...extra
  }).catch(e => console.log('Telegram error:', e.message));
};

const sendDiscordWebhook = async (content, embeds = []) => {
  await axios.post(DISCORD_WEBHOOK, { username: 'TigerAI — Command Center', content, embeds })
    .catch(e => console.log('Discord webhook error:', e.message));
};

const sendDiscordChannel = async (channelId, content, embeds = []) => {
  await axios.post(`https://discord.com/api/v10/channels/${channelId}/messages`,
    { content, embeds },
    { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
  ).catch(e => console.log('Discord bot send error:', e.response?.data || e.message));
};

const saveMessage = (chatId, chatTitle, fromName, fromUsername, message, direction = 'inbound') => {
  db.prepare(`INSERT INTO message_history (chat_id, chat_title, from_name, from_username, message, direction)
    VALUES (?, ?, ?, ?, ?, ?)`).run(chatId, chatTitle, fromName, fromUsername, message, direction);
};

const getGroupLink = (chatId) => db.prepare('SELECT * FROM group_links WHERE chat_id = ?').get(String(chatId));
const getMode = (chatId) => {
  const row = db.prepare('SELECT mode FROM conversation_state WHERE chat_id = ?').get(String(chatId));
  return row ? row.mode : 'ai';
};
const setMode = (chatId, mode) => {
  db.prepare(`INSERT OR REPLACE INTO conversation_state (chat_id, mode, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`)
    .run(String(chatId), mode);
};

// ── Google Calendar — Claude Connector Proxy ─────────────────────────────────
// Calendar operations are handled by Claude.ai (which has native Google Calendar access)
// The inbox server receives results via POST /gcal/result
// Pending calendar requests are stored here until Claude responds
const pendingCalendarRequests = new Map();

function createCalendarRequest(operation, payload, channelId) {
  const requestId = 'gcal_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  pendingCalendarRequests.set(requestId, {
    requestId, operation, payload, channelId,
    status: 'pending',
    createdAt: new Date().toISOString()
  });
  // Auto-expire after 5 minutes
  setTimeout(() => pendingCalendarRequests.delete(requestId), 300000);
  return requestId;
}

// ── Zoom Helper ───────────────────────────────────────────────────────────────
let zoomAccessToken = null;
let zoomTokenExpiry = 0;

async function getZoomToken() {
  if (zoomAccessToken && Date.now() < zoomTokenExpiry) return zoomAccessToken;
  if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) throw new Error('Zoom not configured. Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET env vars.');
  const credentials = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');
  const { data } = await axios.post(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`,
    {}, { headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' } }
  );
  zoomAccessToken = data.access_token;
  zoomTokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
  return zoomAccessToken;
}

async function zoom(endpoint, method = 'GET', body = null) {
  const token = await getZoomToken();
  const config = { method, url: `https://api.zoom.us/v2${endpoint}`, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  if (body) config.data = body;
  const { data } = await axios(config);
  return data;
}

// ── AI Tools (Functions Claude can call) ─────────────────────────────────────
const tools = [
  {
    name: 'get_whmcs_unpaid_invoices',
    description: 'Get all unpaid/overdue invoices from WHMCS billing system. Can filter by client.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string', description: 'Optional: filter by client name or email' },
        limit: { type: 'number', description: 'Max results (default 20)' }
      }
    }
  },
  {
    name: 'get_whmcs_client',
    description: 'Look up a WHMCS client by name, email, or ID',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Name, email, or ID to search' }
      },
      required: ['search']
    }
  },
  {
    name: 'update_whmcs_invoice_status',
    description: 'Cancel or update a WHMCS invoice status. Use for cancelling old invoices.',
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', description: 'WHMCS Invoice ID number' },
        status: { type: 'string', enum: ['Cancelled', 'Unpaid', 'Paid'], description: 'New status' }
      },
      required: ['invoice_id', 'status']
    }
  },
  {
    name: 'update_whmcs_client_status',
    description: 'Set a WHMCS client as Active, Inactive, or Closed',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string', description: 'WHMCS Client ID' },
        status: { type: 'string', enum: ['Active', 'Inactive', 'Closed'] }
      },
      required: ['client_id', 'status']
    }
  },
  {
    name: 'get_manager_invoices',
    description: 'Get unpaid invoices from Manager.io accounting system',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results' }
      }
    }
  },
  {
    name: 'get_manager_quotes',
    description: 'Get pending sales quotes from Manager.io',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'record_manager_payment',
    description: 'Record a payment/receipt in Manager.io for a sales invoice. NEVER deletes data.',
    input_schema: {
      type: 'object',
      properties: {
        invoice_key: { type: 'string', description: 'Manager.io invoice UUID/key' },
        amount: { type: 'number', description: 'Payment amount' },
        bank_account_key: { type: 'string', description: 'Bank account key. UB9855 Unionbank = e84f8ad9-738c-4686-919f-f70055b256ad' },
        description: { type: 'string', description: 'Payment memo/description' }
      },
      required: ['invoice_key', 'amount']
    }
  },
  {
    name: 'get_overdue_summary',
    description: 'Get a full overdue summary across WHMCS and Manager.io',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_calendar_events',
    description: 'Get upcoming events from Google Calendar',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days ahead to look (default 7)' },
        query: { type: 'string', description: 'Optional search query' }
      }
    }
  },
  {
    name: 'create_calendar_event',
    description: 'Create a new event in Google Calendar',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title/summary' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
        start_time: { type: 'string', description: 'Start time in HH:MM (24hr) format, e.g. 14:00' },
        end_time: { type: 'string', description: 'End time in HH:MM (24hr) format, e.g. 15:00' },
        description: { type: 'string', description: 'Event description or notes' },
        location: { type: 'string', description: 'Physical location or meeting link' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'List of attendee email addresses' }
      },
      required: ['title', 'date', 'start_time', 'end_time']
    }
  },
  {
    name: 'create_zoom_meeting',
    description: 'Create a new Zoom meeting and get the join link',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Meeting topic/title' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
        start_time: { type: 'string', description: 'Start time in HH:MM (24hr PHT) format' },
        duration: { type: 'number', description: 'Duration in minutes (default 60)' },
        agenda: { type: 'string', description: 'Meeting agenda or description' }
      },
      required: ['topic', 'date', 'start_time']
    }
  },
  {
    name: 'list_zoom_meetings',
    description: 'List upcoming scheduled Zoom meetings',
    input_schema: { type: 'object', properties: {} }
  }
];

// ── Tool Executor ─────────────────────────────────────────────────────────────
async function executeTool(toolName, toolInput) {
  console.log(`[Tool] Executing: ${toolName}`, JSON.stringify(toolInput).slice(0, 150));
  try {
    if (toolName === 'get_whmcs_unpaid_invoices') {
      const params = { action: 'GetInvoices', status: 'Unpaid', limitnum: String(toolInput.limit || 20) };
      if (toolInput.client_name) params.search = toolInput.client_name;
      const data = await whmcs(params);
      const invoices = data?.invoices?.invoice || [];
      return JSON.stringify({
        count: invoices.length,
        invoices: invoices.map(i => ({
          id: i.id, client: i.clientname, amount: i.total,
          currency: i.currencyprefix || '₱', duedate: i.duedate,
          overdue: new Date(i.duedate) < new Date()
        }))
      });
    }

    if (toolName === 'get_whmcs_client') {
      const data = await whmcs({ action: 'GetClients', search: toolInput.search, limitnum: '5' });
      const clients = data?.clients?.client || [];
      return JSON.stringify({
        count: clients.length,
        clients: clients.map(c => ({
          id: c.id,
          name: `${c.firstname} ${c.lastname}`.trim() || c.companyname,
          email: c.email, status: c.status, company: c.companyname
        }))
      });
    }

    if (toolName === 'update_whmcs_invoice_status') {
      const data = await whmcs({ action: 'UpdateInvoice', invoiceid: toolInput.invoice_id, status: toolInput.status });
      return JSON.stringify({ success: data.result === 'success', result: data.result, invoiceid: toolInput.invoice_id, newStatus: toolInput.status });
    }

    if (toolName === 'update_whmcs_client_status') {
      const data = await whmcs({ action: 'UpdateClient', clientid: toolInput.client_id, status: toolInput.status });
      return JSON.stringify({ success: data.result === 'success', result: data.result, clientId: toolInput.client_id, newStatus: toolInput.status });
    }

    if (toolName === 'get_manager_invoices') {
      const data = await mgr('/index?model=SalesInvoice');
      const unpaid = (Array.isArray(data) ? data : []).filter(i => !i.Void && i.AmountDue > 0);
      const limited = unpaid.slice(0, toolInput.limit || 20);
      const total = unpaid.reduce((s, i) => s + (i.AmountDue || 0), 0);
      return JSON.stringify({
        count: unpaid.length, totalDue: total,
        invoices: limited.map(i => ({
          key: i.Key, reference: i.Reference, customer: i.Customer,
          amountDue: i.AmountDue, date: i.Date
        }))
      });
    }

    if (toolName === 'get_manager_quotes') {
      const data = await mgr('/index?model=SalesQuote');
      const pending = (Array.isArray(data) ? data : []).filter(q => q.Status !== 'Converted' && q.Status !== 'Declined');
      return JSON.stringify({
        count: pending.length,
        quotes: pending.map(q => ({ key: q.Key, reference: q.Reference, customer: q.Customer, amount: q.TotalAmount, date: q.Date, status: q.Status }))
      });
    }

    if (toolName === 'record_manager_payment') {
      const bankKey = toolInput.bank_account_key || 'e84f8ad9-738c-4686-919f-f70055b256ad';
      const payload = {
        Date: new Date().toISOString().split('T')[0],
        BankAccount: bankKey,
        Lines: [{ SalesInvoice: toolInput.invoice_key, Amount: toolInput.amount }],
        Description: toolInput.description || 'Payment received'
      };
      const data = await mgr('/index?model=Receipt', 'POST', payload);
      return JSON.stringify({ success: true, receipt: data });
    }

    if (toolName === 'get_overdue_summary') {
      const data = await whmcs({ action: 'GetInvoices', status: 'Unpaid', limitnum: '200' });
      const all = data?.invoices?.invoice || [];
      const overdue = all.filter(i => new Date(i.duedate) < new Date());
      const byClient = {};
      overdue.forEach(i => {
        if (!byClient[i.clientname]) byClient[i.clientname] = { count: 0, total: 0, oldest: i.duedate };
        byClient[i.clientname].count++;
        byClient[i.clientname].total += parseFloat(i.total);
      });
      let mgrTotal = 0, mgrCount = 0;
      try {
        const mr = await mgr('/index?model=SalesInvoice');
        const unpaid = (Array.isArray(mr) ? mr : []).filter(i => !i.Void && i.AmountDue > 0);
        mgrTotal = unpaid.reduce((s, i) => s + (i.AmountDue || 0), 0);
        mgrCount = unpaid.length;
      } catch (e) {}
      return JSON.stringify({ whmcsOverdue: overdue.length, whmcsTotal: overdue.reduce((s, i) => s + parseFloat(i.total), 0), byClient, managerIoUnpaid: mgrCount, managerIoTotal: mgrTotal });
    }

    if (toolName === 'get_calendar_events') {
      // Queue request for Claude to handle via connector
      const requestId = createCalendarRequest('get_events', toolInput, null);
      return JSON.stringify({
        status: 'queued',
        requestId,
        message: 'Calendar request queued. Check GET /gcal/pending for Claude to process.',
        instruction: `Claude should call POST /gcal/result with requestId="${requestId}" and the event data.`
      });
    }

    if (toolName === 'create_calendar_event') {
      const requestId = createCalendarRequest('create_event', toolInput, null);
      return JSON.stringify({
        status: 'queued',
        requestId,
        message: 'Calendar create request queued.',
        instruction: `Claude should call POST /gcal/result with requestId="${requestId}" after creating the event.`
      });
    }

    if (toolName === 'create_zoom_meeting') {
      const startDT = `${toolInput.date}T${toolInput.start_time}:00`;
      const body = {
        topic: toolInput.topic,
        type: 2, // scheduled
        start_time: startDT,
        duration: toolInput.duration || 60,
        timezone: 'Asia/Manila',
        agenda: toolInput.agenda || '',
        settings: { host_video: true, participant_video: true, waiting_room: true, auto_recording: 'none' }
      };
      const data = await zoom('/users/me/meetings', 'POST', body);
      return JSON.stringify({ success: true, meetingId: data.id, topic: data.topic, joinUrl: data.join_url, startUrl: data.start_url, password: data.password, startTime: data.start_time, duration: data.duration });
    }

    if (toolName === 'list_zoom_meetings') {
      const data = await zoom('/users/me/meetings?type=scheduled&page_size=10');
      const meetings = (data.meetings || []).map(m => ({
        id: m.id, topic: m.topic, startTime: m.start_time,
        duration: m.duration, joinUrl: m.join_url
      }));
      return JSON.stringify({ count: meetings.length, meetings });
    }

    return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  } catch (err) {
    console.error(`[Tool Error] ${toolName}:`, err.message);
    return JSON.stringify({ error: err.message });
  }
}

// ── AI Brain ──────────────────────────────────────────────────────────────────
async function processAICommand(userMessage, username) {
  console.log(`[AI] ${username}: ${userMessage.slice(0, 100)}`);

  const systemPrompt = `You are TigerAI, the AI executive assistant for Tigernethost OPC, an IT services company in Guagua, Pampanga, Philippines. You are talking to Macky, the owner.

You have access to WHMCS (billing) and Manager.io (accounting). You can:
- Check and update invoices, clients, domains
- Look up overdue and unpaid invoices
- Record payments in Manager.io
- Cancel old invoices in WHMCS

Current time: ${getPHDate()} ${getPHTime()} PHT

Rules:
- Be concise and direct — this is a command interface
- Format PHP amounts with ₱ symbol
- NEVER delete data in Manager.io — only read, create, update
- When you complete an action, confirm clearly what was done
- If a task has multiple steps, complete them all before summarizing
- Keep responses under 1500 characters for Discord readability`;

  const messages = [{ role: 'user', content: userMessage }];

  // Use OpenAI if available, else Anthropic
  if (openai) {
    return await processWithOpenAI(userMessage, systemPrompt, messages);
  } else {
    return await processWithAnthropic(systemPrompt, messages);
  }
}

async function processWithAnthropic(systemPrompt, messages) {
  let response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: systemPrompt,
    tools,
    messages
  });

  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      const result = await executeTool(toolUse.name, toolUse.input);
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
    }
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages
    });
  }

  const textBlock = response.content.find(b => b.type === 'text');
  return textBlock ? textBlock.text : 'Done.';
}

// Convert Anthropic tool schema to OpenAI function schema
function toOpenAITools(anthropicTools) {
  return anthropicTools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema
    }
  }));
}

async function processWithOpenAI(userMessage, systemPrompt, messages) {
  const oaiMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];
  const oaiTools = toOpenAITools(tools);

  let response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 1024,
    messages: oaiMessages,
    tools: oaiTools,
    tool_choice: 'auto'
  });

  // Agentic loop
  while (response.choices[0].finish_reason === 'tool_calls') {
    const msg = response.choices[0].message;
    oaiMessages.push(msg);

    for (const toolCall of msg.tool_calls || []) {
      const result = await executeTool(toolCall.function.name, JSON.parse(toolCall.function.arguments));
      oaiMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result
      });
    }

    response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1024,
      messages: oaiMessages,
      tools: oaiTools,
      tool_choice: 'auto'
    });
  }

  return response.choices[0].message.content || 'Done.';
}

// ── Discord Bot Message Polling ───────────────────────────────────────────────
let lastDiscordMessageId = null;
let discordPollingActive = false;

async function pollDiscordMessages() {
  if (!DISCORD_COMMAND_CHANNEL || !DISCORD_BOT_TOKEN) return;
  if (discordPollingActive) return;
  discordPollingActive = true;

  try {
    const params = lastDiscordMessageId ? `?after=${lastDiscordMessageId}&limit=10` : `?limit=5`;
    const { data: messages } = await axios.get(
      `https://discord.com/api/v10/channels/${DISCORD_COMMAND_CHANNEL}/messages${params}`,
      { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
    );

    if (!messages || messages.length === 0) return;
    lastDiscordMessageId = messages[0].id;

    // Process oldest first, skip bots, require !ai or !tiger prefix
    const toProcess = [...messages].reverse().filter(m =>
      !m.author?.bot &&
      (m.content?.toLowerCase().startsWith('!ai ') || m.content?.toLowerCase().startsWith('!tiger '))
    );

    for (const msg of toProcess) {
      const command = msg.content.replace(/^!(ai|tiger)\s+/i, '').trim();
      if (!command) continue;
      console.log(`[Discord Bot] ${msg.author.username}: ${command}`);

      // Typing indicator
      await axios.post(
        `https://discord.com/api/v10/channels/${DISCORD_COMMAND_CHANNEL}/typing`, {},
        { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
      ).catch(() => {});

      const result = await processAICommand(command, msg.author.username);

      db.prepare(`INSERT INTO discord_commands (channel_id, user_id, username, command, result) VALUES (?, ?, ?, ?, ?)`)
        .run(DISCORD_COMMAND_CHANNEL, msg.author.id, msg.author.username, command, result);

      // Reply in channel — mention the user
      await sendDiscordChannel(
        DISCORD_COMMAND_CHANNEL,
        `<@${msg.author.id}> 🤖 **TigerAI** — \`${command}\`\n\n${result}`
      );
    }
  } catch (err) {
    if (err.response?.status === 403) {
      console.log('[Discord] Bot lacks permission to read channel. Make sure bot is in server and has access.');
    } else if (err.response?.status === 401) {
      console.log('[Discord] Invalid bot token.');
    } else {
      console.error('[Discord Poll Error]', err.message);
    }
  } finally {
    discordPollingActive = false;
  }
}

// Poll every 3 seconds
setInterval(pollDiscordMessages, 3000);

// ── Telegram Webhook ──────────────────────────────────────────────────────────
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

    if (isGroup && !botMentioned && !isCommand) {
      saveMessage(chatId, chatTitle, from, username, text, 'inbound');
      return;
    }

    const cleanText = text.replace(`@${BOT_USERNAME}`, '').trim();
    saveMessage(chatId, chatTitle, from, username, cleanText, 'inbound');

    if (cleanText.startsWith('/link ')) {
      const email = cleanText.replace('/link', '').trim();
      if (!email.includes('@')) { await sendTelegram(chatId, `❌ Usage: /link client@email.com`); return; }
      const result = await whmcs({ action: 'GetClients', search: email, limitnum: '1' });
      const client = result?.clients?.client?.[0];
      if (!client) { await sendTelegram(chatId, `❌ No client found with email *${email}*`); return; }
      const clientName = `${client.firstname} ${client.lastname}`.trim() || client.companyname || email;
      db.prepare(`INSERT OR REPLACE INTO group_links (chat_id, chat_title, email, whmcs_client_id, client_name, linked_by) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(chatId, chatTitle, email, String(client.id), clientName, `${from} ${username}`);
      await sendTelegram(chatId, `✅ *Linked!*\n\n👤 *${clientName}*\n📧 ${email}\n🆔 WHMCS #${client.id}`);
      return;
    }

    if (cleanText === '/unlink') { db.prepare('DELETE FROM group_links WHERE chat_id = ?').run(chatId); await sendTelegram(chatId, `✅ Unlinked.`); return; }
    if (cleanText === '/resumeai' || cleanText === '/ai') { setMode(chatId, 'ai'); await sendTelegram(chatId, `✅ AI mode resumed.`); return; }
    if (cleanText === '/status') {
      const link = getGroupLink(chatId);
      const mode = getMode(chatId);
      if (link) await sendTelegram(chatId, `🔗 *${link.client_name}*\n📧 ${link.email}\n🆔 WHMCS #${link.whmcs_client_id}\n🤖 Mode: *${mode.toUpperCase()}*`);
      else await sendTelegram(chatId, `❌ Not linked. Use: /link client@email.com`);
      return;
    }

    const mode = getMode(chatId);
    const link = getGroupLink(chatId);

    if (!link) {
      await sendTelegram(chatId, `👋 Hi ${from}! I'm *TigerAI* from *Tigernethost OPC*.\n\n📧 support@tigernethost.com\n🌐 tigernethost.com`);
      return;
    }

    if (mode === 'agent') return; // Human handling, bot silent

    try {
      const aiReply = await processAICommand(
        `Client ${link.client_name} (WHMCS #${link.whmcs_client_id}) says: ${cleanText}`,
        from
      );
      await sendTelegram(chatId, aiReply);
      saveMessage(chatId, chatTitle, 'TigerAI', BOT_USERNAME, aiReply, 'outbound');

      const lower = cleanText.toLowerCase();
      if (lower.includes('human') || lower.includes('agent') || lower.includes('tao') || lower.includes('frustrated')) {
        setMode(chatId, 'agent');
        db.prepare(`INSERT INTO agent_handoffs (chat_id, client_name, reason, status) VALUES (?, ?, ?, 'pending')`)
          .run(chatId, link.client_name, cleanText);
        await sendTelegram(chatId, `🙋 Connecting you to a human agent. Please wait...`);
        await sendDiscordWebhook(null, [{
          title: `🚨 Agent Handoff — ${link.client_name}`,
          description: `Client is requesting a human agent.`,
          color: 0xff4d4d,
          fields: [
            { name: 'Message', value: cleanText, inline: false },
            { name: 'Client', value: link.client_name, inline: true },
            { name: 'WHMCS', value: `#${link.whmcs_client_id}`, inline: true },
            { name: 'Resume', value: 'Send `/resumeai` in the group', inline: false }
          ],
          footer: { text: `${getPHTime()} PHT` }
        }]);
      }
    } catch (err) {
      console.error('[Telegram AI Error]', err.message);
      await sendTelegram(chatId, `Sorry, I had trouble with that. Please try again or contact support@tigernethost.com`);
    }
  } catch (err) {
    console.error('[Telegram Webhook Error]', err.message);
  }
});

// ── Morning Briefing ──────────────────────────────────────────────────────────
async function sendMorningBriefing() {
  const now = new Date();
  const timeStr = getPHTime();
  try {
    const inv = await whmcs({ action: 'GetInvoices', status: 'Unpaid', limitnum: '200' });
    const allInv = inv?.invoices?.invoice || [];
    const overdue = allInv.filter(i => new Date(i.duedate) < now).slice(0, 5);
    const soon = allInv.filter(i => { const d = new Date(i.duedate); return d >= now && d <= new Date(now.getTime() + 30 * 86400000); }).slice(0, 5);

    let mgrUnpaid = [], mgrTotal = 0, mgrQuotes = [];
    try {
      const mr = await mgr('/index?model=SalesInvoice');
      mgrUnpaid = (Array.isArray(mr) ? mr : []).filter(i => !i.Void && i.AmountDue > 0);
      mgrTotal = mgrUnpaid.reduce((s, i) => s + (i.AmountDue || 0), 0);
      const qr = await mgr('/index?model=SalesQuote');
      mgrQuotes = (Array.isArray(qr) ? qr : []).filter(q => q.Status !== 'Converted' && q.Status !== 'Declined');
    } catch (e) { console.log('Manager.io:', e.message); }

    const linkedGroups = db.prepare('SELECT COUNT(*) as count FROM group_links').get();
    const fields = [
      { name: '📊 WHMCS', value: `Unpaid: **${allInv.length}**\nDue soon: **${soon.length}**`, inline: true },
      { name: '🧾 Manager.io', value: `Invoices: **${mgrUnpaid.length}**\nTotal: **₱${mgrTotal.toLocaleString('en-PH')}**`, inline: true },
      { name: '🤖 Telegram Bot', value: `Linked GCs: **${linkedGroups.count}**`, inline: true },
    ];
    if (mgrQuotes.length > 0) fields.push({ name: '📋 Quotes', value: `**${mgrQuotes.length}** pending`, inline: true });
    if (overdue.length > 0) fields.push({ name: '⚠️ Overdue', value: overdue.map(i => `• #${i.id} — ${i.currencyprefix || '₱'}${parseFloat(i.total).toFixed(2)} (${i.duedate})`).join('\n'), inline: false });
    if (soon.length > 0) fields.push({ name: '📅 Due Soon', value: soon.map(i => `• #${i.id} — ${i.currencyprefix || '₱'}${parseFloat(i.total).toFixed(2)} (${i.duedate})`).join('\n'), inline: false });
    // Calendar events are injected by Claude via POST /gcal/briefing before 7am
    const todayCalCache = db.prepare("SELECT value FROM kv_store WHERE key = 'today_calendar'").get();
    if (todayCalCache) {
      try {
        const events = JSON.parse(todayCalCache.value);
        if (events.length > 0) {
          fields.push({ name: '📅 Today\'s Schedule', value: events.map(e => `• ${e.time} — ${e.title}${e.location ? ' @ ' + e.location : ''}`).join('\n'), inline: false });
        } else {
          fields.push({ name: '📅 Today\'s Schedule', value: 'No meetings scheduled today', inline: false });
        }
      } catch(e) {}
    } else {
      fields.push({ name: '📅 Today\'s Schedule', value: 'No calendar data yet', inline: false });
    }

    fields.push({ name: '💡 Discord AI Commands', value: '`!ai <your command>` in your command channel\nExample: `!ai show overdue invoices` or `!ai cancel invoice #1234`', inline: false });

    await axios.post(DISCORD_WEBHOOK, {
      username: 'Claude AI — TNH Morning Briefing',
      embeds: [{ title: `☀️ Good Morning, Macky! — ${getPHDate()}`, description: 'Daily briefing for **Tigernethost OPC**.', color: 0xf7c948, fields, footer: { text: `inbox.tigernethost.com • ${timeStr} PHT • Node ${process.version}` } }]
    });

    console.log(`✅ Morning briefing sent at ${timeStr}`);
    return { success: true, whmcsUnpaid: allInv.length, mgrTotal, overdueCount: overdue.length };
  } catch (err) {
    console.error('❌ Briefing error:', err.message);
    return { success: false, error: err.message };
  }
}

cron.schedule('0 7 * * *', () => sendMorningBriefing(), { timezone: 'Asia/Manila' });

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'inbox.tigernethost.com',
    nodeVersion: process.version,
    time: new Date().toISOString(),
    nextBriefing: '7:00 AM PHT daily',
    discordBot: DISCORD_BOT_TOKEN ? '✅ configured' : '❌ missing',
    aiProvider: openai ? '✅ OpenAI (gpt-4o)' : (ANTHROPIC_API_KEY ? '✅ Anthropic (claude)' : '❌ no AI key set'),
    anthropicAI: ANTHROPIC_API_KEY ? '✅ configured' : '⚠️ missing',
    openAI: OPENAI_API_KEY ? '✅ configured' : 'not set',
    discordCommandChannel: DISCORD_COMMAND_CHANNEL ? `✅ ${DISCORD_COMMAND_CHANNEL}` : '⚠️ not set — set DISCORD_COMMAND_CHANNEL env var',
    googleCalendar: '✅ connector-mode (Claude native access)',
    zoom: (ZOOM_ACCOUNT_ID && ZOOM_CLIENT_ID) ? '✅ configured' : '⚠️ not configured',
    linkedGroups: db.prepare('SELECT COUNT(*) as c FROM group_links').get().c,
    totalMessages: db.prepare('SELECT COUNT(*) as c FROM message_history').get().c,
    discordCommandsRun: db.prepare('SELECT COUNT(*) as c FROM discord_commands').get().c,
  });
});

app.get('/briefing/send', async (req, res) => res.json(await sendMorningBriefing()));
app.get('/groups', (req, res) => res.json({ groups: db.prepare('SELECT * FROM group_links ORDER BY linked_at DESC').all() }));
app.get('/history/:chatId', (req, res) => res.json({ messages: db.prepare('SELECT * FROM message_history WHERE chat_id = ? ORDER BY created_at DESC LIMIT 50').all(req.params.chatId) }));
app.get('/discord/commands', (req, res) => res.json({ commands: db.prepare('SELECT * FROM discord_commands ORDER BY created_at DESC LIMIT 50').all() }));
app.get('/handoffs', (req, res) => res.json({ handoffs: db.prepare('SELECT * FROM agent_handoffs ORDER BY created_at DESC LIMIT 20').all() }));

// Manual AI test endpoint
app.post('/ai/test', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const result = await processAICommand(message, 'API Test');
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Google Calendar Connector Routes ─────────────────────────────────────────
// Claude calls these endpoints to push calendar data into the inbox server

// GET /gcal/pending — Claude polls this to see if any calendar ops are waiting
app.get('/gcal/pending', (req, res) => {
  const secret = req.headers['x-gcal-secret'] || req.query.secret;
  if (secret !== GCAL_WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const pending = Array.from(pendingCalendarRequests.values()).filter(r => r.status === 'pending');
  res.json({ pending });
});

// POST /gcal/result — Claude posts calendar results back here
app.post('/gcal/result', (req, res) => {
  const secret = req.headers['x-gcal-secret'] || req.body.secret;
  if (secret !== GCAL_WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const { requestId, result, channelId, discordMessage } = req.body;
  if (!requestId) return res.status(400).json({ error: 'requestId required' });

  const request = pendingCalendarRequests.get(requestId);
  if (request) {
    request.status = 'completed';
    request.result = result;
    pendingCalendarRequests.set(requestId, request);
  }

  // If a Discord channel and message are provided, send result there
  const targetChannel = channelId || DISCORD_COMMAND_CHANNEL;
  if (targetChannel && discordMessage) {
    sendDiscordChannel(targetChannel, `📅 **TigerAI Calendar** — ${discordMessage}`);
  }

  console.log(`[GCal] Result received for ${requestId}`);
  res.json({ success: true, requestId });
});

// POST /gcal/briefing — Claude pushes today's events before morning briefing
app.post('/gcal/briefing', (req, res) => {
  const secret = req.headers['x-gcal-secret'] || req.body.secret;
  if (secret !== GCAL_WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const { events } = req.body;
  if (!events) return res.status(400).json({ error: 'events array required' });
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES ('today_calendar', ?, CURRENT_TIMESTAMP)")
    .run(JSON.stringify(events));
  console.log(`[GCal] Briefing updated: ${events.length} events`);
  res.json({ success: true, eventCount: events.length });
});

// GET /gcal/status — check calendar integration status
app.get('/gcal/status', (req, res) => {
  const cache = db.prepare("SELECT value, updated_at FROM kv_store WHERE key = 'today_calendar'").get();
  res.json({
    status: 'connector-mode',
    description: 'Google Calendar is handled by Claude.ai native connector',
    secret: GCAL_WEBHOOK_SECRET,
    endpoints: {
      pending: 'GET /gcal/pending?secret=<secret>',
      result: 'POST /gcal/result',
      briefing: 'POST /gcal/briefing'
    },
    todayCalendarCache: cache ? { eventCount: JSON.parse(cache.value).length, updatedAt: cache.updated_at } : 'empty'
  });
});

app.post('/webhook/:platform', (req, res) => {
  console.log(`[${req.params.platform}]`, JSON.stringify(req.body).slice(0, 200));
  res.json({ received: true, platform: req.params.platform });
});
app.get('/webhook/:platform', (req, res) => {
  const { 'hub.challenge': c, 'hub.mode': m } = req.query;
  if (m === 'subscribe' && c) return res.send(c);
  res.json({ platform: req.params.platform, status: 'ready' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ inbox.tigernethost.com on port ${PORT} • Node ${process.version}`);
  console.log(`⏰ Morning briefing: 7:00 AM PHT daily`);
  console.log(`🤖 Discord AI: ${DISCORD_COMMAND_CHANNEL ? `polling channel ${DISCORD_COMMAND_CHANNEL} every 3s` : '⚠️  set DISCORD_COMMAND_CHANNEL env var'}`);
  console.log(`🧠 AI Provider: ${openai ? 'OpenAI gpt-4o ✅' : (ANTHROPIC_API_KEY ? 'Anthropic claude ✅' : '⚠️  set OPENAI_API_KEY or ANTHROPIC_API_KEY')}`);
});




