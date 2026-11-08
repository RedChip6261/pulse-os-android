import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  Vibration,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView, WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';
import * as Speech from 'expo-speech';
import * as Application from 'expo-application';
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

const C = {
  bg: '#0B0F17',
  panel: '#121826',
  panel2: '#1A2233',
  border: '#263047',
  text: '#E6EAF2',
  muted: '#8A94A8',
  accent: '#7C5CFF',
  accent2: '#22D3EE',
  good: '#22C55E',
  danger: '#EF4444',
};

/* ------------------------------------------------------------------ */
/* Storage keys & Gemini config                                        */
/* ------------------------------------------------------------------ */

const STORAGE_API_KEY = 'pulseos.gemini_api_key';
const STORAGE_MODEL = 'pulseos.gemini_model';
const STORAGE_VOICE = 'pulseos.voice_enabled';
const STORAGE_CHAT = 'pulseos.chat_history';
const STORAGE_CLOUD_URL = 'pulseos.cloud_url';
const STORAGE_CLOUD_TOKEN = 'pulseos.cloud_token';
const STORAGE_CLOUD_MODE = 'pulseos.cloud_mode';

const CLOUD_PORT = 3000;
const CLOUD_DOMAIN = 'app.github.dev';

const DEFAULT_MODEL = 'gemini-flash-latest';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const DEFAULT_UPDATE_REPO = 'RedChip6261/pulse-os-android';

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

type Tab = 'CHAT' | 'WIDGETS' | 'WORKSPACE' | 'SETTINGS';

type PulseReply = {
  direct_response: string;
  proactive_checklist: string[];
  one_line_summary: string;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  reply?: PulseReply;
  source?: 'cloud' | 'device';
  ts: number;
};

type CloudStatus = 'off' | 'checking' | 'online' | 'offline';

type CloudHealth = {
  ok: boolean;
  gemini_key_on_server?: boolean;
  auth_required?: boolean;
  model?: string;
  public_url?: string;
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function stripCodeFences(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^```(?:json|JSON)?\s*/m, '');
  s = s.replace(/```\s*$/m, '');
  return s.trim();
}

function parsePulseReply(raw: string): PulseReply {
  const cleaned = stripCodeFences(raw);
  let obj: any = null;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        obj = JSON.parse(cleaned.slice(first, last + 1));
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
    };
  }
  const checklist = Array.isArray(obj.proactive_checklist)
    ? obj.proactive_checklist.map((x: unknown) => String(x)).filter((x: string) => x.trim().length > 0)
    : [];
  return {
    direct_response: String(obj.direct_response ?? '').trim() || cleaned,
    proactive_checklist: checklist,
    one_line_summary: String(obj.one_line_summary ?? '').trim(),
  };
}

async function discoverFlashModels(apiKey: string): Promise<string[]> {
  try {
    const res = await fetch(GEMINI_BASE.replace(/\/$/, '') + '?pageSize=200', {
      headers: { 'x-goog-api-key': apiKey },
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    const names: string[] = (json?.models ?? [])
      .filter((m: any) => (m?.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m: any) => String(m?.name ?? '').replace(/^models\//, ''))
      .filter((n: string) => /flash/i.test(n) && !/(lite|image|tts|audio|live|thinking|exp|preview|embedding)/i.test(n));
    const ver = (n: string) => {
      const m = n.match(/gemini-(\d+(?:\.\d+)?)/);
      return m ? parseFloat(m[1]) : 0;
    };
    return names.sort((a, b) => ver(b) - ver(a));
  } catch {
    return [];
  }
}

async function callGemini(
  apiKey: string,
  model: string,
  history: ChatMessage[],
  extraSystem = '',
  temperature = 0.7,
): Promise<{ reply: PulseReply; modelUsed: string }> {
  const contents = history
    .filter((m) => m.role !== 'error')
    .slice(-12)
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.role === 'assistant' && m.reply ? JSON.stringify(m.reply) : m.text }],
    }));

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT + (extraSystem ? '\n' + extraSystem : '') }] },
    contents,
    generationConfig: { temperature, responseMimeType: 'application/json' },
  });

  const attempt = async (m: string) =>
    fetch(GEMINI_BASE + encodeURIComponent(m) + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body,
    });

  let modelUsed = model;
  let res = await attempt(model);
  if (!res.ok && (res.status === 404 || res.status === 400 || res.status === 403)) {
    // The model may be retired or unavailable to this key: find a working Flash model.
    const errJson: any = await res.clone().json().catch(() => null);
    const errMsg: string = errJson?.error?.message || '';
    if (/model|not found|no longer available|not supported/i.test(errMsg) || res.status === 404) {
      const candidates: string[] = [];
      const suggested = errMsg.match(/models\/([a-z0-9.\-]+)/gi) || [];
      suggested
        .map((x) => x.replace(/^models\//i, ''))
        .filter((x) => x !== model)
        .forEach((x) => candidates.push(x));
      (await discoverFlashModels(apiKey)).forEach((x) => {
        if (x !== model && !candidates.includes(x)) candidates.push(x);
      });
      if (!candidates.includes('gemini-flash-latest') && model !== 'gemini-flash-latest') {
        candidates.push('gemini-flash-latest');
      }
      for (const c of candidates.slice(0, 5)) {
        const r = await attempt(c);
        if (r.ok) {
          res = r;
          modelUsed = c;
          break;
        }
      }
    }
  }
  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message || 'HTTP ' + res.status;
    throw new Error(msg);
  }
  const text: string =
    json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join('') ?? '';
  if (!text) {
    const reason = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason || 'empty';
    throw new Error('Gemini returned no text (' + reason + ').');
  }
  return { reply: parsePulseReply(text), modelUsed };
}

/* ---- Cloud backend (GitHub Codespaces or any HTTPS host) ---- */

/**
 * Accepts a full URL ("https://foo-3000.app.github.dev"), a host ("foo-3000.app.github.dev"),
 * or just the Codespace name ("fluffy-space-giggle-x5r9") and returns the base URL.
 */
function normalizeCloudUrl(raw: string): string {
  let s = raw.trim().replace(/\s+/g, '');
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, '');
  if (s.includes('.')) return ('https://' + s).replace(/\/+$/, '');
  if (/^[a-z0-9-]+$/i.test(s)) {
    // A bare Codespace name: build its forwarded-port URL.
    const name = s.replace(new RegExp('-' + CLOUD_PORT + '$'), '');
    return 'https://' + name + '-' + CLOUD_PORT + '.' + CLOUD_DOMAIN;
  }
  return s;
}

async function cloudFetch(
  base: string,
  token: string,
  path: string,
  init: { method?: string; body?: unknown; geminiKey?: string; timeoutMs?: number } = {},
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 45000);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  if (init.geminiKey) headers['x-gemini-key'] = init.geminiKey;
  try {
    const res = await fetch(base + path, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // A private Codespace port answers with a GitHub sign-in page, not JSON.
      throw new Error(
        res.status === 401 || /<html/i.test(text)
          ? 'Cloud URL returned a web page. Set port ' + CLOUD_PORT + ' to Public in the Codespace Ports tab.'
          : 'Cloud returned non-JSON (HTTP ' + res.status + ').',
      );
    }
    if (!res.ok || json?.ok === false) throw new Error(json?.error || 'Cloud HTTP ' + res.status);
    return json;
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('Cloud timed out. Is the Codespace running?');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function cloudHealth(base: string): Promise<CloudHealth> {
  return cloudFetch(base, '', '/health', { timeoutMs: 12000 });
}

async function callCloudChat(
  base: string,
  token: string,
  geminiKey: string | undefined,
  history: ChatMessage[],
  extraSystem = '',
): Promise<{ reply: PulseReply; modelUsed: string }> {
  const messages = history
    .filter((m) => m.role !== 'error')
    .slice(-12)
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      text: m.role === 'assistant' && m.reply ? JSON.stringify(m.reply) : m.text,
    }));
  const json = await cloudFetch(base, token, '/api/chat', { body: { messages, context: extraSystem }, geminiKey });
  const r = json?.reply ?? {};
  return {
    reply: {
      direct_response: String(r.direct_response ?? ''),
      proactive_checklist: Array.isArray(r.proactive_checklist) ? r.proactive_checklist.map(String) : [],
      one_line_summary: String(r.one_line_summary ?? ''),
    },
    modelUsed: String(json?.model ?? ''),
  };
}

async function runCloudTask(
  base: string,
  token: string,
  geminiKey: string | undefined,
  type: string,
  payload: unknown,
): Promise<any> {
  const json = await cloudFetch(base, token, '/api/task', { body: { type, payload }, geminiKey, timeoutMs: 60000 });
  return json.run;
}

function speak(text: string) {
  if (!text.trim()) return;
  Speech.stop();
  Speech.speak(text, { language: 'en-US', rate: 1.0, pitch: 1.0 });
}

function replyToSpeech(r: PulseReply): string {
  const parts: string[] = [];
  if (r.one_line_summary) parts.push(r.one_line_summary);
  if (r.proactive_checklist.length) {
    parts.push('Suggested next steps: ' + r.proactive_checklist.join('. ') + '.');
  }
  return parts.join(' ');
}

