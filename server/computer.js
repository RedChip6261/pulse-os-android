/*
 * Pulse OS cloud computer (v3)
 * ----------------------------
 * A real Chromium browser running inside the Codespace, driven by a Gemini agent
 * or by taps from the phone.
 *
 * Routes (mounted under /api/computer, PULSE_TOKEN required; send it as
 * "Authorization: Bearer <token>" or as ?token=<token> for <img>/EventSource clients):
 *   GET  /stream           -> live screen, multipart/x-mixed-replace MJPEG. A frame is pushed only when
 *                             the page repaints (CDP screencast) plus a keep-alive frame every ~1.5 s.
 *                             Query: w=<frame width px, 320..828, default 412>, q=<jpeg quality 30..80, default 55>
 *   GET  /events           -> Server-Sent Events. "state" events carry {status, goal, url, title, steps,
 *                             question, answer, error, model, browser}.
 *   GET  /state            -> same state as JSON (kept for older apps)
 *   GET  /screen.jpg       -> latest screenshot (JPEG, kept for older apps)
 *   POST /wake             -> start the browser if it is asleep
 *   POST /task   {goal}    -> start the agent on a goal
 *   POST /answer {text}    -> answer the agent's question / approve a final step
 *   POST /stop             -> stop the agent
 *   POST /act    {type,..} -> manual control: navigate|tap|type|key|scroll|back|forward|reload
 *   POST /reset            -> close the browser (logins in the profile are kept)
 *
 * Safety rules the agent cannot override:
 *   - never types into password, one-time-code, PIN or card fields (the user types those via /act)
 *   - a click on a final pay / order / book / send / delete button waits for the user's "yes"
 *   - no shell or code execution of any kind
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
const MAX_STEPS = 30;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const HOME_URL = 'https://www.google.com/';
const BOUNDARY = 'pulseframe';
const KEEPALIVE_FRAME_MS = 1500;
const MIN_FRAME_GAP_MS = 90; // at most ~11 fps to the phone
const MAX_TABS = 3;

// Agent models: fastest first. Never gemini-2.x / 1.x (2.5 reroutes on Dec 1 2026) and never pro.
const AGENT_MODELS = ['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-3.5-flash-lite', 'gemini-3.5-flash'];
const FORBIDDEN_MODEL = /(gemini-(1|2)\.|(^|-)pro($|-)|gemini-pro)/i;

const FINAL_RE =
  /\b(pay|pay now|proceed to pay|make payment|place (your )?order|order now|buy now|purchase|confirm (order|booking|purchase|payment|and pay)|book now|book (ticket|tickets|seat|seats|table|ride)|reserve|complete (purchase|booking|order)|send|post|publish|tweet|delete|remove account|transfer|submit payment|submit order|checkout now|donate|subscribe)\b/i;
const SECRET_FIELD_RE =
  /(pass(word|code|phrase)?|otp|one.?time|verification.?code|auth.?code|security.?code|cvv|cvc|csc|card.?(number|no)|cc-?(number|csc|exp)|expir|\bm?pin\b|tpin|upi.?pin)/i;
const MESSAGE_FIELD_RE = /(message|comment|reply|chat|tweet|compose|post)/i;
const YES_RE = /^\s*(y|yes|ok|okay|go|go ahead|confirm|sure|haan|ha|avunu)\b/i;

const state = {
  status: 'off', // off | idle | running | waiting | done | error
  goal: '',
  url: '',
  title: '',
  steps: [], // {n, at, action, detail}
  question: '',
  answer: '',
  pending: null,
  error: '',
  model: '',
  updatedAt: Date.now(),
};

let context = null;
let page = null; // the page the user sees and the agent drives
let lastUse = Date.now();
let stopFlag = false;
let runAbort = null;
let answerWaiter = null;
let launching = null;

/* ------------------------------ Events (SSE) ------------------------------ */

const sseClients = new Set();
let emitTimer = null;

