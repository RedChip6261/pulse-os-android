/*
 * Pulse OS cloud backend
 * ----------------------
 * A small Express server the Pulse OS app talks to over HTTPS.
 * Runs in GitHub Codespaces (see .devcontainer/) or any Node 20+ host.
 *
 * Routes
 *   GET  /health          -> liveness + config check (no auth)
 *   GET  /api/info        -> server info, available task types
 *   POST /api/chat        -> Gemini chat with the Pulse JSON contract
 *   POST /api/task        -> run one named task, returns its result
 *   GET  /api/tasks       -> the most recent task runs (newest first)
 *   GET  /api/tasks/:id   -> one task run
 *
 * Environment (set as Codespaces secrets or in your shell)
 *   PORT            default 3000
 *   GEMINI_API_KEY  server-side Gemini key (recommended; keeps it off the phone)
 *   GEMINI_MODEL    default gemini-flash-latest
 *   PULSE_TOKEN     if set, every /api/* call must send "Authorization: Bearer <token>"
 */

'use strict';

const express = require('express');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const SERVER_KEY = (process.env.GEMINI_API_KEY || '').trim();
const PULSE_TOKEN = (process.env.PULSE_TOKEN || '').trim();
const DEFAULT_MODEL = (process.env.GEMINI_MODEL || 'gemini-flash-latest').trim();
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const STARTED_AT = new Date();
const MAX_RUNS = 100;

const SYSTEM_PROMPT = [
  'You are Pulse, a proactive personal-productivity assistant inside the Pulse OS mobile app.',
  'Answer the user directly and helpfully, then anticipate what they will need next:',
  'reminders, calendar blocks, weather checks, budgeting, messages to send, prep steps, deadlines.',
  'You MUST reply with ONLY a single strict JSON object, no markdown, no code fences, no extra text.',
  'The JSON object must have exactly these keys:',
  '"direct_response": a string answering the user clearly and concisely;',
  '"proactive_checklist": an array of 2 to 5 short strings (max ~10 words each) of helpful follow-up actions;',
  '"one_line_summary": a single short sentence summarising the task or plan.',
].join(' ');

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function publicUrl() {
  const name = process.env.CODESPACE_NAME;
  const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev';
  return name ? `https://${name}-${PORT}.${domain}` : `http://localhost:${PORT}`;
}

function stripCodeFences(raw) {
  return String(raw || '')
    .trim()
    .replace(/^```(?:json|JSON)?\s*/m, '')
    .replace(/```\s*$/m, '')
    .trim();
}

function parsePulseReply(raw) {
  const cleaned = stripCodeFences(raw);
  let obj = null;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    const a = cleaned.indexOf('{');
    const b = cleaned.lastIndexOf('}');
    if (a !== -1 && b > a) {
      try {
        obj = JSON.parse(cleaned.slice(a, b + 1));
      } catch {
        obj = null;
      }
    }
  }
  if (!obj || typeof obj !== 'object') {
    return { direct_response: cleaned || 'No response received.', proactive_checklist: [], one_line_summary: '' };
  }
  return {
    direct_response: String(obj.direct_response ?? '').trim() || cleaned,
    proactive_checklist: Array.isArray(obj.proactive_checklist)
      ? obj.proactive_checklist.map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
      : [],
    one_line_summary: String(obj.one_line_summary ?? '').trim(),
  };
}

let workingModel = DEFAULT_MODEL;

