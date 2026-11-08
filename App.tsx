import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Animated,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  Image,
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
import { captureRef } from 'react-native-view-shot';

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
const DEFAULT_CLOUD_URL = 'https://scaling-space-telegram-jjg94w99g6pj255vv-3000.app.github.dev';

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

type Tab = 'CHAT' | 'APPS' | 'LIVE' | 'SETTINGS';

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
  streaming?: boolean;
  steps?: Step[];
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


/* ---- Fast path: streaming Gemini replies (text first, actions after) ---- */

type SpeedMode = 'fast' | 'balanced' | 'smart';
const FAST_MODEL = 'gemini-flash-lite-latest';
const META_MARK = '<<<PULSE_META>>>';

function buildStreamPrompt(extraSystem: string): string {
  const now = new Date();
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      return '';
    }
  })();
  return [
    'You are Pulse, a sharp, warm personal-productivity assistant inside the Pulse OS app.',
    'Current local time: ' + now.toString() + (tz ? ' (' + tz + ')' : '') + '.',
    'First understand what the user actually wants, using the whole conversation, then answer it directly.',
    'Lead with the answer. Be specific and practical, no filler, no "Great question".',
    'Reply in the same language the user writes in (English, Hindi, Telugu, Hinglish, etc).',
    'Only ask a clarifying question when the request truly cannot be answered without it.',
    'Plain text only: no markdown headings, no tables; short lines or "-" bullets are fine.',
    'Do not add follow-up suggestion lists or a summary line at the end.',
    extraSystem,
  ]
    .filter(Boolean)
    .join('\n');
}

function splitStreamText(full: string): { visible: string; meta: string | null } {
  const i = full.indexOf(META_MARK);
  if (i === -1) {
    // Hide a partially-streamed marker at the very end.
    const tail = full.lastIndexOf('<<<');
    const visible = tail !== -1 && full.length - tail < META_MARK.length ? full.slice(0, tail) : full;
    return { visible: visible.trimEnd(), meta: null };
  }
  return { visible: full.slice(0, i).trimEnd(), meta: full.slice(i + META_MARK.length) };
}