/* ---- One-tap action links (standard Android intents via Linking) ---- */

function pad(n: number) {
  return n < 10 ? '0' + n : String(n);
}

function gcalStamp(d: Date) {
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    '00Z'
  );
}

function calendarUrl(title: string, details: string) {
  const start = new Date(Date.now() + 60 * 60 * 1000);
  start.setMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return (
    'https://calendar.google.com/calendar/render?action=TEMPLATE' +
    '&text=' + encodeURIComponent(title) +
    '&details=' + encodeURIComponent(details) +
    '&dates=' + gcalStamp(start) + '/' + gcalStamp(end)
  );
}

function searchUrl(q: string) {
  return 'https://www.google.com/search?q=' + encodeURIComponent(q);
}

function mailtoUrl(subject: string, body: string) {
  return 'mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
}

function smsUrl(body: string) {
  return 'sms:?body=' + encodeURIComponent(body);
}

async function openLink(url: string) {
  try {
    await Linking.openURL(url);
  } catch {
    Alert.alert('Could not open', 'No app on this device can handle that action.');
  }
}

type ActionItem = { label: string; url: string };

function actionsForItem(item: string, summary: string): ActionItem[] {
  const lower = item.toLowerCase();
  const actions: ActionItem[] = [{ label: '📅 Calendar', url: calendarUrl(item, summary) }];
  if (/(weather|rain|forecast|temperature)/.test(lower)) {
    actions.push({ label: '🌦 Weather', url: searchUrl('weather today') });
  } else {
    actions.push({ label: '🔎 Search', url: searchUrl(item) });
  }
  if (/(email|mail|send|write)/.test(lower)) {
    actions.push({ label: '✉️ Email', url: mailtoUrl(item, summary) });
  }
  if (/(text|message|sms|remind .* (him|her|them))/.test(lower)) {
    actions.push({ label: '💬 SMS', url: smsUrl(item) });
  }
  if (/(call|phone|ring)/.test(lower)) {
    actions.push({ label: '📞 Dial', url: 'tel:' });
  }
  return actions;
}

/* ------------------------------------------------------------------ */
/* Widget HTML (single-file Tailwind micro-tools)                      */
/* ------------------------------------------------------------------ */

const HTML_HEAD =
  '<!DOCTYPE html><html><head><meta charset="utf-8" />' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />' +
  '<script src="https://cdn.tailwindcss.com"></script>' +
  '<style>body{background:#0B0F17;color:#E6EAF2;font-family:system-ui,-apple-system,Roboto,sans-serif;-webkit-tap-highlight-color:transparent}</style>' +
  '</head>';

const POMODORO_HTML =
  HTML_HEAD +
  `<body class="min-h-screen flex flex-col items-center justify-center p-6">
  <h1 class="text-xl font-semibold tracking-wide text-violet-300 mb-2">Pomodoro</h1>
  <p id="mode" class="text-sm uppercase tracking-widest text-slate-400 mb-6">Focus</p>
  <div id="time" class="text-7xl font-bold tabular-nums mb-8">25:00</div>
  <div class="flex gap-3 mb-6">
    <button id="start" class="px-6 py-3 rounded-xl bg-violet-600 active:bg-violet-700 font-semibold">Start</button>
    <button id="reset" class="px-6 py-3 rounded-xl bg-slate-700 active:bg-slate-800 font-semibold">Reset</button>
  </div>
  <div class="flex gap-2 text-sm">
    <button data-min="25" data-label="Focus" class="preset px-3 py-2 rounded-lg bg-slate-800">Focus 25</button>
    <button data-min="5" data-label="Short break" class="preset px-3 py-2 rounded-lg bg-slate-800">Break 5</button>
    <button data-min="15" data-label="Long break" class="preset px-3 py-2 rounded-lg bg-slate-800">Long 15</button>
  </div>
  <p class="mt-6 text-slate-400 text-sm">Sessions completed: <span id="count">0</span></p>
<script>
  var total = 25 * 60, left = total, timer = null, label = 'Focus', count = 0;
  var t = document.getElementById('time'), s = document.getElementById('start');
  function fmt(n){ var m = Math.floor(n/60), x = n%60; return (m<10?'0':'')+m+':'+(x<10?'0':'')+x; }
  function draw(){ t.textContent = fmt(left); document.getElementById('mode').textContent = label; }
  function notify(msg){ if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({type:'speak', text: msg})); }
  function stop(){ clearInterval(timer); timer = null; s.textContent = 'Start'; }
  s.onclick = function(){
    if (timer) { stop(); return; }
    s.textContent = 'Pause';
    timer = setInterval(function(){
      left--; draw();
      if (left <= 0) {
        stop();
        if (label === 'Focus') { count++; document.getElementById('count').textContent = count; }
        notify(label + ' session complete. Time for the next step.');
        left = total; draw();
      }
    }, 1000);
  };
  document.getElementById('reset').onclick = function(){ stop(); left = total; draw(); };
  Array.prototype.forEach.call(document.querySelectorAll('.preset'), function(b){
    b.onclick = function(){ stop(); total = parseInt(b.getAttribute('data-min'),10)*60; left = total; label = b.getAttribute('data-label'); draw(); };
  });
  draw();
</script></body></html>`;

const EXAM_HTML =
  HTML_HEAD +
  `<body class="min-h-screen p-6">
  <h1 class="text-xl font-semibold text-cyan-300 mb-4">Exam Countdown</h1>
  <label class="block text-sm text-slate-400 mb-1">Exam name</label>
  <input id="name" class="w-full mb-3 px-3 py-2 rounded-lg bg-slate-800 border border-slate-700" placeholder="e.g. Physics final" />
  <label class="block text-sm text-slate-400 mb-1">Exam date and time</label>
  <input id="date" type="datetime-local" class="w-full mb-4 px-3 py-2 rounded-lg bg-slate-800 border border-slate-700" />
  <button id="save" class="w-full py-3 rounded-xl bg-cyan-600 active:bg-cyan-700 font-semibold mb-6">Save countdown</button>
  <div id="card" class="rounded-2xl bg-slate-900 border border-slate-700 p-5 hidden">
    <p id="title" class="text-slate-300 mb-3"></p>
    <div class="grid grid-cols-4 gap-2 text-center">
      <div><div id="d" class="text-3xl font-bold tabular-nums">0</div><div class="text-xs text-slate-400">days</div></div>
      <div><div id="h" class="text-3xl font-bold tabular-nums">0</div><div class="text-xs text-slate-400">hours</div></div>
      <div><div id="m" class="text-3xl font-bold tabular-nums">0</div><div class="text-xs text-slate-400">min</div></div>
      <div><div id="s" class="text-3xl font-bold tabular-nums">0</div><div class="text-xs text-slate-400">sec</div></div>
    </div>
    <p id="tip" class="mt-4 text-sm text-slate-400"></p>
  </div>
<script>
  var KEY = 'pulseos_exam';
  function load(){ try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch(e){ return null; } }
  var data = load();
  if (data) { document.getElementById('name').value = data.name; document.getElementById('date').value = data.date; }
  document.getElementById('save').onclick = function(){
    var n = document.getElementById('name').value || 'Exam', d = document.getElementById('date').value;
    if (!d) { alert('Pick a date and time first.'); return; }
    data = { name: n, date: d }; localStorage.setItem(KEY, JSON.stringify(data)); tick();
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({type:'speak', text: 'Countdown saved for ' + n + '.'}));
  };
  function tick(){
    if (!data) return;
    document.getElementById('card').classList.remove('hidden');
    var diff = new Date(data.date).getTime() - Date.now();
    document.getElementById('title').textContent = diff > 0 ? data.name + ' starts in' : data.name + ' has started. Good luck!';
    if (diff < 0) diff = 0;
    var sec = Math.floor(diff/1000);
    var dd = Math.floor(sec/86400), hh = Math.floor((sec%86400)/3600), mm = Math.floor((sec%3600)/60), ss = sec%60;
    document.getElementById('d').textContent = dd; document.getElementById('h').textContent = hh;
    document.getElementById('m').textContent = mm; document.getElementById('s').textContent = ss;
    var tip = dd > 14 ? 'Plenty of runway: plan topics week by week.' : dd > 3 ? 'Crunch time: do past papers daily.' : 'Final stretch: review notes and sleep well.';
    document.getElementById('tip').textContent = diff > 0 ? tip : '';
  }
  setInterval(tick, 1000); tick();
</script></body></html>`;