async function discoverFlashModels(apiKey) {
  try {
    const res = await fetch(GEMINI_BASE.replace(/\/$/, '') + '?pageSize=200', {
      headers: { 'x-goog-api-key': apiKey },
    });
    if (!res.ok) return [];
    const json = await res.json();
    const ver = (n) => {
      const m = n.match(/gemini-(\d+(?:\.\d+)?)/);
      return m ? parseFloat(m[1]) : 0;
    };
    return (json.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((n) => /flash/i.test(n) && !/(lite|image|tts|audio|live|thinking|exp|preview|embedding)/i.test(n))
      .sort((a, b) => ver(b) - ver(a));
  } catch {
    return [];
  }
}

/**
 * Calls Gemini generateContent. If the model is rejected, tries the model named in the
 * error, then the newest Flash model this key can see, then gemini-flash-latest.
 */
async function gemini(apiKey, { system, contents, json = true, temperature = 0.7 }) {
  const body = JSON.stringify({
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents,
    generationConfig: { temperature, ...(json ? { responseMimeType: 'application/json' } : {}) },
  });
  const attempt = (m) =>
    fetch(GEMINI_BASE + encodeURIComponent(m) + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body,
    });

  let model = workingModel;
  let res = await attempt(model);
  if (!res.ok && [400, 403, 404].includes(res.status)) {
    const err = await res.clone().json().catch(() => null);
    const msg = (err && err.error && err.error.message) || '';
    if (res.status === 404 || /model|not found|no longer available|not supported/i.test(msg)) {
      const candidates = [];
      (msg.match(/models\/([a-z0-9.\-]+)/gi) || [])
        .map((x) => x.replace(/^models\//i, ''))
        .forEach((x) => x !== model && !candidates.includes(x) && candidates.push(x));
      (await discoverFlashModels(apiKey)).forEach((x) => x !== model && !candidates.includes(x) && candidates.push(x));
      if (model !== 'gemini-flash-latest' && !candidates.includes('gemini-flash-latest')) {
        candidates.push('gemini-flash-latest');
      }
      for (const c of candidates.slice(0, 5)) {
        const r = await attempt(c);
        if (r.ok) {
          res = r;
          model = c;
          workingModel = c;
          break;
        }
      }
    }
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error((data && data.error && data.error.message) || 'Gemini HTTP ' + res.status);
    e.status = 502;
    throw e;
  }
  const text = ((data && data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts) || [])
    .map((p) => p.text || '')
    .join('');
  if (!text) {
    const reason =
      (data && data.promptFeedback && data.promptFeedback.blockReason) ||
      (data && data.candidates && data.candidates[0] && data.candidates[0].finishReason) ||
      'empty';
    const e = new Error('Gemini returned no text (' + reason + ').');
    e.status = 502;
    throw e;
  }
  return { text, model };
}

function keyFor(req) {
  // Server key first; otherwise the key the app sends in x-gemini-key (your own server, over HTTPS).
  const k = SERVER_KEY || String(req.get('x-gemini-key') || '').trim();
  if (!k) {
    const e = new Error('No Gemini key: set the GEMINI_API_KEY Codespaces secret, or add a key in the app.');
    e.status = 400;
    throw e;
  }
  return k;
}

function toContents(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
    .slice(-12)
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text.slice(0, 8000) }] }));
}

/* ------------------------------------------------------------------ */
/* Tasks: a fixed allow-list. No shell, no arbitrary code execution.   */
/* ------------------------------------------------------------------ */

const TASKS = {
  echo: {
    description: 'Round-trip test: returns what you sent plus server time.',
    run: async ({ payload }) => ({ received: payload ?? null, server_time: new Date().toISOString() }),
  },

  budget: {
    description: 'Totals a list of {label, amount} expenses against an income.',
    run: async ({ payload }) => {
      const income = Number(payload && payload.income) || 0;
      const items = Array.isArray(payload && payload.items) ? payload.items : [];
      const clean = items
        .map((i) => ({ label: String((i && i.label) || 'Item').slice(0, 60), amount: Number(i && i.amount) || 0 }))
        .filter((i) => i.amount !== 0);
      const total = clean.reduce((s, i) => s + i.amount, 0);
      const remaining = income - total;
      const top = [...clean].sort((a, b) => b.amount - a.amount).slice(0, 3);
      return {
        income,
        total: Math.round(total * 100) / 100,
        remaining: Math.round(remaining * 100) / 100,
        savings_rate_pct: income > 0 ? Math.max(0, Math.round((remaining / income) * 100)) : 0,
        biggest: top,
        verdict: income <= 0 ? 'Add an income to compare.' : remaining < 0 ? 'Over budget.' : 'Within budget.',
      };
    },
  },

  plan: {
    description: 'Turns a summary + checklist into a time-blocked plan (Gemini).',
    needsGemini: true,
    run: async ({ payload, apiKey }) => {
      const summary = String((payload && payload.summary) || '').slice(0, 1000);
      const checklist = Array.isArray(payload && payload.checklist)
        ? payload.checklist.map((x) => String(x).slice(0, 200)).slice(0, 10)
        : [];
      const startAt = String((payload && payload.start) || 'the next full hour');
      const { text, model } = await gemini(apiKey, {
        system:
          'You are a planning engine. Reply with ONLY strict JSON: {"blocks":[{"time":"HH:MM","minutes":number,"task":string}],"tip":string}. ' +
          'Use 15 to 90 minute blocks, realistic order, include short breaks.',
        contents: [
          {
            role: 'user',
            parts: [{ text: `Goal: ${summary}\nSteps: ${checklist.join('; ')}\nStart at: ${startAt}` }],
          },
        ],
        temperature: 0.4,
      });
      let parsed;
      try {
        parsed = JSON.parse(stripCodeFences(text));
      } catch {
        parsed = { blocks: [], tip: stripCodeFences(text) };
      }
      return { ...parsed, model };
    },
  },

  summarize: {
    description: 'Summarises text into a one-liner and key points (Gemini).',
    needsGemini: true,
    run: async ({ payload, apiKey }) => {
      const textIn = String((payload && payload.text) || '').slice(0, 20000);
      if (!textIn.trim()) throw Object.assign(new Error('payload.text is required'), { status: 400 });
      const { text, model } = await gemini(apiKey, {
        system: 'Reply with ONLY strict JSON: {"one_line_summary":string,"key_points":[string]} (3 to 6 points).',
        contents: [{ role: 'user', parts: [{ text: textIn }] }],
        temperature: 0.3,
      });
      let parsed;
      try {
        parsed = JSON.parse(stripCodeFences(text));
      } catch {
        parsed = { one_line_summary: stripCodeFences(text), key_points: [] };
      }
      return { ...parsed, model };
    },
  },
};