function publicState() {
  return {
    ok: true,
    status: state.status,
    goal: state.goal,
    url: state.url,
    title: state.title,
    steps: state.steps.slice(-30),
    question: state.question,
    answer: state.answer,
    error: state.error,
    model: state.model,
    updatedAt: state.updatedAt,
    browser: Boolean(page && !page.isClosed()),
  };
}

function emit() {
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = null;
    if (!sseClients.size) return;
    const data = `event: state\ndata: ${JSON.stringify(publicState())}\n\n`;
    for (const res of sseClients) res.write(data);
  }, 60);
}

function touch() {
  lastUse = Date.now();
  state.updatedAt = Date.now();
  emit();
}

function log(action, detail) {
  state.steps.push({ n: state.steps.length ? state.steps[state.steps.length - 1].n + 1 : 1, at: new Date().toISOString(), action, detail: String(detail || '').slice(0, 300) });
  if (state.steps.length > 80) state.steps.splice(0, state.steps.length - 80);
  touch();
}

/* ------------------------------ Live frames (MJPEG) ------------------------------ */

const viewers = new Set(); // {res, busy, pending, lastSent, w}
const frame = { buf: null, at: 0 };
let cast = null; // {page, cdp, width, quality} or {page, poll}
let pushTimer = null;
let lastPush = 0;

function writeFrame(v, buf) {
  if (!buf || v.res.writableEnded) return;
  if (v.busy) {
    v.pending = true; // the phone is behind; send only the newest frame once it catches up
    return;
  }
  v.res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
  v.res.write(buf);
  const ok = v.res.write('\r\n');
  v.lastSent = Date.now();
  if (!ok) {
    v.busy = true;
    v.res.once('drain', () => {
      v.busy = false;
      if (v.pending) {
        v.pending = false;
        writeFrame(v, frame.buf);
      }
    });
  }
}

function pushFrame(buf) {
  frame.buf = buf;
  frame.at = Date.now();
  const gap = Date.now() - lastPush;
  if (gap >= MIN_FRAME_GAP_MS) {
    lastPush = Date.now();
    for (const v of viewers) writeFrame(v, buf);
  } else if (!pushTimer) {
    pushTimer = setTimeout(() => {
      pushTimer = null;
      lastPush = Date.now();
      for (const v of viewers) writeFrame(v, frame.buf);
    }, MIN_FRAME_GAP_MS - gap);
  }
}

function castSize() {
  let w = 412;
  let q = 55;
  for (const v of viewers) {
    w = Math.max(w, v.w);
    q = Math.max(q, v.q);
  }
  return { w, q };
}

async function stopCast() {
  const c = cast;
  cast = null;
  if (!c) return;
  if (c.poll) clearInterval(c.poll);
  if (c.cdp) {
    await c.cdp.send('Page.stopScreencast').catch(() => undefined);
    await c.cdp.detach().catch(() => undefined);
  }
}

