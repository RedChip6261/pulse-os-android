/*
 * Pulse OS cloud backend v3.0 (Gemini flash-lite first + cloud computer with live MJPEG stream and SSE events)
 * ------------------------------------------------------------------------------------------------------------
 * Routes:
 *   GET  /health          -> liveness + config check
 *   GET  /api/info        -> server info, available task types
 *   POST /api/chat        -> Multimodal + Memory + Device Automation + Source Verification chat
 *   POST /api/analyze     -> Dedicated multimodal analyzer (image base64, document text, or video URL)
 *   POST /api/task        -> Run one named task (echo, budget, plan, summarize, verify_source, extract_actions)
 *   GET  /api/tasks       -> Recent task runs
 *   GET  /api/tasks/:id   -> Single task run
 *   /api/computer/*       -> cloud browser (see computer.js): /stream (MJPEG), /events (SSE), /state, /task, /act ...
 *
 * Auth: when PULSE_TOKEN is set every /api call needs "Authorization: Bearer <token>" or "?token=<token>"
 * (the query form exists for <img> and EventSource clients, which cannot set headers).
 * The server never runs shell commands or code sent by the app.
 */

'use strict';

const express = require('express');
const computer = require('./computer');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const SERVER_KEY = (process.env.GEMINI_API_KEY || '').trim();
const PULSE_TOKEN = (process.env.PULSE_TOKEN || '').trim();
// Fastest first. Never gemini-2.x / 1.x (2.5 reroutes on Dec 1 2026) and never pro models.
const FORBIDDEN_MODEL = /(gemini-(1|2)\.|(^|-)pro($|-)|gemini-pro)/i;
const ENV_MODEL = (process.env.GEMINI_MODEL || '').trim();
const DEFAULT_MODEL = ENV_MODEL && !FORBIDDEN_MODEL.test(ENV_MODEL) ? ENV_MODEL : 'gemini-flash-lite-latest';
const FALLBACK_MODELS = ['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-3.5-flash-lite', 'gemini-3.5-flash'];
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const STARTED_AT = new Date();
const MAX_RUNS = 100;

const SYSTEM_PROMPT = [
  'You are Pulse, a fast, capable personal assistant in the Pulse OS phone app (user in India, times in IST unless told otherwise).',
  'Answer first, in as few words as the question needs; then only the detail that helps. No filler, no repeating the question.',
  'Images: describe, read text, answer the question. Files: key facts first. Never invent facts, prices or dates; say when unsure.',
  'Use the memory profile quietly to personalise; do not recite it.',
  'You MUST reply with ONLY a single strict JSON object with these keys:',
  '"direct_response": string (clear, structured answer without filler);',
  '"proactive_checklist": array of 2 to 5 short strings (follow-up actions);',
  '"one_line_summary": string (single short sentence summary);',
  '"extracted_actions": array of objects {"type": "task" | "calendar" | "reminder" | "app_workflow", "title": string, "when": string, "app": string, "requires_confirmation": boolean};',
  '"memory_updates": array of short strings (new user facts/preferences worth remembering across sessions);',
  '"source_verification": {"status": "verified" | "needs_review" | "not_applicable", "confidence": "high" | "medium" | "low", "notes": string}.',
].join('\n');

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
    return {
      direct_response: cleaned || 'No response received.',
      proactive_checklist: [],
      one_line_summary: '',
      extracted_actions: [],
      memory_updates: [],
      source_verification: { status: 'not_applicable', confidence: 'high', notes: '' },
    };
  }
  return {
    direct_response: String(obj.direct_response ?? '').trim() || cleaned,
    proactive_checklist: Array.isArray(obj.proactive_checklist)
      ? obj.proactive_checklist.map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
      : [],
    one_line_summary: String(obj.one_line_summary ?? '').trim(),
    extracted_actions: Array.isArray(obj.extracted_actions) ? obj.extracted_actions.slice(0, 8) : [],
    memory_updates: Array.isArray(obj.memory_updates)
      ? obj.memory_updates.map((x) => String(x).trim()).filter(Boolean).slice(0, 5)
      : [],
    source_verification:
      obj.source_verification && typeof obj.source_verification === 'object'
        ? {
            status: String(obj.source_verification.status || 'verified'),
            confidence: String(obj.source_verification.confidence || 'high'),
            notes: String(obj.source_verification.notes || ''),
          }
        : { status: 'not_applicable', confidence: 'high', notes: '' },
  };
}

let workingModel = DEFAULT_MODEL;

// Lite models: near-off thinking. Other flash models: low. Retried without it if a model rejects the field.
function thinkingConfigFor(model) {
  if (FORBIDDEN_MODEL.test(model)) return undefined;
  return /lite/i.test(model) ? { thinkingLevel: 'minimal' } : { thinkingLevel: 'low' };
}