const EXPENSE_HTML =
  HTML_HEAD +
  `<body class="min-h-screen p-6">
  <h1 class="text-xl font-semibold text-emerald-300 mb-4">Monthly Expenses</h1>
  <label class="block text-sm text-slate-400 mb-1">Monthly income</label>
  <input id="income" type="number" inputmode="decimal" class="w-full mb-4 px-3 py-2 rounded-lg bg-slate-800 border border-slate-700" placeholder="0" />
  <div class="flex gap-2 mb-2">
    <input id="label" class="flex-1 px-3 py-2 rounded-lg bg-slate-800 border border-slate-700" placeholder="Expense (e.g. Rent)" />
    <input id="amount" type="number" inputmode="decimal" class="w-28 px-3 py-2 rounded-lg bg-slate-800 border border-slate-700" placeholder="Amount" />
  </div>
  <button id="add" class="w-full py-3 rounded-xl bg-emerald-600 active:bg-emerald-700 font-semibold mb-4">Add expense</button>
  <ul id="list" class="space-y-2 mb-4"></ul>
  <div class="rounded-2xl bg-slate-900 border border-slate-700 p-4 space-y-1">
    <div class="flex justify-between"><span class="text-slate-400">Total spent</span><span id="total" class="font-semibold tabular-nums">0.00</span></div>
    <div class="flex justify-between"><span class="text-slate-400">Remaining</span><span id="left" class="font-semibold tabular-nums">0.00</span></div>
    <div class="flex justify-between"><span class="text-slate-400">Savings rate</span><span id="rate" class="font-semibold tabular-nums">0%</span></div>
    <div class="h-2 bg-slate-800 rounded-full mt-2 overflow-hidden"><div id="bar" class="h-2 bg-emerald-500" style="width:0%"></div></div>
  </div>
  <button id="clear" class="w-full mt-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-sm">Clear month</button>
<script>
  var KEY = 'pulseos_expenses';
  var state = { income: 0, items: [] };
  try { state = JSON.parse(localStorage.getItem(KEY) || 'null') || state; } catch(e){}
  function save(){ localStorage.setItem(KEY, JSON.stringify(state)); }
  function money(n){ return (Math.round(n*100)/100).toFixed(2); }
  function render(){
    document.getElementById('income').value = state.income || '';
    var ul = document.getElementById('list'); ul.innerHTML = '';
    var total = 0;
    state.items.forEach(function(it, i){
      total += it.amount;
      var li = document.createElement('li');
      li.className = 'flex items-center justify-between rounded-lg bg-slate-900 border border-slate-800 px-3 py-2';
      var span = document.createElement('span'); span.textContent = it.label;
      var right = document.createElement('div'); right.className = 'flex items-center gap-3';
      var amt = document.createElement('span'); amt.className = 'tabular-nums'; amt.textContent = money(it.amount);
      var del = document.createElement('button'); del.className = 'text-red-400 text-sm'; del.textContent = 'Remove';
      del.onclick = function(){ state.items.splice(i,1); save(); render(); };
      right.appendChild(amt); right.appendChild(del); li.appendChild(span); li.appendChild(right); ul.appendChild(li);
    });
    var inc = state.income || 0, left = inc - total, rate = inc > 0 ? Math.max(0, left/inc*100) : 0;
    document.getElementById('total').textContent = money(total);
    var l = document.getElementById('left'); l.textContent = money(left); l.className = 'font-semibold tabular-nums ' + (left < 0 ? 'text-red-400' : 'text-emerald-300');
    document.getElementById('rate').textContent = Math.round(rate) + '%';
    document.getElementById('bar').style.width = (inc > 0 ? Math.min(100, total/inc*100) : 0) + '%';
  }
  document.getElementById('income').oninput = function(e){ state.income = parseFloat(e.target.value) || 0; save(); render(); };
  document.getElementById('add').onclick = function(){
    var lb = document.getElementById('label').value.trim(), am = parseFloat(document.getElementById('amount').value);
    if (!lb || isNaN(am)) { alert('Enter a name and an amount.'); return; }
    state.items.push({ label: lb, amount: am }); save(); render();
    document.getElementById('label').value = ''; document.getElementById('amount').value = '';
  };
  document.getElementById('clear').onclick = function(){ if (confirm('Clear all expenses for this month?')) { state.items = []; save(); render(); } };
  render();
</script></body></html>`;

const WIDGETS = [
  { id: 'pomodoro', title: 'Pomodoro Timer', subtitle: 'Focus sprints with breaks', emoji: '🍅', html: POMODORO_HTML },
  { id: 'exam', title: 'Exam Countdown', subtitle: 'Days, hours and minutes left', emoji: '🎓', html: EXAM_HTML },
  { id: 'expense', title: 'Expense Calculator', subtitle: 'Monthly budget at a glance', emoji: '💸', html: EXPENSE_HTML },
];

/* ------------------------------------------------------------------ */
/* Settings model (one JSON blob, migrated from the old per-key store) */
/* ------------------------------------------------------------------ */

const STORAGE_SETTINGS = 'pulseos.settings.v2';

type Settings = {
  // Profile
  name: string;
  email: string;
  role: string;
  avatar: string;
  focusGoalMin: number;
  personalize: boolean;
  // Assistant
  apiKey: string;
  model: string;
  temperature: number;
  replyLength: 'short' | 'balanced' | 'detailed';
  historyLimit: number;
  // Cloud
  cloudUrl: string;
  cloudToken: string;
  cloudMode: boolean;
  // Voice
  voiceOn: boolean;
  voiceRate: number;
  voicePitch: number;
  voiceLang: string;
  // Workspace
  homeUrl: string;
  confirmBeforeComplete: boolean;
  // Chat behaviour
  haptics: boolean;
  // Updates
  updateRepo: string;
  updateToken: string;
  autoCheckUpdates: boolean;
};

const DEFAULT_SETTINGS: Settings = {
  name: '',
  email: '',
  role: '',
  avatar: '⚡',
  focusGoalMin: 120,
  personalize: true,
  apiKey: '',
  model: DEFAULT_MODEL,
  temperature: 0.7,
  replyLength: 'balanced',
  historyLimit: 60,
  cloudUrl: '',
  cloudToken: '',
  cloudMode: false,
  voiceOn: false,
  voiceRate: 1.0,
  voicePitch: 1.0,
  voiceLang: 'en-US',
  homeUrl: 'https://www.google.com',
  confirmBeforeComplete: true,
  haptics: true,
  updateRepo: DEFAULT_UPDATE_REPO,
  updateToken: '',
  autoCheckUpdates: true,
};

async function loadSettings(): Promise<Settings> {
  const raw = await AsyncStorage.getItem(STORAGE_SETTINGS);
  if (raw) {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      /* fall through to migration */
    }
  }
  // Migrate values saved by earlier versions of the app.
  const [k, m, v, cu, ct, cm] = await Promise.all([
    AsyncStorage.getItem(STORAGE_API_KEY),
    AsyncStorage.getItem(STORAGE_MODEL),
    AsyncStorage.getItem(STORAGE_VOICE),
    AsyncStorage.getItem(STORAGE_CLOUD_URL),
    AsyncStorage.getItem(STORAGE_CLOUD_TOKEN),
    AsyncStorage.getItem(STORAGE_CLOUD_MODE),
  ]);
  const s: Settings = {
    ...DEFAULT_SETTINGS,
    apiKey: k || '',
    model: m || DEFAULT_MODEL,
    voiceOn: v === '1',
    cloudUrl: cu || '',
    cloudToken: ct || '',
    cloudMode: cm === '1' && !!cu,
  };
  await AsyncStorage.setItem(STORAGE_SETTINGS, JSON.stringify(s));
  return s;
}

function profileContext(s: Settings): string {
  if (!s.personalize) return '';
  const bits: string[] = [];
  if (s.name.trim()) bits.push('The user\'s name is ' + s.name.trim() + '.');
  if (s.role.trim()) bits.push('They describe themselves as: ' + s.role.trim() + '.');
  if (s.focusGoalMin > 0) bits.push('Their daily focus goal is ' + s.focusGoalMin + ' minutes.');
  const len =
    s.replyLength === 'short'
      ? 'Keep direct_response to 1-2 sentences.'
      : s.replyLength === 'detailed'
        ? 'direct_response may be detailed (up to ~150 words).'
        : 'Keep direct_response concise (2-4 sentences).';
  bits.push(len);
  return bits.join(' ');
}

function speakWith(s: Settings, text: string) {
  if (!text.trim()) return;
  Speech.stop();
  Speech.speak(text, { language: s.voiceLang || 'en-US', rate: s.voiceRate || 1, pitch: s.voicePitch || 1 });
}

/* ------------------------------------------------------------------ */
/* In-app updates (GitHub Releases, no Play Store)                     */
/* ------------------------------------------------------------------ */

type UpdateInfo = {
  available: boolean;
  latestBuild: number;
  currentBuild: number;
  tag: string;
  name: string;
  notes: string;
  publishedAt: string;
  sizeBytes: number;
  assetApiUrl: string;
  htmlUrl: string;
};

function currentBuildNumber(): number {
  const n = parseInt(String(Application.nativeBuildVersion ?? '0'), 10);
  return Number.isFinite(n) ? n : 0;
}

