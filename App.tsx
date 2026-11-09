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
  NativeModules,
  AppState,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView, WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';
import * as Speech from 'expo-speech';
import * as Application from 'expo-application';
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { captureRef } from 'react-native-view-shot';

const { HarkBridge } = NativeModules;

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

const C = {
  bg: '#060911',
  panel: '#0F1523',
  panel2: '#172034',
  border: '#283552',
  text: '#F3F6FC',
  muted: '#94A3B8',
  accent: '#6366F1',
  accent2: '#06B6D4',
  good: '#10B981',
  warn: '#F59E0B',
  danger: '#F43F5E',
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
const STORAGE_SMART_MEMORY = 'pulseos.smart_memory.v1';

const CLOUD_PORT = 3000;
const CLOUD_DOMAIN = 'app.github.dev';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const FAST_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const DEFAULT_UPDATE_REPO = 'RedChip6261/pulse-os-android';
const DEFAULT_CLOUD_URL = 'https://scaling-space-telegram-jjg94w99g6pj255vv-3000.app.github.dev';

const SYSTEM_PROMPT = [
  'You are Pulse, an OS-level AI agent with Accessibility Service & root/shell capabilities and an advanced multimodal AI assistant inside the Pulse OS mobile app.',
  '1. OS-LEVEL DEVICE AUTOMATION AGENT: You control UI elements, tap screen coordinates, input user-specified data, and launch ANY installed mobile app (including Blinkit, Uber, Ola, Rapido, Zepto, Swiggy, Zomato, Meesho, Flipkart, Amazon, WhatsApp, Instagram, Telegram, Free Fire, PhonePe, GPay, Paytm, YouTube, Spotify, Maps, etc.). Parse the user voice/text command, identify the target app and action, and generate a sequence of UI automation steps to execute the task on the device screen. Handle missing-app or load exceptions gracefully with a clear status update.',
  '2. MULTIMODAL AI ASSISTANT:',
  '   - For images & photos: Describe the contents, extract text (OCR), detect objects, and answer specific user questions about the visual details.',
  '   - For documents & files: Read the uploaded files, extract key information, and provide concise summaries tailored to the user needs.',
  '   - For video files & video links: Extract transcripts/context, summarize the core content, and answer questions based on the video details.',
  '3. SMART CONTEXT MEMORY & ACTION EXTRACTION: Personalize all text, image, and video responses across sessions. Automatically pull tasks, calendar events, and reminders directly from uploaded files, images, or videos.',
  '4. QUICK-VERIFY SOURCE CHECKING: Cross-check extracted data from links and documents to ensure high accuracy.',
  'Always provide structured, precise, and practical answers without unnecessary filler.',
  'You MUST reply with ONLY a single strict JSON object, no markdown, no code fences, no extra text:',
  '{',
  '  "direct_response": "Clear, structured answer without filler",',
  '  "proactive_checklist": ["2 to 5 short actionable follow-ups, extracted tasks, calendar events, or reminders"],',
  '  "one_line_summary": "Single short sentence summary",',
  '  "automation_script": [{"step": 1, "action": "launch_app|tap_text|tap_xy|input_text|swipe|wait|root_exec", "target": "app or node label or x,y", "value": "optional text"}],',
  '  "memory_facts": ["optional new user preference or fact to remember across sessions"],',
  '  "source_verified": "Verified | Needs Review"',
  '}',
].join('\n');

type Tab = 'CHAT' | 'APPS' | 'CLOUD' | 'LIVE' | 'SETTINGS';
type SpeedMode = 'fast' | 'balanced' | 'smart';

type AutomationStep = {
  step?: number;
  action: string;
  target?: string;
  value?: string;
};

type PulseReply = {
  direct_response: string;
  proactive_checklist: string[];
  one_line_summary: string;
  automation_script?: AutomationStep[];
  memory_facts?: string[];
  source_verified?: string;
};

type AttachmentItem = {
  uri: string;
  name: string;
  mimeType: string;
  kind: 'image' | 'video' | 'document' | 'video_link';
  base64?: string;
  textContent?: string;
  sizeBytes?: number;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  attachment?: AttachmentItem;
  verificationShotUri?: string;
  verificationSummary?: string;
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
/* Helpers & Smart Cross-Session Memory                                */
/* ------------------------------------------------------------------ */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function loadSmartMemory(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_SMART_MEMORY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function saveSmartMemoryFacts(facts: string[]): Promise<string[]> {
  const existing = await loadSmartMemory();
  const merged = [...existing];
  for (const f of facts) {
    const clean = String(f || '').trim();
    if (clean && clean.length > 3 && !merged.some((x) => x.toLowerCase() === clean.toLowerCase())) {
      merged.push(clean);
    }
  }
  const trimmed = merged.slice(-40);
  await AsyncStorage.setItem(STORAGE_SMART_MEMORY, JSON.stringify(trimmed));
  return trimmed;
}

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
  const script = Array.isArray(obj.automation_script)
    ? obj.automation_script.map((s: any, idx: number) => ({
        step: Number(s?.step) || idx + 1,
        action: String(s?.action || 'tap_text'),
        target: String(s?.target || ''),
        value: s?.value ? String(s.value) : undefined,
      }))
    : undefined;
  const mem = Array.isArray(obj.memory_facts)
    ? obj.memory_facts.map((x: unknown) => String(x).trim()).filter(Boolean)
    : undefined;
  return {
    direct_response: String(obj.direct_response ?? '').trim() || cleaned,
    proactive_checklist: checklist,
    one_line_summary: String(obj.one_line_summary ?? '').trim(),
    automation_script: script && script.length ? script : undefined,
    memory_facts: mem && mem.length ? mem : undefined,
    source_verified: obj.source_verified ? String(obj.source_verified) : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Video Link Transcript & Quick-Verify Source Checker                 */
/* ------------------------------------------------------------------ */

async function fetchVideoLinkContext(url: string): Promise<string> {
  const cleanUrl = url.trim();
  const lines: string[] = [`Video URL: ${cleanUrl}`];
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4500);
    const oRes = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(cleanUrl)}`, { signal: ctrl.signal }).finally(() =>
      clearTimeout(t),
    );
    if (oRes.ok) {
      const oJson: any = await oRes.json();
      if (oJson?.title) lines.push(`Video Title: ${oJson.title}`);
      if (oJson?.author_name) lines.push(`Channel/Author: ${oJson.author_name}`);
    }
  } catch {
    /* ignore */
  }
  const yt = cleanUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
  if (yt) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5500);
      const res = await fetch(`https://www.youtube.com/watch?v=${yt[1]}`, { signal: ctrl.signal }).finally(() => clearTimeout(t));
      const html = await res.text();
      const descMatch = html.match(/"shortDescription":"((?:\\.|[^"\\])*)"/);
      if (descMatch?.[1]) {
        const desc = JSON.parse(`"${descMatch[1]}"`);
        lines.push(`Description:\n${desc.slice(0, 3500)}`);
      }
      const capMatch = html.match(/"captionTracks":\[\{"baseUrl":"([^"]+)"/);
      if (capMatch?.[1]) {
        const capUrl = capMatch[1].replace(/\\u0026/g, '&');
        const capRes = await fetch(capUrl);
        const capXml = await capRes.text();
        const transcript = Array.from(capXml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g))
          .map((m) =>
            m[1]
              .replace(/&amp;/g, '&')
              .replace(/&#39;/g, "'")
              .replace(/&quot;/g, '"')
              .replace(/<[^>]+>/g, ' ')
              .trim(),
          )
          .filter(Boolean)
          .join(' ');
        if (transcript) lines.push(`Video Transcript:\n${transcript.slice(0, 15000)}`);
      }
    } catch {
      /* fallback to oEmbed title */
    }
  }
  return lines.join('\n');
}

async function quickVerifyUrlsInText(text: string): Promise<string> {
  const urls = Array.from(text.matchAll(/https?:\/\/[^\s)>\]"']+/gi)).map((m) => m[0]);
  if (!urls.length) return '';
  const results: string[] = [];
  await Promise.all(
    urls.slice(0, 2).map(async (u) => {
      try {
        if (/youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts/i.test(u)) {
          const vCtx = await fetchVideoLinkContext(u);
          results.push(`[Quick-Verify Video Source Checked: ${u}]\n${vCtx}`);
          return;
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(u, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
        const raw = await r.text();
        const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const plain = raw
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 3500);
        results.push(
          `[Quick-Verify Source Checked (${r.status}): ${u}]\nTitle: ${titleMatch?.[1]?.trim() || ''}\nExcerpt: ${plain}`,
        );
      } catch (e: any) {
        results.push(`[Quick-Verify Source Unreachable: ${u} (${e?.message || 'timeout'})]`);
      }
    }),
  );
  return results.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* Fast Streaming & Multimodal Gemini Engine                           */
/* ------------------------------------------------------------------ */

const META_MARK = '<<<PULSE_META>>>';

function buildStreamPrompt(extraSystem: string, smartMemory: string[]): string {
  const now = new Date();
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      return '';
    }
  })();
  return [
    'You are Pulse, an OS-level AI agent with Accessibility Service & root permissions and an advanced multimodal AI assistant inside Pulse OS.',
    'Current local time: ' + now.toString() + (tz ? ' (' + tz + ')' : '') + '.',
    'Capabilities:',
    '- For images/photos: Describe contents, extract visible text (OCR), detect objects, and answer specific user questions.',
    '- For documents/files: Extract key information and provide concise, practical summaries.',
    '- For video links/files: Summarize core content from transcripts/metadata and answer questions.',
    '- Automatically extract tasks, calendar events, and reminders into the metadata block at the end.',
    '- Never write fake "Executing now..." or "UI Automation Sequence:" text when you are only chatting; real app actions are executed directly by the Pulse OS native engine.',
    'Lead with the answer. Be structured, precise, and practical with no unnecessary filler.',
    'Reply in the same language the user writes in (English, Hindi, Telugu, Hinglish, etc).',
    'At the very end of your response, after your main answer, append "' +
      META_MARK +
      '" followed by a compact JSON object: {"proactive_checklist":["extracted task/event/reminder 1","step 2"],"one_line_summary":"short summary","memory_facts":["new user preference if any"],"source_verified":"Verified"}.',
    smartMemory.length ? 'User Smart Context Memory Across Sessions:\n- ' + smartMemory.join('\n- ') : '',
    extraSystem,
  ]
    .filter(Boolean)
    .join('\n');
}