async function startCast() {
  if (!viewers.size || !page || page.isClosed() || !context) return;
  const { w, q } = castSize();
  if (cast && cast.page === page && cast.width === w && cast.quality === q) return;
  await stopCast();
  const p = page;
  const width = w;
  const height = Math.round((w * VIEWPORT.height) / VIEWPORT.width);
  try {
    const cdp = await context.newCDPSession(p);
    cast = { page: p, cdp, width: w, quality: q };
    cdp.on('Page.screencastFrame', (evt) => {
      cdp.send('Page.screencastFrameAck', { sessionId: evt.sessionId }).catch(() => undefined);
      if (cast && cast.cdp === cdp) pushFrame(Buffer.from(evt.data, 'base64'));
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: q, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
  } catch (e) {
    // Fallback: poll screenshots and push only when the image changed.
    console.warn('screencast unavailable, polling instead:', e.message || e);
    let last = null;
    const poll = setInterval(async () => {
      if (!page || page.isClosed()) return;
      const buf = await page.screenshot({ type: 'jpeg', quality: q, scale: 'css' }).catch(() => null);
      if (buf && (!last || !buf.equals(last))) {
        last = buf;
        pushFrame(buf);
      }
    }, 350);
    cast = { page: p, poll, width: w, quality: q };
  }
  // Paint the first frame immediately (screencast only fires on the next repaint).
  p.screenshot({ type: 'jpeg', quality: q, scale: 'css' })
    .then((buf) => pushFrame(buf))
    .catch(() => undefined);
}

// Keep-alive frame: some MJPEG decoders only show a part once the next one starts.
setInterval(() => {
  if (!viewers.size || !frame.buf) return;
  const now = Date.now();
  for (const v of viewers) if (now - v.lastSent >= KEEPALIVE_FRAME_MS) writeFrame(v, frame.buf);
}, 500).unref();

/* ------------------------------ Browser ------------------------------ */

function setCurrentPage(p) {
  if (!p || p.isClosed()) return;
  page = p;
  p.on('framenavigated', (f) => {
    if (f === p.mainFrame() && p === page) {
      state.url = p.url();
      touch();
    }
  });
  p.on('close', () => {
    if (page !== p || !context) return;
    const open = context.pages().filter((x) => !x.isClosed());
    page = open[open.length - 1] || null;
    if (page) {
      startCast().catch(() => undefined);
      refreshMeta().catch(() => undefined);
    }
    touch();
  });
  startCast().catch(() => undefined);
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
        timezoneId: process.env.PULSE_TIMEZONE || 'Asia/Kolkata',
        userAgent:
          'Mozilla/5.0 (Linux; Android 14; CPH2609) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
      });
      context.on('close', () => {
        context = null;
        page = null;
        stopCast().catch(() => undefined);
        state.status = 'off';
        touch();
      });
      // Reuse one page: close any extra tabs restored from the profile.
      const pages = context.pages();
      for (const extra of pages.slice(1)) await extra.close().catch(() => undefined);
      setCurrentPage(pages[0] || (await context.newPage()));
      context.on('page', (p) => {
        // A site opened a new tab (target=_blank / popup): follow it, keep at most MAX_TABS open.
        setCurrentPage(p);
        const open = context.pages().filter((x) => !x.isClosed());
        for (const old of open.slice(0, Math.max(0, open.length - MAX_TABS))) old.close().catch(() => undefined);
      });
      // Do not block wake-up on the home page loading; the live stream shows it as it paints.
      if (page.url() === 'about:blank') page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
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
  const url = page.url();
  const title = await page.title().catch(() => '');
  if (url !== state.url || title !== state.title) {
    state.url = url;
    state.title = title;
    touch();
  }
}

async function screenshot(maxAgeMs = 400) {
  const p = await ensureBrowser();
  if (frame.buf && Date.now() - frame.at < maxAgeMs) return frame.buf;
  const buf = await p.screenshot({ type: 'jpeg', quality: 55, scale: 'css' });
  frame.buf = buf;
  frame.at = Date.now();
  return buf;
}

// Tags visible interactive elements with data-pulse-id and returns a compact list + page text.
const SNAPSHOT_FN = () => {
  document.querySelectorAll('[data-pulse-id]').forEach((el) => el.removeAttribute('data-pulse-id'));
  const sel =
    'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=searchbox],[contenteditable=true],[onclick],summary,label[for]';
  const out = [];
  let n = 0;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  for (const el of Array.from(document.querySelectorAll(sel))) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    n += 1;
    el.setAttribute('data-pulse-id', String(n));
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const isField = tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
    const label = (el.getAttribute('aria-label') || el.innerText || (isField ? '' : el.value) || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    const attrs = isField
      ? [el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('autocomplete'), el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('inputmode')]
          .filter(Boolean)
          .join(' ')
          .slice(0, 100)
      : '';
    const value = isField && type !== 'password' && el.value ? String(el.value).slice(0, 40) : '';
    out.push({ id: n, tag, type, label, attrs, value });
    if (n >= 90) break;
  }
  const text = (document.body ? document.body.innerText : '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').slice(0, 2500);
  return { elements: out, text, scrollY: Math.round(window.scrollY), scrollH: Math.round(document.documentElement.scrollHeight), vh };
};