function buildFromTag(tag: string): number {
  const m = String(tag).match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

async function checkForUpdate(repo: string, token: string): Promise<UpdateInfo> {
  const r = repo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error('Update source must look like owner/repo.');
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token.trim()) headers.Authorization = 'Bearer ' + token.trim();
  const res = await fetch('https://api.github.com/repos/' + r + '/releases/latest', { headers });
  if (res.status === 404) {
    throw new Error(
      token.trim()
        ? 'No release found yet. The next successful build publishes one.'
        : 'No release found. If the repo is private, add a read-only GitHub token in Updates.',
    );
  }
  if (res.status === 401 || res.status === 403) throw new Error('GitHub refused the token (HTTP ' + res.status + ').');
  if (!res.ok) throw new Error('GitHub HTTP ' + res.status);
  const rel: any = await res.json();
  const asset = (rel.assets || []).find((a: any) => /\.apk$/i.test(String(a?.name)));
  if (!asset) throw new Error('The latest release has no APK attached.');
  const latestBuild = buildFromTag(rel.tag_name);
  const currentBuild = currentBuildNumber();
  return {
    available: latestBuild > currentBuild,
    latestBuild,
    currentBuild,
    tag: String(rel.tag_name),
    name: String(rel.name || rel.tag_name),
    notes: String(rel.body || '').trim(),
    publishedAt: String(rel.published_at || ''),
    sizeBytes: Number(asset.size) || 0,
    assetApiUrl: String(asset.url),
    htmlUrl: String(rel.html_url || ''),
  };
}

async function downloadAndInstall(
  info: UpdateInfo,
  token: string,
  onProgress: (fraction: number) => void,
): Promise<void> {
  if (Platform.OS !== 'android') throw new Error('Updates install on Android only.');
  const dest = (FileSystem.cacheDirectory || FileSystem.documentDirectory || '') + 'pulse-os-' + info.latestBuild + '.apk';
  await FileSystem.deleteAsync(dest, { idempotent: true });
  const headers: Record<string, string> = { Accept: 'application/octet-stream' };
  if (token.trim()) headers.Authorization = 'Bearer ' + token.trim();
  const task = FileSystem.createDownloadResumable(info.assetApiUrl, dest, { headers }, (p) => {
    const total = p.totalBytesExpectedToWrite > 0 ? p.totalBytesExpectedToWrite : info.sizeBytes;
    if (total > 0) onProgress(Math.min(1, p.totalBytesWritten / total));
  });
  const result = await task.downloadAsync();
  if (!result || (result.status && result.status >= 400)) {
    throw new Error('Download failed (HTTP ' + (result?.status ?? '?') + ').');
  }
  const stat = await FileSystem.getInfoAsync(dest);
  if (!stat.exists || (stat.size ?? 0) < 1024 * 1024) throw new Error('Downloaded file looks incomplete.');
  onProgress(1);
  const contentUri = await FileSystem.getContentUriAsync(dest);
  // Hands the APK to Android's own package installer; the user confirms the install there.
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
    type: 'application/vnd.android.package-archive',
  });
}