function finishStreamReply(full: string): PulseReply {
  const { visible, meta } = splitStreamText(full);
  let checklist: string[] = [];
  let summary = '';
  if (meta) {
    const m = stripCodeFences(meta);
    const a = m.indexOf('{');
    const b = m.lastIndexOf('}');
    if (a !== -1 && b > a) {
      try {
        const o: any = JSON.parse(m.slice(a, b + 1));
        if (Array.isArray(o.proactive_checklist)) {
          checklist = o.proactive_checklist.map((x: unknown) => String(x)).filter((x: string) => x.trim()).slice(0, 5);
        }
        summary = String(o.one_line_summary ?? '').trim();
      } catch {
        /* keep the answer even when the metadata is malformed */
      }
    }
  }
  // A model that ignored the format and sent JSON: fall back to the old parser.
  if (!meta && /^\s*[{`]/.test(visible)) return parsePulseReply(visible);
  return { direct_response: visible || 'No response received.', proactive_checklist: checklist, one_line_summary: summary };
}

function thinkingFor(model: string, speed: SpeedMode): any | undefined {
  if (speed === 'smart') return undefined;
  if (/gemini-2\.5/i.test(model)) return /pro/i.test(model) ? { thinkingBudget: 128 } : { thinkingBudget: 0 };
  if (/pro/i.test(model)) return { thinkingLevel: 'low' };
  // Gemini 3+ and the *-latest aliases take a thinking level.
  return { thinkingLevel: speed === 'fast' ? 'minimal' : 'low' };
}

function streamOnce(
  apiKey: string,
  model: string,
  body: string,
  onText: (full: string) => void,
  firstTokenMs = 6000,
  totalMs = 30000,
): Promise<{ full: string; status: number; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let done = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const finish = (r: { full: string; status: number; error?: string }) => {
      if (done) return;
      done = true;
      if (watchdog) clearTimeout(watchdog);
      resolve(r);
    };
    // No first words fast enough: give up on this model so the next one can answer.
    watchdog = setTimeout(() => {
      if (!full) {
        try {
          xhr.abort();
        } catch {
          /* ignore */
        }
        finish({ full: '', status: 0, error: 'slow' });
      }
    }, firstTokenMs);
    let seen = 0;
    let buffer = '';
    let full = '';
    const pump = () => {
      const chunk = xhr.responseText.slice(seen);
      seen = xhr.responseText.length;
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      let changed = false;
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j: any = JSON.parse(data);
          const parts: any[] = j?.candidates?.[0]?.content?.parts ?? [];
          for (const p of parts) {
            if (p?.thought) continue;
            if (typeof p?.text === 'string') {
              full += p.text;
              changed = true;
            }
          }
        } catch {
          /* partial line; ignore */
        }
      }
      if (changed) onText(full);
    };
    xhr.open('POST', GEMINI_BASE + encodeURIComponent(model) + ':streamGenerateContent?alt=sse');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('x-goog-api-key', apiKey);
    xhr.timeout = totalMs;
    xhr.onprogress = () => {
      if (xhr.status === 200) pump();
    };
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 3 && xhr.status === 200) pump();
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        buffer += '\n';
        pump();
        finish({ full, status: 200 });
      } else {
        let msg = 'HTTP ' + xhr.status;
        try {
          const j = JSON.parse(xhr.responseText);
          msg = (Array.isArray(j) ? j[0] : j)?.error?.message || msg;
        } catch {
          /* keep HTTP code */
        }
        finish({ full: '', status: xhr.status, error: msg });
      }
    };
    xhr.onerror = () => finish({ full: '', status: 0, error: 'Network error' });
    xhr.ontimeout = () => finish({ full, status: full ? 200 : 0, error: full ? undefined : 'Timed out' });
    xhr.send(body);
  });
}

async function streamGemini(
  apiKey: string,
  model: string,
  history: ChatMessage[],
  extraSystem: string,
  temperature: number,
  speed: SpeedMode,
  onText: (visible: string) => void,
): Promise<{ reply: PulseReply; modelUsed: string }> {
  const contents = history
    .filter((m) => m.role !== 'error' && m.text.trim())
    .slice(-16)
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
  const sys = buildStreamPrompt(extraSystem);
  const make = (thinking: any | undefined) =>
    JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: speed === 'smart' ? 4096 : 1500,
        ...(thinking ? { thinkingConfig: thinking } : {}),
      },
    });
  const emit = (full: string) => onText(splitStreamText(full).visible);

  // Busy/overloaded/slow models are skipped instantly; the next fast model answers instead.
  const chain = modelChain(model);
  let lastErr = '';
  let sawNetwork = false;
  for (const m of chain) {
    if (isCooling(m)) continue;
    let r = await streamOnce(apiKey, m, make(thinkingFor(m, speed)), emit);
    if (r.status === 400 && /thinking/i.test(r.error || '')) {
      r = await streamOnce(apiKey, m, make(undefined), emit);
    }
    if (r.status === 200 && r.full.trim()) {
      noteGood(m);
      return { reply: finishStreamReply(r.full), modelUsed: m };
    }
    lastErr = r.error || 'HTTP ' + r.status;
    if (r.error === 'Network error') sawNetwork = true;
    if (r.status === 401 || (r.status === 400 && /api key/i.test(lastErr))) {
      throw new Error('Your Gemini API key was rejected. Check it in Settings → Assistant.');
    }
    // 429 quota, 5xx overloaded/high demand, 404 retired model, slow first token: cool down and move on.
    coolDown(m, r.status === 429 ? 60000 : r.status === 404 ? 3600000 : 30000);
  }
  if (sawNetwork) throw new Error('No internet connection.');
  if (/quota|429|exhausted/i.test(lastErr)) {
    throw new Error('Your free Gemini quota is used up for now. Try again in a minute, or pick another model.');
  }
  throw new Error('Google\'s models are busy right now. Tap send again in a few seconds.');
}

const FALLBACK_MODELS = [
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
];
const cooldowns: Record<string, number> = {};
let lastGoodModel = '';
function isCooling(m: string) {
  return (cooldowns[m] || 0) > Date.now();
}
function coolDown(m: string, ms: number) {
  cooldowns[m] = Date.now() + ms;
}
function noteGood(m: string) {
  lastGoodModel = m;
  delete cooldowns[m];
}
function modelChain(preferred: string): string[] {
  const out: string[] = [];
  const add = (m: string) => m && !out.includes(m) && out.push(m);
  add(preferred);
  if (lastGoodModel && lastGoodModel !== preferred && isCooling(preferred)) out.unshift(lastGoodModel);
  FALLBACK_MODELS.forEach(add);
  // If everything is cooling down, still try the two fastest rather than failing.
  if (out.every(isCooling)) {
    delete cooldowns[out[0]];
    delete cooldowns['gemini-flash-lite-latest'];
  }
  return out;
}


/* ------------------------------------------------------------------ */
/* Live bus: chat ⇄ workspace ("show what the app is doing")          */
/* ------------------------------------------------------------------ */

type LiveState = {
  active: boolean;
  url: string;
  title: string;
  loading: boolean;
  progress: number;
  thumb: string | null;
  log: { t: number; text: string }[];
  startedAt: number;
};

const EMPTY_LIVE: LiveState = { active: false, url: '', title: '', loading: false, progress: 0, thumb: null, log: [], startedAt: 0 };

const LiveBus = (() => {
  let state: LiveState = EMPTY_LIVE;
  const stateSubs = new Set<(s: LiveState) => void>();
  const navSubs = new Set<(url: string) => void>();
  const focusSubs = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<LiveState>, logLine?: string) {
      const log = logLine ? [...state.log, { t: Date.now(), text: logLine }].slice(-8) : state.log;
      state = { ...state, ...patch, log };
      stateSubs.forEach((f) => f(state));
    },
    reset() {
      state = EMPTY_LIVE;
      stateSubs.forEach((f) => f(state));
    },
    onState(f: (s: LiveState) => void) {
      stateSubs.add(f);
      return () => {
        stateSubs.delete(f);
      };
    },
    open(url: string) {
      state = { ...EMPTY_LIVE, active: true, url, loading: true, startedAt: Date.now(), log: [{ t: Date.now(), text: 'Opening ' + hostOf(url) }] };
      stateSubs.forEach((f) => f(state));
      navSubs.forEach((f) => f(url));
    },
    onNav(f: (url: string) => void) {
      navSubs.add(f);
      return () => {
        navSubs.delete(f);
      };
    },
    focus() {
      focusSubs.forEach((f) => f());
    },
    onFocus(f: () => void) {
      focusSubs.add(f);
      return () => {
        focusSubs.delete(f);
      };
    },
  };
})();

function hostOf(u: string) {
  const m = String(u).match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1].replace(/^www\./, '') : u;
}

function useLive(): LiveState {
  const [s, setS] = useState<LiveState>(LiveBus.get());
  useEffect(() => LiveBus.onState(setS), []);
  return s;
}

/** Live mini view of the Workspace browser, shown in chat (tap to go full screen). */
function LiveCard() {
  const live = useLive();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live.active) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [live.active]);
  if (!live.active) return null;
  const secs = Math.max(0, Math.round((Date.now() - live.startedAt) / 1000));
  const last = live.log[live.log.length - 1];
  return (
    <Pressable onPress={() => LiveBus.focus()} style={styles.liveCard} accessibilityLabel="Open the live Workspace view">
      <View style={styles.liveThumbWrap}>
        {live.thumb ? (
          <Image source={{ uri: live.thumb }} style={styles.liveThumb} resizeMode="cover" />
        ) : (
          <View style={[styles.liveThumb, styles.center]}>
            <ActivityIndicator color={C.accent} />
          </View>
        )}
        <View style={styles.liveBadge}>
          <View style={[styles.liveDot, !live.loading && { backgroundColor: C.good }]} />
          <Text style={styles.liveBadgeText}>{live.loading ? 'LIVE' : 'READY'}</Text>
        </View>
      </View>
      <View style={{ flex: 1, paddingLeft: 10 }}>
        <Text style={styles.liveTitle} numberOfLines={1}>{live.title || hostOf(live.url)}</Text>
        <Text style={styles.mutedSmall} numberOfLines={1}>{hostOf(live.url)} · {secs}s</Text>
        {last ? <Text style={[styles.mutedSmall, { color: C.text, marginTop: 4 }]} numberOfLines={2}>{last.text}</Text> : null}
        {live.loading ? (
          <View style={styles.liveTrack}><View style={[styles.liveFill, { width: (Math.round(Math.max(0.08, live.progress) * 100) + '%') as any }]} /></View>
        ) : null}
        <Text style={[styles.mutedSmall, { color: C.accent, marginTop: 4 }]}>Tap to watch full screen ›</Text>
      </View>
      <Pressable onPress={() => LiveBus.reset()} hitSlop={10} style={{ paddingLeft: 6 }} accessibilityLabel="Hide live view">
        <Text style={styles.mutedSmall}>✕</Text>
      </Pressable>
    </Pressable>
  );
}

/* ---- Reply steps ("what Pulse is doing") ---- */

type Step = { label: string; status: 'active' | 'done' | 'error'; startedAt: number; ms?: number };

function StepsView({ steps, streaming }: { steps: Step[]; streaming?: boolean }) {
  const [open, setOpen] = useState(true);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!streaming) {
      setOpen(false);
      return;
    }
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [streaming]);
  if (!steps.length) return null;
  const total = steps.reduce((a, s) => a + (s.ms ?? (s.status === 'active' ? Date.now() - s.startedAt : 0)), 0);
  return (
    <View style={styles.stepsBox}>
      <Pressable onPress={() => setOpen((o) => !o)} style={styles.rowBetween}>
        <Text style={styles.stepsHead}>
          {streaming ? '⚙️ Working… ' : '✓ Worked for '}
          {(total / 1000).toFixed(1)}s
        </Text>
        <Text style={styles.mutedSmall}>{open ? 'Hide steps ▴' : 'Show steps ▾'}</Text>
      </Pressable>
      {open
        ? steps.map((s, i) => (
            <View key={i} style={styles.stepRow}>
              {s.status === 'active' ? (
                <ActivityIndicator size="small" color={C.accent} style={{ width: 16 }} />
              ) : (
                <Text style={[styles.stepIcon, s.status === 'error' && { color: C.danger }]}>{s.status === 'done' ? '✓' : '!'}</Text>
              )}
              <Text style={[styles.stepText, s.status === 'active' && { color: C.text }]}>{s.label}</Text>
              <Text style={styles.stepMs}>
                {((s.ms ?? (s.status === 'active' ? Date.now() - s.startedAt : 0)) / 1000).toFixed(1)}s
              </Text>
            </View>
          ))
        : null}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Models, JSON calls with automatic fallback                          */
/* ------------------------------------------------------------------ */

const MODEL_CHOICES: { id: string; name: string; note: string }[] = [
  { id: 'gemini-flash-lite-latest', name: '⚡ Flash-Lite', note: 'Fastest replies (1–3 s)' },
  { id: 'gemini-flash-latest', name: '✨ Flash', note: 'Fast and smarter' },
  { id: 'gemini-pro-latest', name: '🧠 Pro', note: 'Smartest, slower; free keys have low limits' },
  { id: 'gemini-2.5-flash', name: '2.5 Flash', note: 'Previous generation' },
];

function modelLabel(id: string) {
  const m = MODEL_CHOICES.find((x) => x.id === id);
  return m ? m.name : id;
}

async function geminiJson(
  apiKey: string,
  preferred: string,
  system: string,
  contents: any[],
  timeoutMs = 15000,
): Promise<{ json: any; model: string }> {
  let lastErr = '';
  for (const m of modelChain(preferred)) {
    if (isCooling(m)) continue;
    let thinking: any | undefined = thinkingFor(m, 'fast');
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(GEMINI_BASE + encodeURIComponent(m) + ':generateContent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents,
            generationConfig: {
              temperature: 0.2,
              responseMimeType: 'application/json',
              ...(thinking ? { thinkingConfig: thinking } : {}),
            },
          }),
          signal: ctrl.signal,
        });
        const j: any = await res.json().catch(() => null);
        if (!res.ok) {
          const msg: string = j?.error?.message || 'HTTP ' + res.status;
          lastErr = msg;
          if (res.status === 401 || (res.status === 400 && /api key/i.test(msg))) {
            throw new Error('KEY_REJECTED');
          }
          if (res.status === 400 && /thinking/i.test(msg) && thinking) {
            thinking = undefined;
            continue;
          }
          coolDown(m, res.status === 429 ? 60000 : res.status === 404 ? 3600000 : 30000);
          break;
        }
        const text: string = j?.candidates?.[0]?.content?.parts
          ?.filter((p: any) => !p?.thought)
          .map((p: any) => p?.text ?? '')
          .join('') ?? '';
        const clean = stripCodeFences(text);
        const a = clean.indexOf('{');
        const b = clean.lastIndexOf('}');
        const json = JSON.parse(a !== -1 && b > a ? clean.slice(a, b + 1) : clean);
        noteGood(m);
        return { json, model: m };
      } catch (e: any) {
        if (e?.message === 'KEY_REJECTED') {
          throw new Error('Your Gemini API key was rejected. Check it in Settings → Assistant.');
        }
        lastErr = e?.name === 'AbortError' ? 'slow' : e?.message || String(e);
        coolDown(m, 30000);
        break;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  if (/quota|429|exhausted/i.test(lastErr)) {
    throw new Error('Your free Gemini quota is used up for now. Try again in a minute, or pick another model.');
  }
  throw new Error('Google\'s models are busy right now. Try again in a few seconds.');
}

/* ------------------------------------------------------------------ */
/* Cross-app: open other apps with standard Android links              */
/* ------------------------------------------------------------------ */

type AppArgs = { query?: string; to?: string; text?: string };

const APPS: { id: string; name: string; icon: string; hint: string }[] = [
  { id: 'whatsapp', name: 'WhatsApp', icon: '💬', hint: 'Message to send' },
  { id: 'maps', name: 'Maps', icon: '🗺️', hint: 'Place to find' },
  { id: 'navigate', name: 'Navigate', icon: '🧭', hint: 'Where to go' },
  { id: 'youtube', name: 'YouTube', icon: '▶️', hint: 'Video to search' },
  { id: 'spotify', name: 'Spotify', icon: '🎵', hint: 'Song or artist' },
  { id: 'phone', name: 'Call', icon: '📞', hint: 'Phone number' },
  { id: 'sms', name: 'SMS', icon: '✉️', hint: 'Message text' },
  { id: 'email', name: 'Email', icon: '📧', hint: 'Subject' },
  { id: 'calendar', name: 'Calendar', icon: '📅', hint: 'Event title' },
  { id: 'telegram', name: 'Telegram', icon: '✈️', hint: 'Message to share' },
  { id: 'instagram', name: 'Instagram', icon: '📸', hint: 'Username' },
  { id: 'playstore', name: 'Play Store', icon: '🛍️', hint: 'App to find' },
  { id: 'web', name: 'Web search', icon: '🔎', hint: 'Search the web' },
  { id: 'settings', name: 'Settings', icon: '⚙️', hint: 'Phone settings' },
];

function phoneDigits(to: string) {
  let d = String(to || '').replace(/[^\d]/g, '');
  if (d.length === 10 && /^[6-9]/.test(d)) d = '91' + d; // Indian mobile without country code
  return d;
}

function appUrls(app: string, a: AppArgs): string[] {
  const q = encodeURIComponent(a.query || a.text || '');
  const t = encodeURIComponent(a.text || a.query || '');
  switch (app) {
    case 'whatsapp': {
      const d = phoneDigits(a.to || '');
      return [
        'whatsapp://send?' + (d ? 'phone=' + d + '&' : '') + 'text=' + t,
        'https://wa.me/' + d + '?text=' + t,
      ];
    }
    case 'maps':
      return ['geo:0,0?q=' + q, 'https://www.google.com/maps/search/?api=1&query=' + q];
    case 'navigate':
      return ['google.navigation:q=' + q, 'https://www.google.com/maps/dir/?api=1&destination=' + q];
    case 'youtube':
      return ['vnd.youtube://results?search_query=' + q, 'https://www.youtube.com/results?search_query=' + q];
    case 'spotify':
      return ['spotify:search:' + q, 'https://open.spotify.com/search/' + q];
    case 'phone':
      return ['tel:' + String(a.to || a.query || '').replace(/[^\d+]/g, '')];
    case 'sms':
      return ['sms:' + String(a.to || '').replace(/[^\d+]/g, '') + '?body=' + t];
    case 'email':
      return [mailtoUrl(a.query || '', a.text || '')];
    case 'calendar':
      return [calendarUrl(a.query || a.text || 'New event', a.text || '')];
    case 'telegram':
      return ['tg://msg?text=' + t, 'https://t.me/share/url?url=&text=' + t];
    case 'instagram': {
      const u = String(a.query || '').replace(/^@/, '').trim();
      return u ? ['instagram://user?username=' + encodeURIComponent(u), 'https://instagram.com/' + encodeURIComponent(u)] : ['instagram://app', 'https://instagram.com/'];
    }
    case 'playstore':
      return ['market://search?q=' + q, 'https://play.google.com/store/search?q=' + q];
    case 'web':
      return [searchUrl(a.query || a.text || '')];
    default:
      return [];
  }
}

async function openApp(app: string, a: AppArgs): Promise<boolean> {
  if (app === 'settings') {
    await Linking.openSettings().catch(() => undefined);
    return true;
  }
  for (const u of appUrls(app, a)) {
    try {
      await Linking.openURL(u);
      return true;
    } catch {
      /* not installed: try the web fallback */
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Agent: Pulse drives its own in-app browser (LIVE tab)               */
/* ------------------------------------------------------------------ */

type PageSnap = { url: string; title: string; els: { i: number; tag: string; label: string }[]; text: string };
type AgentRunner = {
  evalJs: (body: string) => Promise<any>;
  navigate: (url: string) => void;
  isLoading: () => boolean;
};
type AgentStatus = { running: boolean; goal: string; step: string };

const AgentBus = (() => {
  let runner: AgentRunner | null = null;
  let stopped = false;
  let status: AgentStatus = { running: false, goal: '', step: '' };
  const subs = new Set<(s: AgentStatus) => void>();
  const emit = () => subs.forEach((f) => f(status));
  return {
    register(r: AgentRunner) {
      runner = r;
      return () => {
        if (runner === r) runner = null;
      };
    },
    runner: () => runner,
    begin(goal: string) {
      stopped = false;
      status = { running: true, goal, step: 'Starting…' };
      emit();
    },
    step(step: string) {
      status = { ...status, step };
      emit();
    },
    end() {
      status = { running: false, goal: status.goal, step: '' };
      emit();
    },
    stop() {
      stopped = true;
      status = { ...status, step: 'Stopping…' };
      emit();
    },
    isStopped: () => stopped,
    get: () => status,
    on(f: (s: AgentStatus) => void) {
      subs.add(f);
      return () => {
        subs.delete(f);
      };
    },
  };
})();

function useAgentStatus(): AgentStatus {
  const [s, setS] = useState<AgentStatus>(AgentBus.get());
  useEffect(() => AgentBus.on(setS), []);
  return s;
}

const SNAPSHOT_JS = String.raw`
var out=[];var n=0;
document.querySelectorAll('[data-pulse-id]').forEach(function(e){e.removeAttribute('data-pulse-id')});
var q='a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=option],[role=menuitem],[role=checkbox],[onclick],[contenteditable=true]';
var els=document.querySelectorAll(q);var vh=window.innerHeight*2.5;
for(var k=0;k<els.length&&n<70;k++){
  var e=els[k];var r=e.getBoundingClientRect();
  if(r.width<2||r.height<2||r.bottom<-50||r.top>vh)continue;
  var st=getComputedStyle(e);if(st.visibility==='hidden'||st.display==='none')continue;
  var lab=(e.getAttribute('aria-label')||e.innerText||e.value||e.getAttribute('placeholder')||e.getAttribute('title')||e.getAttribute('name')||e.getAttribute('alt')||'').replace(/\s+/g,' ').trim().slice(0,70);
  var tag=e.tagName.toLowerCase();if(tag==='input')tag='input['+(e.type||'text')+']';
  if(!lab&&tag==='a'){var img=e.querySelector('img');lab=img?(img.alt||'image link'):'';}
  if(!lab&&tag.indexOf('input')<0&&tag!=='textarea'&&tag!=='select')continue;
  e.setAttribute('data-pulse-id',String(n));out.push({i:n,tag:tag,label:lab});n++;
}
return {url:location.href,title:document.title,els:out,text:(document.body?document.body.innerText:'').replace(/\n{2,}/g,'\n').slice(0,2500)};
`;

const ACT_JS = String.raw`
var e=document.querySelector('[data-pulse-id="'+I+'"]');
if(!e)return {ok:false,msg:'element '+I+' not found; take a new look at the page'};
e.scrollIntoView({block:'center'});
var old=e.style.outline;e.style.outline='3px solid #7C5CFF';setTimeout(function(){e.style.outline=old},1500);
if(KIND==='click'){if(e.focus)e.focus();e.click();return {ok:true};}
if(KIND==='type'){
  e.focus();
  if(e.isContentEditable){e.innerText=TEXT;}
  else{var proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype);
    var d=Object.getOwnPropertyDescriptor(proto,'value');if(d&&d.set){d.set.call(e,TEXT);}else{e.value=TEXT;}}
  e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));
  if(SUBMIT){
    if(e.form){if(e.form.requestSubmit)e.form.requestSubmit();else e.form.submit();}
    else{['keydown','keypress','keyup'].forEach(function(t){e.dispatchEvent(new KeyboardEvent(t,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));});}
  }
  return {ok:true};
}
return {ok:false,msg:'unknown action'};
`;

const AGENT_SYSTEM = [
  'You are Pulse Agent. You complete tasks for the user by operating a mobile web browser inside the Pulse OS app, and you can open other apps on their Android phone.',
  'Each turn you get the goal, the steps already taken, and the current page: its URL, title, numbered interactive elements ([i] tag: label) and visible text.',
  'Reply with ONE JSON object: {"thought": "<=12 words, what you are doing, for the user to see", "action": {...}}.',
  'Actions:',
  '{"type":"navigate","url":"https://..."}  open a page (use https://www.google.com/search?q=... to search).',
  '{"type":"click","i":N}  tap element N.',
  '{"type":"type","i":N,"text":"...","submit":true|false}  type into field N (submit presses Enter).',
  '{"type":"scroll","dir":"down"|"up"}',
  '{"type":"open_app","app":"whatsapp|maps|navigate|youtube|spotify|phone|sms|email|calendar|telegram|instagram|playstore","query":"...","to":"phone number if any","text":"message if any"}  hands off to a native app and ends the task.',
  '{"type":"answer","text":"..."}  the task is done or you found the answer: reply to the user (short, specific, same language as the user).',
  '{"type":"ask","text":"..."}  you need the user: a login, password, OTP, payment, a choice only they can make, or the final confirm of a purchase, booking or message. Leave the page there; the user finishes it in the LIVE tab.',
  'Rules: never type passwords, OTPs or card numbers. Never press the final Pay/Place order/Book/Send button yourself; use ask instead.',
  'Prefer direct URLs (e.g. https://www.youtube.com/results?search_query=...) over many clicks. Be fast: as few steps as possible.',
  'If a page shows the answer, answer right away. If stuck after 2 tries, answer with what you found.',
].join('\n');

const AGENT_RE =
  /^(please\s+|can you\s+|pls\s+)?(open|go to|goto|search|find|look ?up|book|order|play|send|message|whatsapp|call|dial|navigate|take me|directions|show me|check|buy|download|watch|listen|browse|visit|compare|track|fill|apply|sign up|do)\b/i;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function agentSnapshot(): Promise<PageSnap | null> {
  const r = AgentBus.runner();
  if (!r) return null;
  const snap: any = await r.evalJs(SNAPSHOT_JS);
  if (!snap || snap.error) return null;
  return snap as PageSnap;
}

async function waitForPage(maxMs = 10000) {
  const r = AgentBus.runner();
  await sleep(450);
  const t0 = Date.now();
  while (r && r.isLoading() && Date.now() - t0 < maxMs) await sleep(200);
  await sleep(350);
}

async function runAgent(o: {
  apiKey: string;
  model: string;
  goal: string;
  context: string;
  onStep: (label: string) => void;
}): Promise<string> {
  const runner = AgentBus.runner();
  if (!runner) throw new Error('The live browser is not ready yet. Try again in a second.');
  const done: string[] = [];
  for (let n = 0; n < 12; n++) {
    if (AgentBus.isStopped()) return 'Stopped. The page is still open in the LIVE tab.';
    const snap = await agentSnapshot();
    const page = snap
      ? 'URL: ' + snap.url + '\nTitle: ' + snap.title + '\nElements:\n' +
        snap.els.map((e) => '[' + e.i + '] ' + e.tag + ': ' + e.label).join('\n') +
        '\nVisible text:\n' + snap.text
      : 'No page is open yet (blank).';
    const prompt =
      'Goal: ' + o.goal +
      (o.context ? '\nRecent chat:\n' + o.context : '') +
      '\nSteps so far:\n' + (done.length ? done.map((d, i) => i + 1 + '. ' + d).join('\n') : '(none)') +
      '\n\nCurrent page:\n' + page;
    const { json } = await geminiJson(o.apiKey, o.model, AGENT_SYSTEM, [{ role: 'user', parts: [{ text: prompt }] }]);
    const a: any = json?.action || {};
    const thought = String(json?.thought || '').trim();
    const type = String(a.type || '');
    if (type === 'answer' || type === 'ask') {
      return String(a.text || thought || 'Done.');
    }
    if (type === 'navigate' && a.url) {
      const url = normalizeUrl(String(a.url));
      o.onStep(thought || 'Opening ' + hostOf(url));
      runner.navigate(url);
      await waitForPage();
      done.push('navigate ' + url);
    } else if (type === 'click' && Number.isFinite(Number(a.i))) {
      const el = snap?.els.find((e) => e.i === Number(a.i));
      o.onStep(thought || 'Tapping "' + (el?.label || a.i) + '"');
      const r: any = await runner.evalJs('var I=' + JSON.stringify(Number(a.i)) + ',KIND="click",TEXT="",SUBMIT=false;' + ACT_JS);
      await waitForPage(8000);
      done.push('click [' + a.i + '] "' + (el?.label || '') + '" → ' + (r?.ok ? 'ok' : r?.msg || 'failed'));
    } else if (type === 'type' && Number.isFinite(Number(a.i))) {
      const text = String(a.text || '');
      o.onStep(thought || 'Typing "' + text.slice(0, 30) + '"');
      const r: any = await runner.evalJs(
        'var I=' + JSON.stringify(Number(a.i)) + ',KIND="type",TEXT=' + JSON.stringify(text) + ',SUBMIT=' + (a.submit ? 'true' : 'false') + ';' + ACT_JS,
      );
      if (a.submit) await waitForPage(8000);
      done.push('type [' + a.i + '] "' + text + '"' + (a.submit ? ' + Enter' : '') + ' → ' + (r?.ok ? 'ok' : r?.msg || 'failed'));
    } else if (type === 'scroll') {
      const up = a.dir === 'up';
      o.onStep(thought || 'Scrolling ' + (up ? 'up' : 'down'));
      await runner.evalJs('window.scrollBy(0,' + (up ? '-' : '') + 'window.innerHeight*0.8);return {ok:true};');
      await sleep(400);
      done.push('scroll ' + (up ? 'up' : 'down'));
    } else if (type === 'open_app' && a.app) {
      const app = String(a.app);
      const name = APPS.find((x) => x.id === app)?.name || app;
      o.onStep(thought || 'Opening ' + name);
      const ok = await openApp(app, { query: a.query, to: a.to, text: a.text });
      return ok ? 'Opened ' + name + '.' : name + ' isn\'t installed, so I couldn\'t open it.';
    } else {
      done.push('invalid action ' + JSON.stringify(a).slice(0, 80));
    }
  }
  return 'I took 12 steps and stopped here. The page is open in the LIVE tab so you can finish it.';
}

/* ------------------------------------------------------------------ */
/* Conversations (side drawer with summaries)                          */
/* ------------------------------------------------------------------ */

type Convo = { id: string; title: string; summary: string; updatedAt: number; messages: ChatMessage[] };
const STORAGE_CONVOS = 'pulseos.convos.v1';
const STORAGE_CONVO_CURRENT = 'pulseos.convos.current';

async function loadConvos(): Promise<{ convos: Convo[]; current: string }> {
  const [raw, cur] = await Promise.all([AsyncStorage.getItem(STORAGE_CONVOS), AsyncStorage.getItem(STORAGE_CONVO_CURRENT)]);
  let convos: Convo[] = [];
  if (raw) {
    try {
      convos = JSON.parse(raw);
    } catch {
      convos = [];
    }
  }
  if (!convos.length) {
    // Bring the chat from older versions into the first conversation.
    let old: ChatMessage[] = [];
    try {
      old = JSON.parse((await AsyncStorage.getItem(STORAGE_CHAT)) || '[]');
    } catch {
      old = [];
    }
    const firstUser = old.find((m) => m.role === 'user');
    convos = [{ id: uid(), title: firstUser ? firstUser.text.slice(0, 40) : 'New chat', summary: '', updatedAt: Date.now(), messages: old }];
  }
  convos = convos.map((c) => ({
    ...c,
    messages: (c.messages || []).filter((m) => !(m.streaming && !m.text.trim())).map((m) => ({ ...m, streaming: false })),
  }));
  const current = convos.find((c) => c.id === cur) ? (cur as string) : convos[0].id;
  return { convos, current };
}

async function summarizeConvo(apiKey: string, messages: ChatMessage[]): Promise<{ title: string; summary: string } | null> {
  const text = messages
    .filter((m) => m.role !== 'error' && m.text.trim())
    .slice(-12)
    .map((m) => (m.role === 'user' ? 'User: ' : 'Pulse: ') + m.text.slice(0, 400))
    .join('\n');
  if (!text) return null;
  try {
    const { json } = await geminiJson(
      apiKey,
      FAST_MODEL,
      'Summarize this chat. Reply JSON {"title": "max 6 words", "summary": "max 25 words, what was asked and the outcome"}. Same language as the chat.',
      [{ role: 'user', parts: [{ text }] }],
      10000,
    );
    return { title: String(json?.title || '').slice(0, 60), summary: String(json?.summary || '').slice(0, 220) };
  } catch {
    return null;
  }
}

function timeAgo(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}

/* ------------------------------------------------------------------ */
/* APPS tab                                                            */
/* ------------------------------------------------------------------ */

function AppsScreen({ say }: { say: (t: string) => void }) {
  const [text, setText] = useState('');
  const [to, setTo] = useState('');
  const [last, setLast] = useState('');
  const launch = async (id: string, name: string) => {
    const ok = await openApp(id, id === 'email' ? { query: text, text: '' } : { query: text, text, to });
    const msg = ok ? 'Opened ' + name : name + ' isn\'t installed';
    setLast(msg);
    say(msg);
  };
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <Text style={styles.sectionTitle}>Apps</Text>
      <Text style={styles.mutedSmall}>
        Type what you want, then tap an app. Pulse opens it ready to go. You can also just ask in chat: "play lo-fi on YouTube".
      </Text>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="Search, message or place…"
        placeholderTextColor={C.muted}
        style={[styles.input, { marginTop: 12 }]}
      />
      <TextInput
        value={to}
        onChangeText={setTo}
        placeholder="Phone number (for WhatsApp, Call, SMS)"
        placeholderTextColor={C.muted}
        keyboardType="phone-pad"
        style={[styles.input, { marginTop: 8 }]}
      />
      <View style={styles.appGrid}>
        {APPS.map((a) => (
          <Pressable key={a.id} onPress={() => launch(a.id, a.name)} style={styles.appTile} accessibilityLabel={'Open ' + a.name}>
            <Text style={{ fontSize: 26 }}>{a.icon}</Text>
            <Text style={styles.appName} numberOfLines={1}>{a.name}</Text>
          </Pressable>
        ))}
      </View>
      {last ? <Text style={[styles.mutedSmall, { marginTop: 10 }]}>{last}</Text> : null}
    </ScrollView>
  );
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
  speed: SpeedMode;
  fastModel: string;
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
  rev?: number;
};

const DEFAULT_SETTINGS: Settings = {
  name: '',
  email: '',
  role: '',
  avatar: '⚡',
  focusGoalMin: 120,
  personalize: true,
  apiKey: '',
  model: FAST_MODEL,
  temperature: 0.7,
  speed: 'fast',
  fastModel: FAST_MODEL,
  replyLength: 'balanced',
  historyLimit: 60,
  cloudUrl: DEFAULT_CLOUD_URL,
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
      const saved: any = JSON.parse(raw);
      const merged: Settings = { ...DEFAULT_SETTINGS, ...saved };
      if (!saved.rev || saved.rev < 3) {
        // v3: fast replies by default; chat no longer waits on the cloud server.
        merged.speed = 'fast';
        merged.fastModel = FAST_MODEL;
        merged.model = FAST_MODEL;
        merged.cloudMode = false;
        if (!merged.cloudUrl) merged.cloudUrl = DEFAULT_CLOUD_URL;
        merged.rev = 3;
        await AsyncStorage.setItem(STORAGE_SETTINGS, JSON.stringify(merged));
      }
      return merged;
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
      ? 'Keep the answer to 1-2 sentences.'
      : s.replyLength === 'detailed'
        ? 'The answer may be detailed (up to ~150 words).'
        : 'Keep the answer concise (2-4 sentences) unless the task needs more.';
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
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error('Update server is not set up.');
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token.trim()) headers.Authorization = 'Bearer ' + token.trim();
  let res: Response;
  try {
    res = await fetch('https://api.github.com/repos/' + r + '/releases/latest', { headers });
  } catch {
    throw new Error('No internet connection. Try again.');
  }
  if (res.status === 404) throw new Error('Update server unavailable right now.');
  if (!res.ok) throw new Error('Couldn\'t check for updates (' + res.status + '). Try again later.');
  const rel: any = await res.json();
  const asset = (rel.assets || []).find((a: any) => /\.apk$/i.test(String(a?.name)));
  if (!asset) throw new Error('Update server unavailable right now.');
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
      if (s.autoCheckUpdates) {
        checkForUpdate(DEFAULT_UPDATE_REPO, s.updateToken)
          .then((u) => setUpdate(u.available ? u : null))
          .catch(() => undefined);
      }
    });
  }, []);

  useEffect(() => LiveBus.onFocus(() => setTab('LIVE')), []);

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
    { id: 'APPS', icon: '📱' },
    { id: 'LIVE', icon: '🖥️' },
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
        <View style={[styles.fill, tab !== 'APPS' && styles.hidden]}>
          <AppsScreen say={say} />
        </View>
        <View
          style={[styles.fill, tab !== 'LIVE' && styles.offscreen]}
          pointerEvents={tab === 'LIVE' ? 'auto' : 'none'}
          importantForAccessibility={tab === 'LIVE' ? 'auto' : 'no-hide-descendants'}
        >
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

  const [convos, setConvos] = useState<Convo[]>([]);
  const [currentId, setCurrentId] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [modelPicker, setModelPicker] = useState(false);
  const [mode, setMode] = useState<'auto' | 'agent' | 'chat'>('auto');
  const drawerX = useRef(new Animated.Value(-320)).current;
  const summarizing = useRef(false);

  useEffect(() => {
    loadConvos().then(({ convos: list, current }) => {
      setConvos(list);
      setCurrentId(current);
      setMessages(list.find((c) => c.id === current)?.messages || []);
      setLoaded(true);
    });
  }, []);

  // Keep the open conversation in the list, and save everything.
  useEffect(() => {
    if (!loaded || !currentId) return;
    setConvos((prev) =>
      prev.map((c) => {
        if (c.id !== currentId) return c;
        const firstUser = messages.find((m) => m.role === 'user');
        const lastTs = messages.length ? messages[messages.length - 1].ts : c.updatedAt;
        return {
          ...c,
          messages: messages.slice(-Math.max(10, settings.historyLimit)),
          updatedAt: lastTs,
          title: c.title && c.title !== 'New chat' ? c.title : firstUser ? firstUser.text.slice(0, 40) : 'New chat',
        };
      }),
    );
  }, [messages, loaded, currentId, settings.historyLimit]);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_CONVOS, JSON.stringify(convos.slice(0, 50)));
    AsyncStorage.setItem(STORAGE_CONVO_CURRENT, currentId);
  }, [convos, currentId, loaded]);

  const showDrawer = (open: boolean) => {
    if (open) setDrawer(true);
    Animated.timing(drawerX, { toValue: open ? 0 : -320, duration: 200, useNativeDriver: true }).start(() => {
      if (!open) setDrawer(false);
    });
  };

  const newChat = () => {
    if (busy) return;
    const cur = convos.find((c) => c.id === currentId);
    if (cur && !messages.length) {
      showDrawer(false);
      return;
    }
    const c: Convo = { id: uid(), title: 'New chat', summary: '', updatedAt: Date.now(), messages: [] };
    setConvos((prev) => [c, ...prev]);
    setCurrentId(c.id);
    setMessages([]);
    showDrawer(false);
  };

  const openConvo = (id: string) => {
    if (busy) return;
    const c = convos.find((x) => x.id === id);
    if (!c) return;
    setCurrentId(id);
    setMessages(c.messages);
    showDrawer(false);
  };

  const deleteConvo = (id: string) => {
    Alert.alert('Delete chat', 'Delete this conversation?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          const rest = convos.filter((c) => c.id !== id);
          if (!rest.length) {
            const c: Convo = { id: uid(), title: 'New chat', summary: '', updatedAt: Date.now(), messages: [] };
            setConvos([c]);
            setCurrentId(c.id);
            setMessages([]);
            return;
          }
          setConvos(rest);
          if (id === currentId) {
            setCurrentId(rest[0].id);
            setMessages(rest[0].messages);
          }
        },
      },
    ]);
  };

  // Summaries live in the side drawer; made in the background so replies stay fast.
  const refreshSummary = (convoId: string, msgs: ChatMessage[]) => {
    if (!apiKey || summarizing.current || msgs.filter((m) => m.role !== 'error').length < 2) return;
    summarizing.current = true;
    summarizeConvo(apiKey, msgs)
      .then((r) => {
        if (r && (r.title || r.summary)) {
          setConvos((prev) =>
            prev.map((c) => (c.id === convoId ? { ...c, title: r.title || c.title, summary: r.summary || c.summary } : c)),
          );
        }
      })
      .finally(() => {
        summarizing.current = false;
      });
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    // Plain chat always goes straight to Gemini from the phone (fastest path); the cloud is only a fallback with no key.
    const useCloud = !apiKey && cloudMode && !!cloudUrl;
    if (!apiKey && !useCloud) {
      openSettings();
      return;
    }
    if (settings.haptics) Vibration.vibrate(10);
    const userMsg: ChatMessage = { id: uid(), role: 'user', text, ts: Date.now() };
    const next = [...messages, userMsg];
    const botId = uid();
    let steps: Step[] = [{ label: 'Reading your message and context', status: 'active', startedAt: Date.now() }];
    const pushSteps = () =>
      setMessages((prev) => prev.map((m) => (m.id === botId ? { ...m, steps: [...steps] } : m)));
    const step = (label: string, status: Step['status'] = 'active') => {
      const now = Date.now();
      steps = steps.map((s) => (s.status === 'active' ? { ...s, status: 'done', ms: now - s.startedAt } : s));
      steps.push(status === 'active' ? { label, status, startedAt: now } : { label, status, startedAt: now, ms: 0 });
      pushSteps();
    };
    const finishSteps = () => {
      const now = Date.now();
      steps = steps.map((s) => (s.status === 'active' ? { ...s, status: 'done', ms: now - s.startedAt } : s));
    };
    setMessages([
      ...next,
      { id: botId, role: 'assistant', text: '', source: 'device', streaming: true, steps: [...steps], ts: Date.now() },
    ]);
    setInput('');
    setBusy(true);
    const ctx = profileContext(settings);
    const convoId = currentId;
    const useAgent = !!apiKey && (mode === 'agent' || (mode === 'auto' && AGENT_RE.test(text)));
    if (useAgent) {
      AgentBus.begin(text);
      LiveBus.set({ active: true, startedAt: Date.now(), loading: false, thumb: null, log: [] }, '🤖 ' + text.slice(0, 60));
      try {
        const recent = messages
          .filter((m) => m.role !== 'error' && m.text.trim())
          .slice(-6)
          .map((m) => (m.role === 'user' ? 'User: ' : 'Pulse: ') + m.text.slice(0, 300))
          .join('\n');
        const agentModel = /lite/i.test(model) ? 'gemini-flash-latest' : model;
        const answer = await runAgent({
          apiKey,
          model: agentModel,
          goal: text + (ctx ? '\n(' + ctx + ')' : ''),
          context: recent,
          onStep: (label) => {
            step(label);
            AgentBus.step(label);
            LiveBus.set({}, label);
          },
        });
        step('Done', 'done');
        finishSteps();
        LiveBus.set({}, '✅ ' + answer.slice(0, 80));
        const final: ChatMessage = {
          id: botId,
          role: 'assistant',
          text: answer,
          reply: { direct_response: answer, proactive_checklist: [], one_line_summary: '' },
          source: 'device',
          streaming: false,
          steps: [...steps],
          ts: Date.now(),
        };
        setMessages((prev) => prev.map((m) => (m.id === botId ? final : m)));
        refreshSummary(convoId, [...next, final]);
        say(answer);
      } catch (e: any) {
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== botId),
          { id: uid(), role: 'error', text: e?.message || String(e), ts: Date.now() },
        ]);
      } finally {
        AgentBus.end();
        setBusy(false);
      }
      return;
    }
    try {
      let result: { reply: PulseReply; modelUsed: string } | null = null;
      let source: 'cloud' | 'device' = 'device';
      if (useCloud) {
        step('Asking your cloud server');
        try {
          result = await callCloudChat(cloudUrl, cloudToken, keyForCloud(), next, ctx);
          source = 'cloud';
          setCloudStatus('online');
        } catch (cloudErr: any) {
          setCloudStatus('offline');
          if (!apiKey) throw cloudErr;
          step('Cloud unreachable, switching to on-device', 'error');
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
        const useModel = model || FAST_MODEL;
        step('Thinking with ' + modelLabel(useModel).replace(/^\W+/, ''));
        let writing = false;
        result = await streamGemini(apiKey, useModel, next, ctx, settings.temperature, settings.speed, (visible) => {
          if (!writing && visible.trim()) {
            writing = true;
            step('Writing reply');
          }
          setMessages((prev) => prev.map((m) => (m.id === botId ? { ...m, text: visible } : m)));
        });
      }
      const { reply } = result;
      const n = reply.proactive_checklist.length;
      step(n ? 'Prepared ' + n + ' next step' + (n > 1 ? 's' : '') + ' and action cards' : 'Reply ready', 'done');
      finishSteps();
      const botMsg: ChatMessage = {
        id: botId,
        role: 'assistant',
        text: reply.direct_response,
        reply,
        source,
        streaming: false,
        steps: [...steps],
        ts: Date.now(),
      };
      setMessages((prev) => (prev.some((m) => m.id === botId) ? prev.map((m) => (m.id === botId ? botMsg : m)) : [...prev, botMsg]));
      refreshSummary(convoId, [...next, botMsg]);
      say(reply.direct_response.slice(0, 400));
    } catch (e: any) {
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== botId),
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
        ? '⚡ ' + (settings.speed === 'fast' ? settings.fastModel || FAST_MODEL : model) + ' · ' + settings.speed
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
        <Pressable onPress={() => showDrawer(true)} style={styles.chip} accessibilityLabel="Open chats and summaries">
          <Text style={styles.chipText}>☰</Text>
        </Pressable>
        <Pressable onPress={() => setModelPicker(true)} style={[styles.chip, { flexShrink: 1 }]} accessibilityLabel="Choose model">
          <Text style={styles.chipText} numberOfLines={1}>
            {!apiKey && cloudMode && cloudUrl ? '☁️ Cloud' : modelLabel(model || FAST_MODEL)} ▾
          </Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={() => setMode((m) => (m === 'auto' ? 'agent' : m === 'agent' ? 'chat' : 'auto'))}
          style={[styles.chip, mode === 'agent' && { borderColor: C.accent }]}
          accessibilityLabel="Agent mode"
        >
          <Text style={styles.chipText}>{mode === 'auto' ? '🤖 Auto' : mode === 'agent' ? '🤖 Agent' : '💬 Chat'}</Text>
        </Pressable>
        <Pressable onPress={newChat} style={styles.chip} accessibilityLabel="New chat">
          <Text style={styles.chipText}>✎ New</Text>
        </Pressable>
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
              Ask anything, or tell Pulse to do it: "find biryani near me", "play lo-fi on YouTube", "compare iPhone 16 prices".
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

      <LiveCard />

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

      {drawer ? (
        <View style={styles.drawerWrap}>
          <Pressable style={styles.drawerBackdrop} onPress={() => showDrawer(false)} />
          <Animated.View style={[styles.drawer, { transform: [{ translateX: drawerX }] }]}>
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>Chats</Text>
              <Pressable onPress={newChat} style={styles.chip}>
                <Text style={styles.chipText}>✎ New chat</Text>
              </Pressable>
            </View>
            <ScrollView style={{ marginTop: 10 }} contentContainerStyle={{ gap: 8, paddingBottom: 30 }}>
              {[...convos]
                .sort((x, y) => y.updatedAt - x.updatedAt)
                .map((c) => (
                  <Pressable
                    key={c.id}
                    onPress={() => openConvo(c.id)}
                    onLongPress={() => deleteConvo(c.id)}
                    style={[styles.convoItem, c.id === currentId && styles.convoItemOn]}
                  >
                    <View style={styles.rowBetween}>
                      <Text style={styles.convoTitle} numberOfLines={1}>{c.title || 'New chat'}</Text>
                      <Text style={styles.mutedSmall}>{timeAgo(c.updatedAt)}</Text>
                    </View>
                    <Text style={styles.mutedSmall} numberOfLines={3}>
                      {c.summary || (c.messages.length ? c.messages.length + ' messages' : 'Empty')}
                    </Text>
                  </Pressable>
                ))}
            </ScrollView>
            <Text style={styles.mutedSmall}>Long-press a chat to delete it.</Text>
          </Animated.View>
        </View>
      ) : null}

      <Modal visible={modelPicker} transparent animationType="fade" onRequestClose={() => setModelPicker(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setModelPicker(false)}>
          <View style={styles.modalCard}>
            <Text style={styles.cardTitle}>Model</Text>
            {MODEL_CHOICES.map((m) => (
              <Pressable
                key={m.id}
                onPress={() => {
                  patchSettings({ model: m.id });
                  setModelPicker(false);
                }}
                style={[styles.modelRow, (model || FAST_MODEL) === m.id && styles.convoItemOn]}
              >
                <Text style={styles.convoTitle}>{m.name}</Text>
                <Text style={styles.mutedSmall}>{m.note}</Text>
              </Pressable>
            ))}
            <Text style={[styles.mutedSmall, { marginTop: 8 }]}>
              If a model is busy, Pulse switches to another one automatically.
            </Text>
          </View>
        </Pressable>
      </Modal>
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
  return (
    <View style={{ marginBottom: 12 }}>
      <View style={[styles.bubble, styles.botBubble]}>
        {msg.steps && msg.steps.length ? <StepsView steps={msg.steps} streaming={msg.streaming} /> : null}
        {msg.streaming && !msg.text && msg.steps && msg.steps.length ? null : msg.streaming && !msg.text ? (
          <View style={styles.rowCenter}>
            <ActivityIndicator size="small" color={C.accent} />
            <Text style={[styles.muted, { marginLeft: 8 }]}>Thinking…</Text>
          </View>
        ) : (
          <Text style={styles.bubbleText}>
            {msg.text}
            {msg.streaming ? <Text style={{ color: C.accent }}> ▍</Text> : null}
          </Text>
        )}
        {msg.source === 'cloud' ? <Text style={styles.sourceTag}>☁️ cloud</Text> : null}
      </View>
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
  const inApp = /^https:\/\//i.test(url) && !/calendar\.google\.com/i.test(url);
  return (
    <Pressable
      onPress={() => (inApp ? LiveBus.open(url) : openLink(url))}
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
  const shotRef = useRef<View>(null);
  const loadStart = useRef(0);
  const loadingRef = useRef(false);
  const pending = useRef(new Map<string, (v: any) => void>());
  const agent = useAgentStatus();

  // Let the agent look at and act on this browser.
  useEffect(
    () =>
      AgentBus.register({
        evalJs: (body: string) =>
          new Promise((resolve) => {
            const id = uid();
            const timer = setTimeout(() => {
              pending.current.delete(id);
              resolve(null);
            }, 6000);
            pending.current.set(id, (v) => {
              clearTimeout(timer);
              resolve(v);
            });
            webRef.current?.injectJavaScript(
              '(function(){var __r;try{__r=(function(){' + body + '})();}catch(e){__r={error:String(e)};}' +
                'window.ReactNativeWebView.postMessage(JSON.stringify({__pulse:' + JSON.stringify(id) + ',r:__r}));})();true;',
            );
          }),
        navigate: (u: string) => {
          loadingRef.current = true;
          setUrl(u);
          setField(u);
        },
        isLoading: () => loadingRef.current,
      }),
    [],
  );

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const d = JSON.parse(e.nativeEvent.data);
      if (d && d.__pulse) {
        const f = pending.current.get(d.__pulse);
        if (f) {
          pending.current.delete(d.__pulse);
          f(d.r);
        }
      }
    } catch {
      /* not ours */
    }
  };

  // Chat asks the workspace to open a page ("show what the app is doing").
  useEffect(
    () =>
      LiveBus.onNav((u) => {
        setUrl(u);
        setField(u);
      }),
    [],
  );

  const snap = useCallback(async () => {
    if (!LiveBus.get().active || !shotRef.current) return;
    try {
      const uri = await captureRef(shotRef, { format: 'jpg', quality: 0.5, width: 360, result: 'tmpfile' });
      LiveBus.set({ thumb: uri + '?t=' + Date.now() });
    } catch {
      /* preview is best-effort */
    }
  }, []);

  // Refresh the live preview every 2s while a live session is showing.
  useEffect(() => {
    const id = setInterval(() => {
      const l = LiveBus.get();
      if (l.active && Date.now() - l.startedAt < 5 * 60 * 1000) snap();
    }, 2000);
    return () => clearInterval(id);
  }, [snap]);

  const go = () => {
    const u = normalizeUrl(field);
    setUrl(u);
    if (LiveBus.get().active) LiveBus.set({ url: u }, 'Opening ' + hostOf(u));
  };

  const onNav = (nav: WebViewNavigation) => {
    setCanBack(nav.canGoBack);
    setField(nav.url);
    setTitle(nav.title || '');
    if (LiveBus.get().active) LiveBus.set({ url: nav.url, title: nav.title || '' });
  };

  const confirmComplete = () => {
    const label = title || field;
    const markDone = () => {
      setCompleted((prev) => [{ title: label, url: field, ts: Date.now() }, ...prev].slice(0, 20));
      say('Task complete: ' + label);
      if (LiveBus.get().active) LiveBus.set({}, '✅ Marked done: ' + label);
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
    LiveBus.reset();
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
      {agent.running ? (
        <View style={styles.agentStrip}>
          <ActivityIndicator size="small" color={C.accent} />
          <View style={{ flex: 1 }}>
            <Text style={styles.liveTitle} numberOfLines={1}>🤖 {agent.step || 'Working…'}</Text>
            <Text style={styles.mutedSmall} numberOfLines={1}>{agent.goal}</Text>
          </View>
          <Pressable onPress={() => AgentBus.stop()} style={[styles.chip, { borderColor: C.danger }]}>
            <Text style={[styles.chipText, { color: C.danger }]}>■ Stop</Text>
          </Pressable>
        </View>
      ) : null}

      <View ref={shotRef} collapsable={false} style={{ flex: 1, backgroundColor: '#fff' }}>
      <WebView
        ref={webRef}
        source={{ uri: url }}
        onNavigationStateChange={onNav}
        onMessage={onMessage}
        onLoadStart={(e) => {
          loadingRef.current = true;
          setLoading(true);
          loadStart.current = Date.now();
          if (LiveBus.get().active) LiveBus.set({ loading: true, progress: 0.05 }, 'Loading ' + hostOf(e.nativeEvent.url));
        }}
        onLoadProgress={(e) => {
          if (LiveBus.get().active) LiveBus.set({ progress: e.nativeEvent.progress });
        }}
        onLoadEnd={(e) => {
          loadingRef.current = false;
          setLoading(false);
          if (LiveBus.get().active) {
            const secs = ((Date.now() - loadStart.current) / 1000).toFixed(1);
            LiveBus.set(
              { loading: false, progress: 1, title: e.nativeEvent.title || '' },
              'Loaded "' + (e.nativeEvent.title || hostOf(e.nativeEvent.url)) + '" in ' + secs + 's',
            );
            setTimeout(snap, 400);
          }
        }}
        javaScriptEnabled
        domStorageEnabled
        setSupportMultipleWindows={false}
        style={{ flex: 1, backgroundColor: '#fff' }}
      />
      </View>

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
  const [cloudAdv, setCloudAdv] = useState(false);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [checkMsg, setCheckMsg] = useState('');
  const [checkState, setCheckState] = useState<'ok' | 'new' | 'error' | ''>('');

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
    setCheckState('');
    try {
      const info = await checkForUpdate(DEFAULT_UPDATE_REPO, s.updateToken);
      setUpdate(info.available ? info : null);
      setCheckState(info.available ? 'new' : 'ok');
      setCheckMsg(info.available ? 'A new version is available.' : '✓ You\'re up to date.');
    } catch (e: any) {
      setUpdate(null);
      setCheckState('error');
      setCheckMsg(e?.message || 'Couldn\'t check for updates. Try again.');
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
      setCheckState('ok');
      setCheckMsg('Tap Install on the next screen to finish.');
    } catch (e: any) {
      setCheckState('error');
      setCheckMsg('Update failed: ' + (e?.message || String(e)));
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
        {MODEL_CHOICES.map((m) => (
          <Pressable key={m.id} onPress={() => patchSettings({ model: m.id })} style={[styles.modelRow, s.model === m.id && styles.convoItemOn]}>
            <Text style={styles.convoTitle}>{m.name}</Text>
            <Text style={styles.mutedSmall}>{m.note}</Text>
          </Pressable>
        ))}
        <Text style={styles.mutedSmall}>Busy or out-of-quota models are skipped automatically.</Text>
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
          <Text style={styles.cardTitle}>☁️ Cloud computer</Text>
          <Switch value={s.cloudMode} onValueChange={(v) => patchSettings({ cloudMode: v && !!s.cloudUrl })} trackColor={{ false: C.border, true: C.accent }} thumbColor="#fff" />
        </View>
        <Text style={styles.mutedSmall}>
          Your Codespace: {hostOf(s.cloudUrl || DEFAULT_CLOUD_URL).split('-3000')[0]}. Chat stays on the phone for speed; the cloud is used when no API key is set.
        </Text>
        <Pressable onPress={testCloud} disabled={testing} style={styles.secondaryBtn}>
          {testing ? <ActivityIndicator color={C.text} /> : <Text style={styles.primaryBtnText}>Check connection</Text>}
        </Pressable>
        <Pressable onPress={() => setCloudAdv((v) => !v)}>
          <Text style={[styles.mutedSmall, { color: C.accent }]}>{cloudAdv ? 'Hide server details ▴' : 'Change server ▾'}</Text>
        </Pressable>
        {cloudAdv ? (
          <>
            <TextInput value={s.cloudUrl} onChangeText={(t) => patchSettings({ cloudUrl: t })} onBlur={() => patchSettings({ cloudUrl: normalizeCloudUrl(s.cloudUrl) })} placeholder={DEFAULT_CLOUD_URL} placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.input} />
            <TextInput value={s.cloudToken} onChangeText={(t) => patchSettings({ cloudToken: t })} placeholder="Access token (only if you set one)" placeholderTextColor={C.muted} secureTextEntry autoCapitalize="none" autoCorrect={false} style={styles.input} />
          </>
        ) : null}
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
        <Text style={styles.cardTitle}>🖥️ Live browser & chat</Text>
        <Text style={styles.fieldLabel}>Live browser home page</Text>
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
        <Text style={styles.mutedSmall}>Version {Application.nativeApplicationVersion || '2.0.0'} (build {cur})</Text>
        <Pressable onPress={check} disabled={checking || installing} style={styles.primaryBtn}>
          {checking ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Check for updates</Text>}
        </Pressable>
        {checkMsg ? (
          <Text style={[styles.updateResult, checkState === 'ok' && { color: C.good }, checkState === 'error' && { color: C.danger }]}>
            {checkMsg}
          </Text>
        ) : null}
        {update ? (
          <View style={styles.updateBox}>
            <Text style={styles.updateHead}>New version ready · build {update.latestBuild}</Text>
            {update.sizeBytes ? <Text style={styles.mutedSmall}>{formatBytes(update.sizeBytes)}</Text> : null}
            {update.notes ? <Text style={[styles.mutedSmall, { marginTop: 6 }]} numberOfLines={4}>What's new: {update.notes}</Text> : null}
            {installing ? (
              <View style={styles.progressTrack}><View style={[styles.progressFill, { width: (Math.round(progress * 100) + '%') as any }]} /></View>
            ) : null}
            <Pressable onPress={install} disabled={installing} style={[styles.primaryBtn, { marginTop: 10, backgroundColor: C.good }]}>
              <Text style={styles.primaryBtnText}>{installing ? 'Downloading ' + Math.round(progress * 100) + '%' : 'Update now'}</Text>
            </Pressable>
          </View>
        ) : null}
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
  offscreen: { opacity: 0, zIndex: -1 },
  drawerWrap: { ...StyleSheet.absoluteFillObject, zIndex: 50 },
  drawerBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  drawer: {
    position: 'absolute', top: 0, bottom: 0, left: 0, width: 300, padding: 14,
    backgroundColor: C.panel, borderRightWidth: 1, borderRightColor: C.border,
  },
  convoItem: { padding: 10, borderRadius: 12, backgroundColor: C.panel2, borderWidth: 1, borderColor: 'transparent', gap: 4 },
  convoItemOn: { borderColor: C.accent },
  convoTitle: { color: C.text, fontWeight: '700', fontSize: 14, flexShrink: 1, marginRight: 8 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: C.panel, borderRadius: 16, padding: 16, gap: 8, borderWidth: 1, borderColor: C.border },
  modelRow: { padding: 10, borderRadius: 12, backgroundColor: C.panel2, borderWidth: 1, borderColor: 'transparent', gap: 2 },
  appGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  appTile: {
    width: '30%', flexGrow: 1, alignItems: 'center', paddingVertical: 14, borderRadius: 14,
    backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, gap: 6,
  },
  appName: { color: C.text, fontSize: 12, fontWeight: '600' },
  agentStrip: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, gap: 8,
    backgroundColor: C.panel, borderBottomWidth: 1, borderBottomColor: C.accent,
  },
  liveCard: {
    flexDirection: 'row', alignItems: 'center', marginHorizontal: 10, marginBottom: 6, padding: 8,
    backgroundColor: C.panel, borderRadius: 14, borderWidth: 1, borderColor: C.accent,
  },
  liveThumbWrap: { width: 96, height: 72, borderRadius: 10, overflow: 'hidden', backgroundColor: C.panel2 },
  liveThumb: { width: 96, height: 72 },
  liveBadge: {
    position: 'absolute', top: 4, left: 4, flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 2,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.danger, marginRight: 4 },
  liveBadgeText: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  liveTitle: { color: C.text, fontWeight: '700', fontSize: 14 },
  liveTrack: { height: 3, borderRadius: 2, backgroundColor: C.border, marginTop: 6, overflow: 'hidden' },
  liveFill: { height: 3, backgroundColor: C.accent },
  stepsBox: { marginBottom: 8, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  stepsHead: { color: C.muted, fontSize: 12, fontWeight: '700' },
  stepRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  stepIcon: { width: 16, color: C.good, fontWeight: '800', textAlign: 'center' },
  stepText: { flex: 1, color: C.muted, fontSize: 12, marginLeft: 6 },
  stepMs: { color: C.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
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
  updateResult: { color: C.muted, fontSize: 14, fontWeight: '600', marginTop: 8, textAlign: 'center' },
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