const runs = []; // in-memory, newest first; resets when the server restarts

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// CORS so the Expo web build / Snack can call it too. The native app doesn't need it.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-gemini-key');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Tiny request log.
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => console.log(`${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - t}ms)`));
  next();
});

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Auth for /api/*. Public Codespace ports are reachable by anyone with the URL,
// so set PULSE_TOKEN and enter the same token in the app.
app.use('/api', (req, res, next) => {
  if (!PULSE_TOKEN) return next();
  const header = String(req.get('authorization') || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (token && safeEqual(token, PULSE_TOKEN)) return next();
  res.status(401).json({ ok: false, error: 'Missing or wrong token.' });
});

app.get('/', (req, res) => res.redirect('/health'));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'pulse-os-backend',
    version: '1.0.0',
    uptime_s: Math.round(process.uptime()),
    started_at: STARTED_AT.toISOString(),
    gemini_key_on_server: Boolean(SERVER_KEY),
    auth_required: Boolean(PULSE_TOKEN),
    model: workingModel,
    public_url: publicUrl(),
  });
});

app.get('/api/info', (req, res) => {
  res.json({
    ok: true,
    tasks: Object.entries(TASKS).map(([type, t]) => ({ type, description: t.description, gemini: !!t.needsGemini })),
    model: workingModel,
  });
});

app.post('/api/chat', async (req, res, next) => {
  try {
    const apiKey = keyFor(req);
    const contents = toContents(req.body && req.body.messages);
    if (!contents.length || contents[contents.length - 1].role !== 'user') {
      return res.status(400).json({ ok: false, error: 'messages must end with a user message.' });
    }
    const context = String((req.body && req.body.context) || '').slice(0, 800).trim();
    const { text, model } = await gemini(apiKey, { system: SYSTEM_PROMPT + (context ? '\n' + context : ''), contents });
    res.json({ ok: true, reply: parsePulseReply(text), model, source: 'cloud' });
  } catch (e) {
    next(e);
  }
});

app.post('/api/task', async (req, res, next) => {
  const type = String((req.body && req.body.type) || '');
  const task = TASKS[type];
  if (!task) {
    return res.status(400).json({ ok: false, error: `Unknown task "${type}".`, available: Object.keys(TASKS) });
  }
  const run = {
    id: crypto.randomUUID(),
    type,
    status: 'running',
    created_at: new Date().toISOString(),
    finished_at: null,
    duration_ms: null,
    result: null,
    error: null,
  };
  runs.unshift(run);
  if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
  const t0 = Date.now();
  try {
    const apiKey = task.needsGemini ? keyFor(req) : null;
    run.result = await task.run({ payload: req.body && req.body.payload, apiKey });
    run.status = 'done';
  } catch (e) {
    run.status = 'failed';
    run.error = e.message || String(e);
    run.duration_ms = Date.now() - t0;
    run.finished_at = new Date().toISOString();
    return next(Object.assign(e, { run }));
  }
  run.duration_ms = Date.now() - t0;
  run.finished_at = new Date().toISOString();
  res.json({ ok: true, run });
});

app.get('/api/tasks', (req, res) => res.json({ ok: true, runs: runs.slice(0, 20) }));

app.get('/api/tasks/:id', (req, res) => {
  const run = runs.find((r) => r.id === req.params.id);
  if (!run) return res.status(404).json({ ok: false, error: 'Not found.' });
  res.json({ ok: true, run });
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'No such route.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ ok: false, error: err.message || 'Server error', run: err.run || undefined });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Pulse OS backend listening on :${PORT}`);
  console.log(`Public URL: ${publicUrl()}`);
  console.log(`Gemini key on server: ${SERVER_KEY ? 'yes' : 'no (app must send one)'}; token auth: ${PULSE_TOKEN ? 'on' : 'off'}`);
});