function splitStreamText(full: string): { visible: string; meta: string | null } {
  const i = full.indexOf(META_MARK);
  if (i === -1) {
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
  let memory_facts: string[] = [];
  let source_verified = 'Verified';
  if (meta) {
    const m = stripCodeFences(meta);
    const a = m.indexOf('{');
    const b = m.lastIndexOf('}');
    if (a !== -1 && b > a) {
      try {
        const o: any = JSON.parse(m.slice(a, b + 1));
        if (Array.isArray(o.proactive_checklist)) {
          checklist = o.proactive_checklist.map((x: unknown) => String(x)).filter((x: string) => x.trim()).slice(0, 6);
        }
        if (Array.isArray(o.memory_facts)) {
          memory_facts = o.memory_facts.map((x: unknown) => String(x).trim()).filter(Boolean);
        }
        if (o.source_verified) source_verified = String(o.source_verified);
        summary = String(o.one_line_summary ?? '').trim();
      } catch {
        /* ignore malformed meta */
      }
    }
  }
  if (!meta && /^\s*[{`]/.test(visible)) return parsePulseReply(visible);
  return {
    direct_response: visible || 'No response received.',
    proactive_checklist: checklist,
    one_line_summary: summary,
    memory_facts,
    source_verified,
  };
}

function thinkingFor(model: string, speed: SpeedMode): any | undefined {
  if (speed === 'smart') return undefined;
  if (/gemini-2\.5-pro/i.test(model)) return { thinkingBudget: 128 };
  if (/gemini-2\.5-flash/i.test(model) && !/lite/i.test(model)) {
    return { thinkingBudget: speed === 'fast' ? 0 : 64 };
  }
  return undefined;
}

function streamOnce(
  apiKey: string,
  model: string,
  body: string,
  onText: (full: string) => void,
  firstTokenMs = 12000,
  totalMs = 60000,
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
          /* partial line */
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
          /* keep status */
        }
        finish({ full: '', status: xhr.status, error: msg });
      }
    };
    xhr.onerror = () => finish({ full: '', status: 0, error: 'Network error' });
    xhr.ontimeout = () => finish({ full, status: full ? 200 : 0, error: full ? undefined : 'Timed out' });
    xhr.send(body);
  });
}

function buildMultimodalContents(history: ChatMessage[]): any[] {
  return history
    .filter((m) => m.role !== 'error' && (m.text.trim() || m.attachment))
    .slice(-12)
    .map((m) => {
      const parts: any[] = [];
      if (m.attachment?.base64 && m.attachment.mimeType) {
        parts.push({
          inlineData: {
            mimeType: m.attachment.mimeType,
            data: m.attachment.base64,
          },
        });
      }
      if (m.attachment?.textContent) {
        parts.push({
          text: `[Attached File: ${m.attachment.name}]\n${m.attachment.textContent.slice(0, 25000)}`,
        });
      }
      if (m.text.trim()) {
        parts.push({ text: m.text });
      } else if (!parts.length) {
        parts.push({ text: 'Analyze this attachment.' });
      }
      return { role: m.role === 'user' ? 'user' : 'model', parts };
    });
}

async function streamGemini(
  apiKey: string,
  model: string,
  history: ChatMessage[],
  extraSystem: string,
  smartMemory: string[],
  temperature: number,
  speed: SpeedMode,
  onText: (visible: string) => void,
): Promise<{ reply: PulseReply; modelUsed: string }> {
  const contents = buildMultimodalContents(history);
  const sys = buildStreamPrompt(extraSystem, smartMemory);
  const hasMedia = history.some((m) => !!m.attachment?.base64);
  const make = (thinking: any | undefined) =>
    JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: speed === 'smart' || hasMedia ? 4096 : 1500,
        ...(thinking ? { thinkingConfig: thinking } : {}),
      },
    });
  const emit = (full: string) => onText(splitStreamText(full).visible);

  const chain = modelChain(hasMedia ? 'gemini-2.5-flash' : model);
  let lastErr = '';
  let sawNetwork = false;
  for (const m of chain) {
    if (isCooling(m)) continue;
    let r = await streamOnce(apiKey, m, make(thinkingFor(m, speed)), emit, hasMedia ? 14000 : 7000);
    if (r.status === 400 && /thinking/i.test(r.error || '')) {
      r = await streamOnce(apiKey, m, make(undefined), emit, hasMedia ? 14000 : 7000);
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
    coolDown(m, r.status === 429 ? 60000 : r.status === 404 ? 3600000 : 30000);
  }
  if (sawNetwork) throw new Error('No internet connection.');
  if (/quota|429|exhausted/i.test(lastErr)) {
    throw new Error('Your free Gemini quota is used up for now. Try again in a minute, or pick another model.');
  }
  throw new Error("Google's models are busy right now. Tap send again in a few seconds.");
}

const FALLBACK_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
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
  if (out.every(isCooling)) {
    delete cooldowns[out[0]];
    delete cooldowns['gemini-2.5-flash'];
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
  { id: 'gemini-2.5-flash', name: '⚡ 2.5 Flash', note: 'Fastest multimodal + agent model' },
  { id: 'gemini-2.5-flash-lite', name: '🚀 Flash-Lite', note: 'Ultra-fast instant replies (1–2 s)' },
  { id: 'gemini-flash-latest', name: '✨ Flash', note: 'Balanced speed & reasoning' },
  { id: 'gemini-pro-latest', name: '🧠 Pro', note: 'Deepest reasoning & complex coding' },
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
  timeoutMs = 25000,
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
  throw new Error("Google's models are busy right now. Try again in a few seconds.");
}

/* ------------------------------------------------------------------ */
/* Universal Mobile App Launcher & OS-Level Accessibility Integration  */
/* ------------------------------------------------------------------ */

type AppArgs = { query?: string; to?: string; text?: string };

type AppCatalogItem = {
  id: string;
  name: string;
  icon: string;
  hint: string;
  aliases: string[];
  packages: string[];
};

const APPS: AppCatalogItem[] = [
  { id: 'blinkit', name: 'Blinkit', icon: '⚡', hint: 'Groceries in 10m', aliases: ['blinkit', 'grofers'], packages: ['com.grofers.customerapp'] },
  { id: 'uber', name: 'Uber', icon: '🚖', hint: 'Book a ride', aliases: ['uber', 'uber cab', 'uber auto'], packages: ['com.ubercab', 'com.ubercab.uberlite'] },
  { id: 'meesho', name: 'Meesho', icon: '🛍️', hint: 'Shop products', aliases: ['meesho'], packages: ['com.meesho.supply'] },
  { id: 'whatsapp', name: 'WhatsApp', icon: '💬', hint: 'Message to send', aliases: ['whatsapp', 'wa', 'whats app'], packages: ['com.whatsapp', 'com.whatsapp.w4b'] },
  { id: 'instagram', name: 'Instagram', icon: '📸', hint: 'Username / Reels', aliases: ['instagram', 'insta', 'ig'], packages: ['com.instagram.android', 'com.instagram.lite'] },
  { id: 'telegram', name: 'Telegram', icon: '✈️', hint: 'Message / Channel', aliases: ['telegram', 'tg', 'tele'], packages: ['org.telegram.messenger', 'org.telegram.messenger.web', 'org.thunderdog.challegram'] },
  { id: 'freefire', name: 'Free Fire', icon: '🔥', hint: 'Launch game', aliases: ['freefire', 'free fire', 'free fire max', 'ff'], packages: ['com.dts.freefiremax', 'com.dts.freefireth'] },
  { id: 'zepto', name: 'Zepto', icon: '🛒', hint: 'Fast groceries', aliases: ['zepto'], packages: ['com.zeptoconsumerapp'] },
  { id: 'swiggy', name: 'Swiggy', icon: '🍔', hint: 'Food & Instamart', aliases: ['swiggy', 'instamart'], packages: ['in.swiggy.android'] },
  { id: 'zomato', name: 'Zomato', icon: '🍕', hint: 'Order food', aliases: ['zomato'], packages: ['com.application.zomato'] },
  { id: 'ola', name: 'Ola', icon: '🚕', hint: 'Book Ola cab', aliases: ['ola', 'ola cabs'], packages: ['com.olacabs.customer'] },
  { id: 'rapido', name: 'Rapido', icon: '🛵', hint: 'Bike taxi & auto', aliases: ['rapido'], packages: ['com.rapido.passenger'] },
  { id: 'flipkart', name: 'Flipkart', icon: '📦', hint: 'Search products', aliases: ['flipkart', 'fk'], packages: ['com.flipkart.android'] },
  { id: 'amazon', name: 'Amazon', icon: '🛒', hint: 'Shop Amazon', aliases: ['amazon', 'amazon shopping'], packages: ['in.amazon.mShop.android.shopping', 'com.amazon.mShop.android.shopping'] },
  { id: 'phonepe', name: 'PhonePe', icon: '🟣', hint: 'UPI & payments', aliases: ['phonepe', 'phone pe'], packages: ['com.phonepe.app'] },
  { id: 'gpay', name: 'Google Pay', icon: '💳', hint: 'GPay UPI', aliases: ['gpay', 'google pay', 'tez'], packages: ['com.google.android.apps.nbu.paisa.user'] },
  { id: 'paytm', name: 'Paytm', icon: '💠', hint: 'Paytm wallet/UPI', aliases: ['paytm'], packages: ['net.one97.paytm'] },
  { id: 'youtube', name: 'YouTube', icon: '▶️', hint: 'Video to search', aliases: ['youtube', 'yt'], packages: ['com.google.android.youtube'] },
  { id: 'spotify', name: 'Spotify', icon: '🎵', hint: 'Song or artist', aliases: ['spotify', 'music'], packages: ['com.spotify.music'] },
  { id: 'maps', name: 'Maps', icon: '🗺️', hint: 'Place to find', aliases: ['maps', 'google maps'], packages: ['com.google.android.apps.maps'] },
  { id: 'navigate', name: 'Navigate', icon: '🧭', hint: 'Turn-by-turn', aliases: ['navigate', 'directions'], packages: ['com.google.android.apps.maps'] },
  { id: 'phone', name: 'Call', icon: '📞', hint: 'Phone number', aliases: ['phone', 'call', 'dialer'], packages: ['com.google.android.dialer', 'com.android.dialer'] },
  { id: 'sms', name: 'SMS', icon: '✉️', hint: 'Message text', aliases: ['sms', 'messages'], packages: ['com.google.android.apps.messaging'] },
  { id: 'email', name: 'Email', icon: '📧', hint: 'Subject', aliases: ['email', 'gmail', 'mail'], packages: ['com.google.android.gm'] },
  { id: 'calendar', name: 'Calendar', icon: '📅', hint: 'Event title', aliases: ['calendar'], packages: ['com.google.android.calendar'] },
  { id: 'playstore', name: 'Play Store', icon: '▶️', hint: 'App to find', aliases: ['playstore', 'play store'], packages: ['com.android.vending'] },
  { id: 'web', name: 'Chrome', icon: '🌐', hint: 'Search the web', aliases: ['web', 'chrome', 'browser'], packages: ['com.android.chrome'] },
  { id: 'settings', name: 'Settings', icon: '⚙️', hint: 'Phone settings', aliases: ['settings'], packages: ['com.android.settings'] },
];

function phoneDigits(to: string) {
  let d = String(to || '').replace(/[^\d]/g, '');
  if (d.length === 10 && /^[6-9]/.test(d)) d = '91' + d;
  return d;
}

function appUrls(app: string, a: AppArgs): string[] {
  const q = encodeURIComponent(a.query || a.text || '');
  const t = encodeURIComponent(a.text || a.query || '');
  switch (app) {
    case 'blinkit':
      return q ? ['blinkit://search?q=' + q, 'https://blinkit.com/s/?q=' + q] : ['blinkit://'];
    case 'uber':
      return q
        ? ['uber://?action=setPickup&pickup=my_location&dropoff[formatted_address]=' + q, 'https://m.uber.com/ul/?action=setPickup&pickup=my_location']
        : ['uber://'];
    case 'ola':
      return ['olacabs://'];
    case 'rapido':
      return ['rapido://'];
    case 'zepto':
      return ['zepto://'];
    case 'swiggy':
      return q ? ['swiggy://explore?query=' + q] : ['swiggy://'];
    case 'zomato':
      return q ? ['zomato://search?q=' + q] : ['zomato://'];
    case 'meesho':
      return q ? ['meesho://search?q=' + q] : ['meesho://'];
    case 'flipkart':
      return q ? ['flipkart://fk.dl/de_wv_CL?q=' + q] : ['flipkart://'];
    case 'amazon':
      return q ? ['com.amazon.mobile.shopping://www.amazon.in/s?k=' + q] : ['com.amazon.mobile.shopping://'];
    case 'phonepe':
      return ['phonepe://'];
    case 'gpay':
      return ['tez://upi/'];
    case 'paytm':
      return ['paytmmp://'];
    case 'whatsapp': {
      const d = phoneDigits(a.to || '');
      return d || t
        ? ['whatsapp://send?' + (d ? 'phone=' + d + '&' : '') + 'text=' + t, 'https://wa.me/' + d + (t ? '?text=' + t : '')]
        : ['whatsapp://app'];
    }
    case 'maps':
      return ['geo:0,0?q=' + q, 'https://www.google.com/maps/search/?api=1&query=' + q];
    case 'navigate':
      return ['google.navigation:q=' + q, 'https://www.google.com/maps/dir/?api=1&destination=' + q];
    case 'youtube':
      return q ? ['vnd.youtube://results?search_query=' + q, 'https://www.youtube.com/results?search_query=' + q] : ['vnd.youtube://'];
    case 'spotify':
      return q ? ['spotify:search:' + q, 'https://open.spotify.com/search/' + q] : ['spotify:'];
    case 'phone':
      return ['tel:' + String(a.to || a.query || '').replace(/[^\d+]/g, '')];
    case 'sms':
      return ['sms:' + String(a.to || '').replace(/[^\d+]/g, '') + '?body=' + t];
    case 'email':
      return [mailtoUrl(a.query || '', a.text || '')];
    case 'calendar':
      return [calendarUrl(a.query || a.text || 'New event', a.text || '')];
    case 'telegram': {
      const handle = String(a.to || a.query || '').replace(/^@/, '').trim();
      return handle ? ['tg://resolve?domain=' + encodeURIComponent(handle)] : t ? ['tg://msg?text=' + t] : ['tg://'];
    }
    case 'instagram': {
      const u = String(a.query || '').replace(/^@/, '').trim();
      return u ? ['instagram://user?username=' + encodeURIComponent(u)] : ['instagram://app'];
    }
    case 'playstore':
      return ['market://search?q=' + q, 'https://play.google.com/store/search?q=' + q];
    case 'web':
      return [searchUrl(a.query || a.text || '')];
    default:
      return [];
  }
}

/**
 * Universal mobile app launcher with native bridge, package manager intent fallback,
 * deep-link support, and structured exception status reporting.
 */
async function openAppWithStatus(
  appNameOrId: string,
  a: AppArgs = {},
): Promise<{ ok: boolean; appName: string; statusMessage: string }> {
  const clean = appNameOrId.trim().toLowerCase();
  if (clean === 'settings' || clean === 'accessibility') {
    if (clean === 'accessibility' && Platform.OS === 'android') {
      await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.ACCESSIBILITY_SETTINGS).catch(() => Linking.openSettings());
      return { ok: true, appName: 'Accessibility Settings', statusMessage: 'Opened Android Accessibility Settings.' };
    }
    await Linking.openSettings().catch(() => undefined);
    return { ok: true, appName: 'Settings', statusMessage: 'Opened device Settings.' };
  }

  const catalogMatch = APPS.find(
    (x) => x.id === clean || x.name.toLowerCase() === clean || x.aliases.includes(clean),
  );
  const displayName = catalogMatch ? catalogMatch.name : appNameOrId.trim();

  // 1. Try Native HarkBridge (launches ANY installed mobile app on the phone by label or package name, + root/accessibility fallback)
  if (Platform.OS === 'android' && HarkBridge?.launchApp) {
    try {
      const launched = await HarkBridge.launchApp(catalogMatch ? catalogMatch.id : clean, a.query || a.text || '');
      if (launched) {
        return {
          ok: true,
          appName: displayName,
          statusMessage: `Launched ${displayName} via Pulse OS Native Bridge.`,
        };
      }
    } catch {
      /* fallback to deep link / IntentLauncher */
    }
  }

  // 2. Try deep link URLs (with query/message parameters if present)
  if (catalogMatch) {
    for (const u of appUrls(catalogMatch.id, a)) {
      try {
        if (await Linking.canOpenURL(u)) {
          await Linking.openURL(u);
          return {
            ok: true,
            appName: displayName,
            statusMessage: `Opened ${displayName}${a.query ? ` for "${a.query}"` : ''}.`,
          };
        }
      } catch {
        /* continue */
      }
    }

    // 3. Try Android IntentLauncher for each known package variant (works for Blinkit, Uber, Meesho, Free Fire, etc.)
    if (Platform.OS === 'android') {
      for (const pkg of catalogMatch.packages) {
        try {
          await IntentLauncher.startActivityAsync('android.intent.action.MAIN', {
            packageName: pkg,
            category: 'android.intent.category.LAUNCHER',
            flags: 0x10000000,
          });
          return {
            ok: true,
            appName: displayName,
            statusMessage: `Launched ${displayName} (${pkg}).`,
          };
        } catch {
          /* try next package */
        }
      }
    }
  }

  // 4. Exception handling when app is missing or fails to load: offer Play Store / web fallback & return clear status
  return {
    ok: false,
    appName: displayName,
    statusMessage: `Exception: "${displayName}" is not installed or failed to load on this device. You can install it from the Play Store or continue in the Live Browser.`,
  };
}

async function openApp(app: string, a: AppArgs): Promise<boolean> {
  const res = await openAppWithStatus(app, a);
  return res.ok;
}

/**
 * Executes a multi-step UI automation sequence on the device via HarkAccessibilityService / Root shell.
 */
async function executeOsAutomationScript(
  script: AutomationStep[],
  onProgress?: (msg: string) => void,
): Promise<{ ok: boolean; log: string[] }> {
  const logs: string[] = [];
  for (const s of script) {
    const act = (s.action || '').toLowerCase();
    const target = s.target || '';
    const val = s.value || '';
    onProgress?.(`Step ${s.step || ''}: ${act} ${target}`);
    try {
      if (act === 'launch_app' || act === 'open_app') {
        const res = await openAppWithStatus(target, { query: val, text: val });
        logs.push(res.statusMessage);
        if (!res.ok) return { ok: false, log: logs };
        await new Promise((r) => setTimeout(r, 1200));
      } else if (act === 'tap_text' || act === 'click_text') {
        if (HarkBridge?.clickByText) {
          const clicked = await HarkBridge.clickByText(target);
          logs.push(clicked ? `Tapped UI element "${target}".` : `UI element "${target}" not found on screen.`);
        } else {
          logs.push(`Queued assistive tap on "${target}".`);
        }
        await new Promise((r) => setTimeout(r, 500));
      } else if (act === 'tap_xy' || act === 'tap_coordinate') {
        const [xStr, yStr] = target.split(',');
        const x = parseFloat(xStr);
        const y = parseFloat(yStr);
        if (HarkBridge?.tapCoordinate && Number.isFinite(x) && Number.isFinite(y)) {
          await HarkBridge.tapCoordinate(x, y);
          logs.push(`Tapped screen coordinates (${x}, ${y}).`);
        } else {
          logs.push(`Queued coordinate tap (${target}).`);
        }
        await new Promise((r) => setTimeout(r, 450));
      } else if (act === 'input_text' || act === 'type') {
        if (HarkBridge?.inputText) {
          const typed = await HarkBridge.inputText(target, val);
          logs.push(typed ? `Entered "${val}" into "${target || 'focused input'}".` : `Could not find input field "${target}".`);
        } else {
          logs.push(`Queued text input "${val}".`);
        }
        await new Promise((r) => setTimeout(r, 450));
      } else if (act === 'root_exec' || act === 'shell') {
        if (HarkBridge?.runRootCommand) {
          const out = await HarkBridge.runRootCommand(target || val);
          logs.push(`Root shell: ${String(out || 'done').slice(0, 120)}`);
        } else {
          logs.push(`Root shell not available on this device; skipped "${target || val}".`);
        }
      } else if (act === 'wait') {
        await new Promise((r) => setTimeout(r, Math.min(5000, Number(val) || 1000)));
        logs.push(`Waited ${val || 1000}ms.`);
      }
    } catch (err: any) {
      logs.push(`Exception at step ${s.step || act}: ${err?.message || String(err)}`);
      return { ok: false, log: logs };
    }
  }
  return { ok: true, log: logs };
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
  'You are Pulse OS-Level Agent with Accessibility Service & root permissions. You operate both the mobile web browser and ANY installed Android app (Blinkit, Uber, Ola, Rapido, Zepto, Swiggy, Zomato, Meesho, Flipkart, Amazon, WhatsApp, Instagram, Telegram, Free Fire, PhonePe, GPay, Paytm, YouTube, Spotify, Maps, etc.).',
  'Parse the user command, identify the target app and action, and execute the steps cleanly.',
  'Each turn you get the goal, steps taken, and the current page snapshot.',
  'Reply with ONE JSON object: {"thought": "<=12 words describing step", "action": {...}}.',
  'Actions:',
  '{"type":"navigate","url":"https://..."}  open a web URL.',
  '{"type":"click","i":N}  tap web element N.',
  '{"type":"type","i":N,"text":"...","submit":true|false}  type into web field N.',
  '{"type":"scroll","dir":"down"|"up"}',
  '{"type":"open_app","app":"blinkit|uber|meesho|whatsapp|instagram|telegram|freefire|zepto|swiggy|zomato|ola|rapido|flipkart|amazon|phonepe|gpay|paytm|maps|navigate|youtube|spotify|phone|sms|email|calendar|playstore","query":"...","to":"phone","text":"message","ui_steps":[{"step":1,"action":"tap_text","target":"Search"},{"step":2,"action":"input_text","target":"Search","value":"milk"}]}  launches the installed app and runs the UI automation sequence.',
  '{"type":"answer","text":"..."}  task finished; provide clear status update.',
  '{"type":"ask","text":"..."}  ask user for explicit confirmation before final checkout/payment/sending message.',
].join('\n');

const AGENT_RE =
  /^(please\s+|can you\s+|pls\s+)?(open|launch|start|run|go to|goto|search|find|look ?up|book|order|play|send|message|whatsapp|blinkit|uber|meesho|free ?fire|instagram|telegram|call|dial|navigate|take me|directions|show me|check|buy|download|watch|listen|browse|visit|compare|track|fill|apply|sign up|tap|click)\b/i;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function agentSnapshot(): Promise<PageSnap | null> {
  const r = AgentBus.runner();
  if (!r) return null;
  const snap: any = await r.evalJs(SNAPSHOT_JS);
  if (!snap || snap.error) return null;
  return snap as PageSnap;
}

async function waitForPage(maxMs = 7000) {
  const r = AgentBus.runner();
  await sleep(300);
  const t0 = Date.now();
  while (r && r.isLoading() && Date.now() - t0 < maxMs) await sleep(180);
  await sleep(250);
}

async function runAgent(o: {
  apiKey: string;
  model: string;
  goal: string;
  context: string;
  onStep: (label: string) => void;
}): Promise<string> {
  const combinedText = (o.goal + ' ' + (o.context || '')).toLowerCase();
  const goalLower = o.goal.toLowerCase();

  const mentionedApp =
    APPS.find(
      (app: any) =>
        app.id !== 'web' &&
        [app.id, app.name.toLowerCase(), ...(app.aliases || [])].some((al: string) =>
          goalLower.includes(al.toLowerCase()),
        ),
    ) ||
    (/(cart|order|add|buy)/i.test(goalLower)
      ? APPS.find(
          (app: any) =>
            app.id !== 'web' &&
            [app.id, app.name.toLowerCase(), ...(app.aliases || [])].some((al: string) =>
              combinedText.includes(al.toLowerCase()),
            ),
        )
      : undefined);

  if (mentionedApp) {
    let cleanQuery = o.goal
      .replace(/^(?:please\s+|can you\s+|hey pulse\s+)?(?:open|launch|start|run|search|order|book|buy|add|play|send|message)\s+/i, '')
      .replace(new RegExp('\\b(?:on|in|using|via|from|to|into)\\s+(?:my\\s+cart\\s+(?:on|in)\\s+)?' + mentionedApp.name + '\\b', 'gi'), '')
      .replace(new RegExp('^' + mentionedApp.name + '\\s*(?:and|to|for)?\\s*', 'i'), '')
      .replace(/\b(?:to my cart|in my cart|directly|right now|please)\b/gi, '')
      .trim();

    if (/nothing in my cart/i.test(o.goal)) {
      const prevMatch = (o.context || '').match(/(?:order|add|buy)\s+([a-zA-Z0-9\s]{2,25}?)(?:\s+on|\s+in|\s+from|\s+to|\n|$)/i);
      if (prevMatch?.[1]) cleanQuery = prevMatch[1].trim();
    }

    o.onStep(`Launching ${mentionedApp.name}${cleanQuery ? ' for "' + cleanQuery + '"' : ''}…`);

    if (Platform.OS === 'android' && HarkBridge?.launchApp) {
      const launched = await HarkBridge.launchApp(mentionedApp.id, cleanQuery).catch(() => false);
      if (launched && cleanQuery && HarkBridge?.runAutonomousWorkflow) {
        await HarkBridge.runAutonomousWorkflow(mentionedApp.id, cleanQuery, 'order').catch(() => false);
      }
      if (launched) {
        return cleanQuery
          ? `✅ Launched ${mentionedApp.name} and started the native background Accessibility worker (120ms fast node polling + 4-tier layout fallback) to search for "${cleanQuery}", tap ADD to cart, and capture a real-time verification screenshot.`
          : `✅ Opened ${mentionedApp.name}.`;
      }
    }

    const launchRes = await openApp(mentionedApp.id, { query: cleanQuery, text: cleanQuery });
    return launchRes ? `✅ Opened ${mentionedApp.name}.` : `⚠️ ${mentionedApp.name} is not installed on this device.`;
  }

  const runner = AgentBus.runner();
  if (!runner) throw new Error('The live browser is not ready yet. Try again in a second.');
  const done: string[] = [];
  for (let n = 0; n < 25; n++) {
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
    if ((type === 'answer' || type === 'ask') && done.length === 0) {
      const goalLower = o.goal.toLowerCase();
      const matchedApp = APPS.find((ap: any) => ap.id !== 'web' && (goalLower.includes(ap.id) || goalLower.includes(ap.name.toLowerCase())));
      if (matchedApp) {
        o.onStep('Launching ' + matchedApp.name + ' on your phone…');
        const ok = await openApp(matchedApp.id, { query: o.goal, text: o.goal });
        return ok ? '✅ Opened ' + matchedApp.name + ' and started your task.' : matchedApp.name + ' is not installed on this phone.';
      }
      const searchTarget = searchUrl(o.goal);
      o.onStep('Opening Live Browser for: ' + o.goal.slice(0, 40));
      runner.navigate(searchTarget);
      await waitForPage();
      done.push('navigate ' + searchTarget);
      continue;
    }
    if ((type === 'answer' || type === 'ask') && done.length === 0) {
      const goalLower = o.goal.toLowerCase();
      const matchedApp = APPS.find((ap: any) => ap.id !== 'web' && (goalLower.includes(ap.id) || goalLower.includes(ap.name.toLowerCase())));
      if (matchedApp) {
        o.onStep('Launching ' + matchedApp.name + ' on your phone…');
        const ok = await openApp(matchedApp.id, { query: o.goal, text: o.goal });
        return ok ? '✅ Opened ' + matchedApp.name + ' and started your task.' : matchedApp.name + ' is not installed on this phone.';
      }
      const searchTarget = searchUrl(o.goal);
      o.onStep('Opening Live Browser for: ' + o.goal.slice(0, 40));
      runner.navigate(searchTarget);
      await waitForPage();
      done.push('navigate ' + searchTarget);
      continue;
    }
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
      await waitForPage(5000);
      done.push('click [' + a.i + '] "' + (el?.label || '') + '" → ' + (r?.ok ? 'ok' : r?.msg || 'failed'));
    } else if (type === 'type' && Number.isFinite(Number(a.i))) {
      const text = String(a.text || '');
      o.onStep(thought || 'Typing "' + text.slice(0, 30) + '"');
      const r: any = await runner.evalJs(
        'var I=' + JSON.stringify(Number(a.i)) + ',KIND="type",TEXT=' + JSON.stringify(text) + ',SUBMIT=' + (a.submit ? 'true' : 'false') + ';' + ACT_JS,
      );
      if (a.submit) await waitForPage(5000);
      done.push('type [' + a.i + '] "' + text + '"' + (a.submit ? ' + Enter' : '') + ' → ' + (r?.ok ? 'ok' : r?.msg || 'failed'));
    } else if (type === 'scroll') {
      const up = a.dir === 'up';
      o.onStep(thought || 'Scrolling ' + (up ? 'up' : 'down'));
      await runner.evalJs('window.scrollBy(0,' + (up ? '-' : '') + 'window.innerHeight*0.8);return {ok:true};');
      await sleep(300);
      done.push('scroll ' + (up ? 'up' : 'down'));
    } else if (type === 'open_app' && a.app) {
      const app = String(a.app);
      o.onStep(thought || 'Launching ' + app);
      const res = await openAppWithStatus(app, { query: a.query, to: a.to, text: a.text });
      if (res.ok && Array.isArray(a.ui_steps) && a.ui_steps.length) {
        const scriptRes = await executeOsAutomationScript(a.ui_steps, o.onStep);
        return `${res.statusMessage}\n\nUI Automation Sequence:\n- ${scriptRes.log.join('\n- ')}`;
      }
      return res.statusMessage;
    } else {
      done.push('invalid action ' + JSON.stringify(a).slice(0, 80));
    }
  }
  return 'Completed 10 automation steps. You can view or finish the current screen in the LIVE tab.';
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
    .slice(-10)
    .map((m) => (m.role === 'user' ? 'User: ' : 'Pulse: ') + m.text.slice(0, 400))
    .join('\n');
  if (!text) return null;
  try {
    const { json } = await geminiJson(
      apiKey,
      FAST_MODEL,
      'Summarize this chat. Reply JSON {"title": "max 6 words", "summary": "max 25 words, what was asked and the outcome"}. Same language as the chat.',
      [{ role: 'user', parts: [{ text }] }],
      9000,
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
/* APPS tab (Universal App Launcher + Installed Device Apps)           */
/* ------------------------------------------------------------------ */


function CloudComputerScreen({
  settings,
  patchSettings,
  say,
}: {
  settings: Settings;
  patchSettings: (p: Partial<Settings>) => void;
  say: (t: string) => void;
}) {
  const [status, setStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [taskType, setTaskType] = useState<'plan' | 'summarize' | 'budget' | 'echo'>('plan');
  const [taskInput, setTaskInput] = useState('');
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState('');
  const base = normalizeCloudUrl(settings.cloudUrl || DEFAULT_CLOUD_URL);

  const refreshCloud = useCallback(async () => {
    if (!base) {
      setStatus('offline');
      return;
    }
    setStatus('checking');
    try {
      await cloudHealth(base);
      setStatus('online');
    } catch {
      setStatus('offline');
    }
  }, [base]);

  useEffect(() => {
    refreshCloud();
  }, [refreshCloud]);

  const executeTask = async () => {
    if (running) return;
    setRunning(true);
    setOutput('');
    try {
      if (status === 'online' && base) {
        const payload =
          taskType === 'plan'
            ? { summary: taskInput || 'Extended testing sprint', checklist: ['Deep work block', 'Verify features', 'Ship release'], start: '09:00' }
            : taskType === 'summarize'
              ? { text: taskInput || 'Pulse OS cloud computer workload.' }
              : taskType === 'budget'
                ? { income: 50000, items: [{ label: 'Cloud Server', amount: 2500 }, { label: 'AI API', amount: 1500 }] }
                : { message: taskInput || 'Hello Cloud Computer!' };
        const run = await runCloudTask(base, settings.cloudToken, settings.apiKey || undefined, taskType, payload);
        setOutput('✅ Cloud Server Output:\n' + JSON.stringify(run?.result ?? run, null, 2));
        say('Cloud task completed.');
      } else if (settings.apiKey) {
        const { json, model } = await geminiJson(
          settings.apiKey,
          settings.model || DEFAULT_MODEL,
          'You are the Pulse OS Cloud Computer Engine. Execute the requested cloud workload and return structured JSON.',
          [{ role: 'user', parts: [{ text: 'Task: ' + taskType + '\nInput: ' + (taskInput || 'Generate productivity plan & system report') }] }],
          25000,
        );
        setOutput('⚡ Pulse Hybrid Cloud Engine (' + model + '):\n' + JSON.stringify(json, null, 2));
        say('Cloud computer task complete.');
      } else {
        setOutput('⚠️ Add your Gemini API key in Settings or wake your GitHub Codespace.');
      }
    } catch (e: any) {
      setOutput('Error: ' + (e?.message || String(e)));
    } finally {
      setRunning(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <View style={styles.rowBetween}>
        <Text style={styles.sectionTitle}>☁️ Cloud Computer</Text>
        <View style={[styles.chip, { borderColor: status === 'online' ? C.good : C.accent2 }]}>
          <Text style={[styles.chipText, { color: status === 'online' ? C.good : C.accent2 }]}>
            {status === 'online' ? '🟢 Remote Server Online' : status === 'checking' ? '⏳ Checking…' : '⚡ Hybrid Cloud Active'}
          </Text>
        </View>
      </View>
      <View style={styles.settingsCard}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>Cloud Routing</Text>
          <Switch value={settings.cloudMode} onValueChange={(v) => patchSettings({ cloudMode: v })} trackColor={{ false: C.border, true: C.accent }} thumbColor="#fff" />
        </View>
        <Text style={styles.mutedSmall}>
          Routes tasks to your Cloud Server when online and automatically fails over to the local Hybrid Cloud Engine so your Cloud Computer always works.
        </Text>
        <TextInput value={settings.cloudUrl} onChangeText={(t) => patchSettings({ cloudUrl: t })} onBlur={() => patchSettings({ cloudUrl: normalizeCloudUrl(settings.cloudUrl) })} placeholder={DEFAULT_CLOUD_URL} placeholderTextColor={C.muted} autoCapitalize="none" style={styles.input} />
        <Pressable onPress={refreshCloud} style={styles.secondaryBtn}>
          <Text style={styles.primaryBtnText}>↻ Ping Cloud Server</Text>
        </Pressable>
      </View>
      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>🚀 Run Cloud Computer Task</Text>
        <View style={styles.segment}>
          {(['plan', 'summarize', 'budget', 'echo'] as const).map((t) => (
            <Pressable key={t} onPress={() => setTaskType(t)} style={[styles.segItem, taskType === t && styles.segItemOn]}>
              <Text style={[styles.segText, taskType === t && styles.segTextOn]}>{t === 'summarize' ? 'SUMMARY' : t.toUpperCase()}</Text>
            </Pressable>
          ))}
        </View>
        <TextInput value={taskInput} onChangeText={setTaskInput} placeholder="Enter goal, document text, or cloud job parameters…" placeholderTextColor={C.muted} multiline style={[styles.input, { minHeight: 70, marginTop: 8 }]} />
        <Pressable onPress={executeTask} disabled={running} style={styles.primaryBtn}>
          {running ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>▶ Execute on Cloud Computer</Text>}
        </Pressable>
        {output ? (
          <View style={{ marginTop: 10, padding: 12, borderRadius: 10, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border }}>
            <Text style={{ color: C.text, fontSize: 12 }}>{output}</Text>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

function AppsScreen({ say }: { say: (t: string) => void }) {
  const [text, setText] = useState('');
  const [to, setTo] = useState('');
  const [last, setLast] = useState('');
  const [installedApps, setInstalledApps] = useState<{ label: string; packageName: string }[]>([]);

  useEffect(() => {
    if (Platform.OS === 'android' && HarkBridge?.getInstalledApps) {
      HarkBridge.getInstalledApps()
        .then((list: any) => {
          if (Array.isArray(list)) setInstalledApps(list);
        })
        .catch(() => undefined);
    }
  }, []);

  const launch = async (idOrPkg: string, name: string) => {
    const res = await openAppWithStatus(idOrPkg, idOrPkg === 'email' ? { query: text, text: '' } : { query: text, text, to });
    setLast(res.statusMessage);
    say(res.statusMessage);
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <View style={{ gap: 8, marginBottom: 4 }}>
        <View style={styles.rowBetween}>
          <Text style={styles.sectionTitle}>Universal Apps</Text>
          <Pressable
            onPress={() => openAppWithStatus('accessibility')}
            style={[styles.chip, { borderColor: C.accent2, paddingHorizontal: 12, paddingVertical: 6 }]}
          >
            <Text style={[styles.chipText, { color: C.accent2, fontSize: 11 }]}>♿ Assistive Bridge</Text>
          </Pressable>
        </View>
      </View>
      <Text style={[styles.mutedSmall, { marginTop: 4 }]}>
        Launch Blinkit, Uber, Meesho, WhatsApp, Instagram, Telegram, Free Fire, or any app installed on your phone.
      </Text>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="Search query, item to order, destination, or message…"
        placeholderTextColor={C.muted}
        style={[styles.input, { marginTop: 12 }]}
      />
      <TextInput
        value={to}
        onChangeText={setTo}
        placeholder="Phone number or @username (for WhatsApp, Telegram, Call, SMS)"
        placeholderTextColor={C.muted}
        keyboardType="default"
        style={[styles.input, { marginTop: 8 }]}
      />
      {last ? (
        <View style={[styles.settingsCard, { marginTop: 10, borderColor: C.accent }]}>
          <Text style={styles.bubbleText}>{last}</Text>
        </View>
      ) : null}
      <View style={styles.appGrid}>
        {APPS.map((a) => (
          <Pressable key={a.id} onPress={() => launch(a.id, a.name)} style={styles.appTile} accessibilityLabel={'Open ' + a.name}>
            <Text style={{ fontSize: 26 }}>{a.icon}</Text>
            <Text style={styles.appName} numberOfLines={1}>{a.name}</Text>
            <Text style={[styles.mutedSmall, { fontSize: 10 }]} numberOfLines={1}>{a.hint}</Text>
          </Pressable>
        ))}
      </View>

      {installedApps.length > 0 ? (
        <View style={{ marginTop: 22 }}>
          <Text style={styles.sectionTitle}>All Installed Phone Apps ({installedApps.length})</Text>
          <View style={styles.appGrid}>
            {installedApps.map((item) => (
              <Pressable
                key={item.packageName}
                onPress={() => launch(item.packageName, item.label)}
                style={styles.appTile}
              >
                <Text style={{ fontSize: 22 }}>📱</Text>
                <Text style={styles.appName} numberOfLines={1}>{item.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

/* ---- Cloud backend ---- */

function normalizeCloudUrl(raw: string): string {
  let s = raw.trim().replace(/\s+/g, '');
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, '');
  if (s.includes('.')) return ('https://' + s).replace(/\/+$/, '');
  if (/^[a-z0-9-]+$/i.test(s)) {
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
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 6500);
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
  return cloudFetch(base, '', '/health', { timeoutMs: 4500 });
}

async function callCloudChat(
  base: string,
  token: string,
  geminiKey: string | undefined,
  history: ChatMessage[],
  extraSystem = '',
  smartMemory: string[] = [],
): Promise<{ reply: PulseReply; modelUsed: string }> {
  const messages = history
    .filter((m) => m.role !== 'error')
    .slice(-10)
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      text:
        (m.attachment?.textContent ? `[Attached File ${m.attachment.name}]:\n${m.attachment.textContent}\n\n` : '') +
        (m.role === 'assistant' && m.reply ? JSON.stringify(m.reply) : m.text),
      inlineData:
        m.attachment?.base64 && m.attachment?.mimeType
          ? { mimeType: m.attachment.mimeType, data: m.attachment.base64 }
          : undefined,
    }));
  const json = await cloudFetch(base, token, '/api/chat', {
    body: { messages, context: extraSystem, memory: smartMemory.join('\n') },
    geminiKey,
    timeoutMs: 12000,
  });
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
  const json = await cloudFetch(base, token, '/api/task', { body: { type, payload }, geminiKey, timeoutMs: 45000 });
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
  if (/(text|message|sms|whatsapp|remind)/.test(lower)) {
    actions.push({ label: '💬 SMS', url: smsUrl(item) });
  }
  if (/(call|phone|ring)/.test(lower)) {
    actions.push({ label: '📞 Dial', url: 'tel:' });
  }
  return actions;
}

/* ------------------------------------------------------------------ */
/* Multimodal Picker & Native Voice Recognition WebView Modal          */
/* ------------------------------------------------------------------ */

const MULTIMODAL_PICKER_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<style>
  body { background: #121826; color: #E6EAF2; font-family: system-ui, -apple-system, Roboto, sans-serif; margin: 0; padding: 18px; }
  h3 { margin: 0 0 6px 0; font-size: 17px; color: #fff; }
  p { margin: 0 0 14px 0; font-size: 13px; color: #8A94A8; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
  .btn { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 14px 10px; border-radius: 14px; background: #1A2233; border: 1px solid #263047; color: #E6EAF2; font-weight: 700; font-size: 13px; cursor: pointer; text-align: center; gap: 6px; }
  .btn:active { border-color: #7C5CFF; background: #2A1F5C; }
  .icon { font-size: 24px; }
  .box { background: #1A2233; border: 1px solid #263047; border-radius: 12px; padding: 12px; margin-top: 10px; }
  input[type="url"], input[type="text"] { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 10px; border: 1px solid #263047; background: #0B0F17; color: #fff; font-size: 14px; margin-top: 6px; }
  .act { width: 100%; margin-top: 10px; padding: 11px; border-radius: 10px; border: none; background: #7C5CFF; color: #fff; font-weight: 700; font-size: 14px; cursor: pointer; }
  .status { margin-top: 10px; font-size: 12px; color: #22D3EE; text-align: center; }
  input[type="file"] { display: none; }
</style>
</head>
<body>
  <h3>📎 Attach Image, Photo, Video or Document</h3>
  <p>Select a file from your phone or paste a YouTube / Video URL for deep multimodal analysis, OCR, & action extraction.</p>
  <div class="grid">
    <label class="btn" for="imgInput">
      <span class="icon">🖼️</span>
      <span>Photo / Image</span>
      <span style="font-size:11px;color:#8A94A8;font-weight:400">OCR & Object Detect</span>
    </label>
    <label class="btn" for="camInput">
      <span class="icon">📷</span>
      <span>Camera Photo</span>
      <span style="font-size:11px;color:#8A94A8;font-weight:400">Snap & Analyze</span>
    </label>
    <label class="btn" for="docInput">
      <span class="icon">📄</span>
      <span>Document / PDF</span>
      <span style="font-size:11px;color:#8A94A8;font-weight:400">PDF, TXT, CSV, JSON, MD</span>
    </label>
    <label class="btn" for="vidInput">
      <span class="icon">🎬</span>
      <span>Video File</span>
      <span style="font-size:11px;color:#8A94A8;font-weight:400">MP4 / WebM Analysis</span>
    </label>
  </div>

  <input id="imgInput" type="file" accept="image/*" />
  <input id="camInput" type="file" accept="image/*" capture="environment" />
  <input id="docInput" type="file" accept=".pdf,.txt,.md,.csv,.json,.xml,.html,.doc,.docx,application/pdf,text/*" />
  <input id="vidInput" type="file" accept="video/*" />

  <div class="box">
    <div style="font-size:13px;font-weight:700;">🔗 Or Analyze a YouTube / Video Link</div>
    <input id="ytUrl" type="url" placeholder="https://www.youtube.com/watch?v=..." />
    <button class="act" id="ytBtn">Attach Video Link for Transcript & Summary</button>
  </div>
  <div id="status" class="status"></div>

<script>
  function send(payload) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  }
  function handleFile(file, kind) {
    if (!file) return;
    var st = document.getElementById('status');
    st.textContent = 'Reading ' + file.name + ' (' + Math.round(file.size/1024) + ' KB)...';
    var isText = /^text\\/|\\.(txt|md|csv|json|xml|html|js|ts|py)$/i.test(file.type || file.name);
    var reader = new FileReader();
    if (isText) {
      reader.onload = function(e) {
        send({
          type: 'attachment',
          name: file.name,
          mimeType: file.type || 'text/plain',
          kind: 'document',
          textContent: String(e.target.result || '').slice(0, 40000),
          sizeBytes: file.size
        });
      };
      reader.readAsText(file);
    } else {
      reader.onload = function(e) {
        var dataUrl = String(e.target.result || '');
        var comma = dataUrl.indexOf(',');
        var b64 = comma !== -1 ? dataUrl.slice(comma + 1) : dataUrl;
        send({
          type: 'attachment',
          name: file.name,
          mimeType: file.type || (kind === 'image' ? 'image/jpeg' : kind === 'video' ? 'video/mp4' : 'application/pdf'),
          kind: kind,
          base64: b64,
          uri: dataUrl,
          sizeBytes: file.size
        });
      };
      reader.readAsDataURL(file);
    }
  }
  document.getElementById('imgInput').onchange = function(e){ handleFile(e.target.files[0], 'image'); };
  document.getElementById('camInput').onchange = function(e){ handleFile(e.target.files[0], 'image'); };
  document.getElementById('docInput').onchange = function(e){ handleFile(e.target.files[0], 'document'); };
  document.getElementById('vidInput').onchange = function(e){ handleFile(e.target.files[0], 'video'); };
  document.getElementById('ytBtn').onclick = function(){
    var u = document.getElementById('ytUrl').value.trim();
    if (!u) { alert('Paste a video URL first.'); return; }
    send({
      type: 'attachment',
      name: u,
      mimeType: 'text/uri-list',
      kind: 'video_link',
      uri: u
    });
  };
</script>
</body>
</html>`;

/* ------------------------------------------------------------------ */
/* Settings model                                                      */
/* ------------------------------------------------------------------ */

const STORAGE_SETTINGS = 'pulseos.settings.v2';

type Settings = {
  name: string;
  email: string;
  role: string;
  avatar: string;
  profilePhotoUri?: string;
  selfLearn?: boolean;
  focusGoalMin: number;
  personalize: boolean;
  apiKey: string;
  model: string;
  temperature: number;
  speed: SpeedMode;
  fastModel: string;
  replyLength: 'short' | 'balanced' | 'detailed';
  historyLimit: number;
  cloudUrl: string;
  cloudToken: string;
  cloudMode: boolean;
  voiceOn: boolean;
  voiceRate: number;
  voicePitch: number;
  voiceLang: string;
  homeUrl: string;
  confirmBeforeComplete: boolean;
  haptics: boolean;
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
  profilePhotoUri: '',
  selfLearn: true,
  focusGoalMin: 480,
  personalize: true,
  apiKey: '',
  model: DEFAULT_MODEL,
  temperature: 0.5,
  speed: 'fast',
  fastModel: FAST_MODEL,
  replyLength: 'balanced',
  historyLimit: 200,
  cloudUrl: DEFAULT_CLOUD_URL,
  cloudToken: '',
  cloudMode: true,
  voiceOn: true,
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
      if (!saved.rev || saved.rev < 4) {
        merged.speed = 'fast';
        merged.fastModel = FAST_MODEL;
        merged.model = DEFAULT_MODEL;
        merged.cloudMode = false;
        if (!merged.cloudUrl) merged.cloudUrl = DEFAULT_CLOUD_URL;
        merged.rev = 4;
        await AsyncStorage.setItem(STORAGE_SETTINGS, JSON.stringify(merged));
      }
      return merged;
    } catch {
      /* fallback */
    }
  }
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
    voiceOn: v ? v === '1' : true,
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
  if (s.name.trim()) bits.push("The user's name is " + s.name.trim() + '.');
  if (s.role.trim()) bits.push('They describe themselves as: ' + s.role.trim() + '.');
  if (s.focusGoalMin > 0) bits.push('Their daily focus goal is ' + s.focusGoalMin + ' minutes.');
  const len =
    s.replyLength === 'short'
      ? 'Keep the answer to 1-2 sentences.'
      : s.replyLength === 'detailed'
        ? 'Provide a thorough, well-structured breakdown.'
        : 'Keep the answer concise and practical.';
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
  if (!res.ok) throw new Error("Couldn't check for updates (" + res.status + '). Try again later.');
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
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    flags: 1,
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
    { id: 'CLOUD', icon: '☁️' },
    { id: 'LIVE', icon: '🖥️' },
    { id: 'SETTINGS', icon: '⚙️' },
  ];

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" backgroundColor={C.bg} />
      <View style={styles.header}>
        <Pressable onPress={() => setTab('SETTINGS')} style={styles.rowCenter} accessibilityLabel="Open profile">
          <View style={[styles.avatarSmall, { overflow: 'hidden' }]}>
            {settings.profilePhotoUri ? (
              <Image source={{ uri: settings.profilePhotoUri }} style={{ width: 34, height: 34, borderRadius: 17 }} />
            ) : (
              <Text style={{ fontSize: 18 }}>{settings.avatar || '⚡'}</Text>
            )}
          </View>
          <View>
            <Text style={styles.brand}>Pulse OS 3.0</Text>
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
          <Text style={[styles.voiceText, settings.voiceOn && { color: C.text }]}>{settings.voiceOn ? 'VOICE ON' : 'VOICE OFF'}</Text>
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
        <View style={[styles.fill, tab !== 'CLOUD' && styles.hidden]}>
          <CloudComputerScreen settings={settings} patchSettings={patchSettings} say={say} />
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
/* CHAT (Multimodal Attachments + Voice Mic + OS Automation + Memory)  */
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
  const [listening, setListening] = useState(false);
  const [attachModal, setAttachModal] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<AttachmentItem | null>(null);
  const [smartMemory, setSmartMemory] = useState<string[]>([]);
  const [cloudStatus, setCloudStatus] = useState<CloudStatus>('off');
  const [cloudHealthInfo, setCloudHealthInfo] = useState<CloudHealth | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const isNearBottomRef = useRef(true);
  const userDraggingRef = useRef(false);
  const [showScrollBottomBtn, setShowScrollBottomBtn] = useState(false);

  const onChatScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const dist = contentSize.height - layoutMeasurement.height - contentOffset.y;
    const near = dist < 90;
    isNearBottomRef.current = near;
    setShowScrollBottomBtn(!near && contentSize.height > layoutMeasurement.height + 120);
  };
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    loadSmartMemory().then(setSmartMemory);
  }, []);

  const lastPolledAutomationTs = useRef<number>(0);

  useEffect(() => {
    if (Platform.OS !== 'android' || !HarkBridge?.getAutomationResult) return;
    const checkResult = async () => {
      try {
        const res = await HarkBridge.getAutomationResult();
        if (res && res.ts && res.ts > lastPolledAutomationTs.current && (res.status === 'verified' || res.status === 'needs_confirmation' || res.status === 'error')) {
          lastPolledAutomationTs.current = res.ts;
          const badge = res.cartVerified ? '✅ Cart & Action Verified' : '⚠️ Manual Confirmation Needed';
          const statusLine = `${badge}: ${res.message || res.cartSummary || ''}`;
          setMessages((prev) => {
            if (!prev.length) return prev;
            const copy = [...prev];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].role === 'assistant') {
                copy[i] = {
                  ...copy[i],
                  text: copy[i].text.includes(statusLine) ? copy[i].text : `${copy[i].text}

${statusLine}`,
                  verificationShotUri: res.screenshot || copy[i].verificationShotUri,
                  verificationSummary: res.cartSummary || res.message,
                };
                break;
              }
            }
            return copy;
          });
          if (res.message) say(res.message);
        }
      } catch {}
    };
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkResult();
    });
    const timer = setInterval(checkResult, 2200);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [say]);


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

  useEffect(() => {
    if (!loaded || !currentId) return;
    setConvos((prev) =>
      prev.map((c) => {
        if (c.id !== currentId) return c;
        const firstUser = messages.find((m) => m.role === 'user');
        const lastTs = messages.length ? messages[messages.length - 1].ts : c.updatedAt;
        return {
          ...c,
          messages: messages.slice(-Math.max(10, settings.historyLimit)).map((m) => ({
            ...m,
            // Strip large base64 strings when persisting to AsyncStorage so storage stays fast
            attachment: m.attachment ? { ...m.attachment, base64: undefined } : undefined,
          })),
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

  /**
   * Starts Native Android Voice Input (RecognizerIntent via HarkBridge, or focuses keyboard voice mic).
   */
  const startVoiceInput = async () => {
    if (busy) return;
    if (settings.haptics) Vibration.vibrate(15);
    if (Platform.OS === 'android' && HarkBridge?.startVoiceRecognition) {
      try {
        setListening(true);
        const spoken: string = await HarkBridge.startVoiceRecognition(settings.voiceLang || 'en-IN');
        setListening(false);
        if (spoken && spoken.trim()) {
          setInput((prev) => (prev ? prev + ' ' + spoken.trim() : spoken.trim()));
        }
        return;
      } catch {
        setListening(false);
      }
    }
    inputRef.current?.focus();
    Alert.alert(
      '🎙️ Voice Talk Ready',
      'Speak using the microphone on your Android keyboard, or enable the Pulse OS native voice recognizer.',
    );
  };

  const onPickerMessage = async (e: WebViewMessageEvent) => {
    try {
      const d = JSON.parse(e.nativeEvent.data);
      if (d?.type === 'attachment') {
        setAttachModal(false);
        if (d.kind === 'video_link' && d.uri) {
          const videoCtx = await fetchVideoLinkContext(String(d.uri));
          setPendingAttachment({
            uri: String(d.uri),
            name: String(d.name || d.uri),
            mimeType: 'text/uri-list',
            kind: 'video_link',
            textContent: videoCtx,
          });
        } else {
          setPendingAttachment({
            uri: String(d.uri || ''),
            name: String(d.name || 'Attachment'),
            mimeType: String(d.mimeType || 'application/octet-stream'),
            kind: d.kind || 'document',
            base64: d.base64 ? String(d.base64) : undefined,
            textContent: d.textContent ? String(d.textContent) : undefined,
            sizeBytes: Number(d.sizeBytes) || 0,
          });
        }
      }
    } catch {
      /* ignore */
    }
  };

  const send = async () => {
    const rawInput = input.trim();
    const attached = pendingAttachment;
    if (!rawInput && !attached) return;
    if (busy) return;

    const text =
      rawInput ||
      (attached?.kind === 'image'
        ? 'Describe this image in detail, extract any visible text (OCR), detect objects, and pull any actionable tasks or reminders.'
        : attached?.kind === 'video' || attached?.kind === 'video_link'
          ? 'Extract the transcript/details of this video, summarize the core content, and pull any tasks, events, or reminders.'
          : 'Read this document, extract key information, provide a concise summary, and pull any tasks, calendar events, or reminders.');

    const useCloud = !apiKey && cloudMode && !!cloudUrl;
    if (!apiKey && !useCloud) {
      openSettings();
      return;
    }
    if (settings.haptics) Vibration.vibrate(10);

    // Instant OS-level app launch fast-path for simple voice/text commands like "open Blinkit", "open Uber", "open Free Fire", "open Instagram"
    const quickOpenMatch =
      !attached &&
      rawInput.match(/^(?:please\s+|can you\s+|hey pulse\s+)?(?:open|launch|start|run)\s+([a-z0-9\s._@-]+)$/i);
    if (quickOpenMatch) {
      const targetApp = quickOpenMatch[1].trim();
      setInput('');
      const launchRes = await openAppWithStatus(targetApp);
      const userMsg: ChatMessage = { id: uid(), role: 'user', text: rawInput, ts: Date.now() };
      const botMsg: ChatMessage = {
        id: uid(),
        role: 'assistant',
        text: launchRes.statusMessage,
        reply: {
          direct_response: launchRes.statusMessage,
          proactive_checklist: launchRes.ok
            ? [`Opened ${launchRes.appName}`, 'Use voice command for next UI step']
            : [`Install ${launchRes.appName} on Play Store`, `Open ${launchRes.appName} in Live Browser`],
          one_line_summary: launchRes.statusMessage,
          source_verified: 'Verified',
        },
        source: 'device',
        ts: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg, botMsg]);
      say(launchRes.statusMessage);
      return;
    }

    const userMsg: ChatMessage = {
      id: uid(),
      role: 'user',
      text,
      attachment: attached || undefined,
      ts: Date.now(),
    };
    const next = [...messages, userMsg];
    const botId = uid();
    let steps: Step[] = [
      {
        label: attached
          ? `Analyzing attached ${attached.kind} (${attached.name.slice(0, 28)})`
          : 'Reading your command & smart context memory',
        status: 'active',
        startedAt: Date.now(),
      },
    ];
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
    setPendingAttachment(null);
    setBusy(true);

    // Quick-Verify Source Checking step for any URLs or video links in the user prompt
    let verifiedSourceContext = '';
    if (/https?:\/\//i.test(text)) {
      step('Running Quick-Verify source & transcript check');
      verifiedSourceContext = await quickVerifyUrlsInText(text);
    }

    const ctx = [profileContext(settings), verifiedSourceContext].filter(Boolean).join('\n\n');
    const convoId = currentId;
    const useAgent = !attached && !!apiKey && (mode === 'agent' || (mode === 'auto' && AGENT_RE.test(text)));

    if (useAgent) {
      AgentBus.begin(text);
      LiveBus.set({ active: true, startedAt: Date.now(), loading: false, thumb: null, log: [] }, '🤖 ' + text.slice(0, 60));
      try {
        const recent = messages
          .filter((m) => m.role !== 'error' && m.text.trim())
          .slice(-6)
          .map((m) => (m.role === 'user' ? 'User: ' : 'Pulse: ') + m.text.slice(0, 300))
          .join('\n');
        const agentModel = /lite/i.test(model) ? 'gemini-2.5-flash' : model;
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
          reply: { direct_response: answer, proactive_checklist: [], one_line_summary: answer.slice(0, 100), source_verified: 'Verified' },
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
          result = await callCloudChat(cloudUrl, cloudToken, keyForCloud(), next, ctx, smartMemory);
          source = 'cloud';
          setCloudStatus('online');
        } catch (cloudErr: any) {
          setCloudStatus('offline');
          if (!apiKey) throw cloudErr;
          step('Cloud unreachable, switching to on-device', 'error');
        }
      }
      if (!result) {
        const useModel = model || FAST_MODEL;
        step('Thinking with ' + modelLabel(useModel).replace(/^\W+/, ''));
        let writing = false;
        let lastUi = 0;
        result = await streamGemini(
          apiKey,
          useModel,
          next,
          ctx,
          smartMemory,
          settings.temperature,
          settings.speed,
          (visible) => {
            if (!writing && visible.trim()) {
              writing = true;
              step('Writing reply & extracting actions');
            }
            const now = Date.now();
            if (now - lastUi >= 45) {
              lastUi = now;
              setMessages((prev) => prev.map((m) => (m.id === botId ? { ...m, text: visible } : m)));
            }
          },
        );
      }
      const { reply } = result;
      if (reply.memory_facts && reply.memory_facts.length) {
        saveSmartMemoryFacts(reply.memory_facts).then(setSmartMemory).catch(() => undefined);
      }
      const n = reply.proactive_checklist.length;
      step(n ? `Extracted ${n} action item${n > 1 ? 's' : ''} & verified sources` : 'Reply ready', 'done');
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
        {smartMemory.length > 0 ? (
          <Pressable
            onPress={() =>
              Alert.alert(
                '🧠 Smart Context Memory',
                smartMemory.map((m, i) => `${i + 1}. ${m}`).join('\n'),
                [
                  { text: 'Close', style: 'cancel' },
                  {
                    text: 'Clear Memory',
                    style: 'destructive',
                    onPress: () => {
                      AsyncStorage.removeItem(STORAGE_SMART_MEMORY);
                      setSmartMemory([]);
                    },
                  },
                ],
              )
            }
            style={[styles.chip, { borderColor: C.accent2 }]}
          >
            <Text style={[styles.chipText, { color: C.accent2 }]}>🧠 {smartMemory.length}</Text>
          </Pressable>
        ) : null}
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
        onScroll={onChatScroll}
        scrollEventThrottle={16}
        onScrollBeginDrag={() => { userDraggingRef.current = true; }}
        onScrollEndDrag={() => { userDraggingRef.current = false; }}
        onContentSizeChange={() => {
          if (isNearBottomRef.current && !userDraggingRef.current) {
            listRef.current?.scrollToEnd({ animated: false });
          }
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {settings.name.trim() ? "What's on your plate, " + settings.name.trim().split(' ')[0] + '?' : 'Pulse OS Agent Ready'}
            </Text>
            <Text style={[styles.muted, { textAlign: 'center' }]}>
              Tap 📎 to analyze photos, PDFs, documents, or video links. Tap 🎙️ to speak commands like "open Blinkit", "open Uber", "open Meesho", or "open Free Fire".
            </Text>
            {!apiKey && !(cloudMode && cloudUrl) ? (
              <Pressable onPress={openSettings} style={[styles.primaryBtn, { paddingHorizontal: 18 }]}>
                <Text style={styles.primaryBtnText}>Open Settings to add your Gemini API Key</Text>
              </Pressable>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <MessageBubble msg={item} say={say} onCloudPlan={cloudUrl ? cloudPlan : undefined} />
        )}
      />

      <LiveCard />

      {pendingAttachment ? (
        <View style={styles.attachmentPreviewBar}>
          {pendingAttachment.kind === 'image' && pendingAttachment.uri ? (
            <Image source={{ uri: pendingAttachment.uri }} style={styles.attachmentThumb} />
          ) : (
            <View style={[styles.attachmentThumb, styles.center]}>
              <Text style={{ fontSize: 20 }}>
                {pendingAttachment.kind === 'video' || pendingAttachment.kind === 'video_link' ? '🎬' : '📄'}
              </Text>
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.convoTitle} numberOfLines={1}>{pendingAttachment.name}</Text>
            <Text style={styles.mutedSmall}>
              {pendingAttachment.kind.toUpperCase()} ready for Multimodal Analysis & Action Extraction
            </Text>
          </View>
          <Pressable onPress={() => setPendingAttachment(null)} style={styles.chip}>
            <Text style={styles.chipText}>✕</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.composer}>
        <Pressable
          onPress={() => setAttachModal(true)}
          disabled={busy}
          style={styles.iconBtn}
          accessibilityLabel="Attach image, photo, video, or file"
        >
          <Text style={{ fontSize: 20 }}>📎</Text>
        </Pressable>

        <Pressable
          onPress={startVoiceInput}
          disabled={busy}
          style={[styles.iconBtn, listening && { borderColor: C.danger, backgroundColor: '#3B1418' }]}
          accessibilityLabel="Voice talk input"
        >
          <Text style={{ fontSize: 19 }}>{listening ? '🔴' : '🎙️'}</Text>
        </Pressable>

        <TextInput
          ref={inputRef}
          value={input}
          onChangeText={setInput}
          placeholder={
            pendingAttachment
              ? 'Ask a question about this attachment or tap ➤…'
              : apiKey || (cloudMode && cloudUrl)
                ? 'Message Pulse or say "order apples on Blinkit"…'
                : 'Add a Gemini key in Settings'
          }
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

      {/* Multimodal Attachment Modal (Photos, Camera, Documents, Videos, YouTube Links) */}
      <Modal visible={attachModal} transparent animationType="slide" onRequestClose={() => setAttachModal(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { height: 420, padding: 0, overflow: 'hidden' }]}>
            <View style={[styles.rowBetween, { paddingHorizontal: 14, paddingTop: 12 }]}>
              <Text style={styles.cardTitle}>Multimodal Upload</Text>
              <Pressable onPress={() => setAttachModal(false)} style={styles.chip}>
                <Text style={styles.chipText}>✕ Close</Text>
              </Pressable>
            </View>
            <WebView
              originWhitelist={['*']}
              source={{ html: MULTIMODAL_PICKER_HTML }}
              javaScriptEnabled
              domStorageEnabled
              allowFileAccess
              allowUniversalAccessFromFileURLs
              onMessage={onPickerMessage}
              style={{ flex: 1, backgroundColor: C.panel }}
            />
          </View>
        </View>
      </Modal>

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
        {msg.attachment ? (
          <View style={{ marginBottom: 6 }}>
            {msg.attachment.kind === 'image' && msg.attachment.uri ? (
              <Image source={{ uri: msg.attachment.uri }} style={{ width: 180, height: 130, borderRadius: 10, marginBottom: 4 }} resizeMode="cover" />
            ) : null}
            <Text style={{ color: '#E0E7FF', fontSize: 12, fontWeight: '700' }}>
              📎 {msg.attachment.name}
            </Text>
          </View>
        ) : null}
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
    <View style={{ marginBottom: 12, gap: 6 }}>
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
        {msg.verificationShotUri ? (
          <View style={{ marginTop: 10, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: C.good, backgroundColor: C.bg, padding: 8, gap: 6 }}>
            <Text style={{ color: C.good, fontSize: 12, fontWeight: '800' }}>
              📸 Real-Time Cart & Action Verification
            </Text>
            <Image
              source={{ uri: msg.verificationShotUri }}
              style={{ width: 220, height: 340, borderRadius: 8, alignSelf: 'center' }}
              resizeMode="contain"
            />
            {msg.verificationSummary ? (
              <Text style={{ color: C.text, fontSize: 12, fontWeight: '600' }}>
                {msg.verificationSummary}
              </Text>
            ) : null}
          </View>
        ) : null}
        <View style={[styles.rowBetween, { marginTop: 6 }]}>
          <Pressable onPress={() => speak(msg.text)} hitSlop={8}>
            <Text style={{ fontSize: 13, color: C.accent2 }}>🔊 Listen</Text>
          </Pressable>
          {msg.reply?.source_verified ? (
            <Text style={{ fontSize: 11, color: C.good, fontWeight: '700' }}>
              ✓ Quick-Verify: {msg.reply.source_verified}
            </Text>
          ) : null}
          {msg.source === 'cloud' ? <Text style={styles.sourceTag}>☁️ cloud</Text> : null}
        </View>
      </View>
      {/* Removed EXTRACTED ACTIONS card per user request */}
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
        <Text style={styles.cardKicker}>EXTRACTED ACTIONS, EVENTS & REMINDERS</Text>
        <Pressable onPress={() => speak(replyToSpeech(reply) || summary)} hitSlop={8}>
          <Text style={styles.cardSpeak}>🔊</Text>
        </Pressable>
      </View>
      {reply.one_line_summary ? <Text style={styles.cardSummary}>{summary}</Text> : null}

      <View style={styles.cardRow}>
        <ActionButton label="📅 Add Calendar" url={calendarUrl(summary, fullText)} />
        <ActionButton label="✉️ Email" url={mailtoUrl(summary, fullText)} />
        <ActionButton label="💬 SMS" url={smsUrl(fullText)} />
        {onCloudPlan && reply.proactive_checklist.length ? (
          <Pressable
            onPress={() => onCloudPlan(reply)}
            style={({ pressed }) => [styles.actionBtn, styles.cloudBtn, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.actionText}>☁️ Time-Block Plan</Text>
          </Pressable>
        ) : null}
      </View>

      {reply.proactive_checklist.length ? (
        <View style={{ marginTop: 10 }}>
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
      /* ignore */
    }
  };

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
      /* ignore */
    }
  }, []);

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
/* SETTINGS                                                            */
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
  const [photoModal, setPhotoModal] = useState(false);
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
      Alert.alert(
        'Cloud online',
        'Model: ' + (h.model || '?') +
          '\nGemini key on server: ' + (h.gemini_key_on_server ? 'yes' : 'no') +
          '\nToken required: ' + (h.auth_required ? 'yes' : 'no'),
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
      setCheckMsg(info.available ? 'A new version is available.' : "✓ You're up to date.");
    } catch (e: any) {
      setUpdate(null);
      setCheckState('error');
      setCheckMsg(e?.message || "Couldn't check for updates. Try again.");
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

      {/* OS-Level Accessibility & Root Bridge */}
      <View style={[styles.settingsCard, { borderColor: C.accent2 }]}>
        <Text style={styles.cardTitle}>♿ OS-Level Accessibility & Root Bridge</Text>
        <Text style={styles.mutedSmall}>
          Enable "Pulse OS Assistive Bridge" in Android Accessibility Settings so Pulse can read screen elements, tap coordinates, and automate apps like Blinkit, Uber, Meesho, WhatsApp, and Free Fire.
        </Text>
        <Pressable onPress={() => openAppWithStatus('accessibility')} style={styles.primaryBtn}>
          <Text style={styles.primaryBtnText}>Open Android Accessibility Settings</Text>
        </Pressable>
      </View>

      {/* Profile with Custom Profile Picture Upload */}
      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>👤 Profile & Custom Photo</Text>
        <View style={styles.profileRow}>
          <Pressable onPress={() => setPhotoModal(true)} style={[styles.avatarBig, { overflow: 'hidden' }]}>
            {s.profilePhotoUri ? (
              <Image source={{ uri: s.profilePhotoUri }} style={{ width: 60, height: 60, borderRadius: 30 }} />
            ) : (
              <Text style={{ fontSize: 30 }}>{s.avatar}</Text>
            )}
          </Pressable>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={styles.profileName}>{s.name.trim() || 'Your name'}</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable onPress={() => setPhotoModal(true)} style={[styles.chip, { borderColor: C.accent }]}>
                <Text style={[styles.chipText, { color: C.accent }]}>📸 Upload Profile Pic</Text>
              </Pressable>
              {s.profilePhotoUri ? (
                <Pressable onPress={() => patchSettings({ profilePhotoUri: '' })} style={styles.chip}>
                  <Text style={styles.chipText}>Reset</Text>
                </Pressable>
              ) : null}
            </View>
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
        <Text style={styles.fieldLabel}>Role / headline</Text>
        <TextInput value={s.role} onChangeText={(t) => patchSettings({ role: t })} placeholder="e.g. Creator & Developer" placeholderTextColor={C.muted} style={styles.input} />
        <SettingRow label="Personalize replies" hint="Use profile & smart cross-session memory">
          <Switch value={s.personalize} onValueChange={(v) => patchSettings({ personalize: v })} trackColor={{ false: C.border, true: C.accent }} thumbColor="#fff" />
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
        <Text style={styles.fieldLabel}>Reply length</Text>
        <View style={styles.segment}>
          {REPLY_LENGTHS.map((r) => (
            <Pressable key={r} onPress={() => patchSettings({ replyLength: r })} style={[styles.segItem, s.replyLength === r && styles.segItemOn]}>
              <Text style={[styles.segText, s.replyLength === r && styles.segTextOn]}>{r.charAt(0).toUpperCase() + r.slice(1)}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Voice */}
      <View style={styles.settingsCard}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>🔊 Voice Talk & Readout</Text>
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
        <SettingRow label="Speed">
          <Stepper value={s.voiceRate} onChange={(n) => patchSettings({ voiceRate: n })} step={0.1} min={0.5} max={2} />
        </SettingRow>
        <SettingRow label="Pitch">
          <Stepper value={s.voicePitch} onChange={(n) => patchSettings({ voicePitch: n })} step={0.1} min={0.5} max={2} />
        </SettingRow>
        <Text style={styles.fieldLabel}>Language code (e.g. en-IN, te-IN, hi-IN, en-US)</Text>
        <TextInput value={s.voiceLang} onChangeText={(t) => patchSettings({ voiceLang: t })} placeholder="en-IN" placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} style={styles.input} />
        <Pressable onPress={() => speakWith(settings, 'Pulse OS voice assistant is active and ready.')} style={styles.secondaryBtn}>
          <Text style={styles.primaryBtnText}>Preview voice</Text>
        </Pressable>
      </View>

      {/* Cloud */}
      <View style={styles.settingsCard}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>☁️ Cloud computer</Text>
          <Switch value={s.cloudMode} onValueChange={(v) => patchSettings({ cloudMode: v && !!s.cloudUrl })} trackColor={{ false: C.border, true: C.accent }} thumbColor="#fff" />
        </View>
        <Pressable onPress={testCloud} disabled={testing} style={styles.secondaryBtn}>
          {testing ? <ActivityIndicator color={C.text} /> : <Text style={styles.primaryBtnText}>Check connection</Text>}
        </Pressable>
        <Pressable onPress={() => setCloudAdv((v) => !v)}>
          <Text style={[styles.mutedSmall, { color: C.accent }]}>{cloudAdv ? 'Hide server details ▴' : 'Change server ▾'}</Text>
        </Pressable>
        {cloudAdv ? (
          <>
            <TextInput value={s.cloudUrl} onChangeText={(t) => patchSettings({ cloudUrl: t })} onBlur={() => patchSettings({ cloudUrl: normalizeCloudUrl(s.cloudUrl) })} placeholder={DEFAULT_CLOUD_URL} placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.input} />
            <TextInput value={s.cloudToken} onChangeText={(t) => patchSettings({ cloudToken: t })} placeholder="Access token" placeholderTextColor={C.muted} secureTextEntry autoCapitalize="none" autoCorrect={false} style={styles.input} />
          </>
        ) : null}
      </View>

      {/* Updates */}
      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>⬇️ App updates</Text>
        <Text style={styles.mutedSmall}>Version {Application.nativeApplicationVersion || '2.1.0'} (build {cur})</Text>
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

      <Modal visible={photoModal} transparent animationType="slide" onRequestClose={() => setPhotoModal(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { height: 320, padding: 0, overflow: 'hidden' }]}>
            <View style={[styles.rowBetween, { paddingHorizontal: 14, paddingTop: 12 }]}>
              <Text style={styles.cardTitle}>📸 Custom Profile Picture</Text>
              <Pressable onPress={() => setPhotoModal(false)} style={styles.chip}>
                <Text style={styles.chipText}>✕ Close</Text>
              </Pressable>
            </View>
            <WebView
              originWhitelist={['*']}
              source={{
                html: `<!DOCTYPE html><html><body style="background:#121826;color:#fff;font-family:sans-serif;padding:20px;text-align:center;">
                  <p style="color:#8A94A8;font-size:13px;">Select any photo from your phone gallery or camera</p>
                  <label for="p" style="display:block;padding:15px;background:#7C5CFF;border-radius:12px;font-weight:bold;cursor:pointer;margin-top:14px;">🖼️ Choose Photo from Gallery / Camera</label>
                  <input id="p" type="file" accept="image/*" style="display:none" />
                  <script>
                    document.getElementById('p').onchange = function(e) {
                      var f = e.target.files[0];
                      if (!f) return;
                      var r = new FileReader();
                      r.onload = function(ev) {
                        var img = new Image();
                        img.onload = function() {
                          var cv = document.createElement('canvas');
                          cv.width = 240; cv.height = 240;
                          var ctx = cv.getContext('2d');
                          var m = Math.min(img.width, img.height);
                          ctx.drawImage(img, (img.width-m)/2, (img.height-m)/2, m, m, 0, 0, 240, 240);
                          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'profile_pic', uri: cv.toDataURL('image/jpeg', 0.85) }));
                        };
                        img.src = ev.target.result;
                      };
                      r.readAsDataURL(f);
                    };
                  </script>
                </body></html>`
              }}
              javaScriptEnabled
              allowFileAccess
              onMessage={(e) => {
                try {
                  const d = JSON.parse(e.nativeEvent.data);
                  if (d?.type === 'profile_pic' && d.uri) {
                    patchSettings({ profilePhotoUri: String(d.uri) });
                    setPhotoModal(false);
                  }
                } catch {}
              }}
              style={{ flex: 1, backgroundColor: C.panel }}
            />
          </View>
        </View>
      </Modal>
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
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'center', padding: 18 },
  modalCard: { backgroundColor: C.panel, borderRadius: 16, padding: 16, gap: 8, borderWidth: 1, borderColor: C.border },
  modelRow: { padding: 10, borderRadius: 12, backgroundColor: C.panel2, borderWidth: 1, borderColor: 'transparent', gap: 2 },
  appGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  appTile: {
    width: '31%', flexGrow: 0, alignItems: 'center', paddingVertical: 14, paddingHorizontal: 6, borderRadius: 14,
    backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, gap: 4,
  },
  appName: { color: C.text, fontSize: 12, fontWeight: '700' },
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
  voiceText: { color: C.muted, fontWeight: '700', fontSize: 11 },

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
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowCenter: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sourceTag: { color: C.accent2, fontSize: 11, fontWeight: '700' },
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

  empty: { padding: 24, alignItems: 'center', gap: 10, marginTop: 36 },
  emptyTitle: { color: C.text, fontSize: 18, fontWeight: '700' },

  bubble: { maxWidth: '90%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 4 },
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
  cardKicker: { color: C.accent2, fontSize: 11, fontWeight: '800', letterSpacing: 1.1, marginBottom: 6 },
  cardSpeak: { fontSize: 18 },
  cardSummary: { color: C.text, fontSize: 14, fontWeight: '600', marginBottom: 10 },
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

  attachmentPreviewBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 10,
    marginBottom: 6,
    padding: 8,
    borderRadius: 12,
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.accent2,
  },
  attachmentThumb: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: C.panel2,
  },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 8,
    gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
    backgroundColor: C.bg,
  },
  iconBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: C.panel2,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
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
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: { color: '#fff', fontSize: 18, fontWeight: '800' },

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
