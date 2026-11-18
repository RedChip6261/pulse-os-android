/*
 * Pulse OS cloud computer
 * -----------------------
 * A real Chromium browser running inside the Codespace, driven by a Gemini agent
 * or by taps from the phone. The phone watches it through /api/computer/screen.jpg.
 *
 * Routes (mounted under /api/computer, PULSE_TOKEN required):
 *   GET  /state            -> status, url, title, step log, pending question
 *   GET  /screen.jpg       -> latest screenshot (JPEG)
 *   POST /task   {goal}    -> start the agent on a goal
 *   POST /answer {text}    -> answer the agent's question / approve a final step
 *   POST /stop             -> stop the agent
 *   POST /act    {type,..} -> manual control: navigate|tap|type|key|scroll|back|forward|reload
 *   POST /reset            -> close the browser (logins in the profile are kept)
 *
 * Safety rules the agent cannot override:
 *   - never types into password, one-time-code or card fields (the user types those via /act)
 *   - a click on a final pay / order / book / send / delete button waits for the user's "yes"
 */

'use strict';

const path = require('path');
const express = require('express');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch {
  chromium = null;
}

const VIEWPORT = { width: 412, height: 860 };
const PROFILE_DIR = process.env.PULSE_BROWSER_PROFILE || path.join(__dirname, '.browser-profile');
const IDLE_CLOSE_MS = 20 * 60 * 1000;
const MAX_STEPS = 25;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const HOME_URL = 'https://www.google.com/';

const FINAL_RE =
  /\b(pay|pay now|place (your )?order|buy now|confirm (order|booking|purchase|payment)|book now|complete (purchase|booking|order)|send|post|publish|delete|transfer|submit payment|checkout now)\b/i;
const SECRET_FIELD_RE = /(pass(word|code)?|otp|one.?time|verification code|cvv|cvc|card.?number|cc-?(number|csc|exp)|security code|pin\b)/i;

const state = {
  status: 'off', // off | idle | running | waiting | done | error
  goal: '',
  url: '',
  title: '',
  steps: [], // {n, at, action, detail}
  question: '',
  answer: '',
  pending: null, // a held final click {id, label}
  error: '',
  model: '',
  updatedAt: Date.now(),
};

let context = null;
let page = null;
let lastUse = Date.now();
let stopFlag = false;
let answerWaiter = null;
let shotCache = { at: 0, buf: null };
let launching = null;

function touch() {
  lastUse = Date.now();
  state.updatedAt = Date.now();
}

function log(action, detail) {
  state.steps.push({ n: state.steps.length + 1, at: new Date().toISOString(), action, detail: String(detail || '').slice(0, 300) });
  if (state.steps.length > 80) state.steps.splice(0, state.steps.length - 80);
  touch();
}

async function ensureBrowser() {
  if (page && !page.isClosed()) return page;
  if (!chromium) {
    const e = new Error('Playwright is not installed on the server. Run: cd server && npm install && npx playwright install --with-deps chromium');
    e.status = 503;
    throw e;
  }
  if (!launching) {
    launching = (async () => {
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: true,
        viewport: VIEWPORT,
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        locale: 'en-IN',
        userAgent:
          'Mozilla/5.0 (Linux; Android 14; CPH2609) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      context.on('close', () => {
        context = null;
        page = null;
        state.status = 'off';
      });
      page = context.pages()[0] || (await context.newPage());
      context.on('page', (p) => {
        page = p; // follow new tabs
      });
      if (page.url() === 'about:blank') await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
      if (state.status === 'off') state.status = 'idle';
      log('browser', 'Cloud browser started');
    })().finally(() => {
      launching = null;
    });
  }
  await launching;
  return page;
}

async function refreshMeta() {
  if (!page || page.isClosed()) return;
  state.url = page.url();
  state.title = await page.title().catch(() => '');
}

async function screenshot(force) {
  const p = await ensureBrowser();
  if (!force && shotCache.buf && Date.now() - shotCache.at < 400) return shotCache.buf;
  const buf = await p.screenshot({ type: 'jpeg', quality: 55, scale: 'css' });
  shotCache = { at: Date.now(), buf };
  return buf;
}