function formatBytes(n: number) {
  if (!n) return '';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export default function App() {
  const [tab, setTab] = useState<Tab>('CHAT');
  const [settings, setSettings] = useState<Settings | null>(null);
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    loadSettings().then((s) => {
      settingsRef.current = s;
      setSettings(s);
      if (s.autoCheckUpdates && s.updateRepo) {
        checkForUpdate(s.updateRepo, s.updateToken)
          .then((u) => setUpdate(u.available ? u : null))
          .catch(() => undefined);
      }
    });
  }, []);

  const patchSettings = useCallback((patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    AsyncStorage.setItem(STORAGE_SETTINGS, JSON.stringify(next));
  }, []);

  const toggleVoice = useCallback(() => {
    const next = !settingsRef.current.voiceOn;
    patchSettings({ voiceOn: next });
    if (next) speakWith(settingsRef.current, 'Voice readout on.');
    else Speech.stop();
  }, [patchSettings]);

  const say = useCallback((text: string) => {
    if (settingsRef.current.voiceOn) speakWith(settingsRef.current, text);
  }, []);

  if (!settings) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={C.accent} />
      </View>
    );
  }

  const tabs: { id: Tab; icon: string }[] = [
    { id: 'CHAT', icon: '💬' },
    { id: 'WIDGETS', icon: '🧩' },
    { id: 'WORKSPACE', icon: '🌐' },
    { id: 'SETTINGS', icon: '⚙️' },
  ];

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" backgroundColor={C.bg} />
      <View style={styles.header}>
        <Pressable onPress={() => setTab('SETTINGS')} style={styles.rowCenter} accessibilityLabel="Open profile">
          <View style={styles.avatarSmall}>
            <Text style={{ fontSize: 18 }}>{settings.avatar || '⚡'}</Text>
          </View>
          <View>
            <Text style={styles.brand}>Pulse OS</Text>
            <Text style={styles.brandSub}>
              {settings.name.trim() ? 'Hi, ' + settings.name.trim().split(' ')[0] : tab.charAt(0) + tab.slice(1).toLowerCase()}
            </Text>
          </View>
        </Pressable>
        <Pressable
          onPress={toggleVoice}
          accessibilityRole="switch"
          accessibilityState={{ checked: settings.voiceOn }}
          accessibilityLabel="Voice readout"
          style={[styles.voiceBtn, settings.voiceOn && styles.voiceBtnOn]}
        >
          <Text style={styles.voiceIcon}>{settings.voiceOn ? '🔊' : '🔈'}</Text>
          <Text style={[styles.voiceText, settings.voiceOn && { color: C.text }]}>{settings.voiceOn ? 'ON' : 'OFF'}</Text>
        </Pressable>
      </View>

      {update && tab !== 'SETTINGS' ? (
        <Pressable onPress={() => setTab('SETTINGS')} style={styles.updateBanner}>
          <Text style={styles.updateBannerText}>
            ⬆️ Update available: build {update.latestBuild} (you have {update.currentBuild}). Tap to install.
          </Text>
        </Pressable>
      ) : null}

      <View style={{ flex: 1 }}>
        <View style={[styles.fill, tab !== 'CHAT' && styles.hidden]}>
          <ChatScreen say={say} settings={settings} patchSettings={patchSettings} openSettings={() => setTab('SETTINGS')} />
        </View>
        <View style={[styles.fill, tab !== 'WIDGETS' && styles.hidden]}>
          <WidgetsScreen say={say} />
        </View>
        <View style={[styles.fill, tab !== 'WORKSPACE' && styles.hidden]}>
          <WorkspaceScreen say={say} homeUrl={settings.homeUrl} confirmFirst={settings.confirmBeforeComplete} />
        </View>
        <View style={[styles.fill, tab !== 'SETTINGS' && styles.hidden]}>
          <SettingsScreen
            settings={settings}
            patchSettings={patchSettings}
            update={update}
            setUpdate={setUpdate}
          />
        </View>
      </View>

      <View style={styles.tabBar}>
        {tabs.map(({ id, icon }) => (
          <Pressable
            key={id}
            onPress={() => setTab(id)}
            style={styles.tabItem}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === id }}
          >
            <Text style={styles.tabIcon}>{icon}</Text>
            <Text style={[styles.tabLabel, tab === id && styles.tabLabelActive]}>{id}</Text>
            {tab === id ? <View style={styles.tabDot} /> : id === 'SETTINGS' && update ? <View style={styles.tabBadge} /> : null}
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

/* ------------------------------------------------------------------ */
/* CHAT                                                                */
/* ------------------------------------------------------------------ */

function ChatScreen({
  say,
  settings,
  patchSettings,
  openSettings,
}: {
  say: (t: string) => void;
  settings: Settings;
  patchSettings: (p: Partial<Settings>) => void;
  openSettings: () => void;
}) {
  const { apiKey, model, cloudUrl, cloudToken, cloudMode } = settings;
  const [loaded, setLoaded] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [cloudStatus, setCloudStatus] = useState<CloudStatus>('off');
  const [cloudHealthInfo, setCloudHealthInfo] = useState<CloudHealth | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const checkCloud = useCallback(async (base: string) => {
    if (!base) {
      setCloudStatus('off');
      setCloudHealthInfo(null);
      return;
    }
    setCloudStatus('checking');
    try {
      const h = await cloudHealth(base);
      setCloudHealthInfo(h);
      setCloudStatus('online');
    } catch {
      setCloudHealthInfo(null);
      setCloudStatus('offline');
    }
  }, []);

  useEffect(() => {
    checkCloud(cloudUrl);
  }, [cloudUrl, checkCloud]);

  // Only send the phone's key when the server says it has none of its own.
  const keyForCloud = () =>
    cloudHealthInfo && cloudHealthInfo.gemini_key_on_server === false && apiKey ? apiKey : undefined;

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_CHAT).then((h) => {
      if (h) {
        try {
          setMessages(JSON.parse(h));
        } catch {
          setMessages([]);
        }
      }
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (loaded) AsyncStorage.setItem(STORAGE_CHAT, JSON.stringify(messages.slice(-Math.max(10, settings.historyLimit))));
  }, [messages, loaded, settings.historyLimit]);

  const clearChat = () => {
    Alert.alert('Clear chat', 'Delete the whole conversation?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => setMessages([]) },
    ]);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const useCloud = cloudMode && !!cloudUrl;
    if (!apiKey && !useCloud) {
      openSettings();
      return;
    }
    if (settings.haptics) Vibration.vibrate(10);
    const userMsg: ChatMessage = { id: uid(), role: 'user', text, ts: Date.now() };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput('');
    setBusy(true);
    const ctx = profileContext(settings);
    try {
      let result: { reply: PulseReply; modelUsed: string } | null = null;
      let source: 'cloud' | 'device' = 'device';
      if (useCloud) {
        try {
          result = await callCloudChat(cloudUrl, cloudToken, keyForCloud(), next, ctx);
          source = 'cloud';
          setCloudStatus('online');
        } catch (cloudErr: any) {
          setCloudStatus('offline');
          if (!apiKey) throw cloudErr;
          setMessages((prev) => [
            ...prev,
            {
              id: uid(),
              role: 'error',
              text: 'Cloud unavailable (' + (cloudErr?.message || 'error') + '). Answering on this device.',
              ts: Date.now(),
            },
          ]);
        }
      }
      if (!result) {
        result = await callGemini(apiKey, model, next, ctx, settings.temperature);
      }
      const { reply, modelUsed } = result;
      if (source === 'device' && modelUsed && modelUsed !== model) {
        patchSettings({ model: modelUsed });
      }
      const botMsg: ChatMessage = {
        id: uid(),
        role: 'assistant',
        text: reply.direct_response,
        reply,
        source,
        ts: Date.now(),
      };
      setMessages((prev) => [...prev, botMsg]);
      say(replyToSpeech(reply));
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: 'error', text: 'Request failed: ' + (e?.message || String(e)), ts: Date.now() },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const cloudPlan = async (reply: PulseReply) => {
    if (!cloudUrl) {
      openSettings();
      return;
    }
    if (busy) return;
    setBusy(true);
    const now = new Date();
    const start = pad((now.getHours() + (now.getMinutes() > 0 ? 1 : 0)) % 24) + ':00';
    try {
      const run = await runCloudTask(cloudUrl, cloudToken, keyForCloud(), 'plan', {
        summary: reply.one_line_summary || reply.direct_response.slice(0, 300),
        checklist: reply.proactive_checklist,
        start,
      });
      setCloudStatus('online');
      const blocks: any[] = Array.isArray(run?.result?.blocks) ? run.result.blocks : [];
      const lines = blocks.map(
        (b) => String(b?.time ?? '') + '  ·  ' + String(b?.minutes ?? '?') + ' min  ·  ' + String(b?.task ?? ''),
      );
      const tip = String(run?.result?.tip ?? '').trim();
      const plan: PulseReply = {
        direct_response: (lines.length ? lines.join('\n') : 'The server returned no blocks.') + (tip ? '\n\nTip: ' + tip : ''),
        proactive_checklist: blocks.slice(0, 5).map((b) => String(b?.time ?? '') + ' ' + String(b?.task ?? '')),
        one_line_summary: 'Time-blocked plan from ' + start + ' (' + blocks.length + ' blocks)',
      };
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: 'assistant', text: plan.direct_response, reply: plan, source: 'cloud', ts: Date.now() },
      ]);
      say(plan.one_line_summary);
    } catch (e: any) {
      setCloudStatus('offline');
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: 'error', text: 'Cloud task failed: ' + (e?.message || String(e)), ts: Date.now() },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const statusLabel =
    cloudMode && cloudUrl
      ? '☁️ Cloud · ' + (cloudStatus === 'online' ? 'online' : cloudStatus === 'checking' ? 'checking…' : 'offline')
      : apiKey
        ? 'Model: ' + model
        : 'Set up a Gemini key or cloud in Settings';

  if (!loaded) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={C.accent} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.chatToolbar}>
        <Pressable onPress={() => cloudUrl && checkCloud(cloudUrl)} style={{ flex: 1 }}>
          <Text
            style={[
              styles.muted,
              cloudMode && cloudStatus === 'online' && { color: C.good },
              cloudMode && cloudStatus === 'offline' && { color: C.danger },
            ]}
            numberOfLines={1}
          >
            {statusLabel}
          </Text>
        </Pressable>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable onPress={openSettings} style={styles.chip}>
            <Text style={styles.chipText}>⚙️ Settings</Text>
          </Pressable>
          <Pressable onPress={clearChat} style={styles.chip}>
            <Text style={styles.chipText}>🗑 Clear</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 12, paddingBottom: 20 }}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {settings.name.trim() ? 'What\'s on your plate, ' + settings.name.trim().split(' ')[0] + '?' : 'What\'s on your plate?'}
            </Text>
            <Text style={styles.muted}>
              Try: "Plan my week around a Friday exam" or "Help me budget for a trip to Goa".
            </Text>
            {!apiKey && !(cloudMode && cloudUrl) ? (
              <Pressable onPress={openSettings} style={[styles.primaryBtn, { paddingHorizontal: 18 }]}>
                <Text style={styles.primaryBtnText}>Open Settings to get started</Text>
              </Pressable>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <MessageBubble msg={item} say={say} onCloudPlan={cloudUrl ? cloudPlan : undefined} />
        )}
      />

      <View style={styles.composer}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder={apiKey || (cloudMode && cloudUrl) ? 'Ask Pulse anything…' : 'Add a Gemini key or cloud URL in Settings'}
          placeholderTextColor={C.muted}
          style={styles.composerInput}
          multiline
          editable={!busy}
          onSubmitEditing={send}
        />
        <Pressable onPress={send} disabled={busy} style={[styles.sendBtn, busy && { opacity: 0.6 }]}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.sendText}>➤</Text>}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function MessageBubble({
  msg,
  say,
  onCloudPlan,
}: {
  msg: ChatMessage;
  say: (t: string) => void;
  onCloudPlan?: (r: PulseReply) => void;
}) {
  if (msg.role === 'user') {
    return (
      <View style={[styles.bubble, styles.userBubble]}>
        <Text style={styles.bubbleText}>{msg.text}</Text>
      </View>
    );
  }
  if (msg.role === 'error') {
    return (
      <View style={[styles.bubble, styles.errorBubble]}>
        <Text style={styles.bubbleText}>{msg.text}</Text>
      </View>
    );
  }
  const r = msg.reply;
  return (
    <View style={{ marginBottom: 12 }}>
      <View style={[styles.bubble, styles.botBubble]}>
        <Text style={styles.bubbleText}>{msg.text}</Text>
        {msg.source === 'cloud' ? <Text style={styles.sourceTag}>☁️ cloud</Text> : null}
      </View>
      {r ? <ActionCard reply={r} say={say} onCloudPlan={onCloudPlan} /> : null}
    </View>
  );
}