async function gemini(apiKey, { system, contents, json = true, temperature = 0.4, timeoutMs = 12000 }) {
  const buildBody = (m, includeThinking = true) => {
    const thinking = includeThinking ? thinkingConfigFor(m) : undefined;
    return JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: 2048,
        ...(json ? { responseMimeType: 'application/json' } : {}),
        ...(thinking ? { thinkingConfig: thinking } : {}),
      },
    });
  };

  const attempt = async (m, includeThinking = true) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(GEMINI_BASE + encodeURIComponent(m) + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: buildBody(m, includeThinking),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const candidates = [workingModel, ...FALLBACK_MODELS.filter((m) => m !== workingModel)].filter((m) => !FORBIDDEN_MODEL.test(m));
  let lastData = null;
  let lastStatus = 502;

  for (const candidate of candidates) {
    try {
      let res = await attempt(candidate, true);
      if (res.status === 400 && thinkingConfigFor(candidate)) {
        res = await attempt(candidate, false);
      }
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const text = ((data && data.candidates && data.candidates[0] && data.candidates[0].content &&
          data.candidates[0].content.parts) || [])
          .filter((p) => !p.thought)
          .map((p) => p.text || '')
          .join('');
        if (text) {
          workingModel = candidate;
          return { text, model: candidate };
        }
      }
      lastStatus = res.status;
      lastData = await res.clone().json().catch(() => null);
      if (res.status === 401) break;
    } catch (err) {
      lastData = { error: { message: err.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : err.message } };
    }
  }

  const msg = (lastData && lastData.error && lastData.error.message) || 'Gemini HTTP ' + lastStatus;
  const e = new Error(msg);
  e.status = 502;
  throw e;
}

function keyFor(req) {
  const k = SERVER_KEY || String(req.get('x-gemini-key') || '').trim();
  if (!k) {
    const e = new Error('No Gemini key: set GEMINI_API_KEY secret or add a key in the app.');
    e.status = 400;
    throw e;
  }
  return k;
}

function toContents(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-10)
    .map((m) => {
      const parts = [];
      if (typeof m.text === 'string' && m.text.trim()) {
        parts.push({ text: m.text.slice(0, 12000) });
      }
      if (m.inlineData && m.inlineData.data && m.inlineData.mimeType) {
        parts.push({
          inlineData: {
            mimeType: String(m.inlineData.mimeType),
            data: String(m.inlineData.data),
          },
        });
      }
      if (!parts.length) parts.push({ text: '' });
      return { role: m.role === 'user' ? 'user' : 'model', parts };
    });
}

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
        contents: [{ role: 'user', parts: [{ text: `Goal: ${summary}\nSteps: ${checklist.join('; ')}\nStart at: ${startAt}` }] }],
        temperature: 0.3,
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
    description: 'Summarises documents, files, or transcripts + extracts actions & verifies sources (Gemini).',
    needsGemini: true,
    run: async ({ payload, apiKey }) => {
      const textIn = String((payload && payload.text) || '').slice(0, 25000);
      if (!textIn.trim()) throw Object.assign(new Error('payload.text is required'), { status: 400 });
      const { text, model } = await gemini(apiKey, {
        system:
          'Reply with ONLY strict JSON: {"one_line_summary":string,"key_points":[string],"extracted_actions":[{"type":"task"|"calendar"|"reminder","title":string,"when":string}],"source_verification":{"status":"verified"|"needs_review","confidence":"high"|"medium"|"low","notes":string}}.',
        contents: [{ role: 'user', parts: [{ text: textIn }] }],
        temperature: 0.2,
      });
      let parsed;
      try {
        parsed = JSON.parse(stripCodeFences(text));
      } catch {
        parsed = { one_line_summary: stripCodeFences(text), key_points: [], extracted_actions: [] };
      }
      return { ...parsed, model };
    },
  },
};

const runs = [];

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-gemini-key');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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

app.use('/api', (req, res, next) => {
  if (!PULSE_TOKEN) return next();
  const header = String(req.get('authorization') || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.query.token || '').trim();
  if (token && safeEqual(token, PULSE_TOKEN)) return next();
  res.status(401).json({ ok: false, error: 'Missing or wrong token.' });
});

app.get('/', (req, res) => res.redirect('/health'));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'pulse-os-backend',
    version: '3.0.0',
    uptime_s: Math.round(process.uptime()),
    started_at: STARTED_AT.toISOString(),
    gemini_key_on_server: Boolean(SERVER_KEY),
    auth_required: Boolean(PULSE_TOKEN),
    computer: computer.computerAvailable() && Boolean(PULSE_TOKEN),
    computer_features: ['stream', 'events', 'wake'],
    model: workingModel,
    agent_models: computer.agentModels(),
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
    const context = String((req.body && req.body.context) || '').slice(0, 2000).trim();
    const memory = String((req.body && req.body.memory) || '').slice(0, 2000).trim();
    const fullSystem = [
      SYSTEM_PROMPT,
      memory ? `USER SMART MEMORY PROFILE:\n${memory}` : '',
      context ? `ACTIVE DEVICE & MULTIMODAL CONTEXT:\n${context}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const { text, model } = await gemini(apiKey, { system: fullSystem, contents });
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

app.use('/api/computer', computer.router({ keyFor, token: PULSE_TOKEN }));

app.use((req, res) => res.status(404).json({ ok: false, error: 'No such route.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ ok: false, error: err.message || 'Server error', run: err.run || undefined });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Pulse OS backend v3.0 listening on :${PORT}`);
  console.log(`Public URL: ${publicUrl()}`);
});