// Tags visible interactive elements with data-pulse-id and returns a compact list.
const SNAPSHOT_FN = () => {
  document.querySelectorAll('[data-pulse-id]').forEach((el) => el.removeAttribute('data-pulse-id'));
  const sel = 'a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[contenteditable=true],[onclick],summary,label[for]';
  const out = [];
  let n = 0;
  for (const el of Array.from(document.querySelectorAll(sel))) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    n += 1;
    el.setAttribute('data-pulse-id', String(n));
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const label =
      (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
    const attrs = [el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('autocomplete'), el.getAttribute('placeholder'), el.getAttribute('aria-label')]
      .filter(Boolean)
      .join(' ')
      .slice(0, 120);
    out.push({ id: n, tag, type, label, attrs, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    if (n >= 120) break;
  }
  const text = (document.body ? document.body.innerText : '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').slice(0, 3500);
  return { elements: out, text };
};

async function snapshot() {
  const p = await ensureBrowser();
  await refreshMeta();
  const snap = await p.evaluate(SNAPSHOT_FN).catch(() => ({ elements: [], text: '' }));
  return snap;
}

function isSecretField(el) {
  if (!el) return false;
  if (el.type === 'password') return true;
  return SECRET_FIELD_RE.test(`${el.attrs} ${el.label}`);
}

/* ------------------------------ Gemini ------------------------------ */

let modelList = null;
async function pickModels(apiKey) {
  const prefer = (process.env.GEMINI_MODEL || '').trim();
  if (!modelList) {
    try {
      const r = await fetch(`${GEMINI_BASE}?key=${encodeURIComponent(apiKey)}&pageSize=200`);
      const j = await r.json();
      modelList = (j.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => String(m.name || '').replace(/^models\//, ''))
        .filter((n) => /flash/.test(n) && !/(image|tts|audio|live|embedding|preview-tts)/.test(n));
    } catch {
      modelList = [];
    }
  }
  const ordered = [prefer, 'gemini-flash-latest', 'gemini-flash-lite-latest', ...modelList].filter(Boolean);
  return Array.from(new Set(ordered));
}

const cooldown = new Map();
async function geminiJSON(apiKey, system, parts) {
  const models = await pickModels(apiKey);
  let lastErr = null;
  for (const model of models) {
    const until = cooldown.get(model) || 0;
    if (until > Date.now()) continue;
    try {
      const r = await fetch(`${GEMINI_BASE}${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 600 },
        }),
        signal: AbortSignal.timeout(30000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        cooldown.set(model, Date.now() + (r.status === 404 ? 3600e3 : r.status === 429 ? 60e3 : 30e3));
        lastErr = new Error((j.error && j.error.message) || `Gemini HTTP ${r.status}`);
        continue;
      }
      const text = ((j.candidates || [])[0]?.content?.parts || []).map((p) => p.text || '').join('');
      state.model = model;
      const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
      const a = cleaned.indexOf('{');
      const b = cleaned.lastIndexOf('}');
      return JSON.parse(a >= 0 && b > a ? cleaned.slice(a, b + 1) : cleaned);
    } catch (e) {
      lastErr = e;
      cooldown.set(model, Date.now() + 30e3);
    }
  }
  throw lastErr || new Error('No Gemini model available.');
}

const AGENT_PROMPT = [
  'You operate a real mobile Chrome browser for the user, one action per turn.',
  'You get: the goal, a screenshot, the numbered interactive elements (id, tag, type, label, attrs), the page text, and your previous actions.',
  'Reply with ONE JSON object: {"action": ..., "id": number?, "text": string?, "url": string?, "direction": "up"|"down"?, "key": string?, "reason": short string}',
  'Actions: "navigate" (url), "click" (id), "type" (id, text; set "submit": true to press Enter), "scroll" (direction), "key" (key such as Enter, Escape),',
  '"back", "wait", "ask" (text = question for the user, e.g. which option, or to type a login/OTP/card themselves), "done" (text = the final answer for the user, concise, with the facts found).',
  'Rules: never type passwords, OTPs, PINs or card details: use "ask" so the user types them. Do not invent personal data; ask for it.',
  'For search, prefer navigating straight to a search URL (e.g. https://www.google.com/search?q=...).',
  'Close cookie banners and popups when they block the page. Finish with "done" as soon as the goal is met. If stuck after a few tries, "ask".',
].join('\n');

/* ------------------------------ Actions ------------------------------ */

async function clickId(p, id) {
  const loc = p.locator(`[data-pulse-id="${Number(id)}"]`).first();
  await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => undefined);
  await loc.click({ timeout: 5000 });
}

async function settle(p) {
  await p.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => undefined);
  await p.waitForTimeout(600);
}

function waitForAnswer(question) {
  state.status = 'waiting';
  state.question = question;
  log('ask', question);
  return new Promise((resolve) => {
    answerWaiter = resolve;
  });
}

async function runAgent(goal, apiKey) {
  stopFlag = false;
  state.goal = goal;
  state.status = 'running';
  state.question = '';
  state.answer = '';
  state.error = '';
  state.pending = null;
  log('goal', goal);
  const history = [];
  try {
    const p = await ensureBrowser();
    for (let step = 1; step <= MAX_STEPS; step++) {
      if (stopFlag) {
        log('stopped', 'Stopped by you');
        state.status = 'idle';
        return;
      }
      const snap = await snapshot();
      const shot = await screenshot(true);
      const parts = [
        {
          text:
            `GOAL: ${goal}\nURL: ${state.url}\nTITLE: ${state.title}\n` +
            `PREVIOUS ACTIONS:\n${history.slice(-10).join('\n') || '(none)'}\n` +
            `ELEMENTS:\n${snap.elements.map((e) => `[${e.id}] ${e.tag}${e.type ? `(${e.type})` : ''} "${e.label}" ${e.attrs ? `{${e.attrs}}` : ''}`).join('\n')}\n` +
            `PAGE TEXT:\n${snap.text}`,
        },
        { inlineData: { mimeType: 'image/jpeg', data: shot.toString('base64') } },
      ];
      const act = await geminiJSON(apiKey, AGENT_PROMPT, parts);
      if (stopFlag) continue;
      const a = String(act.action || '').toLowerCase();
      const el = snap.elements.find((e) => e.id === Number(act.id));
      history.push(`${step}. ${a} ${act.id ?? ''} ${act.url || ''} ${act.text ? JSON.stringify(String(act.text).slice(0, 60)) : ''} - ${act.reason || ''}`);

      try {
        if (a === 'navigate' && act.url) {
          const url = /^https?:\/\//i.test(act.url) ? act.url : `https://${act.url}`;
          log('open', url);
          await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } else if (a === 'click' && el) {
          if (FINAL_RE.test(el.label)) {
            const reply = await waitForAnswer(`Ready to press "${el.label}". Reply yes to go ahead, or tell me what to change.`);
            state.status = 'running';
            state.question = '';
            if (!/^\s*(y|yes|ok|okay|go|go ahead|confirm|haan|ha)\b/i.test(reply)) {
              history.push(`user said: ${reply}`);
              continue;
            }
          }
          log('click', el.label || `#${el.id}`);
          await clickId(p, el.id);
        } else if (a === 'type' && el) {
          if (isSecretField(el)) {
            const reply = await waitForAnswer(
              `"${el.label || 'This field'}" needs a password, code or card detail. Type it yourself in the Computer tab, then reply "done".`
            );
            state.status = 'running';
            state.question = '';
            history.push(`user handled the secret field and said: ${reply}`);
            continue;
          }
          log('type', `${el.label || `#${el.id}`}: ${String(act.text || '').slice(0, 60)}`);
          const loc = p.locator(`[data-pulse-id="${el.id}"]`).first();
          await loc.fill(String(act.text || ''), { timeout: 5000 }).catch(async () => {
            await loc.click({ timeout: 3000 });
            await p.keyboard.type(String(act.text || ''), { delay: 15 });
          });
          if (act.submit) await p.keyboard.press('Enter');
        } else if (a === 'scroll') {
          log('scroll', act.direction || 'down');
          await p.mouse.wheel(0, act.direction === 'up' ? -600 : 600);
        } else if (a === 'key' && act.key) {
          log('key', act.key);
          await p.keyboard.press(String(act.key));
        } else if (a === 'back') {
          log('back', '');
          await p.goBack({ timeout: 10000 }).catch(() => undefined);
        } else if (a === 'wait') {
          log('wait', act.reason || '');
          await p.waitForTimeout(1500);
        } else if (a === 'ask') {
          const reply = await waitForAnswer(String(act.text || 'What should I do next?'));
          state.status = 'running';
          state.question = '';
          history.push(`user answered: ${reply}`);
          continue;
        } else if (a === 'done') {
          state.answer = String(act.text || 'Done.');
          log('done', state.answer);
          state.status = 'done';
          await refreshMeta();
          return;
        } else {
          history.push(`(invalid action, element ${act.id} not found)`);
          log('retry', 'Invalid action, re-reading the page');
        }
      } catch (e) {
        history.push(`(action failed: ${String(e.message || e).slice(0, 120)})`);
        log('error', String(e.message || e).slice(0, 160));
      }
      await settle(p);
      shotCache.at = 0;
    }
    state.status = 'done';
    state.answer = 'I hit the step limit. Tell me how to continue.';
    log('done', state.answer);
  } catch (e) {
    state.status = 'error';
    state.error = e.message || String(e);
    log('error', state.error);
  }
}

/* ------------------------------ Router ------------------------------ */

function router({ keyFor, token }) {
  const r = express.Router();

  r.use((req, res, next) => {
    if (!token) {
      return res.status(403).json({
        ok: false,
        error: 'The cloud computer needs PULSE_TOKEN set on the server (Codespace secret) and the same token in the app.',
      });
    }
    touch();
    next();
  });

  r.get('/state', async (req, res) => {
    await refreshMeta().catch(() => undefined);
    res.json({ ok: true, ...state, pending: undefined, steps: state.steps.slice(-30), browser: Boolean(page && !page.isClosed()) });
  });

  r.get('/screen.jpg', async (req, res, next) => {
    try {
      const buf = await screenshot(false);
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'no-store');
      res.send(buf);
    } catch (e) {
      next(e);
    }
  });

  r.post('/task', async (req, res, next) => {
    try {
      const goal = String((req.body && req.body.goal) || '').trim().slice(0, 1000);
      if (!goal) return res.status(400).json({ ok: false, error: 'Tell me what to do.' });
      if (state.status === 'running' || state.status === 'waiting') {
        return res.status(409).json({ ok: false, error: 'Already working on a task. Stop it first.' });
      }
      const apiKey = keyFor(req);
      await ensureBrowser();
      runAgent(goal, apiKey); // runs in the background; the phone polls /state
      res.json({ ok: true, status: 'running' });
    } catch (e) {
      next(e);
    }
  });

  r.post('/answer', (req, res) => {
    const text = String((req.body && req.body.text) || '').trim();
    if (!answerWaiter) return res.status(409).json({ ok: false, error: 'Nothing is waiting for an answer.' });
    const w = answerWaiter;
    answerWaiter = null;
    log('you', text);
    w(text || 'yes');
    res.json({ ok: true });
  });

  r.post('/stop', (req, res) => {
    stopFlag = true;
    if (answerWaiter) {
      const w = answerWaiter;
      answerWaiter = null;
      w('stop');
    }
    state.status = page ? 'idle' : 'off';
    state.question = '';
    log('stopped', 'Stopped by you');
    res.json({ ok: true });
  });

  r.post('/act', async (req, res, next) => {
    try {
      const p = await ensureBrowser();
      const b = req.body || {};
      const type = String(b.type || '');
      if (type === 'navigate') {
        const raw = String(b.url || '').trim();
        const url = /^https?:\/\//i.test(raw) ? raw : /\s/.test(raw) || !raw.includes('.') ? `https://www.google.com/search?q=${encodeURIComponent(raw)}` : `https://${raw}`;
        log('open', url);
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } else if (type === 'tap') {
        const x = Math.max(0, Math.min(1, Number(b.x))) * VIEWPORT.width;
        const y = Math.max(0, Math.min(1, Number(b.y))) * VIEWPORT.height;
        log('tap', `${Math.round(x)},${Math.round(y)}`);
        await p.mouse.click(x, y);
      } else if (type === 'type') {
        // Typed by the user themselves, so secret fields are allowed here. Never logged.
        await p.keyboard.type(String(b.text || ''), { delay: 10 });
        log('type', '(your text)');
        if (b.submit) await p.keyboard.press('Enter');
      } else if (type === 'key') {
        await p.keyboard.press(String(b.key || 'Enter'));
      } else if (type === 'scroll') {
        await p.mouse.wheel(0, b.direction === 'up' ? -600 : 600);
      } else if (type === 'back') {
        await p.goBack({ timeout: 10000 }).catch(() => undefined);
      } else if (type === 'forward') {
        await p.goForward({ timeout: 10000 }).catch(() => undefined);
      } else if (type === 'reload') {
        await p.reload({ timeout: 20000 }).catch(() => undefined);
      } else {
        return res.status(400).json({ ok: false, error: `Unknown action "${type}".` });
      }
      await settle(p);
      shotCache.at = 0;
      await refreshMeta();
      res.json({ ok: true, url: state.url, title: state.title });
    } catch (e) {
      next(e);
    }
  });

  r.post('/reset', async (req, res) => {
    stopFlag = true;
    if (context) await context.close().catch(() => undefined);
    context = null;
    page = null;
    state.status = 'off';
    state.steps = [];
    res.json({ ok: true });
  });

  return r;
}

// Close the browser when nobody has used it for a while (keeps the Codespace light).
setInterval(() => {
  if (context && Date.now() - lastUse > IDLE_CLOSE_MS && state.status !== 'running' && state.status !== 'waiting') {
    context.close().catch(() => undefined);
    context = null;
    page = null;
    state.status = 'off';
  }
}, 60000).unref();

module.exports = { router, computerAvailable: () => Boolean(chromium) };