function ActionCard({
  reply,
  say,
  onCloudPlan,
}: {
  reply: PulseReply;
  say: (t: string) => void;
  onCloudPlan?: (r: PulseReply) => void;
}) {
  const summary = reply.one_line_summary || reply.direct_response.slice(0, 120);
  const fullText =
    summary + (reply.proactive_checklist.length ? '\n\n- ' + reply.proactive_checklist.join('\n- ') : '');
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardKicker}>SUMMARY</Text>
        <Pressable onPress={() => speak(replyToSpeech(reply) || summary)} hitSlop={8}>
          <Text style={styles.cardSpeak}>🔊</Text>
        </Pressable>
      </View>
      <Text style={styles.cardSummary}>{summary}</Text>

      <View style={styles.cardRow}>
        <ActionButton label="📅 Calendar" url={calendarUrl(summary, fullText)} />
        <ActionButton label="✉️ Email" url={mailtoUrl(summary, fullText)} />
        <ActionButton label="💬 SMS" url={smsUrl(fullText)} />
        <ActionButton label="📞 Dial" url="tel:" />
        {onCloudPlan && reply.proactive_checklist.length ? (
          <Pressable
            onPress={() => onCloudPlan(reply)}
            style={({ pressed }) => [styles.actionBtn, styles.cloudBtn, pressed && { opacity: 0.7 }]}
            accessibilityRole="button"
            accessibilityLabel="Build a time-blocked plan in the cloud"
          >
            <Text style={styles.actionText}>☁️ Cloud plan</Text>
          </Pressable>
        ) : null}
      </View>

      {reply.proactive_checklist.length ? (
        <View style={{ marginTop: 10 }}>
          <Text style={styles.cardKicker}>PROACTIVE CHECKLIST</Text>
          {reply.proactive_checklist.map((item, i) => (
            <ChecklistRow key={i + item} item={item} summary={summary} say={say} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ChecklistRow({ item, summary, say }: { item: string; summary: string; say: (t: string) => void }) {
  const [done, setDone] = useState(false);
  return (
    <View style={styles.checkRow}>
      <Pressable
        onPress={() => {
          const next = !done;
          setDone(next);
          if (next) say('Done: ' + item);
        }}
        style={styles.checkLine}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done }}
      >
        <Text style={styles.checkBox}>{done ? '☑' : '☐'}</Text>
        <Text style={[styles.checkText, done && styles.checkTextDone]}>{item}</Text>
      </Pressable>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        {actionsForItem(item, summary).map((a) => (
          <ActionButton key={a.label} label={a.label} url={a.url} small />
        ))}
      </ScrollView>
    </View>
  );
}

function ActionButton({ label, url, small }: { label: string; url: string; small?: boolean }) {
  return (
    <Pressable
      onPress={() => openLink(url)}
      style={({ pressed }) => [styles.actionBtn, small && styles.actionBtnSmall, pressed && { opacity: 0.7 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={[styles.actionText, small && { fontSize: 12 }]}>{label}</Text>
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */
/* WIDGETS                                                             */
/* ------------------------------------------------------------------ */

function WidgetsScreen({ say }: { say: (t: string) => void }) {
  const [active, setActive] = useState<string | null>(null);
  const widget = WIDGETS.find((w) => w.id === active);

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(e.nativeEvent.data);
      if (data?.type === 'speak' && typeof data.text === 'string') say(data.text);
    } catch {
      /* ignore non-JSON messages */
    }
  };

  if (widget) {
    return (
      <View style={{ flex: 1 }}>
        <View style={styles.widgetBar}>
          <Pressable onPress={() => setActive(null)} style={styles.chip}>
            <Text style={styles.chipText}>‹ All widgets</Text>
          </Pressable>
          <Text style={styles.widgetBarTitle}>
            {widget.emoji} {widget.title}
          </Text>
        </View>
        <WebView
          key={widget.id}
          originWhitelist={['*']}
          source={{ html: widget.html, baseUrl: 'https://pulseos.local/' + widget.id + '/' }}
          javaScriptEnabled
          domStorageEnabled
          onMessage={onMessage}
          style={{ flex: 1, backgroundColor: C.bg }}
          containerStyle={{ backgroundColor: C.bg }}
          startInLoadingState
          renderLoading={() => (
            <View style={styles.center}>
              <ActivityIndicator color={C.accent} />
            </View>
          )}
        />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={styles.sectionTitle}>Micro-tools</Text>
      {WIDGETS.map((w) => (
        <Pressable
          key={w.id}
          onPress={() => setActive(w.id)}
          style={({ pressed }) => [styles.widgetTile, pressed && { opacity: 0.8 }]}
        >
          <Text style={styles.widgetEmoji}>{w.emoji}</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.widgetTitle}>{w.title}</Text>
            <Text style={styles.mutedSmall}>{w.subtitle}</Text>
          </View>
          <Text style={styles.muted}>›</Text>
        </Pressable>
      ))}
      <Text style={styles.mutedSmall}>Widgets need an internet connection the first time to load Tailwind.</Text>
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ */
/* WORKSPACE                                                           */
/* ------------------------------------------------------------------ */

const HOME_URL = 'https://www.google.com';

function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return HOME_URL;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(s)) return 'https://' + s;
  return searchUrl(s);
}

function WorkspaceScreen({
  say,
  homeUrl,
  confirmFirst,
}: {
  say: (t: string) => void;
  homeUrl: string;
  confirmFirst: boolean;
}) {
  const home = normalizeUrl(homeUrl || HOME_URL);
  const webRef = useRef<WebView>(null);
  const [url, setUrl] = useState(home);
  const [field, setField] = useState(home);
  const [canBack, setCanBack] = useState(false);
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState('');
  const [completed, setCompleted] = useState<{ title: string; url: string; ts: number }[]>([]);

  const go = () => setUrl(normalizeUrl(field));

  const onNav = (nav: WebViewNavigation) => {
    setCanBack(nav.canGoBack);
    setField(nav.url);
    setTitle(nav.title || '');
  };

  const confirmComplete = () => {
    const label = title || field;
    const markDone = () => {
      setCompleted((prev) => [{ title: label, url: field, ts: Date.now() }, ...prev].slice(0, 20));
      say('Task complete: ' + label);
    };
    if (!confirmFirst) {
      markDone();
      return;
    }
    Alert.alert('Confirm task complete', 'Mark "' + label + '" as done?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Confirm', onPress: markDone },
    ]);
  };

  const close = () => {
    setUrl(home);
    setField(home);
    setTitle('');
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.urlBar}>
        <Pressable
          onPress={() => webRef.current?.goBack()}
          disabled={!canBack}
          style={[styles.navBtn, !canBack && { opacity: 0.35 }]}
        >
          <Text style={styles.navText}>‹</Text>
        </Pressable>
        <TextInput
          value={field}
          onChangeText={setField}
          onSubmitEditing={go}
          placeholder="Search or enter URL"
          placeholderTextColor={C.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          selectTextOnFocus
          style={styles.urlInput}
        />
        <Pressable onPress={go} style={styles.navBtn}>
          <Text style={styles.navText}>Go</Text>
        </Pressable>
        <Pressable onPress={() => webRef.current?.reload()} style={styles.navBtn}>
          <Text style={styles.navText}>↻</Text>
        </Pressable>
      </View>
      {loading ? <View style={styles.progress} /> : null}

      <WebView
        ref={webRef}
        source={{ uri: url }}
        onNavigationStateChange={onNav}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        javaScriptEnabled
        domStorageEnabled
        setSupportMultipleWindows={false}
        style={{ flex: 1, backgroundColor: '#fff' }}
      />

      {completed.length ? (
        <View style={styles.completedStrip}>
          <Text style={styles.mutedSmall} numberOfLines={1}>
            ✅ {completed.length} done · last: {completed[0].title}
          </Text>
        </View>
      ) : null}

      <View style={styles.confirmBar}>
        <Pressable onPress={confirmComplete} style={[styles.confirmBtn, { backgroundColor: C.good }]}>
          <Text style={styles.confirmText}>Confirm Task Complete</Text>
        </Pressable>
        <Pressable onPress={close} style={[styles.confirmBtn, { backgroundColor: C.panel2, flex: 0.6 }]}>
          <Text style={styles.confirmText}>Close</Text>
        </Pressable>
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* SETTINGS (Profile · Assistant · Cloud · Voice · Workspace · Updates) */
/* ------------------------------------------------------------------ */

const AVATARS = ['⚡', '🧠', '🚀', '🦊', '🐼', '🐱', '🔥', '🌙', '🎯', '💡', '😎', '🙂'];
const REPLY_LENGTHS: Settings['replyLength'][] = ['short', 'balanced', 'detailed'];

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={styles.settingRow}>
      <View style={{ flex: 1, paddingRight: 10 }}>
        <Text style={styles.settingLabel}>{label}</Text>
        {hint ? <Text style={styles.mutedSmall}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function Stepper({ value, onChange, step, min, max, suffix }: { value: number; onChange: (n: number) => void; step: number; min: number; max: number; suffix?: string }) {
  const set = (n: number) => onChange(Math.max(min, Math.min(max, Math.round(n * 100) / 100)));
  return (
    <View style={styles.stepper}>
      <Pressable onPress={() => set(value - step)} style={styles.stepBtn}><Text style={styles.stepBtnText}>−</Text></Pressable>
      <Text style={styles.stepValue}>{value}{suffix || ''}</Text>
      <Pressable onPress={() => set(value + step)} style={styles.stepBtn}><Text style={styles.stepBtnText}>+</Text></Pressable>
    </View>
  );
}

function SettingsScreen({
  settings,
  patchSettings,
  update,
  setUpdate,
}: {
  settings: Settings;
  patchSettings: (p: Partial<Settings>) => void;
  update: UpdateInfo | null;
  setUpdate: (u: UpdateInfo | null) => void;
}) {
  const s = settings;
  const [testing, setTesting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [checkMsg, setCheckMsg] = useState('');

  const testCloud = async () => {
    const cu = normalizeCloudUrl(s.cloudUrl);
    if (!cu) {
      Alert.alert('Cloud URL needed', 'Paste the URL your Codespace printed.');
      return;
    }
    patchSettings({ cloudUrl: cu });
    setTesting(true);
    try {
      const h = await cloudHealth(cu);
      let authNote = '';
      if (h.auth_required) {
        try {
          await cloudFetch(cu, s.cloudToken.trim(), '/api/info', { timeoutMs: 12000 });
          authNote = '\nToken: accepted';
        } catch (e: any) {
          authNote = '\nToken: ' + (e?.message || 'rejected');
        }
      }
      Alert.alert(
        'Cloud online',
        'Model: ' + (h.model || '?') +
          '\nGemini key on server: ' + (h.gemini_key_on_server ? 'yes' : 'no') +
          '\nToken required: ' + (h.auth_required ? 'yes' : 'no') + authNote,
      );
    } catch (e: any) {
      Alert.alert('Cloud not reachable', e?.message || String(e));
    } finally {
      setTesting(false);
    }
  };

  const check = async () => {
    setChecking(true);
    setCheckMsg('');
    try {
      const info = await checkForUpdate(s.updateRepo, s.updateToken);
      setUpdate(info.available ? info : null);
      setCheckMsg(
        info.available
          ? 'Update available: build ' + info.latestBuild + ' (you have ' + info.currentBuild + ').'
          : 'You are on the latest build (' + info.currentBuild + ').',
      );
    } catch (e: any) {
      setCheckMsg('');
      Alert.alert('Update check failed', e?.message || String(e));
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    if (!update) return;
    setInstalling(true);
    setProgress(0);
    try {
      await downloadAndInstall(update, s.updateToken, setProgress);
      setCheckMsg('Installer opened. Approve the install to finish.');
    } catch (e: any) {
      Alert.alert('Install failed', e?.message || String(e));
    } finally {
      setInstalling(false);
    }
  };

  const cur = currentBuildNumber();

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <Text style={styles.sectionTitle}>Settings</Text>

      {/* Profile */}
      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>👤 Profile</Text>
        <View style={styles.profileRow}>
          <View style={styles.avatarBig}><Text style={{ fontSize: 30 }}>{s.avatar}</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.profileName}>{s.name.trim() || 'Your name'}</Text>
            <Text style={styles.mutedSmall}>{s.role.trim() || 'Add a role or headline'}</Text>
          </View>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 6 }}>
          {AVATARS.map((a) => (
            <Pressable key={a} onPress={() => patchSettings({ avatar: a })} style={[styles.emojiPick, s.avatar === a && styles.emojiPickOn]}>
              <Text style={{ fontSize: 20 }}>{a}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <Text style={styles.fieldLabel}>Name</Text>
        <TextInput value={s.name} onChangeText={(t) => patchSettings({ name: t })} placeholder="e.g. Alex" placeholderTextColor={C.muted} style={styles.input} />
        <Text style={styles.fieldLabel}>Email</Text>
        <TextInput value={s.email} onChangeText={(t) => patchSettings({ email: t })} placeholder="you@example.com" placeholderTextColor={C.muted} autoCapitalize="none" keyboardType="email-address" style={styles.input} />
        <Text style={styles.fieldLabel}>Role / headline</Text>
        <TextInput value={s.role} onChangeText={(t) => patchSettings({ role: t })} placeholder="e.g. CS student, building a startup" placeholderTextColor={C.muted} style={styles.input} />
        <SettingRow label="Personalize replies" hint="Let Pulse use your profile for context">
          <Switch value={s.personalize} onValueChange={(v) => patchSettings({ personalize: v })} trackColor={{ false: C.border, true: C.accent }} thumbColor="#fff" />
        </SettingRow>
        <SettingRow label="Daily focus goal" hint="Minutes of deep work">
          <Stepper value={s.focusGoalMin} onChange={(n) => patchSettings({ focusGoalMin: n })} step={15} min={0} max={720} suffix="m" />
        </SettingRow>
      </View>

      {/* Assistant */}
      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>🧠 Assistant</Text>
        <Text style={styles.mutedSmall}>Gemini API key — stored only on this device. Free at aistudio.google.com.</Text>
        <TextInput value={s.apiKey} onChangeText={(t) => patchSettings({ apiKey: t })} placeholder="AIza…" placeholderTextColor={C.muted} secureTextEntry autoCapitalize="none" autoCorrect={false} style={styles.input} />
        <Text style={styles.fieldLabel}>Model</Text>
        <TextInput value={s.model} onChangeText={(t) => patchSettings({ model: t })} placeholder={DEFAULT_MODEL} placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} style={styles.input} />
        <Text style={styles.fieldLabel}>Reply length</Text>
        <View style={styles.segment}>
          {REPLY_LENGTHS.map((r) => (
            <Pressable key={r} onPress={() => patchSettings({ replyLength: r })} style={[styles.segItem, s.replyLength === r && styles.segItemOn]}>
              <Text style={[styles.segText, s.replyLength === r && styles.segTextOn]}>{r.charAt(0).toUpperCase() + r.slice(1)}</Text>
            </Pressable>
          ))}
        </View>
        <SettingRow label="Creativity" hint="Model temperature">
          <Stepper value={s.temperature} onChange={(n) => patchSettings({ temperature: n })} step={0.1} min={0} max={1} />
        </SettingRow>
        <SettingRow label="Chat history kept" hint="Messages stored on device">
          <Stepper value={s.historyLimit} onChange={(n) => patchSettings({ historyLimit: n })} step={10} min={10} max={200} />
        </SettingRow>
      </View>

      {/* Cloud */}
      <View style={styles.settingsCard}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>☁️ Cloud backend</Text>
          <Switch value={s.cloudMode} onValueChange={(v) => patchSettings({ cloudMode: v && !!s.cloudUrl })} trackColor={{ false: C.border, true: C.accent }} thumbColor="#fff" />
        </View>
        <Text style={styles.mutedSmall}>Route chat through your own server. Paste the Codespace URL (https://NAME-3000.app.github.dev) or just the name.</Text>
        <TextInput value={s.cloudUrl} onChangeText={(t) => patchSettings({ cloudUrl: t })} onBlur={() => patchSettings({ cloudUrl: normalizeCloudUrl(s.cloudUrl) })} placeholder="https://your-codespace-3000.app.github.dev" placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.input} />
        <TextInput value={s.cloudToken} onChangeText={(t) => patchSettings({ cloudToken: t })} placeholder="PULSE_TOKEN (if the server has one)" placeholderTextColor={C.muted} secureTextEntry autoCapitalize="none" autoCorrect={false} style={styles.input} />
        <Pressable onPress={testCloud} disabled={testing} style={styles.secondaryBtn}>
          {testing ? <ActivityIndicator color={C.text} /> : <Text style={styles.primaryBtnText}>Test connection</Text>}
        </Pressable>
      </View>

      {/* Voice */}
      <View style={styles.settingsCard}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>🔊 Voice readout</Text>
          <Switch
            value={s.voiceOn}
            onValueChange={(v) => {
              patchSettings({ voiceOn: v });
              if (v) speakWith({ ...s, voiceOn: true }, 'Voice readout on.');
              else Speech.stop();
            }}
            trackColor={{ false: C.border, true: C.accent }}
            thumbColor="#fff"
          />
        </View>
        <Text style={styles.mutedSmall}>Reads summaries and reminders aloud.</Text>
        <SettingRow label="Speed">
          <Stepper value={s.voiceRate} onChange={(n) => patchSettings({ voiceRate: n })} step={0.1} min={0.5} max={2} />
        </SettingRow>
        <SettingRow label="Pitch">
          <Stepper value={s.voicePitch} onChange={(n) => patchSettings({ voicePitch: n })} step={0.1} min={0.5} max={2} />
        </SettingRow>
        <Text style={styles.fieldLabel}>Language code</Text>
        <TextInput value={s.voiceLang} onChangeText={(t) => patchSettings({ voiceLang: t })} placeholder="en-US" placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} style={styles.input} />
        <Pressable onPress={() => speakWith(settings, 'This is how Pulse will read your tasks aloud.')} style={styles.secondaryBtn}>
          <Text style={styles.primaryBtnText}>Preview voice</Text>
        </Pressable>
      </View>

      {/* Workspace & chat */}
      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>🌐 Workspace & chat</Text>
        <Text style={styles.fieldLabel}>Workspace home page</Text>
        <TextInput value={s.homeUrl} onChangeText={(t) => patchSettings({ homeUrl: t })} placeholder="https://www.google.com" placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.input} />
        <SettingRow label="Confirm before marking done" hint="Ask before completing a task">
          <Switch value={s.confirmBeforeComplete} onValueChange={(v) => patchSettings({ confirmBeforeComplete: v })} trackColor={{ false: C.border, true: C.accent }} thumbColor="#fff" />
        </SettingRow>
        <SettingRow label="Haptics" hint="Vibrate when sending">
          <Switch value={s.haptics} onValueChange={(v) => patchSettings({ haptics: v })} trackColor={{ false: C.border, true: C.accent }} thumbColor="#fff" />
        </SettingRow>
      </View>

      {/* Updates */}
      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>⬇️ App updates</Text>
        <Text style={styles.mutedSmall}>Pulse OS installs outside the Play Store, so it updates itself from GitHub Releases. You're on build {cur}.</Text>
        <Text style={styles.fieldLabel}>Release source (owner/repo)</Text>
        <TextInput value={s.updateRepo} onChangeText={(t) => patchSettings({ updateRepo: t })} placeholder={DEFAULT_UPDATE_REPO} placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} style={styles.input} />
        <Text style={styles.fieldLabel}>GitHub token (needed for a private repo)</Text>
        <TextInput value={s.updateToken} onChangeText={(t) => patchSettings({ updateToken: t })} placeholder="ghp_… (read-only)" placeholderTextColor={C.muted} secureTextEntry autoCapitalize="none" autoCorrect={false} style={styles.input} />
        <SettingRow label="Check on launch" hint="Look for updates when the app opens">
          <Switch value={s.autoCheckUpdates} onValueChange={(v) => patchSettings({ autoCheckUpdates: v })} trackColor={{ false: C.border, true: C.accent }} thumbColor="#fff" />
        </SettingRow>
        <Pressable onPress={check} disabled={checking || installing} style={styles.secondaryBtn}>
          {checking ? <ActivityIndicator color={C.text} /> : <Text style={styles.primaryBtnText}>Check for updates</Text>}
        </Pressable>
        {checkMsg ? <Text style={[styles.mutedSmall, { marginTop: 6 }]}>{checkMsg}</Text> : null}
        {update ? (
          <View style={styles.updateBox}>
            <Text style={styles.updateHead}>{update.name || ('Build ' + update.latestBuild)}</Text>
            <Text style={styles.mutedSmall}>
              {formatBytes(update.sizeBytes)}{update.sizeBytes ? ' · ' : ''}build {update.latestBuild}
            </Text>
            {update.notes ? <Text style={[styles.mutedSmall, { marginTop: 6 }]} numberOfLines={6}>{update.notes}</Text> : null}
            {installing ? (
              <View style={styles.progressTrack}><View style={[styles.progressFill, { width: (Math.round(progress * 100) + '%') as any }]} /></View>
            ) : null}
            <Pressable onPress={install} disabled={installing} style={[styles.primaryBtn, { marginTop: 10 }]}>
              <Text style={styles.primaryBtnText}>{installing ? 'Downloading ' + Math.round(progress * 100) + '%' : '⬇️ Download & install'}</Text>
            </Pressable>
          </View>
        ) : null}
        <Text style={[styles.mutedSmall, { marginTop: 8 }]}>Android will ask you to allow installs from Pulse OS the first time.</Text>
      </View>

      {/* About */}
      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>ℹ️ About</Text>
        <Text style={styles.mutedSmall}>
          {(Application.applicationName || 'Pulse OS')} v{Application.nativeApplicationVersion || '1.0.0'} (build {cur})
        </Text>
        <Text style={styles.mutedSmall}>Package: {Application.applicationId || 'com.pulseos.app'}</Text>
        <Pressable
          onPress={() =>
            Alert.alert('Reset settings', 'Restore every setting to its default? Your chat history stays.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Reset', style: 'destructive', onPress: () => patchSettings({ ...DEFAULT_SETTINGS }) },
            ])
          }
          style={[styles.secondaryBtn, { borderColor: C.danger, marginTop: 8 }]}
        >
          <Text style={[styles.primaryBtnText, { color: C.danger }]}>Reset all settings</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
    paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight ?? 0 : 0,
  },
  fill: { ...StyleSheet.absoluteFillObject },
  hidden: { display: 'none' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  brand: { color: C.text, fontSize: 20, fontWeight: '800', letterSpacing: 0.5 },
  brandSub: { color: C.muted, fontSize: 12 },
  voiceBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.panel,
  },
  voiceBtnOn: { borderColor: C.accent, backgroundColor: '#2A1F5C' },
  voiceIcon: { fontSize: 16 },
  voiceText: { color: C.muted, fontWeight: '700', fontSize: 12 },

  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
    backgroundColor: C.panel,
    paddingBottom: 6,
  },
  tabItem: { flex: 1, alignItems: 'center', paddingTop: 8, paddingBottom: 4 },
  tabIcon: { fontSize: 18 },
  tabLabel: { color: C.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginTop: 2 },
  tabLabelActive: { color: C.text },
  tabDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: C.accent, marginTop: 3 },

  muted: { color: C.muted, fontSize: 13 },
  mutedSmall: { color: C.muted, fontSize: 12 },
  sectionTitle: { color: C.text, fontSize: 16, fontWeight: '700' },

  chatToolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: C.panel2,
    borderWidth: 1,
    borderColor: C.border,
  },
  chipText: { color: C.text, fontSize: 12, fontWeight: '600' },

  settings: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: 14,
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.border,
    gap: 6,
  },
  settingsTitle: { color: C.text, fontWeight: '700' },
  input: {
    color: C.text,
    backgroundColor: C.panel2,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  primaryBtn: {
    marginTop: 8,
    backgroundColor: C.accent,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontWeight: '700' },
  secondaryBtn: {
    backgroundColor: C.panel2,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    paddingVertical: 12,
    alignItems: 'center',
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: C.border, marginVertical: 8 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowCenter: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sourceTag: { color: C.accent2, fontSize: 11, fontWeight: '700', marginTop: 6 },
  cloudBtn: { borderColor: C.accent2 },
  avatarSmall: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border,
    alignItems: 'center', justifyContent: 'center', marginRight: 10,
  },
  avatarBig: {
    width: 60, height: 60, borderRadius: 30, backgroundColor: C.panel2, borderWidth: 2, borderColor: C.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  profileRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 4 },
  profileName: { color: C.text, fontSize: 18, fontWeight: '800' },
  emojiPick: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border },
  emojiPickOn: { borderColor: C.accent, backgroundColor: '#2A1F5C' },
  settingsCard: { backgroundColor: C.panel, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 14, gap: 8 },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: '800' },
  fieldLabel: { color: C.muted, fontSize: 12, fontWeight: '700', marginTop: 4 },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  settingLabel: { color: C.text, fontSize: 14, fontWeight: '600' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepBtn: { width: 32, height: 32, borderRadius: 8, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  stepBtnText: { color: C.text, fontSize: 18, fontWeight: '700' },
  stepValue: { color: C.text, minWidth: 44, textAlign: 'center', fontWeight: '700' },
  segment: { flexDirection: 'row', backgroundColor: C.panel2, borderRadius: 10, padding: 3, borderWidth: 1, borderColor: C.border },
  segItem: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  segItemOn: { backgroundColor: C.accent },
  segText: { color: C.muted, fontWeight: '700', fontSize: 13 },
  segTextOn: { color: '#fff' },
  updateBanner: { backgroundColor: '#123524', borderBottomWidth: 1, borderBottomColor: C.good, paddingHorizontal: 14, paddingVertical: 8 },
  updateBannerText: { color: C.text, fontSize: 13, fontWeight: '600' },
  updateBox: { marginTop: 8, padding: 12, borderRadius: 12, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.good },
  updateHead: { color: C.text, fontWeight: '800', fontSize: 15 },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: C.border, marginTop: 10, overflow: 'hidden' },
  progressFill: { height: 6, backgroundColor: C.good },
  tabBadge: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.good, marginTop: 3 },

  empty: { padding: 24, alignItems: 'center', gap: 8, marginTop: 40 },
  emptyTitle: { color: C.text, fontSize: 18, fontWeight: '700' },

  bubble: { maxWidth: '88%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 8 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: C.accent, borderBottomRightRadius: 4 },
  botBubble: { alignSelf: 'flex-start', backgroundColor: C.panel2, borderBottomLeftRadius: 4 },
  errorBubble: { alignSelf: 'flex-start', backgroundColor: '#3B1418', borderWidth: 1, borderColor: C.danger },
  bubbleText: { color: C.text, fontSize: 15, lineHeight: 21 },

  card: {
    backgroundColor: C.panel,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardKicker: { color: C.accent2, fontSize: 11, fontWeight: '800', letterSpacing: 1.2, marginBottom: 6 },
  cardSpeak: { fontSize: 18 },
  cardSummary: { color: C.text, fontSize: 15, fontWeight: '600', marginBottom: 10 },
  cardRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },

  actionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: C.panel2,
    borderWidth: 1,
    borderColor: C.border,
  },
  actionBtnSmall: { paddingHorizontal: 10, paddingVertical: 6 },
  actionText: { color: C.text, fontSize: 13, fontWeight: '600' },

  checkRow: { paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, gap: 6 },
  checkLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  checkBox: { color: C.accent2, fontSize: 18, lineHeight: 20 },
  checkText: { color: C.text, fontSize: 14, flex: 1, lineHeight: 20 },
  checkTextDone: { color: C.muted, textDecorationLine: 'line-through' },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 10,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
    backgroundColor: C.bg,
  },
  composerInput: {
    flex: 1,
    color: C.text,
    backgroundColor: C.panel2,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxHeight: 120,
    fontSize: 15,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: { color: '#fff', fontSize: 18, fontWeight: '800' },

  widgetTile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    borderRadius: 16,
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.border,
  },
  widgetEmoji: { fontSize: 28 },
  widgetTitle: { color: C.text, fontSize: 16, fontWeight: '700' },
  widgetBar: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10 },
  widgetBarTitle: { color: C.text, fontWeight: '700' },

  urlBar: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8, backgroundColor: C.panel },
  urlInput: {
    flex: 1,
    color: C.text,
    backgroundColor: C.panel2,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  navBtn: {
    minWidth: 36,
    height: 36,
    paddingHorizontal: 8,
    borderRadius: 10,
    backgroundColor: C.panel2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navText: { color: C.text, fontSize: 16, fontWeight: '700' },
  progress: { height: 2, backgroundColor: C.accent2 },
  completedStrip: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: C.panel },
  confirmBar: {
    flexDirection: 'row',
    gap: 8,
    padding: 10,
    backgroundColor: C.panel,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
  confirmBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
  confirmText: { color: '#fff', fontWeight: '700' },
});