async function snapshot() {
  const p = await ensureBrowser();
  await refreshMeta();
  return p.evaluate(SNAPSHOT_FN).catch(() => ({ elements: [], text: '', scrollY: 0, scrollH: 0, vh: 0 }));
}

function isSecretField(el) {
  if (!el) return false;
  if (el.type === 'password') return true;
  return SECRET_FIELD_RE.test(`${el.attrs} ${el.label} ${el.type}`);
}

/* ------------------------------ Gemini ------------------------------ */

function agentModels() {
  const prefer = String(process.env.GEMINI_AGENT_MODEL || process.env.GEMINI_MODEL || '').trim();
  const list = [prefer, ...AGENT_MODELS].filter((m) => m && !FORBIDDEN_MODEL.test(m));
  return Array.from(new Set(list));
}

function thinkingFor(model) {
  return /lite/i.test(model) ? { thinkingLevel: 'minimal' } : { thinkingLevel: 'low' };
}

function anySignal(signal, ms) {
  const t = AbortSignal.timeout(ms);
  if (!signal) return t;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, t]);
  const c = new AbortController();
  const stop = () => c.abort();
  signal.addEventListener('abort', stop, { once: true });
  t.addEventListener('abort', stop, { once: true });
  return c.signal;
}

const cooldown = new Map();
async function geminiJSON(apiKey, system, parts, signal) {
  let lastErr = null;
  for (const model of agentModels()) {
    if ((cooldown.get(model) || 0) > Date.now()) continue;
    for (const withThinking of [true, false]) {
      try {
        const r = await fetch(`${GEMINI_BASE}${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts }],
            generationConfig: {
              temperature: 0.2,
              responseMimeType: 'application/json',
              maxOutputTokens: 1024,
              ...(withThinking ? { thinkingConfig: thinkingFor(model) } : {}),
            },
          }),
          signal: anySignal(signal, 25000),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          const msg = (j.error && j.error.message) || `Gemini HTTP ${r.status}`;
          lastErr = new Error(msg);
          if (r.status === 400 && withThinking && /thinking/i.test(msg)) continue; // retry without thinkingConfig
          if (r.status === 401 || r.status === 403) throw lastErr;
          cooldown.set(model, Date.now() + (r.status === 404 ? 3600e3 : r.status === 429 ? 60e3 : 20e3));
          break;
        }
        const text = ((j.candidates || [])[0]?.content?.parts || [])
          .filter((p) => !p.thought)
          .map((p) => p.text || '')
          .join('');
        state.model = model;
        const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
        const a = cleaned.indexOf('{');
        const b = cleaned.lastIndexOf('}');
        return JSON.parse(a >= 0 && b > a ? cleaned.slice(a, b + 1) : cleaned);
      } catch (e) {
        if (signal && signal.aborted) throw e;
        if (e && /HTTP 40[13]|API key/i.test(String(e.message))) throw e;
        lastErr = e;
        cooldown.set(model, Date.now() + 15e3);
        break;
      }
    }
  }
  throw lastErr || new Error('No Gemini model available.');
}

const AGENT_PROMPT = [
  'You operate a real mobile Chrome browser for the user, one action per turn. Be fast: take the shortest path.',
  'Each turn you get: the goal, URL, title, scroll position, numbered interactive elements, the visible page text, your previous actions, and sometimes a screenshot.',
  'Reply with ONE JSON object: {"action": ..., "id": number?, "text": string?, "url": string?, "direction": "up"|"down"?, "key": string?, "submit": boolean?, "reason": short string}',
  'Actions: "navigate" (url), "click" (id), "type" (id, text; "submit": true presses Enter), "scroll" (direction), "key" (Enter, Escape, Tab...),',
  '"back", "wait", "look" (you need a screenshot next turn, e.g. images, maps, captchas, canvas or unlabeled icons),',
  '"ask" (text = question for the user: a choice only they can make, or asking them to type a login/OTP/card detail themselves),',
  '"done" (text = the final answer for the user: short, the facts they asked for first, with prices/times/links if relevant).',
  'Rules: never type passwords, OTPs, PINs, UPI PINs or card details: use "ask" so the user types them. Never invent personal data; ask for it.',
  'Final steps (pay, place order, book, send, post, delete) are confirmed with the user automatically when you click them; still click them only when the goal asks for it.',
  'For lookups, navigate straight to a search URL (https://www.google.com/search?q=...) or the site\'s own search URL instead of typing into boxes.',
  'Read the answer from PAGE TEXT whenever possible; finish with "done" as soon as the goal is met. Close cookie banners/popups that block the page. If stuck after 3 tries, "ask".',
].join('\n');

/* ------------------------------ Actions ------------------------------ */

// goto that survives racing with another navigation (e.g. the home page still loading after wake-up).
async function gotoSafe(p, url) {
  try {
    return await gotoSafe(p, url);
  } catch (e) {
    if (!/interrupted by another navigation|net::ERR_ABORTED/i.test(String(e && e.message))) throw e;
    await p.waitForTimeout(150);
    return p.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  }
}

async function clickId(p, id) {
  const loc = p.locator(`[data-pulse-id="${Number(id)}"]`).first();
  await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined);
  await loc.click({ timeout: 4000 });
}

// Short settle: give a click a moment to start a navigation, then wait for DOM only (not every image/script).
async function settle(p) {
  await p.waitForTimeout(250);
  await p.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
}

function waitForAnswer(question) {
  state.status = 'waiting';
  state.question = question;
  log('ask', question);
  return new Promise((resolve) => {
    answerWaiter = resolve;
  });
}

function resumeRunning() {
  state.status = 'running';
  state.question = '';
  touch();
}

function formatElements(elements) {
  return elements
    .map((e) => {
      let s = `[${e.id}] ${e.tag}${e.type ? `:${e.type}` : ''}`;
      if (e.label) s += ` "${e.label}"`;
      if (e.attrs) s += ` {${e.attrs}}`;
      if (e.value) s += ` =${JSON.stringify(e.value)}`;
      return s;
    })
    .join('\n');
}

async function runAgent(goal, apiKey) {
  stopFlag = false;
  runAbort = new AbortController();
  const signal = runAbort.signal;
  state.goal = goal;
  state.status = 'running';
  state.question = '';
  state.answer = '';
  state.error = '';
  state.pending = null;
  log('goal', goal);
  const history = [];
  let needShot = true;
  try {
    await ensureBrowser();
    for (let step = 1; step <= MAX_STEPS; step++) {
      if (stopFlag) return;
      const p = page;
      const snap = await snapshot();
      const sparse = snap.elements.length < 4 || snap.text.length < 120;
      const parts = [
        {
          text:
            `GOAL: ${goal}\nURL: ${state.url}\nTITLE: ${state.title}\n` +
            `SCROLL: ${snap.scrollY}/${Math.max(0, snap.scrollH - snap.vh)}px\n` +
            `PREVIOUS ACTIONS:\n${history.slice(-8).join('\n') || '(none)'}\n` +
            `ELEMENTS:\n${formatElements(snap.elements)}\n` +
            `PAGE TEXT:\n${snap.text}`,
        },
      ];
      if (needShot || sparse) {
        const shot = await screenshot(150).catch(() => null);
        if (shot) parts.push({ inlineData: { mimeType: 'image/jpeg', data: shot.toString('base64') } });
      }
      needShot = false;

      const act = await geminiJSON(apiKey, AGENT_PROMPT, parts, signal);
      if (stopFlag) return;
      const a = String(act.action || '').toLowerCase();
      const el = snap.elements.find((e) => e.id === Number(act.id));
      history.push(`${step}. ${a} ${act.id ?? ''} ${act.url || ''} ${act.text && a !== 'type' ? JSON.stringify(String(act.text).slice(0, 60)) : ''} - ${act.reason || ''}`.replace(/\s+/g, ' '));

      let acted = true;
      try {
        if (a === 'navigate' && act.url) {
          const url = /^https?:\/\//i.test(act.url) ? act.url : `https://${act.url}`;
          log('open', url);
          await gotoSafe(p, url);
        } else if (a === 'click' && el) {
          if (FINAL_RE.test(`${el.label} ${el.attrs}`)) {
            const reply = await waitForAnswer(`Ready to press "${el.label || 'this button'}". Reply yes to go ahead, or tell me what to change.`);
            if (stopFlag) return;
            resumeRunning();
            if (!YES_RE.test(reply)) {
              history.push(`user did not approve the click and said: ${reply}`);
              continue;
            }
          }
          log('click', el.label || `#${el.id}`);
          await clickId(p, el.id);
        } else if (a === 'type' && el) {
          if (isSecretField(el)) {
            const reply = await waitForAnswer(
              `"${el.label || 'This field'}" needs a password, code, PIN or card detail. Tap the field on the screen and type it yourself below, then reply "done".`
            );
            if (stopFlag) return;
            resumeRunning();
            history.push(`user handled the secret field and said: ${reply}`);
            needShot = true;
            continue;
          }
          if (act.submit && MESSAGE_FIELD_RE.test(`${el.label} ${el.attrs}`)) {
            const reply = await waitForAnswer(`Ready to send "${String(act.text || '').slice(0, 120)}". Reply yes to send it.`);
            if (stopFlag) return;
            resumeRunning();
            if (!YES_RE.test(reply)) {
              history.push(`user did not approve sending and said: ${reply}`);
              continue;
            }
          }
          log('type', `${el.label || `#${el.id}`}: ${String(act.text || '').slice(0, 60)}`);
          const loc = p.locator(`[data-pulse-id="${el.id}"]`).first();
          await loc.fill(String(act.text || ''), { timeout: 4000 }).catch(async () => {
            await loc.click({ timeout: 3000 });
            await p.keyboard.type(String(act.text || ''), { delay: 8 });
          });
          if (act.submit) await p.keyboard.press('Enter');
          else acted = false; // typing alone does not change the page much; skip the settle wait
        } else if (a === 'scroll') {
          log('scroll', act.direction || 'down');
          await p.mouse.wheel(0, act.direction === 'up' ? -650 : 650);
          await p.waitForTimeout(150);
          acted = false;
        } else if (a === 'key' && act.key) {
          log('key', act.key);
          await p.keyboard.press(String(act.key));
        } else if (a === 'back') {
          log('back', '');
          await p.goBack({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => undefined);
        } else if (a === 'wait') {
          log('wait', act.reason || '');
          await p.waitForTimeout(1200);
          acted = false;
        } else if (a === 'look') {
          needShot = true;
          acted = false;
        } else if (a === 'ask') {
          const reply = await waitForAnswer(String(act.text || 'What should I do next?'));
          if (stopFlag) return;
          resumeRunning();
          history.push(`user answered: ${reply}`);
          continue;
        } else if (a === 'done') {
          state.answer = String(act.text || 'Done.');
          log('done', state.answer);
          state.status = 'done';
          await refreshMeta();
          touch();
          return;
        } else {
          history.push(`(invalid action, element ${act.id} not found on this screen)`);
          log('retry', 'Re-reading the page');
          needShot = true;
          acted = false;
        }
      } catch (e) {
        history.push(`(action failed: ${String(e.message || e).slice(0, 120)})`);
        log('error', String(e.message || e).slice(0, 160));
        needShot = true;
      }
      if (acted) await settle(page || p);
    }
    state.status = 'done';
    state.answer = 'I hit the step limit. Tell me how to continue.';
    log('done', state.answer);
  } catch (e) {
    if (stopFlag) return;
    state.status = 'error';
    state.error = e.message || String(e);
    log('error', state.error);
  } finally {
    runAbort = null;
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
    res.json(publicState());
  });

  r.get('/events', (req, res) => {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // 2 KB of padding defeats proxies that buffer small responses before streaming.
    res.write(`:${' '.repeat(2048)}\nretry: 2000\n\n`);
    res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    sseClients.add(res);
    const hb = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(hb);
      sseClients.delete(res);
    });
  });

  r.get('/stream', (req, res) => {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-cache, no-store, no-transform, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const v = {
      res,
      busy: false,
      pending: false,
      lastSent: 0,
      w: Math.max(320, Math.min(828, Number(req.query.w) || 412)),
      q: Math.max(30, Math.min(80, Number(req.query.q) || 55)),
    };
    viewers.add(v);
    if (frame.buf) writeFrame(v, frame.buf);
    startCast().catch(() => undefined);
    req.on('close', () => {
      viewers.delete(v);
      if (!viewers.size) stopCast().catch(() => undefined);
      else startCast().catch(() => undefined);
    });
  });

  r.get('/screen.jpg', async (req, res, next) => {
    try {
      const buf = await screenshot(500);
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'no-store');
      res.send(buf);
    } catch (e) {
      next(e);
    }
  });

  r.post('/wake', async (req, res, next) => {
    try {
      await ensureBrowser();
      await refreshMeta();
      res.json(publicState());
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
      runAgent(goal, apiKey); // runs in the background; the phone follows /events
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
    if (runAbort) runAbort.abort();
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
      let wait = true;
      if (type === 'navigate') {
        const raw = String(b.url || '').trim();
        const url = /^https?:\/\//i.test(raw) ? raw : /\s/.test(raw) || !raw.includes('.') ? `https://www.google.com/search?q=${encodeURIComponent(raw)}` : `https://${raw}`;
        log('open', url);
        await gotoSafe(p, url);
        wait = false;
      } else if (type === 'tap') {
        const x = Math.max(0, Math.min(1, Number(b.x))) * VIEWPORT.width;
        const y = Math.max(0, Math.min(1, Number(b.y))) * VIEWPORT.height;
        log('tap', `${Math.round(x)},${Math.round(y)}`);
        await p.mouse.click(x, y);
      } else if (type === 'type') {
        // Typed by the user themselves, so secret fields are allowed here. Never logged.
        await p.keyboard.type(String(b.text || ''), { delay: 5 });
        log('type', '(your text)');
        if (b.submit) await p.keyboard.press('Enter');
        else wait = false;
      } else if (type === 'key') {
        await p.keyboard.press(String(b.key || 'Enter'));
      } else if (type === 'scroll') {
        const dy = Number.isFinite(Number(b.dy)) ? Math.max(-3000, Math.min(3000, Number(b.dy))) : b.direction === 'up' ? -600 : 600;
        await p.mouse.wheel(0, dy);
        wait = false;
      } else if (type === 'back') {
        await p.goBack({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => undefined);
        wait = false;
      } else if (type === 'forward') {
        await p.goForward({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => undefined);
        wait = false;
      } else if (type === 'reload') {
        await p.reload({ timeout: 20000, waitUntil: 'domcontentloaded' }).catch(() => undefined);
        wait = false;
      } else {
        return res.status(400).json({ ok: false, error: `Unknown action "${type}".` });
      }
      if (wait) await settle(p);
      await refreshMeta();
      res.json({ ok: true, url: state.url, title: state.title });
    } catch (e) {
      next(e);
    }
  });

  r.post('/reset', async (req, res) => {
    stopFlag = true;
    if (runAbort) runAbort.abort();
    await stopCast();
    if (context) await context.close().catch(() => undefined);
    context = null;
    page = null;
    frame.buf = null;
    state.status = 'off';
    state.steps = [];
    touch();
    res.json({ ok: true });
  });

  return r;
}

// Close the browser when nobody has used it for a while (keeps the Codespace light).
setInterval(() => {
  if (viewers.size) lastUse = Date.now(); // someone is watching the live screen
  if (context && Date.now() - lastUse > IDLE_CLOSE_MS && state.status !== 'running' && state.status !== 'waiting') {
    stopCast().catch(() => undefined);
    context.close().catch(() => undefined);
    context = null;
    page = null;
    state.status = 'off';
    touch();
  }
}, 60000).unref();

module.exports = { router, computerAvailable: () => Boolean(chromium), agentModels };
