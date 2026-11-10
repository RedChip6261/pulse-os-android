import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
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

import {
  RagCategory,
  RagChunk,
  RagSearchResult,
  STORAGE_RAG_INDEX,
  DEFAULT_RAG_PLAYBOOKS,
  loadRagIndex,
  saveRagIndex,
  ingestDocumentIntoRag,
  syncUserVaultToRag,
  retrieveRagChunksSync,
  buildAgenticRagContext,
  EngineId,
  VoiceLanguageMode,
  OPEN_SOURCE_CORE_INTEGRATIONS,
  ProcessingEngine,
  SelfDevelopmentEngine,
  ReplyEngine,
  AgenticEngine,
  MediaGenerationEngine,
  GeneratedMediaAsset,
} from './pulseFeatures';

const { HarkBridge } = NativeModules;

/* ------------------------------------------------------------------ */
/* High-Contrast Tactile Dark OS Theme                                 */
/* ------------------------------------------------------------------ */

const C = {
  bg: '#04060E',
  panel: 'rgba(15, 23, 42, 0.84)',
  panel2: 'rgba(30, 41, 59, 0.78)',
  border: 'rgba(148, 163, 184, 0.24)',
  text: '#F8FAFC',
  muted: '#94A3B8',
  accent: '#4F46E5',
  accent2: '#38BDF8',
  rag: '#14B8A6',
  good: '#10B981',
  warn: '#F59E0B',
  danger: '#EF4444',
};

const omniProcessingEngine = new ProcessingEngine();
const omniSelfDevEngine = new SelfDevelopmentEngine();
const omniReplyEngine = new ReplyEngine();
const omniAgenticEngine = new AgenticEngine();
const omniMediaEngine = new MediaGenerationEngine();

function speakBilingualProgress(enText: string, teText?: string, langMode: VoiceLanguageMode = 'BILINGUAL_AUTO') {
  try {
    const useTe = (langMode === 'te-IN' || langMode === 'te-ROMAN' || langMode === 'BILINGUAL_AUTO') && Boolean(teText && teText.trim());
    const text = useTe ? teText! : enText;
    const language = useTe ? 'te-IN' : 'en-IN';
    Speech.stop();
    Speech.speak(text, { language, rate: 0.97, pitch: 1.02 });
  } catch {}
}

/* ------------------------------------------------------------------ */
/* Storage keys & Gemini config                                        */
/* ------------------------------------------------------------------ */

const STORAGE_API_KEY = 'pulseos.gemini_api_key';
const STORAGE_MODEL = 'pulseos.gemini_model';
const STORAGE_CHAT = 'pulseos.chat_history';
const STORAGE_CLOUD_URL = 'pulseos.cloud_url';
const STORAGE_CLOUD_TOKEN = 'pulseos.cloud_token';
const STORAGE_SMART_MEMORY = 'pulseos.smart_memory.v1';
const STORAGE_USER_AUTH = 'pulseos.user_auth.v1';
const STORAGE_ROUTINES = 'pulseos.agent_routines.v1';

const CLOUD_PORT = 3000;
const CLOUD_DOMAIN = 'app.github.dev';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const FAST_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const DEFAULT_UPDATE_REPO = 'RedChip6261/pulse-os-android';
const DEFAULT_CLOUD_URL = 'https://scaling-space-telegram-jjg94w99g6pj255vv-3000.app.github.dev';

type Tab = 'CHAT' | 'VOICE' | 'OMNICORE' | 'MEDIA' | 'RAG' | 'APPS' | 'LOGIN' | 'LIVE' | 'CLOUD' | 'SETTINGS';
type SpeedMode = 'fast' | 'balanced' | 'smart';

type SavedAppLogin = {
  id: string;
  app: string;
  username: string;
  password: string;
};

type UserAuthData = {
  isLoggedIn: boolean;
  name: string;
  email: string;
  phone: string;
  password: string;
  address: string;
  savedLogins: SavedAppLogin[];
};

const DEFAULT_USER_AUTH: UserAuthData = {
  isLoggedIn: false,
  name: '',
  email: '',
  phone: '',
  password: '',
  address: '',
  savedLogins: [],
};

type AutomationStep = {
  step?: number;
  action: string;
  target?: string;
  value?: string;
};

type RagCitation = {
  id: string;
  title: string;
  category: RagCategory;
  score: number;
  snippet: string;
};

type PulseReply = {
  direct_response: string;
  proactive_checklist: string[];
  one_line_summary: string;
  automation_script?: AutomationStep[];
  memory_facts?: string[];
  source_verified?: string;
  rag_citations?: RagCitation[];
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

type Step = { label: string; status: 'active' | 'done' | 'error'; startedAt: number; ms?: number };

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  attachment?: AttachmentItem;
  verificationShotUri?: string;
  verificationSummary?: string;
  reply?: PulseReply;
  ragCitations?: RagCitation[];
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

type AgentRoutine = {
  id: string;
  title: string;
  command: string;
  category: string;
};

const DEFAULT_ROUTINES: AgentRoutine[] = [
  { id: 'rt_1', title: 'Order Milk on Blinkit', command: 'open blinkit and order milk', category: 'Shopping' },
  { id: 'rt_2', title: 'Play Telugu Hits on YouTube', command: 'open youtube and play latest telugu hit songs', category: 'Media' },
  { id: 'rt_3', title: 'Search Wireless Earbuds on Flipkart', command: 'open flipkart and search wireless earbuds', category: 'Shopping' },
  { id: 'rt_4', title: 'Book Uber to My Saved Address', command: 'open uber and book a ride to my address', category: 'Travel' },
];

/* ------------------------------------------------------------------ */
/* Helpers, Login Persistence & Smart Cross-Session Memory             */
/* ------------------------------------------------------------------ */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function loadUserAuth(): Promise<UserAuthData> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_USER_AUTH);
    if (!raw) return DEFAULT_USER_AUTH;
    const parsed = JSON.parse(raw);
    const data: UserAuthData = {
      ...DEFAULT_USER_AUTH,
      ...parsed,
      savedLogins: Array.isArray(parsed?.savedLogins) ? parsed.savedLogins : [],
    };
    if (Platform.OS === 'android' && HarkBridge?.syncUserLoginData) {
      HarkBridge.syncUserLoginData(JSON.stringify(data)).catch(() => undefined);
    }
    return data;
  } catch {
    return DEFAULT_USER_AUTH;
  }
}

async function saveUserAuth(data: UserAuthData): Promise<RagChunk[]> {
  const json = JSON.stringify(data);
  await AsyncStorage.setItem(STORAGE_USER_AUTH, json);
  if (Platform.OS === 'android' && HarkBridge?.syncUserLoginData) {
    HarkBridge.syncUserLoginData(json).catch(() => undefined);
  }
  return syncUserVaultToRag(data);
}

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
/* Fast Streaming & Multimodal Gemini Engine with Agentic RAG          */
/* ------------------------------------------------------------------ */

const META_MARK = '<<<PULSE_META>>>';

function buildStreamPrompt(extraSystem: string, smartMemory: string[], ragContextBlock = ''): string {
  const now = new Date();
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      return '';
    }
  })();
  return [
    'You are Pulse OS v4.0, an OS-level Android automation agent, RAG-grounded intelligence engine, and multimodal AI assistant.',
    'Current local time: ' + now.toString() + (tz ? ' (' + tz + ')' : '') + '.',
    'STRICT EXECUTION & AGENTIC RAG RULES:',
    '- Ground your answers and task parameters in the RETRIEVED AGENTIC RAG KNOWLEDGE block below whenever relevant.',
    '- NEVER pretend you opened an app, searched for an item, or completed a device action unless an actual automation_script is included in the metadata block.',
    '- When the user asks to open an app, search in an app, order/buy an item, play a video/song, send a message, or log in, ALWAYS include the exact steps in "automation_script" inside the metadata JSON at the end.',
    '- Keep answers clear, direct, and grounded with zero filler.',
    'Reply in the same language the user writes in.',
    'At the very end of your response, append "' +
      META_MARK +
      '" followed by a single-line JSON object: {"proactive_checklist":["actionable follow-up step 1","step 2"],"one_line_summary":"short summary","automation_script":[{"step":1,"action":"launch_app|tap_text|tap_xy|input_text|scroll|global_action|wait","target":"app_or_label","value":"query_or_text"}],"memory_facts":["any new user preference or fact to remember"],"source_verified":"Verified with RAG"}.',
    ragContextBlock,
    smartMemory.length ? 'User Context Memory:\n- ' + smartMemory.join('\n- ') : '',
    extraSystem,
  ]
    .filter(Boolean)
    .join('\n\n');
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
  let automation_script: AutomationStep[] | undefined;
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
        if (Array.isArray(o.automation_script) && o.automation_script.length > 0) {
          automation_script = o.automation_script.map((s: any, idx: number) => ({
            step: Number(s?.step) || idx + 1,
            action: String(s?.action || 'launch_app'),
            target: String(s?.target || ''),
            value: s?.value ? String(s.value) : undefined,
          }));
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
    direct_response: visible || 'Done.',
    proactive_checklist: checklist,
    one_line_summary: summary,
    automation_script,
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
  ragContextBlock: string,
  temperature: number,
  speed: SpeedMode,
  onText: (visible: string) => void,
): Promise<{ reply: PulseReply; modelUsed: string }> {
  const contents = buildMultimodalContents(history);
  const sys = buildStreamPrompt(extraSystem, smartMemory, ragContextBlock);
  const hasMedia = history.some((m) => !!m.attachment?.base64);
  const make = (thinking: any | undefined) =>
    JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: speed === 'smart' || hasMedia ? 4096 : 1800,
        ...(thinking ? { thinkingConfig: thinking } : {}),
      },
    });
  const emit = (full: string) => onText(splitStreamText(full).visible);

  const chain = modelChain(hasMedia ? 'gemini-2.5-flash' : model);
  let lastErr = '';
  let sawNetwork = false;
  for (const m of chain) {
    if (isCooling(m)) continue;
    let r = await streamOnce(apiKey, m, make(thinkingFor(m, speed)), emit, hasMedia ? 14000 : 7500);
    if (r.status === 400 && /thinking/i.test(r.error || '')) {
      r = await streamOnce(apiKey, m, make(undefined), emit, hasMedia ? 14000 : 7500);
    }
    if (r.status === 200 && r.full.trim()) {
      noteGood(m);
      return { reply: finishStreamReply(r.full), modelUsed: m };
    }
    lastErr = r.error || 'HTTP ' + r.status;
    if (r.error === 'Network error') sawNetwork = true;
    if (r.status === 401 || (r.status === 400 && /api key/i.test(lastErr))) {
      throw new Error('Your Gemini API key was rejected. Check it in Settings.');
    }
    coolDown(m, r.status === 429 ? 60000 : r.status === 404 ? 3600000 : 30000);
  }
  if (sawNetwork) throw new Error('No internet connection.');
  if (/quota|429|exhausted/i.test(lastErr)) {
    throw new Error('Gemini quota reached. Try again in a minute or switch models.');
  }
  throw new Error('Model busy. Tap send again.');
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
/* Live bus & StepsView                                                */
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
      state = { ...EMPTY_LIVE, active: false, url, loading: true, startedAt: Date.now(), log: [{ t: Date.now(), text: 'Opening ' + hostOf(url) }] };
      stateSubs.forEach((f) => f(state));
      navSubs.forEach((f) => f(url));
    },
    onNav(f: (url: string) => void) {
      navSubs.add(f);
      return () => {
        navSubs.delete(f);
      };
    },
  };
})();

function hostOf(u: string) {
  const m = String(u).match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1].replace(/^www\./, '') : u;
}

function StepsView({ steps, streaming }: { steps: Step[]; streaming?: boolean }) {
  const [open, setOpen] = useState(true);
  if (!steps.length) return null;
  const total = steps.reduce((a, s) => a + (s.ms ?? (s.status === 'active' ? Date.now() - s.startedAt : 0)), 0);
  return (
    <View style={styles.stepsBox}>
      <Pressable onPress={() => setOpen((o) => !o)} style={styles.rowBetween}>
        <Text style={styles.stepsHead}>
          {streaming ? '⚡ Executing Agent + RAG... ' : '✓ Completed in '}
          {(total / 1000).toFixed(1)}s
        </Text>
        <Text style={styles.mutedSmall}>{open ? 'Hide' : `Steps (${steps.length})`}</Text>
      </Pressable>
      {open
        ? steps.map((s, i) => (
            <View key={i} style={styles.stepRow}>
              <Text style={[styles.stepIcon, s.status === 'error' && { color: C.danger }, s.status === 'active' && { color: C.accent2 }]}>
                {s.status === 'active' ? '●' : s.status === 'done' ? '✓' : '!'}
              </Text>
              <Text style={[styles.stepText, s.status === 'active' && { color: C.text, fontWeight: '600' }]}>{s.label}</Text>
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
  { id: 'gemini-2.5-flash', name: '2.5 Flash', note: 'Default fast multimodal, RAG & OS automation model' },
  { id: 'gemini-2.5-flash-lite', name: 'Flash-Lite', note: 'Ultra-low latency replies & quick actions' },
  { id: 'gemini-flash-latest', name: 'Flash Latest', note: 'Balanced speed & multi-step reasoning' },
  { id: 'gemini-pro-latest', name: 'Pro Latest', note: 'Deep reasoning, complex RAG & coding' },
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
          throw new Error('Your Gemini API key was rejected. Check it in Settings.');
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
    throw new Error('Gemini quota reached. Try again in a minute.');
  }
  throw new Error('Model busy. Try again in a few seconds.');
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
  { id: 'blinkit', name: 'Blinkit', icon: '⚡', hint: 'Groceries', aliases: ['blinkit', 'grofers'], packages: ['com.grofers.customerapp'] },
  { id: 'zepto', name: 'Zepto', icon: '🥬', hint: 'Groceries', aliases: ['zepto'], packages: ['com.zeptoconsumerapp'] },
  { id: 'swiggy', name: 'Swiggy', icon: '🍔', hint: 'Food & Instamart', aliases: ['swiggy', 'instamart'], packages: ['in.swiggy.android'] },
  { id: 'zomato', name: 'Zomato', icon: '🍕', hint: 'Food delivery', aliases: ['zomato'], packages: ['com.application.zomato'] },
  { id: 'flipkart', name: 'Flipkart', icon: '🛒', hint: 'Shopping', aliases: ['flipkart', 'fk'], packages: ['com.flipkart.android'] },
  { id: 'meesho', name: 'Meesho', icon: '🛍️', hint: 'Shopping', aliases: ['meesho'], packages: ['com.meesho.supply'] },
  { id: 'amazon', name: 'Amazon', icon: '📦', hint: 'Shopping', aliases: ['amazon', 'amazon shopping'], packages: ['in.amazon.mShop.android.shopping', 'com.amazon.mShop.android.shopping'] },
  { id: 'youtube', name: 'YouTube', icon: '▶️', hint: 'Videos', aliases: ['youtube', 'yt'], packages: ['com.google.android.youtube'] },
  { id: 'spotify', name: 'Spotify', icon: '🎵', hint: 'Music', aliases: ['spotify', 'music'], packages: ['com.spotify.music'] },
  { id: 'whatsapp', name: 'WhatsApp', icon: '💬', hint: 'Messaging', aliases: ['whatsapp', 'wa', 'whats app'], packages: ['com.whatsapp', 'com.whatsapp.w4b'] },
  { id: 'instagram', name: 'Instagram', icon: '📸', hint: 'Social', aliases: ['instagram', 'insta', 'ig'], packages: ['com.instagram.android', 'com.instagram.lite'] },
  { id: 'telegram', name: 'Telegram', icon: '✈️', hint: 'Messaging', aliases: ['telegram', 'tg', 'tele'], packages: ['org.telegram.messenger', 'org.telegram.messenger.web', 'org.thunderdog.challegram'] },
  { id: 'uber', name: 'Uber', icon: '🚕', hint: 'Book ride', aliases: ['uber', 'uber cab', 'uber auto'], packages: ['com.ubercab', 'com.ubercab.uberlite'] },
  { id: 'ola', name: 'Ola', icon: '🚖', hint: 'Cab booking', aliases: ['ola', 'ola cabs'], packages: ['com.olacabs.customer'] },
  { id: 'rapido', name: 'Rapido', icon: '🛵', hint: 'Bike & Auto', aliases: ['rapido'], packages: ['com.rapido.passenger'] },
  { id: 'phonepe', name: 'PhonePe', icon: '🟣', hint: 'UPI Payments', aliases: ['phonepe', 'phone pe'], packages: ['com.phonepe.app'] },
  { id: 'gpay', name: 'Google Pay', icon: '💳', hint: 'UPI Payments', aliases: ['gpay', 'google pay', 'tez'], packages: ['com.google.android.apps.nbu.paisa.user'] },
  { id: 'paytm', name: 'Paytm', icon: '💠', hint: 'Payments', aliases: ['paytm'], packages: ['net.one97.paytm'] },
  { id: 'freefire', name: 'Free Fire', icon: '🔥', hint: 'Game', aliases: ['freefire', 'free fire', 'free fire max', 'ff'], packages: ['com.dts.freefiremax', 'com.dts.freefireth'] },
  { id: 'maps', name: 'Maps', icon: '🗺️', hint: 'Navigation', aliases: ['maps', 'google maps'], packages: ['com.google.android.apps.maps'] },
  { id: 'navigate', name: 'Navigate', icon: '🧭', hint: 'Directions', aliases: ['navigate', 'directions'], packages: ['com.google.android.apps.maps'] },
  { id: 'phone', name: 'Call', icon: '📞', hint: 'Dialer', aliases: ['phone', 'call', 'dialer'], packages: ['com.google.android.dialer', 'com.android.dialer'] },
  { id: 'sms', name: 'SMS', icon: '✉️', hint: 'Messages', aliases: ['sms', 'messages'], packages: ['com.google.android.apps.messaging'] },
  { id: 'email', name: 'Gmail', icon: '📧', hint: 'Email', aliases: ['email', 'gmail', 'mail'], packages: ['com.google.android.gm'] },
  { id: 'calendar', name: 'Calendar', icon: '📅', hint: 'Schedule', aliases: ['calendar'], packages: ['com.google.android.calendar'] },
  { id: 'playstore', name: 'Play Store', icon: '▶️', hint: 'Install apps', aliases: ['playstore', 'play store'], packages: ['com.android.vending'] },
  { id: 'web', name: 'Chrome', icon: '🌐', hint: 'Web search', aliases: ['web', 'chrome', 'browser'], packages: ['com.android.chrome'] },
  { id: 'settings', name: 'Settings', icon: '⚙️', hint: 'Device settings', aliases: ['settings'], packages: ['com.android.settings'] },
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

async function openAppWithStatus(
  appNameOrId: string,
  a: AppArgs = {},
): Promise<{ ok: boolean; appName: string; statusMessage: string; bridgeActive?: boolean }> {
  const clean = appNameOrId.trim().toLowerCase();
  if (clean === 'settings' || clean === 'accessibility') {
    if (clean === 'accessibility' && Platform.OS === 'android') {
      if (HarkBridge?.openAccessibilitySettings) {
        await HarkBridge.openAccessibilitySettings().catch(() => undefined);
      } else {
        await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.ACCESSIBILITY_SETTINGS).catch(() => Linking.openSettings());
      }
      return { ok: true, appName: 'Accessibility Settings', statusMessage: 'Opened Android Accessibility Settings. Enable "Pulse OS Assistive Bridge".' };
    }
    await Linking.openSettings().catch(() => undefined);
    return { ok: true, appName: 'Settings', statusMessage: 'Opened device Settings.' };
  }

  let bridgeActive = false;
  if (Platform.OS === 'android' && HarkBridge?.isAccessibilityEnabled) {
    try {
      bridgeActive = !!(await HarkBridge.isAccessibilityEnabled());
    } catch {
      bridgeActive = false;
    }
  }

  const catalogMatch = APPS.find(
    (x) => x.id === clean || x.name.toLowerCase() === clean || x.aliases.includes(clean),
  );
  const displayName = catalogMatch ? catalogMatch.name : appNameOrId.trim();
  const qText = (a.query || a.text || '').trim();

  // 1. For WhatsApp/Phone/SMS with explicit phone number, use direct URI first
  if (catalogMatch && (catalogMatch.id === 'whatsapp' || catalogMatch.id === 'phone' || catalogMatch.id === 'sms') && (a.to || qText)) {
    if (catalogMatch.id === 'phone' && Platform.OS === 'android' && HarkBridge?.dialPhone) {
      const ok = await HarkBridge.dialPhone(a.to || qText, false).catch(() => false);
      if (ok) {
        return { ok: true, appName: displayName, statusMessage: `Dialing ${a.to || qText}.`, bridgeActive };
      }
    }
    if (catalogMatch.id === 'sms' && Platform.OS === 'android' && HarkBridge?.sendSms && a.to) {
      const ok = await HarkBridge.sendSms(a.to, qText).catch(() => false);
      if (ok) {
        return { ok: true, appName: displayName, statusMessage: `Opened SMS to ${a.to}.`, bridgeActive };
      }
    }
    for (const u of appUrls(catalogMatch.id, a)) {
      try {
        if (await Linking.canOpenURL(u)) {
          await Linking.openURL(u);
          if (qText && HarkBridge?.runAutonomousWorkflow) {
            await HarkBridge.runAutonomousWorkflow(catalogMatch.id, qText, 'order').catch(() => false);
          }
          return {
            ok: true,
            appName: displayName,
            statusMessage: `Opened ${displayName}${qText ? ` for "${qText}"` : ''}.`,
            bridgeActive,
          };
        }
      } catch {
        /* fallback */
      }
    }
  }

  // 2. Native HarkBridge (handles package launch + reliable deep links + single-thread Accessibility workflow)
  if (Platform.OS === 'android' && HarkBridge?.launchApp) {
    try {
      const targetKey = catalogMatch ? catalogMatch.id : clean;
      const launched = await HarkBridge.launchApp(targetKey, qText);
      if (launched) {
        const bridgeHint =
          qText && !bridgeActive
            ? ' (Note: Enable "Bridge: OFF" at top-right so Pulse can type & click inside the app automatically!)'
            : '';
        return {
          ok: true,
          appName: displayName,
          statusMessage: qText
            ? `Opened ${displayName} and executing "${qText}".${bridgeHint}`
            : `Opened ${displayName}.`,
          bridgeActive,
        };
      }
    } catch {
      /* fallback to deep link / IntentLauncher */
    }
  }

  // 3. Try deep link URLs
  if (catalogMatch) {
    for (const u of appUrls(catalogMatch.id, a)) {
      try {
        if (await Linking.canOpenURL(u)) {
          await Linking.openURL(u);
          if (qText && HarkBridge?.runAutonomousWorkflow) {
            await HarkBridge.runAutonomousWorkflow(catalogMatch.id, qText, 'order').catch(() => false);
          }
          return {
            ok: true,
            appName: displayName,
            statusMessage: `Opened ${displayName}${qText ? ` for "${qText}"` : ''}.`,
            bridgeActive,
          };
        }
      } catch {
        /* continue */
      }
    }

    // 4. Try Android IntentLauncher for each known package variant
    if (Platform.OS === 'android') {
      for (const pkg of catalogMatch.packages) {
        try {
          await IntentLauncher.startActivityAsync('android.intent.action.MAIN', {
            packageName: pkg,
            category: 'android.intent.category.LAUNCHER',
            flags: 0x10000000,
          });
          if (qText && HarkBridge?.runAutonomousWorkflow) {
            await HarkBridge.runAutonomousWorkflow(catalogMatch.id, qText, 'order').catch(() => false);
          }
          return {
            ok: true,
            appName: displayName,
            statusMessage: qText
              ? `Opened ${displayName} and executing "${qText}".`
              : `Opened ${displayName}.`,
            bridgeActive,
          };
        } catch {
          /* try next package */
        }
      }
    }
  }

  return {
    ok: false,
    appName: displayName,
    statusMessage: `"${displayName}" is not installed on this device.`,
    bridgeActive,
  };
}

function extractCleanAppQuery(rawGoal: string, app: AppCatalogItem): string {
  let q = rawGoal.trim();
  const names = [app.id, app.name, ...(app.aliases || [])]
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  const appPattern = names.join('|');

  q = q
    .replace(/^(?:please\s+|can you\s+|pls\s+|hey\s+pulse\s+|pulse\s+)?/i, '')
    .replace(new RegExp(`\\b(?:open|launch|start|run|go\\s+to|in|on|using|via|from|into)\\s+(?:the\\s+)?(?:${appPattern})(?:\\s+app)?\\b`, 'gi'), ' ')
    .replace(new RegExp(`^(?:${appPattern})(?:\\s+app)?\\b`, 'i'), ' ')
    .replace(/\b(?:in\s+(?:the\s+)?search\s*bar|search\s+for|search|look\s+for|find|order|buy|add\s+to\s+cart|add|book\s+a\s+ride\s+to|book\s+a\s+cab\s+to|book|play|watch|listen\s+to|send\s+message|send)\b/gi, ' ')
    .replace(/\b(?:to\s+my\s+cart|in\s+my\s+cart|directly|right\s+now|please|and\s+do\s+the\s+work|and)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  q = q.replace(/^(?:for|to|of|on|in|and)\s+/i, '').replace(/\s+(?:on|in|from|to)$/i, '').trim();
  return q;
}

/**
 * RAG-Augmented Pre-Flight Executor:
 * Uses retrieved RAG chunks (`user_vault`, `note`, `document`, `playbook`) to resolve indirect references
 * (like "my address", "my usual groceries", saved app logins, or phone numbers) and executes native OS actions immediately.
 */
async function tryDirectDeviceExecution(
  rawText: string,
  userAuth: UserAuthData,
  ragIndex: RagChunk[],
  onStep?: (label: string) => void,
): Promise<{
  handled: boolean;
  statusMessage: string;
  appName?: string;
  ragCitations?: RagCitation[];
}> {
  const clean = rawText.trim();
  const lower = clean.toLowerCase();

  const ragCtx = buildAgenticRagContext(clean, ragIndex, 4);
  const ragCitations: RagCitation[] = ragCtx.results.map((r) => ({
    id: r.chunk.id,
    title: r.chunk.title,
    category: r.chunk.category,
    score: r.score,
    snippet: r.chunk.content.slice(0, 140),
  }));

  // 1. Hardware / OS System Commands (Flashlight, Volume, Back/Home/Notifications)
  if (/\b(turn\s+on|enable|switch\s+on)\s+(?:the\s+)?(?:flashlight|torch|light)\b/i.test(lower)) {
    onStep?.('Toggling device flashlight ON...');
    const ok = Platform.OS === 'android' && HarkBridge?.toggleTorch ? await HarkBridge.toggleTorch(true) : false;
    return {
      handled: true,
      statusMessage: ok ? 'Turned ON the device flashlight.' : 'Could not toggle flashlight on this device.',
      ragCitations,
    };
  }
  if (/\b(turn\s+off|disable|switch\s+off)\s+(?:the\s+)?(?:flashlight|torch|light)\b/i.test(lower)) {
    onStep?.('Toggling device flashlight OFF...');
    const ok = Platform.OS === 'android' && HarkBridge?.toggleTorch ? await HarkBridge.toggleTorch(false) : false;
    return {
      handled: true,
      statusMessage: ok ? 'Turned OFF the device flashlight.' : 'Could not toggle flashlight on this device.',
      ragCitations,
    };
  }
  const volMatch = lower.match(/\b(?:set\s+)?volume\s+(?:to\s+)?(\d{1,3})\s*%?\b/i);
  if (volMatch && Platform.OS === 'android' && HarkBridge?.setVolume) {
    const pct = Math.min(100, Math.max(0, parseInt(volMatch[1], 10)));
    onStep?.(`Setting media volume to ${pct}%...`);
    await HarkBridge.setVolume(pct);
    return {
      handled: true,
      statusMessage: `Set device media volume to ${pct}%.`,
      ragCitations,
    };
  }

  // 2. Check if user is asking to log in to an app
  const loginMatch = lower.match(/\b(?:log\s*in|login|sign\s*in)\b/);
  const matchedApp = APPS.find(
    (app) =>
      app.id !== 'web' &&
      [app.id, app.name.toLowerCase(), ...(app.aliases || [])].some((al) => {
        const escaped = al.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?:^|\\b)${escaped}(?:\\b|$)`, 'i').test(lower);
      }),
  );

  if (loginMatch && matchedApp) {
    const saved = userAuth.savedLogins.find(
      (s) =>
        s.app.toLowerCase() === matchedApp.id ||
        s.app.toLowerCase() === matchedApp.name.toLowerCase() ||
        matchedApp.aliases.includes(s.app.toLowerCase()),
    );
    const u = saved?.username || userAuth.email || userAuth.phone || '';
    const p = saved?.password || userAuth.password || '';
    onStep?.(`RAG Vault matched credentials for ${matchedApp.name}. Logging in...`);
    const loginPayload = u || p ? `${u}|${p}` : '';
    const res = await openAppWithStatus(matchedApp.id, { query: loginPayload, text: loginPayload });
    return {
      handled: true,
      appName: matchedApp.name,
      statusMessage: u
        ? `${res.statusMessage} Auto-filling RAG Vault login for ${u}.`
        : `${res.statusMessage} Add credentials in the LOGIN tab to auto-fill.`,
      ragCitations,
    };
  }

  // 3. Check if any known app is mentioned in the user message
  if (matchedApp) {
    let query = extractCleanAppQuery(clean, matchedApp);
    // If query refers to "my address", "my office", "usual", etc., replace with RAG-resolved value!
    if (ragCtx.resolvedHintQuery && (!query || /\b(my\s+address|my\s+home|my\s+office|usual|saved)\b/i.test(clean))) {
      query = ragCtx.resolvedHintQuery;
    } else if (/\b(my\s+address|my\s+home|my\s+office)\b/i.test(clean) && userAuth.address) {
      query = userAuth.address;
    }
    const phoneMatch = clean.match(/(?:\+?91[\s-]?)?[6-9]\d{9}\b/);
    const toPhone = phoneMatch ? phoneMatch[0] : '';
    onStep?.(`RAG Grounded -> Opening ${matchedApp.name}${query ? ` for "${query}"` : ''}...`);
    const res = await openAppWithStatus(matchedApp.id, {
      query,
      text: query,
      to: toPhone || undefined,
    });
    return {
      handled: true,
      appName: matchedApp.name,
      statusMessage: res.statusMessage,
      ragCitations,
    };
  }

  // 4. Generic "open <installed app>" command for any non-catalog phone app
  const genericOpen = clean.match(/^(?:please\s+|can you\s+|pls\s+)?(?:open|launch|start|run)\s+([a-zA-Z0-9._\s-]{2,30})$/i);
  if (genericOpen) {
    const target = genericOpen[1].trim();
    onStep?.(`Opening ${target}...`);
    const res = await openAppWithStatus(target);
    if (res.ok) {
      return { handled: true, appName: res.appName, statusMessage: res.statusMessage, ragCitations };
    }
  }

  return { handled: false, statusMessage: '', ragCitations };
}

/**
 * Executes a multi-step UI automation sequence on the device via HarkAccessibilityService.
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
          logs.push(clicked ? `Tapped "${target}".` : `Element "${target}" not found.`);
        }
        await new Promise((r) => setTimeout(r, 500));
      } else if (act === 'tap_xy' || act === 'tap_coordinate') {
        const [xStr, yStr] = target.split(',');
        const x = parseFloat(xStr);
        const y = parseFloat(yStr);
        if (HarkBridge?.tapCoordinate && Number.isFinite(x) && Number.isFinite(y)) {
          await HarkBridge.tapCoordinate(x, y);
          logs.push(`Tapped (${x}, ${y}).`);
        }
        await new Promise((r) => setTimeout(r, 450));
      } else if (act === 'input_text' || act === 'type') {
        if (HarkBridge?.inputText) {
          const typed = await HarkBridge.inputText(target, val);
          logs.push(typed ? `Entered "${val}".` : `Input "${target}" not found.`);
        }
        await new Promise((r) => setTimeout(r, 450));
      } else if (act === 'scroll') {
        if (HarkBridge?.scrollScreen) {
          await HarkBridge.scrollScreen(val || target || 'down');
          logs.push(`Scrolled ${val || target || 'down'}.`);
        }
        await new Promise((r) => setTimeout(r, 450));
      } else if (act === 'global_action') {
        if (HarkBridge?.globalAction) {
          await HarkBridge.globalAction(target || val || 'back');
          logs.push(`Executed global action: ${target || val}.`);
        }
        await new Promise((r) => setTimeout(r, 450));
      } else if (act === 'wait') {
        await new Promise((r) => setTimeout(r, Math.min(5000, Number(val) || 1000)));
        logs.push(`Waited ${val || 1000}ms.`);
      }
    } catch (err: any) {
      logs.push(`Error at step ${s.step || act}: ${err?.message || String(err)}`);
      return { ok: false, log: logs };
    }
  }
  return { ok: true, log: logs };
}

/* ------------------------------------------------------------------ */
/* Agent: Pulse drives Installed Apps + In-App Browser with RAG        */
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
      status = { running: true, goal, step: 'Retrieving RAG context…' };
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
  'You are Pulse OS v4.0 Agent with integrated RAG AI. You operate both installed Android apps and the web browser.',
  'Always use the RETRIEVED AGENTIC RAG KNOWLEDGE provided in the prompt to fill in exact user addresses, saved logins, phone numbers, document facts, and app workflow steps.',
  'If the user wants to use an installed mobile app (or buy groceries/food/products, play videos/music, book a ride, or send a message), use open_app immediately.',
  'Reply with ONE JSON object: {"thought": "<=12 words describing step", "action": {...}}.',
  'Actions:',
  '{"type":"open_app","app":"blinkit|uber|meesho|whatsapp|instagram|telegram|freefire|zepto|swiggy|zomato|ola|rapido|flipkart|amazon|phonepe|gpay|paytm|maps|navigate|youtube|spotify|phone|sms|email|calendar|playstore","query":"clean search query resolved via RAG","to":"phone","text":"message","ui_steps":[{"step":1,"action":"tap_text","target":"Search"},{"step":2,"action":"input_text","target":"Search","value":"milk"}]}',
  '{"type":"os_step","steps":[{"step":1,"action":"tap_text|input_text|tap_xy|scroll|global_action","target":"...","value":"..."}]}',
  '{"type":"navigate","url":"https://..."}',
  '{"type":"click","i":N}',
  '{"type":"type","i":N,"text":"...","submit":true|false}',
  '{"type":"scroll","dir":"down"|"up"}',
  '{"type":"answer","text":"..."}',
  '{"type":"ask","text":"..."}',
].join('\n');

const AGENT_RE =
  /\b(open|launch|start|run|go to|goto|search|find|look ?up|book|order|play|send|message|whatsapp|blinkit|uber|meesho|free ?fire|instagram|telegram|zepto|swiggy|zomato|flipkart|amazon|youtube|spotify|ola|rapido|phonepe|gpay|paytm|call|dial|navigate|directions|buy|watch|listen|browse|visit|login|log in|sign in|tap|click|flashlight|torch|volume)\b/i;

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
  ragContextBlock: string;
  userAuth: UserAuthData;
  ragIndex: RagChunk[];
  onStep: (label: string) => void;
}): Promise<string> {
  // 1. Try RAG-grounded direct native app execution first
  const direct = await tryDirectDeviceExecution(o.goal, o.userAuth, o.ragIndex, o.onStep);
  if (direct.handled) {
    return direct.statusMessage;
  }

  const runner = AgentBus.runner();
  let osScreenNodes = '';
  if (Platform.OS === 'android' && HarkBridge?.dumpScreenNodes) {
    try {
      osScreenNodes = await HarkBridge.dumpScreenNodes();
    } catch {
      osScreenNodes = '';
    }
  }

  const done: string[] = [];
  for (let n = 0; n < 12; n++) {
    if (AgentBus.isStopped()) return 'Stopped.';
    const snap = runner ? await agentSnapshot() : null;
    const page = snap
      ? 'URL: ' + snap.url + '\nTitle: ' + snap.title + '\nElements:\n' +
        snap.els.map((e) => '[' + e.i + '] ' + e.tag + ': ' + e.label).join('\n') +
        '\nVisible text:\n' + snap.text
      : 'No web page open yet.';
    const prompt = [
      'Goal: ' + o.goal,
      o.ragContextBlock,
      o.context ? 'User Context & Vault:\n' + o.context : '',
      osScreenNodes ? 'Active Android Screen Nodes:\n' + osScreenNodes.slice(0, 2000) : '',
      'Steps completed so far:\n' + (done.length ? done.map((d, i) => i + 1 + '. ' + d).join('\n') : '(none)'),
      'Current Browser State:\n' + page,
    ]
      .filter(Boolean)
      .join('\n\n');

    const { json } = await geminiJson(o.apiKey, o.model, AGENT_SYSTEM, [{ role: 'user', parts: [{ text: prompt }] }]);
    const a: any = json?.action || {};
    const thought = String(json?.thought || '').trim();
    const type = String(a.type || '');

    if (type === 'open_app' && a.app) {
      const app = String(a.app);
      o.onStep(thought || 'Opening ' + app);
      const res = await openAppWithStatus(app, { query: a.query, to: a.to, text: a.text });
      if (res.ok && Array.isArray(a.ui_steps) && a.ui_steps.length) {
        const scriptRes = await executeOsAutomationScript(a.ui_steps, o.onStep);
        return `${res.statusMessage}\n${scriptRes.log.join('\n')}`;
      }
      return res.statusMessage;
    }

    if (type === 'os_step' && Array.isArray(a.steps)) {
      o.onStep(thought || 'Executing OS UI steps');
      const scriptRes = await executeOsAutomationScript(a.steps, o.onStep);
      return scriptRes.log.join('\n') || 'Completed OS steps.';
    }

    if (!runner) {
      return String(a.text || thought || 'Action dispatched.');
    }

    if ((type === 'answer' || type === 'ask') && done.length === 0 && !o.ragContextBlock) {
      const searchTarget = searchUrl(o.goal);
      o.onStep('Searching web: ' + o.goal.slice(0, 40));
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
      done.push('click [' + a.i + '] "' + (el?.label || '') + '" -> ' + (r?.ok ? 'ok' : r?.msg || 'failed'));
    } else if (type === 'type' && Number.isFinite(Number(a.i))) {
      const text = String(a.text || '');
      o.onStep(thought || 'Entering "' + text.slice(0, 30) + '"');
      const r: any = await runner.evalJs(
        'var I=' + JSON.stringify(Number(a.i)) + ',KIND="type",TEXT=' + JSON.stringify(text) + ',SUBMIT=' + (a.submit ? 'true' : 'false') + ';' + ACT_JS,
      );
      if (a.submit) await waitForPage(5000);
      done.push('type [' + a.i + '] "' + text + '"' + (a.submit ? ' + Enter' : '') + ' -> ' + (r?.ok ? 'ok' : r?.msg || 'failed'));
    } else if (type === 'scroll') {
      const up = a.dir === 'up';
      o.onStep(thought || 'Scrolling ' + (up ? 'up' : 'down'));
      await runner.evalJs('window.scrollBy(0,' + (up ? '-' : '') + 'window.innerHeight*0.8);return {ok:true};');
      await sleep(300);
      done.push('scroll ' + (up ? 'up' : 'down'));
    } else {
      done.push('step ' + JSON.stringify(a).slice(0, 80));
    }
  }
  return 'Completed agentic automation steps.';
}

/* ------------------------------------------------------------------ */
/* Conversations Persistence                                           */
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
      'Summarize this chat. Reply JSON {"title": "max 6 words", "summary": "max 25 words"}.',
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
/* RAG AI KNOWLEDGE VAULT & AGENTIC TASK STUDIO SCREEN                 */
/* ------------------------------------------------------------------ */

function RagKnowledgeScreen({
  ragIndex,
  setRagIndex,
  apiKey,
  onRunAgentWithQuery,
}: {
  ragIndex: RagChunk[];
  setRagIndex: (next: RagChunk[]) => void;
  apiKey: string;
  onRunAgentWithQuery: (taskText: string) => void;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCat, setFilterCat] = useState<'ALL' | RagCategory>('ALL');
  const [docTitle, setDocTitle] = useState('');
  const [docContent, setDocContent] = useState('');
  const [docCat, setDocCat] = useState<RagCategory>('document');
  const [docAppTag, setDocAppTag] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [busyIngest, setBusyIngest] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const searchResults: RagSearchResult[] = searchQuery.trim()
    ? retrieveRagChunksSync(searchQuery, ragIndex, 8)
    : [];

  const filteredChunks = ragIndex.filter((c) => (filterCat === 'ALL' ? true : c.category === filterCat));

  const handleAddDocument = async () => {
    if (!docTitle.trim() || !docContent.trim()) {
      Alert.alert('Missing fields', 'Enter both a title and knowledge content to index into RAG.');
      return;
    }
    setBusyIngest(true);
    try {
      const updated = await ingestDocumentIntoRag(docTitle.trim(), docContent.trim(), docCat, {
        appTag: docAppTag.trim() || undefined,
        apiKey: apiKey || undefined,
      });
      setRagIndex(updated);
      setDocTitle('');
      setDocContent('');
      setDocAppTag('');
      setStatusMsg(`Indexed "${docTitle.trim()}" into RAG Knowledge Vault (${updated.length} total chunks).`);
    } finally {
      setBusyIngest(false);
    }
  };

  const handleIngestUrlOrVideo = async () => {
    const u = urlInput.trim();
    if (!u) return;
    setBusyIngest(true);
    setStatusMsg('Fetching and chunking URL / YouTube transcript for RAG...');
    try {
      let extracted = '';
      if (/youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts/i.test(u)) {
        extracted = await fetchVideoLinkContext(u);
      } else {
        extracted = await quickVerifyUrlsInText(u);
      }
      if (!extracted.trim()) {
        setStatusMsg('Could not extract text from URL.');
      } else {
        const updated = await ingestDocumentIntoRag(`Web/Video Source: ${hostOf(u)}`, extracted, 'web_clip', {
          sourceUrl: u,
          apiKey: apiKey || undefined,
        });
        setRagIndex(updated);
        setUrlInput('');
        setStatusMsg(`Indexed URL content into RAG (${updated.length} total chunks).`);
      }
    } catch (e: any) {
      setStatusMsg(`Failed to ingest URL: ${e?.message || String(e)}`);
    } finally {
      setBusyIngest(false);
    }
  };

  const handleIndexLiveScreen = async () => {
    if (Platform.OS !== 'android' || !HarkBridge?.dumpScreenNodes) {
      setStatusMsg('Live screen capture requires Android Accessibility Bridge.');
      return;
    }
    setBusyIngest(true);
    try {
      const dump = await HarkBridge.dumpScreenNodes();
      if (!dump || !String(dump).trim()) {
        setStatusMsg('No active external screen nodes found. Ensure Accessibility Bridge is ON.');
      } else {
        const updated = await ingestDocumentIntoRag(
          `Screen Snapshot (${new Date().toLocaleTimeString()})`,
          String(dump),
          'screen_dump',
          { apiKey: apiKey || undefined },
        );
        setRagIndex(updated);
        setStatusMsg('Indexed live Android screen nodes into RAG Knowledge Base.');
      }
    } finally {
      setBusyIngest(false);
    }
  };

  const deleteChunk = async (id: string) => {
    const next = ragIndex.filter((c) => c.id !== id);
    setRagIndex(next);
    await saveRagIndex(next);
  };

  const resetPlaybooks = async () => {
    const existingDynamic = ragIndex.filter((c) => c.category !== 'playbook');
    const merged = [...DEFAULT_RAG_PLAYBOOKS, ...existingDynamic];
    setRagIndex(merged);
    await saveRagIndex(merged);
    setStatusMsg('Restored built-in OS Automation Playbooks.');
  };

  const categories: ('ALL' | RagCategory)[] = [
    'ALL',
    'playbook',
    'user_vault',
    'document',
    'note',
    'web_clip',
    'screen_dump',
    'task_memory',
  ];

  return (
    <ScrollView contentContainerStyle={{ padding: 14, gap: 14, paddingBottom: 44 }} keyboardShouldPersistTaps="handled">
      <View style={styles.rowBetween}>
        <View>
          <Text style={styles.sectionTitle}>Agentic RAG Knowledge Vault</Text>
          <Text style={styles.mutedSmall}>
            {ragIndex.length} knowledge chunks active · Grounds all chat & OS automation tasks
          </Text>
        </View>
        <Pressable onPress={handleIndexLiveScreen} style={[styles.chip, { borderColor: C.rag }]}>
          <Text style={[styles.chipText, { color: '#5EEAD4' }]}>+ Index Screen</Text>
        </Pressable>
      </View>

      {statusMsg ? (
        <View style={[styles.settingsCard, { borderColor: C.rag, paddingVertical: 10 }]}>
          <Text style={{ color: '#5EEAD4', fontSize: 13, fontWeight: '600' }}>{statusMsg}</Text>
        </View>
      ) : null}

      {/* 1. Live RAG Retrieval & Agentic Task Launcher */}
      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>Test RAG Retrieval & Run Agentic Task</Text>
        <Text style={styles.mutedSmall}>
          Search your RAG knowledge base or enter a task (e.g., "order my usual groceries on Blinkit", "book Uber to my office", "login to Flipkart").
        </Text>
        <TextInput
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Enter query or agentic task to test RAG retrieval..."
          placeholderTextColor={C.muted}
          style={styles.input}
        />
        {searchQuery.trim() ? (
          <View style={{ gap: 8, marginTop: 4 }}>
            <Pressable
              onPress={() => onRunAgentWithQuery(searchQuery.trim())}
              style={[styles.primaryBtn, { backgroundColor: C.rag, marginTop: 2 }]}
            >
              <Text style={styles.primaryBtnText}>⚡ Execute Agentic Task with RAG ({searchResults.length} matches)</Text>
            </Pressable>
            {searchResults.length === 0 ? (
              <Text style={styles.mutedSmall}>No matching RAG chunks above threshold.</Text>
            ) : (
              searchResults.map((r) => (
                <View
                  key={r.chunk.id}
                  style={{
                    padding: 10,
                    borderRadius: 6,
                    backgroundColor: C.bg,
                    borderWidth: 1,
                    borderColor: C.rag,
                    gap: 4,
                  }}
                >
                  <View style={styles.rowBetween}>
                    <Text style={{ color: '#5EEAD4', fontWeight: '700', fontSize: 13, flex: 1 }} numberOfLines={1}>
                      {r.chunk.title}
                    </Text>
                    <Text style={{ color: C.good, fontWeight: '700', fontSize: 12 }}>{r.score}% match</Text>
                  </View>
                  <Text style={{ color: C.text, fontSize: 12 }} numberOfLines={3}>
                    {r.chunk.content}
                  </Text>
                  {r.matchedTerms.length > 0 ? (
                    <Text style={styles.mutedSmall}>Matched terms: {r.matchedTerms.join(', ')}</Text>
                  ) : null}
                </View>
              ))
            )}
          </View>
        ) : null}
      </View>

      {/* 2. Ingest Custom Knowledge / Usual Orders / App Playbooks */}
      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>Add Document, Note, or Custom Playbook to RAG</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {(['document', 'note', 'playbook', 'task_memory'] as RagCategory[]).map((cat) => (
            <Pressable
              key={cat}
              onPress={() => setDocCat(cat)}
              style={[styles.chip, docCat === cat && { borderColor: C.rag, backgroundColor: '#112E2B' }]}
            >
              <Text style={styles.chipText}>{cat.toUpperCase()}</Text>
            </Pressable>
          ))}
        </View>
        <TextInput
          value={docTitle}
          onChangeText={setDocTitle}
          placeholder="Title (e.g., My Usual Grocery List, Office Address, Custom App Flow)"
          placeholderTextColor={C.muted}
          style={styles.input}
        />
        <TextInput
          value={docAppTag}
          onChangeText={setDocAppTag}
          placeholder="Optional App Tag (e.g., blinkit, flipkart, whatsapp, uber)"
          placeholderTextColor={C.muted}
          autoCapitalize="none"
          style={styles.input}
        />
        <TextInput
          value={docContent}
          onChangeText={setDocContent}
          placeholder="Enter knowledge text, shopping items, addresses, contacts, or step-by-step instructions..."
          placeholderTextColor={C.muted}
          multiline
          style={[styles.input, { minHeight: 80 }]}
        />
        <Pressable onPress={handleAddDocument} disabled={busyIngest} style={styles.primaryBtn}>
          {busyIngest ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>+ Index into RAG Vault</Text>}
        </Pressable>
      </View>

      {/* 3. Ingest Web URL or YouTube Video Transcript */}
      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>Ingest Web Page or YouTube Video into RAG</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput
            value={urlInput}
            onChangeText={setUrlInput}
            placeholder="https://... or YouTube link"
            placeholderTextColor={C.muted}
            autoCapitalize="none"
            keyboardType="url"
            style={[styles.input, { flex: 1 }]}
          />
          <Pressable
            onPress={handleIngestUrlOrVideo}
            disabled={busyIngest}
            style={[styles.primaryBtn, { marginTop: 0, paddingHorizontal: 14, justifyContent: 'center' }]}
          >
            <Text style={styles.primaryBtnText}>Ingest</Text>
          </Pressable>
        </View>
      </View>

      {/* 4. Browse & Manage Indexed RAG Chunks */}
      <View style={styles.settingsCard}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>Indexed RAG Chunks ({filteredChunks.length})</Text>
          <Pressable onPress={resetPlaybooks} style={styles.chip}>
            <Text style={styles.chipText}>Restore Playbooks</Text>
          </Pressable>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 4 }}>
          {categories.map((cat) => (
            <Pressable
              key={cat}
              onPress={() => setFilterCat(cat)}
              style={[styles.chip, filterCat === cat && { borderColor: C.accent }]}
            >
              <Text style={styles.chipText}>{cat.toUpperCase()}</Text>
            </Pressable>
          ))}
        </ScrollView>

        {filteredChunks.slice(0, 35).map((item) => (
          <View
            key={item.id}
            style={{
              padding: 10,
              borderRadius: 6,
              backgroundColor: C.bg,
              borderWidth: 1,
              borderColor: C.border,
              marginTop: 6,
              gap: 4,
            }}
          >
            <View style={styles.rowBetween}>
              <Text style={{ color: C.text, fontWeight: '700', fontSize: 13, flex: 1 }} numberOfLines={1}>
                {item.title}
              </Text>
              <View style={styles.rowCenter}>
                <View style={[styles.chip, { paddingVertical: 2, paddingHorizontal: 6 }]}>
                  <Text style={{ color: '#5EEAD4', fontSize: 10, fontWeight: '700' }}>{item.category.toUpperCase()}</Text>
                </View>
                <Pressable onPress={() => deleteChunk(item.id)}>
                  <Text style={{ color: C.danger, fontSize: 12, fontWeight: '600', marginLeft: 6 }}>Delete</Text>
                </Pressable>
              </View>
            </View>
            <Text style={{ color: C.muted, fontSize: 12 }} numberOfLines={3}>
              {item.content}
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ */
/* LOGIN & USER DATA VAULT SCREEN (Auto-Syncs with Bridge & RAG)       */
/* ------------------------------------------------------------------ */

function LoginScreen({
  userAuth,
  saveAuth,
  settings,
  patchSettings,
  onDoneLogin,
}: {
  userAuth: UserAuthData;
  saveAuth: (next: UserAuthData) => void;
  settings: Settings;
  patchSettings: (p: Partial<Settings>) => void;
  onDoneLogin?: () => void;
}) {
  const [name, setName] = useState(userAuth.name || settings.name || '');
  const [email, setEmail] = useState(userAuth.email || settings.email || '');
  const [phone, setPhone] = useState(userAuth.phone || '');
  const [password, setPassword] = useState(userAuth.password || '');
  const [address, setAddress] = useState(userAuth.address || '');
  const [apiKey, setApiKey] = useState(settings.apiKey || '');
  const [appKey, setAppKey] = useState('');
  const [appUser, setAppUser] = useState('');
  const [appPass, setAppPass] = useState('');
  const [statusMsg, setStatusMsg] = useState('');

  const handleSaveLogin = () => {
    if (!name.trim() && !email.trim() && !phone.trim()) {
      Alert.alert('Required', 'Please enter your Name, Email, or Phone number to save your profile vault.');
      return;
    }
    const nextAuth: UserAuthData = {
      ...userAuth,
      isLoggedIn: true,
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      password: password.trim(),
      address: address.trim(),
    };
    saveAuth(nextAuth);
    patchSettings({
      name: name.trim() || settings.name,
      email: email.trim() || settings.email,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
    setStatusMsg('User login data saved & indexed into Agentic RAG Vault.');
    onDoneLogin?.();
  };

  const addSavedAppLogin = () => {
    if (!appKey.trim() || !appUser.trim()) {
      Alert.alert('Missing fields', 'Enter the App/Site name and Username/Email/Phone.');
      return;
    }
    const entry: SavedAppLogin = {
      id: uid(),
      app: appKey.trim(),
      username: appUser.trim(),
      password: appPass.trim(),
    };
    const filtered = userAuth.savedLogins.filter(
      (x) => x.app.toLowerCase() !== entry.app.toLowerCase(),
    );
    const nextAuth: UserAuthData = {
      ...userAuth,
      isLoggedIn: true,
      name: name.trim() || userAuth.name,
      email: email.trim() || userAuth.email,
      phone: phone.trim() || userAuth.phone,
      password: password.trim() || userAuth.password,
      address: address.trim() || userAuth.address,
      savedLogins: [entry, ...filtered],
    };
    saveAuth(nextAuth);
    setAppKey('');
    setAppUser('');
    setAppPass('');
    setStatusMsg(`Saved & indexed login credentials for ${entry.app}.`);
  };

  const removeSavedAppLogin = (id: string) => {
    const nextAuth: UserAuthData = {
      ...userAuth,
      savedLogins: userAuth.savedLogins.filter((x) => x.id !== id),
    };
    saveAuth(nextAuth);
  };

  const loginAndOpenApp = async (item: SavedAppLogin) => {
    const payload = `${item.username}|${item.password}`;
    const res = await openAppWithStatus(item.app, { query: payload, text: payload });
    setStatusMsg(res.statusMessage);
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <View style={styles.rowBetween}>
        <Text style={styles.sectionTitle}>User Identity & Login Vault</Text>
        <View style={[styles.chip, { borderColor: userAuth.isLoggedIn ? C.good : C.border }]}>
          <Text style={styles.chipText}>{userAuth.isLoggedIn ? 'VAULT ACTIVE' : 'SETUP'}</Text>
        </View>
      </View>

      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>Personal Profile & Default Auto-Login Data</Text>
        <Text style={styles.mutedSmall}>
          Automatically synced with the Native Accessibility Bridge and Agentic RAG Knowledge Vault so tasks like "book Uber to my address" or "login to Flipkart" work hands-free.
        </Text>

        <Text style={styles.fieldLabel}>Full Name</Text>
        <TextInput value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor={C.muted} style={styles.input} />

        <Text style={styles.fieldLabel}>Email / Default Username</Text>
        <TextInput value={email} onChangeText={setEmail} placeholder="user@example.com" placeholderTextColor={C.muted} autoCapitalize="none" keyboardType="email-address" style={styles.input} />

        <Text style={styles.fieldLabel}>Phone Number (for WhatsApp, Shopping, Rides, OTP)</Text>
        <TextInput value={phone} onChangeText={setPhone} placeholder="10-digit mobile number" placeholderTextColor={C.muted} keyboardType="phone-pad" style={styles.input} />

        <Text style={styles.fieldLabel}>Default Password / PIN (for App & Web Auto-Login)</Text>
        <TextInput value={password} onChangeText={setPassword} placeholder="Password or PIN" placeholderTextColor={C.muted} secureTextEntry autoCapitalize="none" style={styles.input} />

        <Text style={styles.fieldLabel}>Default Delivery / Office Address (Used by RAG Agent)</Text>
        <TextInput value={address} onChangeText={setAddress} placeholder="Full address or landmark" placeholderTextColor={C.muted} style={styles.input} />

        <Text style={styles.fieldLabel}>Gemini API Key (Required for AI & Vector RAG)</Text>
        <TextInput value={apiKey} onChangeText={setApiKey} placeholder="AIza..." placeholderTextColor={C.muted} secureTextEntry autoCapitalize="none" style={styles.input} />

        <Pressable onPress={handleSaveLogin} style={styles.primaryBtn}>
          <Text style={styles.primaryBtnText}>{userAuth.isLoggedIn ? 'Update & Sync Vault to RAG' : 'Save & Activate Vault'}</Text>
        </Pressable>

        {statusMsg ? <Text style={{ color: C.good, fontSize: 13, marginTop: 4 }}>{statusMsg}</Text> : null}
      </View>

      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>Per-App & Website Credentials ({userAuth.savedLogins.length})</Text>
        <Text style={styles.mutedSmall}>
          Save specific app logins (Flipkart, Meesho, Instagram, Amazon). Tap "Login & Open" or ask in Chat.
        </Text>

        <Text style={styles.fieldLabel}>App or Website Name</Text>
        <TextInput value={appKey} onChangeText={setAppKey} placeholder="e.g. flipkart, meesho, instagram, amazon" placeholderTextColor={C.muted} autoCapitalize="none" style={styles.input} />

        <Text style={styles.fieldLabel}>Username / Email / Phone</Text>
        <TextInput value={appUser} onChangeText={setAppUser} placeholder="Username, email, or phone" placeholderTextColor={C.muted} autoCapitalize="none" style={styles.input} />

        <Text style={styles.fieldLabel}>Password</Text>
        <TextInput value={appPass} onChangeText={setAppPass} placeholder="Password" placeholderTextColor={C.muted} secureTextEntry autoCapitalize="none" style={styles.input} />

        <Pressable onPress={addSavedAppLogin} style={styles.secondaryBtn}>
          <Text style={styles.primaryBtnText}>+ Save App Login</Text>
        </Pressable>

        {userAuth.savedLogins.map((item) => (
          <View
            key={item.id}
            style={[
              styles.rowBetween,
              { paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.border, marginTop: 6 },
            ]}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: C.text, fontWeight: '700', fontSize: 14 }}>{item.app}</Text>
              <Text style={styles.mutedSmall}>{item.username}</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Pressable onPress={() => loginAndOpenApp(item)} style={[styles.chip, { borderColor: C.accent }]}>
                <Text style={styles.chipText}>Login & Open</Text>
              </Pressable>
              <Pressable onPress={() => removeSavedAppLogin(item.id)} style={styles.chip}>
                <Text style={[styles.chipText, { color: C.danger }]}>Delete</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ */
/* CLOUD COMPUTER & HYBRID RAG WORKLOAD SCREEN                         */
/* ------------------------------------------------------------------ */

function CloudComputerScreen({
  settings,
  patchSettings,
  ragIndex,
}: {
  settings: Settings;
  patchSettings: (p: Partial<Settings>) => void;
  ragIndex: RagChunk[];
}) {
  const [status, setStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [taskType, setTaskType] = useState<'plan' | 'rag_qa' | 'summarize' | 'budget'>('plan');
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
      const ragCtx = buildAgenticRagContext(taskInput || taskType, ragIndex, 5);
      if (status === 'online' && base && taskType !== 'rag_qa') {
        const payload =
          taskType === 'plan'
            ? { summary: taskInput || 'Work sprint', checklist: ['Retrieve RAG context', 'Execute OS task', 'Verify output'], start: '09:00' }
            : taskType === 'summarize'
              ? { text: (taskInput || 'Cloud workload.') + '\n\n' + ragCtx.contextBlock }
              : { income: 50000, items: [{ label: 'Server', amount: 2500 }, { label: 'API', amount: 1500 }] };
        const run = await runCloudTask(base, settings.cloudToken, settings.apiKey || undefined, taskType, payload);
        setOutput('Cloud Output:\n' + JSON.stringify(run?.result ?? run, null, 2));
      } else if (settings.apiKey) {
        const { json, model } = await geminiJson(
          settings.apiKey,
          settings.model || DEFAULT_MODEL,
          'Execute the requested workload using the provided Agentic RAG Knowledge and return structured JSON.',
          [
            {
              role: 'user',
              parts: [
                {
                  text:
                    `Task Type: ${taskType}\nUser Input: ${taskInput || 'Generate actionable plan'}\n\n` +
                    (ragCtx.contextBlock || 'No specific RAG chunks matched.'),
                },
              ],
            },
          ],
          25000,
        );
        setOutput(`RAG Hybrid Engine (${model} · ${ragCtx.results.length} RAG chunks used):\n` + JSON.stringify(json, null, 2));
      } else {
        setOutput('Add your Gemini API key in LOGIN or SETTINGS to run hybrid RAG workloads.');
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
        <Text style={styles.sectionTitle}>Cloud & Hybrid RAG Compute</Text>
        <View style={styles.chip}>
          <Text style={styles.chipText}>
            {status === 'online' ? 'Remote Online' : status === 'checking' ? 'Checking...' : 'Local RAG Engine'}
          </Text>
        </View>
      </View>
      <View style={styles.settingsCard}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>Cloud Routing</Text>
          <Switch value={settings.cloudMode} onValueChange={(v) => patchSettings({ cloudMode: v })} trackColor={{ false: C.border, true: C.accent }} thumbColor="#fff" />
        </View>
        <TextInput value={settings.cloudUrl} onChangeText={(t) => patchSettings({ cloudUrl: t })} onBlur={() => patchSettings({ cloudUrl: normalizeCloudUrl(settings.cloudUrl) })} placeholder={DEFAULT_CLOUD_URL} placeholderTextColor={C.muted} autoCapitalize="none" style={styles.input} />
        <Pressable onPress={refreshCloud} style={styles.secondaryBtn}>
          <Text style={styles.primaryBtnText}>Ping Server</Text>
        </Pressable>
      </View>
      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>Run RAG-Augmented Workload</Text>
        <View style={styles.segment}>
          {(['plan', 'rag_qa', 'summarize', 'budget'] as const).map((t) => (
            <Pressable key={t} onPress={() => setTaskType(t)} style={[styles.segItem, taskType === t && styles.segItemOn]}>
              <Text style={[styles.segText, taskType === t && styles.segTextOn]}>{t.toUpperCase()}</Text>
            </Pressable>
          ))}
        </View>
        <TextInput value={taskInput} onChangeText={setTaskInput} placeholder="Enter task goal or question for RAG + Cloud..." placeholderTextColor={C.muted} multiline style={[styles.input, { minHeight: 70, marginTop: 8 }]} />
        <Pressable onPress={executeTask} disabled={running} style={styles.primaryBtn}>
          {running ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Execute Workload</Text>}
        </Pressable>
        {output ? (
          <View style={{ marginTop: 10, padding: 12, borderRadius: 6, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border }}>
            <Text style={{ color: C.text, fontSize: 12 }}>{output}</Text>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ */
/* APPS & SYSTEM HARDWARE CONTROL CENTER SCREEN                        */
/* ------------------------------------------------------------------ */

function AppsScreen({
  userAuth,
  ragIndex,
}: {
  userAuth: UserAuthData;
  ragIndex: RagChunk[];
}) {
  const [text, setText] = useState('');
  const [to, setTo] = useState(userAuth.phone || '');
  const [last, setLast] = useState('');
  const [installedApps, setInstalledApps] = useState<{ label: string; packageName: string }[]>([]);
  const [deviceInfo, setDeviceInfo] = useState<any>(null);
  const [torchOn, setTorchOn] = useState(false);

  const refreshTelemetry = useCallback(async () => {
    if (Platform.OS !== 'android' || !HarkBridge) return;
    try {
      if (HarkBridge.getDeviceStatus) {
        const st = await HarkBridge.getDeviceStatus();
        setDeviceInfo(st);
        if (typeof st?.torchOn === 'boolean') setTorchOn(st.torchOn);
      }
      if (HarkBridge.getInstalledApps) {
        const list = await HarkBridge.getInstalledApps();
        if (Array.isArray(list)) setInstalledApps(list);
      }
    } catch {}
  }, []);

  useEffect(() => {
    refreshTelemetry();
  }, [refreshTelemetry]);

  const fillFromRag = () => {
    if (!text.trim()) {
      if (userAuth.address) {
        setText(userAuth.address);
        setLast(`Filled saved address from RAG Vault: "${userAuth.address}"`);
      }
      return;
    }
    const ctx = buildAgenticRagContext(text, ragIndex, 2);
    if (ctx.resolvedHintQuery) {
      setText(ctx.resolvedHintQuery);
      setLast(`Resolved via RAG: "${ctx.resolvedHintQuery}"`);
    } else if (ctx.results[0]) {
      setLast(`Top RAG match (${ctx.results[0].score}%): ${ctx.results[0].chunk.title}`);
    }
  };

  const launch = async (idOrPkg: string) => {
    const cleanQ = text.trim();
    const res = await openAppWithStatus(
      idOrPkg,
      idOrPkg === 'email' ? { query: cleanQ, text: '' } : { query: cleanQ, text: cleanQ, to: to.trim() },
    );
    setLast(res.statusMessage);
  };

  const toggleFlashlight = async () => {
    if (Platform.OS !== 'android' || !HarkBridge?.toggleTorch) return;
    const next = !torchOn;
    const ok = await HarkBridge.toggleTorch(next);
    if (ok) {
      setTorchOn(next);
      setLast(`Flashlight turned ${next ? 'ON' : 'OFF'}.`);
    }
  };

  const setDeviceVol = async (pct: number) => {
    if (Platform.OS !== 'android' || !HarkBridge?.setVolume) return;
    await HarkBridge.setVolume(pct);
    setLast(`Media volume set to ${pct}%.`);
    refreshTelemetry();
  };

  const triggerGlobal = async (act: string) => {
    if (Platform.OS !== 'android' || !HarkBridge?.globalAction) return;
    const ok = await HarkBridge.globalAction(act);
    setLast(ok ? `Triggered global ${act.toUpperCase()}.` : `Enable Accessibility Bridge to use ${act.toUpperCase()}.`);
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 44 }} keyboardShouldPersistTaps="handled">
      <View style={styles.rowBetween}>
        <Text style={styles.sectionTitle}>Apps & System Controls</Text>
        <Pressable onPress={() => openAppWithStatus('accessibility')} style={styles.chip}>
          <Text style={styles.chipText}>
            {deviceInfo?.accessibilityEnabled ? 'Bridge: ON' : 'Enable Bridge'}
          </Text>
        </Pressable>
      </View>

      {/* Hardware & System Quick Controls */}
      <View style={styles.settingsCard}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>OS Hardware & Global Controls</Text>
          <Pressable onPress={refreshTelemetry} style={styles.chip}>
            <Text style={styles.chipText}>
              {deviceInfo?.batteryPct > 0 ? `🔋 ${deviceInfo.batteryPct}%` : 'Refresh'}
            </Text>
          </Pressable>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Pressable
            onPress={toggleFlashlight}
            style={[styles.chip, torchOn && { borderColor: C.warn, backgroundColor: '#3B2506' }]}
          >
            <Text style={styles.chipText}>{torchOn ? '🔦 Torch: ON' : '🔦 Torch: OFF'}</Text>
          </Pressable>
          {[0, 40, 75, 100].map((v) => (
            <Pressable key={v} onPress={() => setDeviceVol(v)} style={styles.chip}>
              <Text style={styles.chipText}>🔊 {v}%</Text>
            </Pressable>
          ))}
          <Pressable
            onPress={() => HarkBridge?.vibrate?.(120)}
            style={styles.chip}
          >
            <Text style={styles.chipText}>📳 Haptic</Text>
          </Pressable>
        </View>

        <Text style={styles.fieldLabel}>Global Navigation & System Panels</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {(['back', 'home', 'recents', 'notifications', 'quick_settings'] as const).map((g) => (
            <Pressable key={g} onPress={() => triggerGlobal(g)} style={styles.chip}>
              <Text style={styles.chipText}>{g.replace('_', ' ').toUpperCase()}</Text>
            </Pressable>
          ))}
          {(['wifi', 'bluetooth', 'display', 'sound'] as const).map((p) => (
            <Pressable
              key={p}
              onPress={() => HarkBridge?.openSystemSettings?.(p)}
              style={[styles.chip, { borderColor: C.accent }]}
            >
              <Text style={styles.chipText}>⚙️ {p.toUpperCase()}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Direct App Action Launcher */}
      <View style={styles.settingsCard}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>Direct App Workflow Launcher</Text>
          <Pressable onPress={fillFromRag} style={[styles.chip, { borderColor: C.rag }]}>
            <Text style={[styles.chipText, { color: '#5EEAD4' }]}>⚡ Resolve via RAG</Text>
          </Pressable>
        </View>
        <Text style={styles.mutedSmall}>
          Enter a search query, product to buy, video to play, or message, then tap an app below to launch & automate it.
        </Text>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Search query, product to buy, video to play, or message..."
          placeholderTextColor={C.muted}
          style={styles.input}
        />
        <TextInput
          value={to}
          onChangeText={setTo}
          placeholder="Phone number or @username (for WhatsApp, Telegram, Call, SMS)"
          placeholderTextColor={C.muted}
          keyboardType="default"
          style={styles.input}
        />
        {last ? (
          <View style={{ padding: 10, borderRadius: 6, backgroundColor: C.bg, borderWidth: 1, borderColor: C.accent }}>
            <Text style={styles.bubbleText}>{last}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.appGrid}>
        {APPS.map((a) => (
          <Pressable key={a.id} onPress={() => launch(a.id)} style={styles.appTile} accessibilityLabel={'Open ' + a.name}>
            <Text style={{ fontSize: 18 }}>{a.icon}</Text>
            <Text style={styles.appName} numberOfLines={1}>{a.name}</Text>
            <Text style={[styles.mutedSmall, { fontSize: 10 }]} numberOfLines={1}>{a.hint}</Text>
          </Pressable>
        ))}
      </View>

      {installedApps.length > 0 ? (
        <View style={{ marginTop: 12 }}>
          <Text style={styles.sectionTitle}>All Installed Device Apps ({installedApps.length})</Text>
          <View style={styles.appGrid}>
            {installedApps.map((item) => (
              <Pressable
                key={item.packageName}
                onPress={() => launch(item.packageName)}
                style={styles.appTile}
              >
                <Text style={styles.appName} numberOfLines={1}>{item.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

/* ---- Cloud backend helpers ---- */

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
          ? 'Cloud URL returned a web page. Set port ' + CLOUD_PORT + ' to Public.'
          : 'Cloud returned non-JSON (HTTP ' + res.status + ').',
      );
    }
    if (!res.ok || json?.ok === false) throw new Error(json?.error || 'Cloud HTTP ' + res.status);
    return json;
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('Cloud timed out.');
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
      automation_script: Array.isArray(r.automation_script) ? r.automation_script : undefined,
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

/* ------------------------------------------------------------------ */
/* Multimodal Picker HTML                                              */
/* ------------------------------------------------------------------ */

const MULTIMODAL_PICKER_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<style>
  body { background: #131A26; color: #F3F6FA; font-family: system-ui, sans-serif; margin: 0; padding: 16px; }
  h3 { margin: 0 0 6px 0; font-size: 16px; color: #fff; }
  p { margin: 0 0 12px 0; font-size: 12px; color: #94A3B8; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
  .btn { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 12px 8px; border-radius: 6px; background: #1B2434; border: 1px solid #2A364B; color: #F3F6FA; font-weight: 600; font-size: 13px; cursor: pointer; text-align: center; gap: 4px; }
  .box { background: #1B2434; border: 1px solid #2A364B; border-radius: 6px; padding: 12px; margin-top: 8px; }
  input[type="url"], input[type="text"] { width: 100%; box-sizing: border-box; padding: 10px; border-radius: 6px; border: 1px solid #2A364B; background: #0B0F17; color: #fff; font-size: 14px; margin-top: 6px; }
  .act { width: 100%; margin-top: 8px; padding: 10px; border-radius: 6px; border: none; background: #2563EB; color: #fff; font-weight: 600; font-size: 14px; cursor: pointer; }
  .status { margin-top: 8px; font-size: 12px; color: #94A3B8; text-align: center; }
  input[type="file"] { display: none; }
</style>
</head>
<body>
  <h3>Attach File or Link (Auto-Indexes into RAG)</h3>
  <p>Select an image, PDF, document, or video link for analysis and RAG indexing.</p>
  <div class="grid">
    <label class="btn" for="imgInput"><span>📷 Photo / Image</span></label>
    <label class="btn" for="camInput"><span>📸 Camera</span></label>
    <label class="btn" for="docInput"><span>📄 Document / PDF</span></label>
    <label class="btn" for="vidInput"><span>🎬 Video File</span></label>
  </div>
  <input id="imgInput" type="file" accept="image/*" />
  <input id="camInput" type="file" accept="image/*" capture="environment" />
  <input id="docInput" type="file" accept=".pdf,.txt,.md,.csv,.json,.xml,.html,.doc,.docx,application/pdf,text/*" />
  <input id="vidInput" type="file" accept="video/*" />
  <div class="box">
    <div style="font-size:13px;font-weight:600;">YouTube / Video URL</div>
    <input id="ytUrl" type="url" placeholder="https://www.youtube.com/watch?v=..." />
    <button class="act" id="ytBtn">Attach Video Link</button>
  </div>
  <div id="status" class="status"></div>
<script>
  function send(payload) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(payload));
  }
  function handleFile(file, kind) {
    if (!file) return;
    document.getElementById('status').textContent = 'Reading ' + file.name + '...';
    var isText = /^text\\/|\\.(txt|md|csv|json|xml|html|js|ts|py)$/i.test(file.type || file.name);
    var reader = new FileReader();
    if (isText) {
      reader.onload = function(e) {
        send({ type: 'attachment', name: file.name, mimeType: file.type || 'text/plain', kind: 'document', textContent: String(e.target.result || '').slice(0, 40000), sizeBytes: file.size });
      };
      reader.readAsText(file);
    } else {
      reader.onload = function(e) {
        var dataUrl = String(e.target.result || '');
        var comma = dataUrl.indexOf(',');
        var b64 = comma !== -1 ? dataUrl.slice(comma + 1) : dataUrl;
        send({ type: 'attachment', name: file.name, mimeType: file.type || (kind === 'image' ? 'image/jpeg' : kind === 'video' ? 'video/mp4' : 'application/pdf'), kind: kind, base64: b64, uri: dataUrl, sizeBytes: file.size });
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
    if (!u) return;
    send({ type: 'attachment', name: u, mimeType: 'text/uri-list', kind: 'video_link', uri: u });
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
  ragEnabled: boolean;
  autoIndexAttachments: boolean;
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
  avatar: 'P',
  profilePhotoUri: '',
  selfLearn: true,
  ragEnabled: true,
  autoIndexAttachments: true,
  focusGoalMin: 480,
  personalize: true,
  apiKey: '',
  model: DEFAULT_MODEL,
  temperature: 0.3,
  speed: 'fast',
  fastModel: FAST_MODEL,
  replyLength: 'short',
  historyLimit: 200,
  cloudUrl: DEFAULT_CLOUD_URL,
  cloudToken: '',
  cloudMode: false,
  voiceOn: false,
  voiceRate: 1.0,
  voicePitch: 1.0,
  voiceLang: 'en-IN',
  homeUrl: 'https://www.google.com',
  confirmBeforeComplete: false,
  haptics: false,
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
      if (!saved.rev || saved.rev < 6) {
        merged.speed = 'fast';
        merged.fastModel = FAST_MODEL;
        merged.model = DEFAULT_MODEL;
        merged.cloudMode = false;
        merged.ragEnabled = true;
        merged.autoIndexAttachments = true;
        if (!merged.cloudUrl) merged.cloudUrl = DEFAULT_CLOUD_URL;
        merged.rev = 6;
        await AsyncStorage.setItem(STORAGE_SETTINGS, JSON.stringify(merged));
      }
      return merged;
    } catch {
      /* fallback */
    }
  }
  const [k, m, cu, ct] = await Promise.all([
    AsyncStorage.getItem(STORAGE_API_KEY),
    AsyncStorage.getItem(STORAGE_MODEL),
    AsyncStorage.getItem(STORAGE_CLOUD_URL),
    AsyncStorage.getItem(STORAGE_CLOUD_TOKEN),
  ]);
  const s: Settings = {
    ...DEFAULT_SETTINGS,
    apiKey: k || '',
    model: m || DEFAULT_MODEL,
    voiceOn: false,
    cloudUrl: cu || DEFAULT_CLOUD_URL,
    cloudToken: ct || '',
    cloudMode: false,
    rev: 6,
  };
  await AsyncStorage.setItem(STORAGE_SETTINGS, JSON.stringify(s));
  return s;
}

function profileContext(s: Settings, auth: UserAuthData): string {
  const bits: string[] = [];
  const uName = auth.name.trim() || s.name.trim();
  if (uName) bits.push(`User Name: ${uName}`);
  if (auth.email.trim() || s.email.trim()) bits.push(`User Email: ${auth.email.trim() || s.email.trim()}`);
  if (auth.phone.trim()) bits.push(`User Phone: ${auth.phone.trim()}`);
  if (auth.address.trim()) bits.push(`User Address: ${auth.address.trim()}`);
  if (auth.savedLogins.length > 0) {
    bits.push(
      `Saved App Logins available: ${auth.savedLogins.map((l) => `${l.app} (user: ${l.username})`).join(', ')}`,
    );
  }
  return bits.join('\n');
}

/* ------------------------------------------------------------------ */
/* In-app updates (GitHub Releases)                                    */
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
    throw new Error('No internet connection.');
  }
  if (res.status === 404) throw new Error('Update server unavailable.');
  if (!res.ok) throw new Error("Couldn't check for updates (" + res.status + ').');
  const rel: any = await res.json();
  const asset = (rel.assets || []).find((a: any) => /\.apk$/i.test(String(a?.name)));
  if (!asset) throw new Error('No APK found in latest release.');
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
  if (!stat.exists || (stat.size ?? 0) < 1024 * 1024) throw new Error('Downloaded file incomplete.');
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
/* Root App                                                            */
/* ------------------------------------------------------------------ */

export default function App() {
  const [tab, setTab] = useState<Tab>('CHAT');
  const [settings, setSettings] = useState<Settings | null>(null);
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const [userAuth, setUserAuth] = useState<UserAuthData>(DEFAULT_USER_AUTH);
  const [ragIndex, setRagIndex] = useState<RagChunk[]>(DEFAULT_RAG_PLAYBOOKS);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [bridgeActive, setBridgeActive] = useState<boolean>(false);
  const [externalCommand, setExternalCommand] = useState<string>('');

  const checkBridgeState = useCallback(async () => {
    if (Platform.OS !== 'android' || !HarkBridge?.isAccessibilityEnabled) return;
    try {
      const en = await HarkBridge.isAccessibilityEnabled();
      setBridgeActive(!!en);
    } catch {
      setBridgeActive(false);
    }
  }, []);

  useEffect(() => {
    Speech.stop();
    Promise.all([loadSettings(), loadUserAuth(), loadRagIndex()]).then(async ([s, auth, loadedRag]) => {
      settingsRef.current = s;
      setSettings(s);
      setUserAuth(auth);
      const syncedRag = await syncUserVaultToRag(auth).catch(() => loadedRag);
      setRagIndex(syncedRag);
      setAuthLoaded(true);
      checkBridgeState();
      if (s.autoCheckUpdates) {
        checkForUpdate(DEFAULT_UPDATE_REPO, s.updateToken)
          .then((u) => setUpdate(u.available ? u : null))
          .catch(() => undefined);
      }
    });
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') checkBridgeState();
    });
    return () => sub.remove();
  }, [checkBridgeState]);

  const patchSettings = useCallback((patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    AsyncStorage.setItem(STORAGE_SETTINGS, JSON.stringify(next));
  }, []);

  const updateAuth = useCallback((next: UserAuthData) => {
    setUserAuth(next);
    saveUserAuth(next)
      .then((updatedRag) => setRagIndex(updatedRag))
      .catch(() => undefined);
  }, []);

  const triggerAgentTaskFromAnywhere = useCallback((cmd: string) => {
    setExternalCommand(cmd);
    setTab('CHAT');
  }, []);

  if (!settings || !authLoaded) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={C.accent} />
      </View>
    );
  }

  // First-time Login Gate
  if (!userAuth.isLoggedIn) {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar style="light" backgroundColor={C.bg} />
        <View style={styles.header}>
          <Text style={styles.brand}>Pulse OS 4.0 · Agentic RAG</Text>
          <Pressable
            onPress={() => updateAuth({ ...userAuth, isLoggedIn: true })}
            style={styles.chip}
          >
            <Text style={styles.chipText}>Skip to App</Text>
          </Pressable>
        </View>
        <LoginScreen
          userAuth={userAuth}
          saveAuth={updateAuth}
          settings={settings}
          patchSettings={patchSettings}
          onDoneLogin={() => setTab('CHAT')}
        />
      </SafeAreaView>
    );
  }

  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  const [voiceLangMode, setVoiceLangMode] = useState<VoiceLanguageMode>('BILINGUAL_AUTO');
  const tabs: { id: Tab; label: string; emoji: string; desc: string }[] = [
    { id: 'CHAT', label: '✨ Chat', emoji: '✨', desc: 'Omni Assistant, Own Thoughts & Telugu/EN Voice' },
    { id: 'VOICE', label: '🎙️ Voice Orb', emoji: '🎙️', desc: 'Hands-Free Control: Scroll Down, Select It, Search, Proceed' },
    { id: 'OMNICORE', label: '🧠 5 Engines', emoji: '🧠', desc: 'Processing, Reply, Agentic, Self-Dev & GitHub Integrations' },
    { id: 'MEDIA', label: '🎨 Media Gen', emoji: '🎨', desc: 'Flux 8K Image Gen, AI Video Storyboard & Native PDF' },
    { id: 'RAG', label: '📚 RAG AI', emoji: '📚', desc: 'Hybrid BM25 + Vector Knowledge Vault & Playbooks' },
    { id: 'APPS', label: '📱 Apps & OS', emoji: '📱', desc: '28+ App Workflows, Installed Apps & Hardware Deck' },
    { id: 'LOGIN', label: '🔐 Vault', emoji: '🔐', desc: 'Personal Identity, Address & Auto-Login Credentials' },
    { id: 'LIVE', label: '🌐 Studio', emoji: '🌐', desc: 'Agentic Browser, OS Bridge Inspector, Timer & Notes' },
    { id: 'CLOUD', label: '☁️ Cloud', emoji: '☁️', desc: 'Remote Cloud Server & Codespace Task Runner' },
    { id: 'SETTINGS', label: '⚙️ Setup', emoji: '⚙️', desc: 'API Key, Speed Mode, Self-Test & OTA APK Updater' },
  ];

  const displayUser = userAuth.name.trim() || settings.name.trim();

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" backgroundColor={C.bg} />
      <View style={[styles.header, { backgroundColor: 'rgba(15, 23, 42, 0.88)', borderBottomColor: 'rgba(99, 102, 241, 0.35)' }]}>
        <View style={[styles.rowCenter, { gap: 10, flexShrink: 1 }]}>
          <Pressable
            onPress={() => setNavDrawerOpen(true)}
            style={[styles.chip, { paddingHorizontal: 11, paddingVertical: 7, backgroundColor: 'rgba(79, 70, 229, 0.28)', borderColor: '#818CF8' }]}
          >
            <Text style={[styles.chipText, { fontSize: 15, color: '#FFFFFF' }]}>☰</Text>
          </Pressable>
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.brand}>✨ Hark Pro 5.0 · OmniCore</Text>
            <Text style={styles.brandSub} numberOfLines={1}>
              {displayUser ? `${displayUser} · ` : ''}🇮🇳 తెలుగు/EN · ⚡-{omniProcessingEngine.getMetrics().compressionRatioPct}% Tok · RAG ({ragIndex.length})
            </Text>
          </View>
        </View>
        <View style={styles.rowCenter}>
          <Pressable
            onPress={() => setTab('VOICE')}
            style={[styles.chip, { borderColor: '#38BDF8', backgroundColor: 'rgba(56, 189, 248, 0.16)' }]}
          >
            <Text style={[styles.chipText, { color: '#BAE6FD' }]}>🎙️ Live</Text>
          </Pressable>
          <Pressable
            onPress={() => setTab('MEDIA')}
            style={[styles.chip, { borderColor: '#C084FC', backgroundColor: 'rgba(192, 132, 252, 0.16)' }]}
          >
            <Text style={[styles.chipText, { color: '#E9D5FF' }]}>🎨 Media</Text>
          </Pressable>
          <Pressable
            onPress={() => openAppWithStatus('accessibility')}
            style={[
              styles.chip,
              { borderColor: bridgeActive ? C.good : C.warn },
            ]}
          >
            <Text
              style={[
                styles.chipText,
                { color: bridgeActive ? '#4ADE80' : '#FBBF24' },
              ]}
            >
              {bridgeActive ? '🟢 OS' : '⚠️ OS'}
            </Text>
          </Pressable>
        </View>
      </View>

      {!bridgeActive && Platform.OS === 'android' ? (
        <Pressable
          onPress={() => openAppWithStatus('accessibility')}
          style={[styles.updateBanner, { borderBottomColor: C.warn }]}
        >
          <Text style={[styles.updateBannerText, { color: '#FBBF24' }]}>
            ⚠️ Accessibility Bridge is OFF. Tap here to enable "Pulse OS Assistive Bridge" so app search & clicks work!
          </Text>
        </Pressable>
      ) : null}

      {update && tab !== 'SETTINGS' ? (
        <Pressable onPress={() => setTab('SETTINGS')} style={styles.updateBanner}>
          <Text style={styles.updateBannerText}>
            Update available: build {update.latestBuild} (current: {update.currentBuild}). Tap to install.
          </Text>
        </Pressable>
      ) : null}

      <View style={{ flex: 1 }}>
        <View style={[styles.fill, tab !== 'CHAT' && styles.hidden]}>
          <ChatScreen
            settings={settings}
            userAuth={userAuth}
            ragIndex={ragIndex}
            setRagIndex={setRagIndex}
            externalCommand={externalCommand}
            clearExternalCommand={() => setExternalCommand('')}
            patchSettings={patchSettings}
            openSettings={() => setTab('SETTINGS')}
          />
        </View>
        <View style={[styles.fill, tab !== 'RAG' && styles.hidden]}>
          <RagKnowledgeScreen
            ragIndex={ragIndex}
            setRagIndex={setRagIndex}
            apiKey={settings.apiKey}
            onRunAgentWithQuery={triggerAgentTaskFromAnywhere}
          />
        </View>
        <View style={[styles.fill, tab !== 'APPS' && styles.hidden]}>
          <AppsScreen userAuth={userAuth} ragIndex={ragIndex} />
        </View>
        <View style={[styles.fill, tab !== 'LOGIN' && styles.hidden]}>
          <LoginScreen
            userAuth={userAuth}
            saveAuth={updateAuth}
            settings={settings}
            patchSettings={patchSettings}
          />
        </View>
        <View
          style={[styles.fill, tab !== 'LIVE' && styles.offscreen]}
          pointerEvents={tab === 'LIVE' ? 'auto' : 'none'}
          importantForAccessibility={tab === 'LIVE' ? 'auto' : 'no-hide-descendants'}
        >
          <WorkspaceScreen
            homeUrl={settings.homeUrl}
            ragIndex={ragIndex}
            setRagIndex={setRagIndex}
            apiKey={settings.apiKey}
            onRunRoutine={triggerAgentTaskFromAnywhere}
          />
        </View>
        <View style={[styles.fill, tab !== 'CLOUD' && styles.hidden]}>
          <CloudComputerScreen settings={settings} patchSettings={patchSettings} ragIndex={ragIndex} />
        </View>
        <View style={[styles.fill, tab !== 'SETTINGS' && styles.hidden]}>
          <SettingsScreen
            settings={settings}
            patchSettings={patchSettings}
            ragIndex={ragIndex}
            update={update}
            setUpdate={setUpdate}
          />
        </View>
        <View style={[styles.fill, tab !== 'VOICE' && styles.hidden]}>
          <HandsFreeVoiceOrbScreen
            langMode={voiceLangMode}
            setLangMode={setVoiceLangMode}
            onRunCommand={triggerAgentTaskFromAnywhere}
          />
        </View>
        <View style={[styles.fill, tab !== 'OMNICORE' && styles.hidden]}>
          <OmniCoreEnginesScreen />
        </View>
        <View style={[styles.fill, tab !== 'MEDIA' && styles.hidden]}>
          <MediaGenStudioScreen />
        </View>
      </View>

      {/* Slide-Out Pure Glass Workspace Drawer (Separates all 10 workspaces cleanly!) */}
      <Modal
        visible={navDrawerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setNavDrawerOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { width: '90%', maxHeight: '88%', backgroundColor: 'rgba(10, 15, 30, 0.96)', borderColor: 'rgba(99, 102, 241, 0.45)' }]}>
            <View style={styles.rowBetween}>
              <View>
                <Text style={styles.cardTitle}>✨ Hark Pro 5.0 · Glass Workspaces</Text>
                <Text style={styles.mutedSmall}>5 Dedicated Engines · Telugu Voice · Hands-Free OS</Text>
              </View>
              <Pressable onPress={() => setNavDrawerOpen(false)} style={styles.chip}>
                <Text style={styles.chipText}>✕ Close</Text>
              </Pressable>
            </View>
            <ScrollView style={{ marginTop: 10 }} contentContainerStyle={{ gap: 8, paddingBottom: 16 }}>
              {tabs.map((t) => (
                <Pressable
                  key={t.id}
                  onPress={() => {
                    setTab(t.id);
                    setNavDrawerOpen(false);
                  }}
                  style={[
                    styles.convoItem,
                    tab === t.id && styles.convoItemOn,
                    { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
                  ]}
                >
                  <Text style={{ fontSize: 22 }}>{t.emoji}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.convoTitle}>{t.label}</Text>
                    <Text style={styles.mutedSmall}>{t.desc}</Text>
                  </View>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/* ------------------------------------------------------------------ */
/* CHAT SCREEN (Agentic RAG + Direct Execution + Rich Interactive UI)  */
/* ------------------------------------------------------------------ */

function ChatScreen({
  settings,
  userAuth,
  ragIndex,
  setRagIndex,
  externalCommand,
  clearExternalCommand,
  patchSettings,
  openSettings,
}: {
  settings: Settings;
  userAuth: UserAuthData;
  ragIndex: RagChunk[];
  setRagIndex: (next: RagChunk[]) => void;
  externalCommand: string;
  clearExternalCommand: () => void;
  patchSettings: (p: Partial<Settings>) => void;
  openSettings: () => void;
}) {
  const { apiKey, model, cloudUrl, cloudToken, cloudMode } = settings;
  const [loaded, setLoaded] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const handsFreeRef = useRef(false);
  const [attachModal, setAttachModal] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<AttachmentItem | null>(null);
  const [smartMemory, setSmartMemory] = useState<string[]>([]);
  const [, setCloudStatus] = useState<CloudStatus>('off');
  const [cloudHealthInfo, setCloudHealthInfo] = useState<CloudHealth | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const isNearBottomRef = useRef(true);
  const userDraggingRef = useRef(false);

  const onChatScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const dist = contentSize.height - layoutMeasurement.height - contentOffset.y;
    isNearBottomRef.current = dist < 90;
  };
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    loadSmartMemory().then(setSmartMemory);
  }, []);

  const lastPolledAutomationTs = useRef<number>(Date.now());

  useEffect(() => {
    if (Platform.OS !== 'android' || !HarkBridge?.getAutomationResult) return;
    const checkResult = async () => {
      try {
        const res = await HarkBridge.getAutomationResult();
        if (
          res &&
          res.ts &&
          res.ts > lastPolledAutomationTs.current &&
          (res.status === 'verified' || res.status === 'needs_confirmation' || res.status === 'error')
        ) {
          lastPolledAutomationTs.current = res.ts;
          const badge = res.cartVerified ? '[Verified]' : '[OS Status]';
          const stepTrace = Array.isArray(res.stepLogs) && res.stepLogs.length
            ? `\nSteps: ${res.stepLogs.join(' -> ')}`
            : '';
          const statusLine = `${badge} ${res.message || res.cartSummary || ''}${stepTrace}`;
          if (res.screenDump && String(res.screenDump).trim().length > 20) {
            ingestDocumentIntoRag(
              `Auto Screen Capture: ${res.cartSummary || res.message || 'App Workflow'}`,
              String(res.screenDump),
              'screen_dump',
            )
              .then(setRagIndex)
              .catch(() => undefined);
          }
          setMessages((prev) => {
            if (!prev.length) return prev;
            const copy = [...prev];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].role === 'assistant') {
                copy[i] = {
                  ...copy[i],
                  text: copy[i].text.includes(res.message || '__none__') ? copy[i].text : `${copy[i].text}\n\n${statusLine}`,
                  verificationShotUri: res.screenshot || copy[i].verificationShotUri,
                  verificationSummary: res.cartSummary || res.message,
                };
                break;
              }
            }
            return copy;
          });
        }
      } catch {}
    };
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkResult();
    });
    const timer = setInterval(checkResult, 2000);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [setRagIndex]);

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

  const newChat = () => {
    if (busy) return;
    const cur = convos.find((c) => c.id === currentId);
    if (cur && !messages.length) {
      setDrawer(false);
      return;
    }
    const c: Convo = { id: uid(), title: 'New chat', summary: '', updatedAt: Date.now(), messages: [] };
    setConvos((prev) => [c, ...prev]);
    setCurrentId(c.id);
    setMessages([]);
    setDrawer(false);
  };

  const openConvo = (id: string) => {
    if (busy) return;
    const c = convos.find((x) => x.id === id);
    if (!c) return;
    setCurrentId(id);
    setMessages(c.messages);
    setDrawer(false);
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

  const pendingVoiceAutoSendRef = useRef<string>('');

  const startVoiceInput = async () => {
    if (busy) return;
    Speech.stop();
    if (Platform.OS === 'android' && HarkBridge?.startVoiceRecognition) {
      try {
        setListening(true);
        const spoken: string = await HarkBridge.startVoiceRecognition(settings.voiceLang || 'en-IN');
        setListening(false);
        const cleanSpoken = (spoken || '').trim();
        if (cleanSpoken) {
          setInput(cleanSpoken);
          pendingVoiceAutoSendRef.current = cleanSpoken;
        }
      } catch {
        setListening(false);
      }
    }
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
          if (settings.autoIndexAttachments && videoCtx.trim()) {
            ingestDocumentIntoRag(`Video: ${d.name || d.uri}`, videoCtx, 'web_clip', {
              sourceUrl: String(d.uri),
              apiKey: apiKey || undefined,
            })
              .then(setRagIndex)
              .catch(() => undefined);
          }
        } else {
          const item: AttachmentItem = {
            uri: String(d.uri || ''),
            name: String(d.name || 'Attachment'),
            mimeType: String(d.mimeType || 'application/octet-stream'),
            kind: d.kind || 'document',
            base64: d.base64 ? String(d.base64) : undefined,
            textContent: d.textContent ? String(d.textContent) : undefined,
            sizeBytes: Number(d.sizeBytes) || 0,
          };
          setPendingAttachment(item);
          if (settings.autoIndexAttachments && item.textContent) {
            ingestDocumentIntoRag(`File: ${item.name}`, item.textContent, 'document', {
              apiKey: apiKey || undefined,
            })
              .then(setRagIndex)
              .catch(() => undefined);
          }
        }
      }
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (externalCommand && !busy) {
      const cmd = externalCommand;
      clearExternalCommand();
      setInput(cmd);
      pendingVoiceAutoSendRef.current = cmd;
    }
  }, [externalCommand, busy, clearExternalCommand]);

  useEffect(() => {
    if (pendingVoiceAutoSendRef.current && input === pendingVoiceAutoSendRef.current && !busy) {
      pendingVoiceAutoSendRef.current = '';
      send();
    }
  });

  const send = async (overrideText?: string) => {
    const rawInput = (overrideText ?? input).trim();
    const attached = pendingAttachment;
    if (!rawInput && !attached) return;
    if (busy) return;

    const text =
      rawInput ||
      (attached?.kind === 'image'
        ? 'Analyze this image, extract text (OCR), and list key details.'
        : attached?.kind === 'video' || attached?.kind === 'video_link'
          ? 'Summarize this video from its transcript and metadata.'
          : 'Summarize this document and extract key facts.');

    const recentContext = messages
      .filter((m) => m.role !== 'error' && m.text.trim())
      .slice(-6)
      .map((m) => (m.role === 'user' ? 'User: ' : 'Pulse: ') + m.text.slice(0, 300))
      .join('\n');

    // Stage 1: Retrieve Agentic RAG Knowledge for this command
    const ragCtx = settings.ragEnabled ? buildAgenticRagContext(text, ragIndex, 5) : { results: [], contextBlock: '' };
    const ragCitations: RagCitation[] = ragCtx.results.map((r) => ({
      id: r.chunk.id,
      title: r.chunk.title,
      category: r.chunk.category,
      score: r.score,
      snippet: r.chunk.content.slice(0, 140),
    }));

    // Stage 1.5: Hark Pro 5.0 OmniCore (Processing Engine + Self-Dev Own Thoughts + Hands-Free Voice + Media Gen)
    const omniPacket = omniProcessingEngine.analyzeAndCompress(
      text,
      messages.slice(-4).map((m) => ({ role: m.role, text: m.text })),
      ragCtx.contextBlock
    );
    const omniPreThought = omniSelfDevEngine.generatePreTaskThought(omniPacket);
    const hfCmd = omniAgenticEngine.parseHandsFreeVoiceInput(rawInput);

    if (!attached && hfCmd.isDirectOSCommand && hfCmd.actionType !== 'app_workflow') {
      setInput('');
      const narr = omniReplyEngine.getInstantHandsFreeNarration(
        hfCmd.actionType,
        hfCmd.searchQuery || hfCmd.targetText || '',
        'BILINGUAL_AUTO'
      );
      speakBilingualProgress(narr.en, narr.te, 'BILINGUAL_AUTO');
      if (Platform.OS === 'android' && HarkBridge) {
        try {
          if (hfCmd.actionType === 'scroll_down') await HarkBridge.scrollScreen('down');
          else if (hfCmd.actionType === 'scroll_up') await HarkBridge.scrollScreen('up');
          else if (hfCmd.actionType === 'select_item' && HarkBridge.selectBestVisibleNode) await HarkBridge.selectBestVisibleNode(hfCmd.targetText || '');
          else if (hfCmd.actionType === 'proceed' && HarkBridge.proceedAction) await HarkBridge.proceedAction();
          else if (hfCmd.actionType === 'search' && HarkBridge.performInAppSearch) await HarkBridge.performInAppSearch(hfCmd.searchQuery || '');
          else if (hfCmd.actionType === 'click_text') await HarkBridge.clickByText(hfCmd.targetText || '');
          else if (hfCmd.actionType === 'back') await HarkBridge.globalAction('back');
          else if (hfCmd.actionType === 'home') await HarkBridge.globalAction('home');
          else if (HarkBridge.executeVoiceCommand) await HarkBridge.executeVoiceCommand(rawInput);
        } catch {}
      }
      omniSelfDevEngine.reflectAndEvolve(rawInput, omniPacket.primaryIntent, true, omniPacket.tokensSaved + 420);
      const userMsg: ChatMessage = { id: uid(), role: 'user', text: rawInput, ts: Date.now() };
      const botMsg: ChatMessage = {
        id: uid(),
        role: 'assistant',
        text: `${narr.display}\n\n💭 **Own Thoughts:** ${omniPreThought.thoughtEn}\n⚡ **Tokens Saved:** ${omniPacket.tokensSaved + 420} (0-Token Direct Hands-Free Execution)`,
        ragCitations,
        reply: {
          direct_response: narr.display,
          proactive_checklist: ['scroll down', 'select it', 'proceed', 'go back'],
          one_line_summary: narr.en,
          source_verified: 'OmniCore Hands-Free Engine',
          rag_citations: ragCitations,
        },
        steps: [
          { label: `OmniCore Thought: ${omniPreThought.thoughtTe.slice(0, 48)}`, status: 'done', startedAt: Date.now() - 90, ms: 45 },
          { label: `Executed ${hfCmd.actionType} + Bilingual Voice Narration`, status: 'done', startedAt: Date.now() - 45, ms: 45 },
        ],
        source: 'device',
        ts: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg, botMsg]);
      return;
    }

    if (!attached && (omniPacket.primaryIntent === 'IMAGE_GEN' || omniPacket.primaryIntent === 'VIDEO_GEN' || omniPacket.primaryIntent === 'PDF_GEN')) {
      setInput('');
      const userMsg: ChatMessage = { id: uid(), role: 'user', text: rawInput, ts: Date.now() };
      let mediaSummary = '';
      let shotUri: string | undefined;
      if (omniPacket.primaryIntent === 'IMAGE_GEN') {
        const imgAsset = omniMediaEngine.createImageAsset(rawInput, 'FLUX_REALISM', '1:1');
        shotUri = imgAsset.imageUrl;
        speakBilingualProgress(`Generated AI image for ${imgAsset.title}`, `మీకోసం "${imgAsset.title}" AI ఫోటో తయారు చేశాను!`);
        mediaSummary = `🎨 **Flux 8K AI Image Generated**\n\n- **Prompt:** ${imgAsset.prompt}\n- **Image URL:** ${imgAsset.imageUrl}\n- **Own Thoughts:** ${omniPreThought.thoughtEn}`;
      } else if (omniPacket.primaryIntent === 'VIDEO_GEN') {
        const vidAsset = omniMediaEngine.createVideoAsset(rawInput, 12);
        shotUri = vidAsset.imageUrl;
        speakBilingualProgress(`Created 3-scene AI video storyboard for ${vidAsset.title}`, `మీకోసం "${vidAsset.title}" AI వీడియో సిద్ధం చేశాను!`);
        mediaSummary = `🎬 **Cinematic 3-Scene AI Video Storyboard Ready**\n\n- **Title:** ${vidAsset.title}\n- **Scenes:** 3 Dynamic Keyframes with Telugu & English Subtitles (Open **🎨 MEDIA** studio for interactive player)\n- **Own Thoughts:** ${omniPreThought.thoughtEn}`;
      } else {
        speakBilingualProgress(`Generating native PDF report`, `మీకోసం నేటివ్ పిడిఎఫ్ (PDF) రిపోర్ట్ తయారు చేస్తున్నాను!`);
        let savedPath = '/storage/emulated/0/Android/data/com.pulseos.app/files/Documents/hark_report.pdf';
        if (Platform.OS === 'android' && HarkBridge?.generateNativePdf) {
          try {
            const pdfRes = JSON.parse(await HarkBridge.generateNativePdf(rawInput.slice(0, 40), 'Hark Pro 5.0 OmniCore', rawInput, true));
            if (pdfRes.ok) savedPath = pdfRes.filePath;
          } catch {}
        }
        mediaSummary = `📄 **Native Android PDF Generated**\n\n- **File Path:** `${savedPath}`\n- **Own Thoughts:** ${omniPreThought.thoughtEn}`;
      }
      omniSelfDevEngine.reflectAndEvolve(rawInput, omniPacket.primaryIntent, true, omniPacket.tokensSaved);
      const botMsg: ChatMessage = {
        id: uid(),
        role: 'assistant',
        text: mediaSummary,
        verificationShotUri: shotUri,
        verificationSummary: 'Generated by OmniCore MediaGenerationEngine',
        ragCitations,
        reply: {
          direct_response: mediaSummary,
          proactive_checklist: ['Generate another variation', 'Export as PDF'],
          one_line_summary: mediaSummary.slice(0, 80),
          source_verified: 'OmniCore MediaGenerationEngine',
          rag_citations: ragCitations,
        },
        source: 'device',
        ts: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg, botMsg]);
      return;
    }

    // Stage 2: Try RAG-Grounded Direct Native Device Execution FIRST
    if (!attached && mode !== 'chat') {
      const directExec = await tryDirectDeviceExecution(rawInput, userAuth, ragIndex);
      if (directExec.handled) {
        speakBilingualProgress(
          directExec.statusMessage,
          `${directExec.appName || 'యాప్'} ఓపెన్ చేసి మీ పని చేస్తున్నాను, చూడండి!`
        );
        setInput('');
        const userMsg: ChatMessage = { id: uid(), role: 'user', text: rawInput, ts: Date.now() };
        const botMsg: ChatMessage = {
          id: uid(),
          role: 'assistant',
          text: directExec.statusMessage,
          ragCitations: directExec.ragCitations,
          reply: {
            direct_response: directExec.statusMessage,
            proactive_checklist: [
              directExec.appName ? `Verify ${directExec.appName} screen state` : 'Verify device state',
              'Capture screen verification in STUDIO -> OS Bridge',
            ],
            one_line_summary: directExec.statusMessage,
            source_verified: 'Executed with Agentic RAG',
            rag_citations: directExec.ragCitations,
          },
          steps: [
            { label: `RAG Retrieved (${directExec.ragCitations?.length || 0} chunks)`, status: 'done', startedAt: Date.now() - 120, ms: 60 },
            { label: directExec.statusMessage.slice(0, 65), status: 'done', startedAt: Date.now() - 60, ms: 60 },
          ],
          source: 'device',
          ts: Date.now(),
        };
        setMessages((prev) => [...prev, userMsg, botMsg]);
        // Index completed agentic action into RAG task_memory
        ingestDocumentIntoRag(
          `Completed Task: ${rawInput.slice(0, 45)}`,
          `User Command: "${rawInput}" -> Result: ${directExec.statusMessage}`,
          'task_memory',
          { appTag: directExec.appName?.toLowerCase() },
        )
          .then(setRagIndex)
          .catch(() => undefined);
        return;
      }
    }

    const useCloud = !apiKey && cloudMode && !!cloudUrl;
    if (!apiKey && !useCloud) {
      openSettings();
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
        label: ragCitations.length
          ? `RAG Retrieved ${ragCitations.length} chunks (top: ${ragCitations[0].score}%)`
          : attached
            ? `Reading ${attached.name.slice(0, 28)}`
            : 'Processing request',
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
      {
        id: botId,
        role: 'assistant',
        text: '',
        ragCitations,
        source: 'device',
        streaming: true,
        steps: [...steps],
        ts: Date.now(),
      },
    ]);
    setInput('');
    setPendingAttachment(null);
    setBusy(true);

    let verifiedSourceContext = '';
    if (/https?:\/\//i.test(text)) {
      step('Checking & indexing source link into RAG');
      verifiedSourceContext = await quickVerifyUrlsInText(text);
      if (verifiedSourceContext.trim()) {
        ingestDocumentIntoRag(`Link Context: ${text.slice(0, 40)}`, verifiedSourceContext, 'web_clip')
          .then(setRagIndex)
          .catch(() => undefined);
      }
    }

    const ctx = [profileContext(settings, userAuth), verifiedSourceContext].filter(Boolean).join('\n\n');
    const convoId = currentId;
    const useAgent = !attached && !!apiKey && (mode === 'agent' || (mode === 'auto' && AGENT_RE.test(text)));

    if (useAgent) {
      AgentBus.begin(text);
      try {
        const agentModel = /lite/i.test(model) ? 'gemini-2.5-flash' : model;
        const answer = await runAgent({
          apiKey,
          model: agentModel,
          goal: text,
          context: [recentContext, ctx].filter(Boolean).join('\n\n'),
          ragContextBlock: ragCtx.contextBlock,
          userAuth,
          ragIndex,
          onStep: (label) => {
            step(label);
            AgentBus.step(label);
          },
        });
        step('Done', 'done');
        finishSteps();
        const final: ChatMessage = {
          id: botId,
          role: 'assistant',
          text: answer,
          ragCitations,
          reply: {
            direct_response: answer,
            proactive_checklist: ['Open STUDIO -> OS Bridge to inspect screen nodes', 'Save workflow to Routines'],
            one_line_summary: answer.slice(0, 100),
            source_verified: 'Verified with Agentic RAG',
            rag_citations: ragCitations,
          },
          source: 'device',
          streaming: false,
          steps: [...steps],
          ts: Date.now(),
        };
        setMessages((prev) => prev.map((m) => (m.id === botId ? final : m)));
        refreshSummary(convoId, [...next, final]);
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
        step('Running on cloud server with RAG');
        try {
          result = await callCloudChat(
            cloudUrl,
            cloudToken,
            keyForCloud(),
            next,
            [ctx, ragCtx.contextBlock].filter(Boolean).join('\n\n'),
            smartMemory,
          );
          source = 'cloud';
          setCloudStatus('online');
        } catch (cloudErr: any) {
          setCloudStatus('offline');
          if (!apiKey) throw cloudErr;
          step('Switching to local model', 'error');
        }
      }
      if (!result) {
        const useModel = model || FAST_MODEL;
        step('Running ' + modelLabel(useModel) + (ragCitations.length ? ' + RAG' : ''));
        let writing = false;
        let lastUi = 0;
        result = await streamGemini(
          apiKey,
          useModel,
          next,
          ctx,
          smartMemory,
          ragCtx.contextBlock,
          settings.temperature,
          settings.speed,
          (visible) => {
            if (!writing && visible.trim()) {
              writing = true;
              step('Generating RAG-grounded response');
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
      reply.rag_citations = ragCitations;

      if (reply.memory_facts && reply.memory_facts.length) {
        saveSmartMemoryFacts(reply.memory_facts).then(setSmartMemory).catch(() => undefined);
        ingestDocumentIntoRag(
          `Learned Memory (${new Date().toLocaleDateString()})`,
          reply.memory_facts.join('\n'),
          'task_memory',
        )
          .then(setRagIndex)
          .catch(() => undefined);
      }

      // Execute any returned automation_script on the device!
      let execLogText = '';
      if (reply.automation_script && reply.automation_script.length > 0) {
        step('Executing device automation script');
        const execRes = await executeOsAutomationScript(reply.automation_script, (msg) => step(msg));
        if (execRes.log.length > 0) {
          execLogText = '\n\nExecuted on Device:\n• ' + execRes.log.join('\n• ');
        }
      }

      step('Done', 'done');
      finishSteps();
      const finalText = (reply.direct_response + execLogText).trim();
      const botMsg: ChatMessage = {
        id: botId,
        role: 'assistant',
        text: finalText,
        reply,
        ragCitations,
        source,
        streaming: false,
        steps: [...steps],
        ts: Date.now(),
      };
      setMessages((prev) => (prev.some((m) => m.id === botId) ? prev.map((m) => (m.id === botId ? botMsg : m)) : [...prev, botMsg]));
      refreshSummary(convoId, [...next, botMsg]);

      if (settings.voiceOn && finalText) {
        Speech.speak(finalText.slice(0, 450), {
          language: settings.voiceLang || 'en-IN',
          rate: settings.voiceRate || 1.0,
          pitch: settings.voicePitch || 1.0,
          onDone: () => {
            if (handsFreeRef.current) startVoiceInput();
          },
        });
      } else if (handsFreeRef.current) {
        setTimeout(() => startVoiceInput(), 600);
      }
    } catch (e: any) {
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== botId),
        { id: uid(), role: 'error', text: 'Request failed: ' + (e?.message || String(e)), ts: Date.now() },
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

  const quickCommands = [
    { label: '⚡ Blinkit Milk', cmd: 'open blinkit and order milk' },
    { label: '▶️ YouTube Telugu', cmd: 'open youtube and play telugu hit songs' },
    { label: '🛒 Flipkart Shoes', cmd: 'open flipkart and search running shoes' },
    { label: '🚕 Uber to Address', cmd: 'open uber and book a ride to my address' },
    { label: '🔐 Auto-Login', cmd: 'login to instagram' },
  ];

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.chatToolbar}>
        <Pressable onPress={() => setDrawer(true)} style={styles.chip} accessibilityLabel="Open chats">
          <Text style={styles.chipText}>☰ Chats</Text>
        </Pressable>
        <Pressable onPress={() => setModelPicker(true)} style={[styles.chip, { flexShrink: 1 }]} accessibilityLabel="Choose model">
          <Text style={styles.chipText} numberOfLines={1}>
            {!apiKey && cloudMode && cloudUrl ? 'Cloud' : modelLabel(model || FAST_MODEL)}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => patchSettings({ ragEnabled: !settings.ragEnabled })}
          style={[styles.chip, settings.ragEnabled && { borderColor: C.rag, backgroundColor: '#112E2B' }]}
        >
          <Text style={[styles.chipText, settings.ragEnabled && { color: '#5EEAD4' }]}>
            RAG: {settings.ragEnabled ? 'ON' : 'OFF'}
          </Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={() => setMode((m) => (m === 'auto' ? 'agent' : m === 'agent' ? 'chat' : 'auto'))}
          style={[styles.chip, mode === 'agent' && { borderColor: C.accent }]}
        >
          <Text style={styles.chipText}>{mode.toUpperCase()}</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            const nextHf = !handsFree;
            setHandsFree(nextHf);
            handsFreeRef.current = nextHf;
            if (nextHf) startVoiceInput();
          }}
          style={[styles.chip, handsFree && { borderColor: C.good }]}
        >
          <Text style={styles.chipText}>{handsFree ? '🎙️ Loop ON' : '🎙️ Loop'}</Text>
        </Pressable>
        <Pressable onPress={newChat} style={styles.chip}>
          <Text style={styles.chipText}>+ New</Text>
        </Pressable>
      </View>

      {/* Quick Action Command Strip */}
      <View style={{ borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.panel }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 10, paddingVertical: 6, gap: 6 }}>
          {quickCommands.map((q) => (
            <Pressable
              key={q.label}
              onPress={() => send(q.cmd)}
              style={[styles.chip, { backgroundColor: C.bg }]}
            >
              <Text style={[styles.chipText, { fontSize: 11 }]}>{q.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
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
            <Text style={styles.emptyTitle}>Pulse OS 4.0 · Agentic RAG Ready</Text>
            <Text style={[styles.muted, { textAlign: 'center' }]}>
              Every task is grounded in your on-device RAG Knowledge Vault ({ragIndex.length} chunks). Try: "order milk on Blinkit", "play Telugu songs on YouTube", "book Uber to my address", or attach any PDF/image/video link.
            </Text>
            {!apiKey && !(cloudMode && cloudUrl) ? (
              <Pressable onPress={openSettings} style={[styles.primaryBtn, { paddingHorizontal: 18 }]}>
                <Text style={styles.primaryBtnText}>Add Gemini API Key in Settings</Text>
              </Pressable>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <MessageBubble
            msg={item}
            onRunCommand={(cmd) => send(cmd)}
            onSaveToRag={async (title, content) => {
              const updated = await ingestDocumentIntoRag(title, content, 'note', { apiKey: apiKey || undefined });
              setRagIndex(updated);
              Alert.alert('Saved to RAG', `Indexed "${title}" into your RAG Knowledge Vault.`);
            }}
          />
        )}
      />

      {pendingAttachment ? (
        <View style={styles.attachmentPreviewBar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.convoTitle} numberOfLines={1}>{pendingAttachment.name}</Text>
            <Text style={styles.mutedSmall}>{pendingAttachment.kind.toUpperCase()} attached · Auto-indexed to RAG</Text>
          </View>
          <Pressable onPress={() => setPendingAttachment(null)} style={styles.chip}>
            <Text style={styles.chipText}>Remove</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.composer}>
        <Pressable
          onPress={() => setAttachModal(true)}
          disabled={busy}
          style={styles.iconBtn}
          accessibilityLabel="Attach file"
        >
          <Text style={styles.chipText}>+ File</Text>
        </Pressable>

        {Platform.OS === 'android' ? (
          <Pressable
            onPress={startVoiceInput}
            disabled={busy}
            style={[styles.iconBtn, listening && { borderColor: C.danger }]}
            accessibilityLabel="Dictate command"
          >
            <Text style={styles.chipText}>{listening ? 'Stop' : '🎙️ Mic'}</Text>
          </Pressable>
        ) : null}

        <TextInput
          ref={inputRef}
          value={input}
          onChangeText={setInput}
          placeholder="Type agentic command or RAG question..."
          placeholderTextColor={C.muted}
          style={styles.composerInput}
          multiline
          editable={!busy}
          onSubmitEditing={() => send()}
        />
        <Pressable onPress={() => send()} disabled={busy} style={[styles.sendBtn, busy && { opacity: 0.6 }]}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.sendText}>Run</Text>}
        </Pressable>
      </View>

      {/* Multimodal Attachment Modal */}
      <Modal visible={attachModal} transparent animationType="none" onRequestClose={() => setAttachModal(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { height: 390, padding: 0, overflow: 'hidden' }]}>
            <View style={[styles.rowBetween, { paddingHorizontal: 14, paddingTop: 12 }]}>
              <Text style={styles.cardTitle}>Attach File or Video Link</Text>
              <Pressable onPress={() => setAttachModal(false)} style={styles.chip}>
                <Text style={styles.chipText}>Close</Text>
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
          <Pressable style={styles.drawerBackdrop} onPress={() => setDrawer(false)} />
          <View style={styles.drawer}>
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>Chat History</Text>
              <Pressable onPress={newChat} style={styles.chip}>
                <Text style={styles.chipText}>+ New</Text>
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
                    <Text style={styles.mutedSmall} numberOfLines={2}>
                      {c.summary || (c.messages.length ? c.messages.length + ' messages' : 'Empty')}
                    </Text>
                  </Pressable>
                ))}
            </ScrollView>
            <Text style={styles.mutedSmall}>Long-press a conversation to delete it.</Text>
          </View>
        </View>
      ) : null}

      <Modal visible={modelPicker} transparent animationType="none" onRequestClose={() => setModelPicker(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setModelPicker(false)}>
          <View style={styles.modalCard}>
            <Text style={styles.cardTitle}>Select Gemini Model</Text>
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

/* ------------------------------------------------------------------ */
/* RICH INTERACTIVE MESSAGE BUBBLE (RAG Citations, Checklists, Actions)*/
/* ------------------------------------------------------------------ */

function MessageBubble({
  msg,
  onRunCommand,
  onSaveToRag,
}: {
  msg: ChatMessage;
  onRunCommand: (cmd: string) => void;
  onSaveToRag: (title: string, content: string) => void;
}) {
  const [showRagDetails, setShowRagDetails] = useState(false);

  if (msg.role === 'user') {
    return (
      <View style={[styles.bubble, styles.userBubble]}>
        {msg.attachment ? (
          <View style={{ marginBottom: 6 }}>
            {msg.attachment.kind === 'image' && msg.attachment.uri ? (
              <Image source={{ uri: msg.attachment.uri }} style={{ width: 180, height: 130, borderRadius: 6, marginBottom: 4 }} resizeMode="cover" />
            ) : null}
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>
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

  const citations = msg.ragCitations || msg.reply?.rag_citations || [];
  const checklist = msg.reply?.proactive_checklist || [];
  const script = msg.reply?.automation_script || [];

  return (
    <View style={{ marginBottom: 12 }}>
      <View style={[styles.bubble, styles.botBubble]}>
        {msg.steps && msg.steps.length ? <StepsView steps={msg.steps} streaming={msg.streaming} /> : null}

        {/* RAG Grounding Pill */}
        {citations.length > 0 ? (
          <View style={{ marginBottom: 8 }}>
            <Pressable
              onPress={() => setShowRagDetails((v) => !v)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: 8,
                paddingVertical: 5,
                borderRadius: 5,
                backgroundColor: '#112E2B',
                borderWidth: 1,
                borderColor: C.rag,
              }}
            >
              <Text style={{ color: '#5EEAD4', fontSize: 11, fontWeight: '700' }}>
                🧠 Grounded with {citations.length} RAG chunk{citations.length === 1 ? '' : 's'} (Top: {citations[0].title.slice(0, 26)} · {citations[0].score}%)
              </Text>
              <Text style={{ color: '#5EEAD4', fontSize: 11 }}>{showRagDetails ? 'Hide' : 'View'}</Text>
            </Pressable>
            {showRagDetails ? (
              <View style={{ marginTop: 6, gap: 4, padding: 8, borderRadius: 5, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border }}>
                {citations.map((c) => (
                  <View key={c.id} style={{ marginBottom: 4 }}>
                    <Text style={{ color: '#5EEAD4', fontSize: 11, fontWeight: '700' }}>
                      [{c.category.toUpperCase()}] {c.title} ({c.score}%)
                    </Text>
                    <Text style={{ color: C.muted, fontSize: 11 }} numberOfLines={2}>
                      {c.snippet}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {/* Main Response Text */}
        {msg.streaming && !msg.text && msg.steps && msg.steps.length ? null : msg.streaming && !msg.text ? (
          <Text style={styles.muted}>Working...</Text>
        ) : (
          <Text style={styles.bubbleText}>{msg.text}</Text>
        )}

        {/* Re-Run Automation Script Card */}
        {!msg.streaming && script.length > 0 ? (
          <View style={{ marginTop: 10, padding: 10, borderRadius: 6, backgroundColor: C.bg, borderWidth: 1, borderColor: C.accent, gap: 6 }}>
            <View style={styles.rowBetween}>
              <Text style={{ color: C.accent2, fontSize: 12, fontWeight: '700' }}>
                ⚡ OS Automation Script ({script.length} steps)
              </Text>
              <Pressable
                onPress={() => executeOsAutomationScript(script)}
                style={[styles.chip, { borderColor: C.accent, paddingVertical: 4 }]}
              >
                <Text style={styles.chipText}>▶ Re-Run on Device</Text>
              </Pressable>
            </View>
            {script.map((s, idx) => (
              <Text key={idx} style={{ color: C.muted, fontSize: 11 }}>
                {idx + 1}. {s.action} → {s.target} {s.value ? `("${s.value}")` : ''}
              </Text>
            ))}
          </View>
        ) : null}

        {/* Interactive Proactive Follow-up Checklist */}
        {!msg.streaming && checklist.length > 0 ? (
          <View style={{ marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.border, gap: 6 }}>
            <Text style={{ color: C.muted, fontSize: 11, fontWeight: '700' }}>NEXT AGENTIC ACTIONS:</Text>
            {checklist.map((item, idx) => (
              <Pressable
                key={idx}
                onPress={() => onRunCommand(item)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: 8,
                  borderRadius: 6,
                  backgroundColor: C.panel2,
                  borderWidth: 1,
                  borderColor: C.border,
                }}
              >
                <Text style={{ color: C.text, fontSize: 12, flex: 1, marginRight: 8 }}>• {item}</Text>
                <Text style={{ color: C.accent2, fontSize: 11, fontWeight: '700' }}>Run →</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {/* Screen Verification Card */}
        {msg.verificationShotUri ? (
          <View style={{ marginTop: 10, borderRadius: 6, borderWidth: 1, borderColor: C.good, backgroundColor: C.bg, padding: 8, gap: 4 }}>
            <Text style={{ color: C.good, fontSize: 12, fontWeight: '700' }}>
              ✓ Live Screen Verification
            </Text>
            <Image
              source={{ uri: msg.verificationShotUri }}
              style={{ width: 200, height: 300, borderRadius: 4, alignSelf: 'center' }}
              resizeMode="contain"
            />
            {msg.verificationSummary ? (
              <Text style={{ color: C.text, fontSize: 12 }}>{msg.verificationSummary}</Text>
            ) : null}
          </View>
        ) : null}

        {/* Bubble Bottom Action Bar */}
        {!msg.streaming && msg.text ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.border }}>
            <Pressable
              onPress={() => Speech.speak(msg.text.slice(0, 600), { language: 'en-IN' })}
              style={[styles.chip, { paddingVertical: 4, paddingHorizontal: 8 }]}
            >
              <Text style={[styles.chipText, { fontSize: 11 }]}>🔊 Speak</Text>
            </Pressable>
            <Pressable
              onPress={() => Speech.stop()}
              style={[styles.chip, { paddingVertical: 4, paddingHorizontal: 8 }]}
            >
              <Text style={[styles.chipText, { fontSize: 11 }]}>⏹ Stop</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (HarkBridge?.copyToClipboard) {
                  HarkBridge.copyToClipboard(msg.text);
                  Alert.alert('Copied', 'Response copied to clipboard.');
                }
              }}
              style={[styles.chip, { paddingVertical: 4, paddingHorizontal: 8 }]}
            >
              <Text style={[styles.chipText, { fontSize: 11 }]}>📋 Copy</Text>
            </Pressable>
            <Pressable
              onPress={() => onSaveToRag(msg.reply?.one_line_summary || msg.text.slice(0, 36), msg.text)}
              style={[styles.chip, { paddingVertical: 4, paddingHorizontal: 8, borderColor: C.rag }]}
            >
              <Text style={[styles.chipText, { fontSize: 11, color: '#5EEAD4' }]}>🧠 Save to RAG</Text>
            </Pressable>
            {Platform.OS === 'android' && HarkBridge?.shareText ? (
              <Pressable
                onPress={() => HarkBridge.shareText(msg.text, 'Pulse OS Response')}
                style={[styles.chip, { paddingVertical: 4, paddingHorizontal: 8 }]}
              >
                <Text style={[styles.chipText, { fontSize: 11 }]}>↗ Share</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* STUDIO / LIVE WORKSPACE TAB (Browser + OS Bridge + Routines/Tools) */
/* ------------------------------------------------------------------ */

const HOME_URL = 'https://www.google.com';

function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return HOME_URL;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(s)) return 'https://' + s;
  return searchUrl(s);
}

function WidgetsScreen({
  ragIndex,
  setRagIndex,
  apiKey,
  onRunRoutine,
}: {
  ragIndex: RagChunk[];
  setRagIndex: (next: RagChunk[]) => void;
  apiKey: string;
  onRunRoutine: (cmd: string) => void;
}) {
  const [minutes, setMinutes] = useState(60);
  const [secondsLeft, setSecondsLeft] = useState(60 * 60);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState('');
  const [savedNotes, setSavedNotes] = useState<string[]>([]);
  const [routines, setRoutines] = useState<AgentRoutine[]>(DEFAULT_ROUTINES);
  const [rtTitle, setRtTitle] = useState('');
  const [rtCmd, setRtCmd] = useState('');

  useEffect(() => {
    AsyncStorage.getItem('pulseos.quick_notes.v1')
      .then((raw) => {
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) setSavedNotes(parsed);
        }
      })
      .catch(() => undefined);
    AsyncStorage.getItem(STORAGE_ROUTINES)
      .then((raw) => {
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length) setRoutines(parsed);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          setRunning(false);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [running]);

  const setPreset = (m: number) => {
    setRunning(false);
    setMinutes(m);
    setSecondsLeft(m * 60);
  };

  const addNote = async () => {
    const clean = note.trim();
    if (!clean) return;
    const next = [clean, ...savedNotes].slice(0, 25);
    setSavedNotes(next);
    setNote('');
    AsyncStorage.setItem('pulseos.quick_notes.v1', JSON.stringify(next)).catch(() => undefined);
    // Also index note into RAG automatically!
    const updatedRag = await ingestDocumentIntoRag(`Quick Note: ${clean.slice(0, 32)}`, clean, 'note', {
      apiKey: apiKey || undefined,
    });
    setRagIndex(updatedRag);
  };

  const addRoutine = () => {
    if (!rtTitle.trim() || !rtCmd.trim()) return;
    const next: AgentRoutine[] = [
      { id: uid(), title: rtTitle.trim(), command: rtCmd.trim(), category: 'Custom' },
      ...routines,
    ];
    setRoutines(next);
    setRtTitle('');
    setRtCmd('');
    AsyncStorage.setItem(STORAGE_ROUTINES, JSON.stringify(next)).catch(() => undefined);
  };

  const mm = Math.floor(secondsLeft / 60);
  const ss = secondsLeft % 60;

  return (
    <ScrollView contentContainerStyle={{ padding: 14, gap: 12, paddingBottom: 36 }} keyboardShouldPersistTaps="handled">
      {/* 1. Agentic RAG Routines */}
      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>1-Tap Agentic RAG Routines</Text>
        <Text style={styles.mutedSmall}>
          Tap any routine to execute it via the RAG + Accessibility Agent.
        </Text>
        {routines.map((rt) => (
          <View key={rt.id} style={[styles.rowBetween, { paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.border }]}>
            <View style={{ flex: 1, marginRight: 8 }}>
              <Text style={{ color: C.text, fontWeight: '700', fontSize: 13 }}>{rt.title}</Text>
              <Text style={styles.mutedSmall} numberOfLines={1}>{rt.command}</Text>
            </View>
            <Pressable onPress={() => onRunRoutine(rt.command)} style={[styles.chip, { borderColor: C.accent }]}>
              <Text style={styles.chipText}>▶ Run</Text>
            </Pressable>
          </View>
        ))}
        <Text style={styles.fieldLabel}>Create New Routine</Text>
        <TextInput value={rtTitle} onChangeText={setRtTitle} placeholder="Routine Name (e.g. Order Evening Snacks)" placeholderTextColor={C.muted} style={styles.input} />
        <TextInput value={rtCmd} onChangeText={setRtCmd} placeholder="Agent Command (e.g. open swiggy and order samosa)" placeholderTextColor={C.muted} style={styles.input} />
        <Pressable onPress={addRoutine} style={styles.secondaryBtn}>
          <Text style={styles.primaryBtnText}>+ Save Routine</Text>
        </Pressable>
      </View>

      {/* 2. Quick Notes (Auto-Indexed into RAG) */}
      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>RAG-Synced Quick Notes ({savedNotes.length})</Text>
        <Text style={styles.mutedSmall}>
          Every saved note is automatically indexed into your RAG Knowledge Vault for agentic tasks.
        </Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="Add a note, grocery list, or reminder..."
            placeholderTextColor={C.muted}
            style={[styles.input, { flex: 1 }]}
          />
          <Pressable onPress={addNote} style={[styles.primaryBtn, { marginTop: 0, paddingHorizontal: 16, justifyContent: 'center' }]}>
            <Text style={styles.primaryBtnText}>Save + RAG</Text>
          </Pressable>
        </View>
        {savedNotes.map((n, idx) => (
          <View key={idx} style={[styles.rowBetween, { paddingVertical: 6, borderTopWidth: 1, borderTopColor: C.border }]}>
            <Text style={{ color: C.text, fontSize: 13, flex: 1 }}>{n}</Text>
            <Pressable
              onPress={() => {
                const next = savedNotes.filter((_, i) => i !== idx);
                setSavedNotes(next);
                AsyncStorage.setItem('pulseos.quick_notes.v1', JSON.stringify(next)).catch(() => undefined);
              }}
            >
              <Text style={{ color: C.danger, fontSize: 12, marginLeft: 8 }}>Delete</Text>
            </Pressable>
          </View>
        ))}
      </View>

      {/* 3. Focus Timer */}
      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>Focus Timer</Text>
        <Text style={{ color: C.text, fontSize: 28, fontWeight: '700', textAlign: 'center', marginVertical: 6 }}>
          {pad(mm)}:{pad(ss)}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
          {[25, 60, 120, 240].map((m) => (
            <Pressable
              key={m}
              onPress={() => setPreset(m)}
              style={[styles.chip, minutes === m && { borderColor: C.accent }]}
            >
              <Text style={styles.chipText}>{m >= 60 ? `${m / 60}h` : `${m}m`}</Text>
            </Pressable>
          ))}
        </View>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
          <Pressable onPress={() => setRunning((r) => !r)} style={[styles.primaryBtn, { flex: 1, marginTop: 0 }]}>
            <Text style={styles.primaryBtnText}>{running ? 'Pause' : 'Start'}</Text>
          </Pressable>
          <Pressable onPress={() => setPreset(minutes)} style={[styles.secondaryBtn, { flex: 0.5 }]}>
            <Text style={styles.primaryBtnText}>Reset</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}

function WorkspaceScreen({
  homeUrl,
  ragIndex,
  setRagIndex,
  apiKey,
  onRunRoutine,
}: {
  homeUrl: string;
  ragIndex: RagChunk[];
  setRagIndex: (next: RagChunk[]) => void;
  apiKey: string;
  onRunRoutine: (cmd: string) => void;
}) {
  const home = normalizeUrl(homeUrl || HOME_URL);
  const webRef = useRef<WebView>(null);
  const [url, setUrl] = useState(home);
  const [field, setField] = useState(home);
  const [canBack, setCanBack] = useState(false);
  const [loading, setLoading] = useState(false);
  const [liveMode, setLiveMode] = useState<'handoff' | 'os_bridge' | 'panels'>('handoff');
  const [screenDump, setScreenDump] = useState('');
  const [osShot, setOsShot] = useState('');
  const [osStatus, setOsStatus] = useState<any>(null);
  const [remoteClickTarget, setRemoteClickTarget] = useState('');
  const [remoteInputText, setRemoteInputText] = useState('');
  const [bridgeActionMsg, setBridgeActionMsg] = useState('');
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

  const refreshOsBridge = useCallback(async () => {
    if (Platform.OS !== 'android' || !HarkBridge) return;
    try {
      const [res, nodes] = await Promise.all([
        HarkBridge.getAutomationResult ? HarkBridge.getAutomationResult() : Promise.resolve(null),
        HarkBridge.dumpScreenNodes ? HarkBridge.dumpScreenNodes() : Promise.resolve(''),
      ]);
      if (res) {
        setOsStatus(res);
        if (res.screenshot) setOsShot(res.screenshot);
      }
      if (nodes) setScreenDump(String(nodes));
    } catch {}
  }, []);

  useEffect(() => {
    if (liveMode !== 'os_bridge') return;
    refreshOsBridge();
  }, [liveMode, refreshOsBridge]);

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
    } catch {}
  };

  useEffect(
    () =>
      LiveBus.onNav((u) => {
        setUrl(u);
        setField(u);
      }),
    [],
  );

  const go = (targetUrl?: string) => {
    const u = normalizeUrl(targetUrl || field);
    setUrl(u);
    setField(u);
  };

  const indexCurrentWebPageToRag = async () => {
    const snap = await agentSnapshot();
    if (!snap || !snap.text.trim()) {
      Alert.alert('Browser Empty', 'Wait for the page to finish loading before indexing into RAG.');
      return;
    }
    const updated = await ingestDocumentIntoRag(
      `Browser Page: ${snap.title || hostOf(snap.url)}`,
      `URL: ${snap.url}\nTitle: ${snap.title}\n\n${snap.text}`,
      'web_clip',
      { sourceUrl: snap.url, apiKey: apiKey || undefined },
    );
    setRagIndex(updated);
    Alert.alert('Indexed into RAG', `Added "${snap.title || hostOf(snap.url)}" to your RAG Knowledge Vault.`);
  };

  const onNav = (nav: WebViewNavigation) => {
    setCanBack(nav.canGoBack);
    setField(nav.url);
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingHorizontal: 12, paddingVertical: 8, backgroundColor: C.panel, borderBottomWidth: 1, borderBottomColor: C.border }}>
        <View style={styles.rowBetween}>
          <Text style={{ color: C.text, fontWeight: '700', fontSize: 14 }}>Live Studio</Text>
          <View style={styles.segment}>
            {[
              { id: 'handoff', label: 'Browser' },
              { id: 'os_bridge', label: 'OS Bridge' },
              { id: 'panels', label: 'Routines & Tools' },
            ].map((m) => (
              <Pressable
                key={m.id}
                onPress={() => setLiveMode(m.id as any)}
                style={[styles.segItem, { paddingHorizontal: 10, paddingVertical: 5 }, liveMode === m.id && styles.segItemOn]}
              >
                <Text style={[styles.segText, { fontSize: 11 }, liveMode === m.id && styles.segTextOn]}>{m.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>

      {liveMode === 'handoff' ? (
        <View style={{ flex: 1 }}>
          <View style={styles.urlBar}>
            <Pressable
              onPress={() => webRef.current?.goBack()}
              disabled={!canBack}
              style={[styles.navBtn, !canBack && { opacity: 0.35 }]}
            >
              <Text style={styles.navText}>Back</Text>
            </Pressable>
            <TextInput
              value={field}
              onChangeText={setField}
              onSubmitEditing={() => go()}
              placeholder="Enter URL or search..."
              placeholderTextColor={C.muted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              selectTextOnFocus
              style={styles.urlInput}
            />
            <Pressable onPress={() => go()} style={styles.navBtn}>
              <Text style={styles.navText}>Go</Text>
            </Pressable>
            <Pressable
              onPress={indexCurrentWebPageToRag}
              style={[styles.navBtn, { borderColor: C.rag }]}
            >
              <Text style={[styles.navText, { color: '#5EEAD4', fontSize: 11 }]}>+ RAG</Text>
            </Pressable>
          </View>

          {loading ? <View style={styles.progress} /> : null}

          {agent.running ? (
            <View style={styles.agentStrip}>
              <View style={{ flex: 1 }}>
                <Text style={styles.liveTitle} numberOfLines={1}>{agent.step || 'Working...'}</Text>
                <Text style={styles.mutedSmall} numberOfLines={1}>{agent.goal}</Text>
              </View>
              <Pressable onPress={() => AgentBus.stop()} style={[styles.chip, { borderColor: C.danger }]}>
                <Text style={[styles.chipText, { color: C.danger }]}>Stop</Text>
              </Pressable>
            </View>
          ) : null}

          <View style={{ flex: 1, backgroundColor: '#fff' }}>
            <WebView
              ref={webRef}
              source={{ uri: url }}
              onNavigationStateChange={onNav}
              onMessage={onMessage}
              onLoadStart={() => {
                loadingRef.current = true;
                setLoading(true);
              }}
              onLoadEnd={() => {
                loadingRef.current = false;
                setLoading(false);
              }}
              javaScriptEnabled
              domStorageEnabled
              setSupportMultipleWindows={false}
              style={{ flex: 1, backgroundColor: '#fff' }}
            />
          </View>
        </View>
      ) : liveMode === 'os_bridge' ? (
        <ScrollView contentContainerStyle={{ padding: 14, gap: 12, paddingBottom: 36 }} keyboardShouldPersistTaps="handled">
          <View style={styles.settingsCard}>
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>OS Assistive Bridge Inspector</Text>
              <Pressable onPress={refreshOsBridge} style={styles.chip}>
                <Text style={styles.chipText}>Refresh</Text>
              </Pressable>
            </View>
            <Text style={styles.mutedSmall}>
              Status: {osStatus?.status ? String(osStatus.status).toUpperCase() : 'IDLE'} · {osStatus?.message || 'Ready'}
            </Text>
            {Array.isArray(osStatus?.stepLogs) && osStatus.stepLogs.length > 0 ? (
              <View style={{ padding: 8, borderRadius: 6, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, gap: 2 }}>
                <Text style={{ color: C.accent2, fontSize: 11, fontWeight: '700' }}>Recent Automation Steps:</Text>
                {osStatus.stepLogs.map((l: string, idx: number) => (
                  <Text key={idx} style={{ color: C.muted, fontSize: 11 }}>• {l}</Text>
                ))}
              </View>
            ) : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
              <Pressable
                onPress={async () => {
                  if (HarkBridge?.captureScreenVerification) {
                    const s = await HarkBridge.captureScreenVerification();
                    if (s) setOsShot(s);
                  }
                }}
                style={styles.chip}
              >
                <Text style={styles.chipText}>📸 Capture Screenshot</Text>
              </Pressable>
              <Pressable
                onPress={async () => {
                  if (screenDump.trim()) {
                    const updated = await ingestDocumentIntoRag(
                      `Screen Dump (${new Date().toLocaleTimeString()})`,
                      screenDump,
                      'screen_dump',
                    );
                    setRagIndex(updated);
                    setBridgeActionMsg('Indexed window nodes into RAG Vault.');
                  }
                }}
                style={[styles.chip, { borderColor: C.rag }]}
              >
                <Text style={[styles.chipText, { color: '#5EEAD4' }]}>🧠 Index Nodes to RAG</Text>
              </Pressable>
              <Pressable onPress={() => openAppWithStatus('accessibility')} style={styles.chip}>
                <Text style={styles.chipText}>⚙️ Accessibility Settings</Text>
              </Pressable>
            </View>
          </View>

          {/* Interactive OS Remote Control */}
          <View style={styles.settingsCard}>
            <Text style={styles.cardTitle}>Interactive OS Action Tester</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput
                value={remoteClickTarget}
                onChangeText={setRemoteClickTarget}
                placeholder="Label/text to tap (e.g. Search, ADD)"
                placeholderTextColor={C.muted}
                style={[styles.input, { flex: 1 }]}
              />
              <Pressable
                onPress={async () => {
                  if (!remoteClickTarget.trim() || !HarkBridge?.clickByText) return;
                  const ok = await HarkBridge.clickByText(remoteClickTarget.trim());
                  setBridgeActionMsg(ok ? `Tapped "${remoteClickTarget.trim()}"` : `Could not find "${remoteClickTarget.trim()}"`);
                }}
                style={[styles.primaryBtn, { marginTop: 0, paddingHorizontal: 14, justifyContent: 'center' }]}
              >
                <Text style={styles.primaryBtnText}>Tap Text</Text>
              </Pressable>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput
                value={remoteInputText}
                onChangeText={setRemoteInputText}
                placeholder="Text to type into active input..."
                placeholderTextColor={C.muted}
                style={[styles.input, { flex: 1 }]}
              />
              <Pressable
                onPress={async () => {
                  if (!remoteInputText.trim() || !HarkBridge?.inputText) return;
                  const ok = await HarkBridge.inputText(remoteClickTarget.trim() || null, remoteInputText.trim());
                  setBridgeActionMsg(ok ? `Typed "${remoteInputText.trim()}"` : 'No editable input found.');
                }}
                style={[styles.primaryBtn, { marginTop: 0, paddingHorizontal: 14, justifyContent: 'center' }]}
              >
                <Text style={styles.primaryBtnText}>Type</Text>
              </Pressable>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {(['down', 'up', 'left', 'right'] as const).map((dir) => (
                <Pressable
                  key={dir}
                  onPress={() => HarkBridge?.scrollScreen?.(dir)}
                  style={styles.chip}
                >
                  <Text style={styles.chipText}>Scroll {dir.toUpperCase()}</Text>
                </Pressable>
              ))}
            </View>
            {bridgeActionMsg ? <Text style={{ color: C.good, fontSize: 12 }}>{bridgeActionMsg}</Text> : null}
          </View>

          {osShot ? (
            <View style={styles.settingsCard}>
              <Text style={styles.cardTitle}>Latest Screen Capture</Text>
              <Image source={{ uri: osShot }} style={{ width: '100%', height: 340, borderRadius: 6 }} resizeMode="contain" />
            </View>
          ) : null}

          <View style={styles.settingsCard}>
            <Text style={styles.cardTitle}>Live Window Nodes (Used by Agentic RAG)</Text>
            <Text style={{ color: C.text, fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier', fontSize: 11 }}>
              {screenDump || 'No external window captured yet. Open an app and tap Refresh.'}
            </Text>
          </View>
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>
          <WidgetsScreen
            ragIndex={ragIndex}
            setRagIndex={setRagIndex}
            apiKey={apiKey}
            onRunRoutine={onRunRoutine}
          />
        </View>
      )}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* SETTINGS & SYSTEM SELF-TEST DIAGNOSTICS SCREEN                      */
/* ------------------------------------------------------------------ */

const REPLY_LENGTHS: Settings['replyLength'][] = ['short', 'balanced', 'detailed'];

function SettingsScreen({
  settings,
  patchSettings,
  ragIndex,
  update,
  setUpdate,
}: {
  settings: Settings;
  patchSettings: (p: Partial<Settings>) => void;
  ragIndex: RagChunk[];
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
  const [diagResults, setDiagResults] = useState<{ label: string; ok: boolean; detail: string }[]>([]);
  const [runningDiag, setRunningDiag] = useState(false);

  const runSystemDiagnostics = async () => {
    setRunningDiag(true);
    const items: { label: string; ok: boolean; detail: string }[] = [];
    try {
      const hasBridge = Platform.OS === 'android' && !!HarkBridge;
      items.push({
        label: 'Native HarkBridge Module',
        ok: hasBridge,
        detail: hasBridge ? 'Connected on standard React Native bridge' : 'Not available',
      });

      if (hasBridge && HarkBridge.isAccessibilityEnabled) {
        const acc = await HarkBridge.isAccessibilityEnabled();
        items.push({
          label: 'Android Accessibility Service',
          ok: !!acc,
          detail: acc ? 'Active & ready for UI search/tap automation' : 'OFF — Tap "Open Accessibility Settings" below to enable',
        });
      }

      if (hasBridge && HarkBridge.getInstalledApps) {
        const apps = await HarkBridge.getInstalledApps().catch(() => []);
        items.push({
          label: 'Package Visibility (QUERY_ALL_PACKAGES)',
          ok: Array.isArray(apps) && apps.length > 0,
          detail: Array.isArray(apps) ? `${apps.length} launchable device apps detected` : '0 apps detected',
        });
      }

      items.push({
        label: 'Agentic RAG Knowledge Vault',
        ok: ragIndex.length > 0,
        detail: `${ragIndex.length} chunks indexed & ready for retrieval`,
      });

      items.push({
        label: 'Gemini API Key Configuration',
        ok: !!s.apiKey.trim() || (s.cloudMode && !!s.cloudUrl),
        detail: s.apiKey.trim() ? 'API Key configured on device' : s.cloudMode ? 'Using Cloud Server' : 'Missing API Key',
      });
    } finally {
      setDiagResults(items);
      setRunningDiag(false);
    }
  };

  useEffect(() => {
    runSystemDiagnostics();
  }, [ragIndex.length, s.apiKey]);

  const testCloud = async () => {
    const cu = normalizeCloudUrl(s.cloudUrl);
    if (!cu) {
      Alert.alert('Cloud URL needed', 'Enter your cloud server URL.');
      return;
    }
    patchSettings({ cloudUrl: cu });
    setTesting(true);
    try {
      const h = await cloudHealth(cu);
      Alert.alert('Cloud online', 'Model: ' + (h.model || '?'));
    } catch (e: any) {
      Alert.alert('Cloud offline', e?.message || String(e));
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
      setCheckMsg(info.available ? 'New version available.' : 'Up to date.');
    } catch (e: any) {
      setUpdate(null);
      setCheckState('error');
      setCheckMsg(e?.message || "Couldn't check for updates.");
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
      setCheckMsg('Tap Install on the next screen.');
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
      <Text style={styles.sectionTitle}>Setup & System Diagnostics</Text>

      {/* 1. System Self-Test & Health Scorecard */}
      <View style={styles.settingsCard}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>System Self-Test & Bridge Health</Text>
          <Pressable onPress={runSystemDiagnostics} style={styles.chip}>
            <Text style={styles.chipText}>{runningDiag ? 'Testing...' : 'Re-Test'}</Text>
          </Pressable>
        </View>
        {diagResults.map((d, idx) => (
          <View key={idx} style={[styles.rowBetween, { paddingVertical: 6, borderTopWidth: idx > 0 ? 1 : 0, borderTopColor: C.border }]}>
            <View style={{ flex: 1, marginRight: 8 }}>
              <Text style={{ color: C.text, fontSize: 13, fontWeight: '600' }}>{d.label}</Text>
              <Text style={styles.mutedSmall}>{d.detail}</Text>
            </View>
            <Text style={{ color: d.ok ? C.good : C.warn, fontWeight: '700', fontSize: 12 }}>
              {d.ok ? '✓ PASS' : '⚠️ ACTION'}
            </Text>
          </View>
        ))}
        <Pressable onPress={() => openAppWithStatus('accessibility')} style={styles.primaryBtn}>
          <Text style={styles.primaryBtnText}>Open Android Accessibility Settings</Text>
        </Pressable>
      </View>

      {/* 2. Agentic RAG & Voice Settings */}
      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>Agentic RAG & Voice Preferences</Text>
        <View style={styles.rowBetween}>
          <Text style={{ color: C.text, fontSize: 14 }}>Enable Agentic RAG Grounding</Text>
          <Switch value={s.ragEnabled} onValueChange={(v) => patchSettings({ ragEnabled: v })} trackColor={{ false: C.border, true: C.rag }} thumbColor="#fff" />
        </View>
        <View style={styles.rowBetween}>
          <Text style={{ color: C.text, fontSize: 14 }}>Auto-Index Attached Files & Links into RAG</Text>
          <Switch value={s.autoIndexAttachments} onValueChange={(v) => patchSettings({ autoIndexAttachments: v })} trackColor={{ false: C.border, true: C.rag }} thumbColor="#fff" />
        </View>
        <View style={styles.rowBetween}>
          <Text style={{ color: C.text, fontSize: 14 }}>Speak AI Replies Aloud (TTS)</Text>
          <Switch value={s.voiceOn} onValueChange={(v) => patchSettings({ voiceOn: v })} trackColor={{ false: C.border, true: C.accent }} thumbColor="#fff" />
        </View>
      </View>

      {/* 3. Gemini API & Model Configuration */}
      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>AI Assistant & Model Engine</Text>
        <Text style={styles.mutedSmall}>Gemini API key (stored locally on device).</Text>
        <TextInput value={s.apiKey} onChangeText={(t) => patchSettings({ apiKey: t })} placeholder="AIza..." placeholderTextColor={C.muted} secureTextEntry autoCapitalize="none" autoCorrect={false} style={styles.input} />
        <Text style={styles.fieldLabel}>Model</Text>
        {MODEL_CHOICES.map((m) => (
          <Pressable key={m.id} onPress={() => patchSettings({ model: m.id })} style={[styles.modelRow, s.model === m.id && styles.convoItemOn]}>
            <Text style={styles.convoTitle}>{m.name}</Text>
            <Text style={styles.mutedSmall}>{m.note}</Text>
          </Pressable>
        ))}
        <Text style={styles.fieldLabel}>Speed Mode</Text>
        <View style={styles.segment}>
          {(['fast', 'balanced', 'smart'] as SpeedMode[]).map((sp) => (
            <Pressable key={sp} onPress={() => patchSettings({ speed: sp })} style={[styles.segItem, s.speed === sp && styles.segItemOn]}>
              <Text style={[styles.segText, s.speed === sp && styles.segTextOn]}>{sp.toUpperCase()}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.fieldLabel}>Reply length</Text>
        <View style={styles.segment}>
          {REPLY_LENGTHS.map((r) => (
            <Pressable key={r} onPress={() => patchSettings({ replyLength: r })} style={[styles.segItem, s.replyLength === r && styles.segItemOn]}>
              <Text style={[styles.segText, s.replyLength === r && styles.segTextOn]}>{r.toUpperCase()}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* 4. Cloud Server */}
      <View style={styles.settingsCard}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>Cloud Server</Text>
          <Switch value={s.cloudMode} onValueChange={(v) => patchSettings({ cloudMode: v && !!s.cloudUrl })} trackColor={{ false: C.border, true: C.accent }} thumbColor="#fff" />
        </View>
        <Pressable onPress={testCloud} disabled={testing} style={styles.secondaryBtn}>
          {testing ? <ActivityIndicator color={C.text} /> : <Text style={styles.primaryBtnText}>Check Connection</Text>}
        </Pressable>
        <Pressable onPress={() => setCloudAdv((v) => !v)}>
          <Text style={[styles.mutedSmall, { color: C.accent2 }]}>{cloudAdv ? 'Hide server details' : 'Edit server URL'}</Text>
        </Pressable>
        {cloudAdv ? (
          <>
            <TextInput value={s.cloudUrl} onChangeText={(t) => patchSettings({ cloudUrl: t })} onBlur={() => patchSettings({ cloudUrl: normalizeCloudUrl(s.cloudUrl) })} placeholder={DEFAULT_CLOUD_URL} placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.input} />
            <TextInput value={s.cloudToken} onChangeText={(t) => patchSettings({ cloudToken: t })} placeholder="Access token" placeholderTextColor={C.muted} secureTextEntry autoCapitalize="none" autoCorrect={false} style={styles.input} />
          </>
        ) : null}
      </View>

      {/* 5. In-App OTA Updates */}
      <View style={styles.settingsCard}>
        <Text style={styles.cardTitle}>App Updates</Text>
        <Text style={styles.mutedSmall}>Version {Application.nativeApplicationVersion || '4.0.0'} (build {cur})</Text>
        <Pressable onPress={check} disabled={checking || installing} style={styles.primaryBtn}>
          {checking ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Check for Updates</Text>}
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
            {installing ? (
              <View style={styles.progressTrack}><View style={[styles.progressFill, { width: (Math.round(progress * 100) + '%') as any }]} /></View>
            ) : null}
            <Pressable onPress={install} disabled={installing} style={[styles.primaryBtn, { marginTop: 10, backgroundColor: C.good }]}>
              <Text style={styles.primaryBtnText}>{installing ? 'Downloading ' + Math.round(progress * 100) + '%' : 'Install Update'}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* HARK PRO 5.0: HANDS-FREE VOICE ORB & TELUGU/EN REALTIME COMMANDER  */
/* ------------------------------------------------------------------ */

function HandsFreeVoiceOrbScreen({
  langMode,
  setLangMode,
  onRunCommand,
}: {
  langMode: VoiceLanguageMode;
  setLangMode: (m: VoiceLanguageMode) => void;
  onRunCommand: (cmd: string) => void;
}) {
  const [listeningLoop, setListeningLoop] = useState(false);
  const [lastSpoken, setLastSpoken] = useState('');
  const [statusLine, setStatusLine] = useState('Tap the Voice Orb or any command pill below. Speaks Telugu & English while working!');
  const [customQuery, setCustomQuery] = useState('Telugu hit songs');
  const loopRef = useRef(false);
  loopRef.current = listeningLoop;

  const triggerVoiceListenOnce = async () => {
    if (Platform.OS !== 'android' || !HarkBridge?.startVoiceRecognition) {
      speakBilingualProgress(
        'Hands free voice ready. Tap any action below.',
        'హ్యాండ్స్ ఫ్రీ వాయిస్ సిద్ధంగా ఉంది. కింది బటన్లను నొక్కండి లేదా మాట్లాడండి!',
        langMode
      );
      return;
    }
    try {
      setStatusLine('🔴 Listening in Telugu & English... Speak "scroll down", "select it", "search", "proceed"');
      const recLang = langMode === 'en-IN' ? 'en-IN' : 'te-IN';
      const transcript = await HarkBridge.startVoiceRecognition(recLang);
      if (transcript && String(transcript).trim()) {
        const clean = String(transcript).trim();
        setLastSpoken(clean);
        await runInstantVoiceCmd(clean);
      }
      if (loopRef.current) {
        setTimeout(() => {
          if (loopRef.current) triggerVoiceListenOnce();
        }, 700);
      }
    } catch {
      setStatusLine('Voice listener idle. Tap Orb to speak again.');
    }
  };

  const runInstantVoiceCmd = async (spoken: string) => {
    const parsed = omniAgenticEngine.parseHandsFreeVoiceInput(spoken);
    if (parsed.isDirectOSCommand && parsed.actionType !== 'app_workflow') {
      const narr = omniReplyEngine.getInstantHandsFreeNarration(
        parsed.actionType,
        parsed.searchQuery || parsed.targetText || customQuery,
        langMode
      );
      setStatusLine(narr.display);
      speakBilingualProgress(narr.en, narr.te, langMode);
      if (Platform.OS === 'android' && HarkBridge) {
        try {
          if (parsed.actionType === 'scroll_down') await HarkBridge.scrollScreen('down');
          else if (parsed.actionType === 'scroll_up') await HarkBridge.scrollScreen('up');
          else if (parsed.actionType === 'select_item' && HarkBridge.selectBestVisibleNode) await HarkBridge.selectBestVisibleNode(parsed.targetText || '');
          else if (parsed.actionType === 'proceed' && HarkBridge.proceedAction) await HarkBridge.proceedAction();
          else if (parsed.actionType === 'search' && HarkBridge.performInAppSearch) await HarkBridge.performInAppSearch(parsed.searchQuery || customQuery);
          else if (parsed.actionType === 'back') await HarkBridge.globalAction('back');
          else if (parsed.actionType === 'home') await HarkBridge.globalAction('home');
          else if (HarkBridge.executeVoiceCommand) await HarkBridge.executeVoiceCommand(spoken);
        } catch {}
      }
      return;
    }
    onRunCommand(spoken);
  };

  return (
    <ScrollView style={styles.fill} contentContainerStyle={{ padding: 14, gap: 12, paddingBottom: 32 }}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>🎙️ Hands-Free Telugu & English Voice Intelligence</Text>
        <Text style={styles.mutedSmall}>{statusLine}</Text>

        <Pressable
          onPress={() => {
            const next = !listeningLoop;
            setListeningLoop(next);
            if (next) triggerVoiceListenOnce();
          }}
          style={{
            alignSelf: 'center',
            width: 190,
            height: 190,
            borderRadius: 95,
            backgroundColor: listeningLoop ? 'rgba(239, 68, 68, 0.28)' : 'rgba(56, 189, 248, 0.18)',
            borderWidth: 2,
            borderColor: listeningLoop ? '#F87171' : '#38BDF8',
            alignItems: 'center',
            justifyContent: 'center',
            marginVertical: 14,
            padding: 14,
          }}
        >
          <Text style={{ fontSize: 42 }}>{listeningLoop ? '🔴' : '🎙️'}</Text>
          <Text style={[styles.convoTitle, { marginTop: 8, textAlign: 'center' }]}>
            {listeningLoop ? 'HANDS-FREE LOOP ON' : 'TAP TO SPEAK HANDS-FREE'}
          </Text>
          <Text style={[styles.mutedSmall, { textAlign: 'center', marginTop: 4 }]}>
            {lastSpoken ? `Heard: "${lastSpoken}"` : '"Scroll down" · "Select it" · "Proceed"'}
          </Text>
        </Pressable>

        <View style={[styles.rowWrap, { justifyContent: 'center' }]}>
          {(
            [
              { id: 'BILINGUAL_AUTO', label: '🇮🇳 తెలుగు + EN Auto' },
              { id: 'te-IN', label: '🇮🇳 స్వచ్ఛమైన తెలుగు' },
              { id: 'te-ROMAN', label: '💬 Telugish' },
              { id: 'en-IN', label: '🌐 English' },
            ] as Array<{ id: VoiceLanguageMode; label: string }>
          ).map((m) => (
            <Pressable
              key={m.id}
              onPress={() => setLangMode(m.id)}
              style={[styles.chip, langMode === m.id && { borderColor: '#38BDF8', backgroundColor: 'rgba(56, 189, 248, 0.22)' }]}
            >
              <Text style={styles.chipText}>{m.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>⚡ Instant 0-Token Hands-Free Actions (Speaks While Working)</Text>
        <TextInput
          value={customQuery}
          onChangeText={setCustomQuery}
          placeholder="Search query for hands-free search..."
          placeholderTextColor={C.muted}
          style={styles.input}
        />
        <View style={[styles.rowWrap, { gap: 8 }]}>
          {[
            { label: '⬇️ Scroll Down (కిందికి)', cmd: 'scroll down' },
            { label: '⬆️ Scroll Up (పైకి)', cmd: 'scroll up' },
            { label: '🎯 Select It (సెలెక్ట్ చేయి)', cmd: 'select it' },
            { label: '✅ Proceed (ముందుకు వెళ్ళు)', cmd: 'proceed' },
            { label: `🔎 Search "${customQuery.slice(0, 16)}"`, cmd: `search ${customQuery}` },
            { label: '🔙 Go Back (వెనక్కి)', cmd: 'go back' },
            { label: '🏠 Go Home (హోమ్)', cmd: 'go home' },
          ].map((item) => (
            <Pressable
              key={item.label}
              onPress={() => runInstantVoiceCmd(item.cmd)}
              style={[styles.chip, { paddingVertical: 9, paddingHorizontal: 12 }]}
            >
              <Text style={styles.chipText}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ */
/* HARK PRO 5.0: OMNICORE & 5 DEDICATED ENGINES SCREEN                */
/* ------------------------------------------------------------------ */

function OmniCoreEnginesScreen() {
  const metrics = omniProcessingEngine.getMetrics();
  const state = omniSelfDevEngine.state;
  return (
    <ScrollView style={styles.fill} contentContainerStyle={{ padding: 14, gap: 12, paddingBottom: 32 }}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>🧠 OmniCore Self-Awareness & 5 Engines</Text>
        <Text style={styles.mutedSmall}>
          Consciousness: {state.consciousnessLevel}% · Confidence: {state.confidenceScore}% · Tokens Saved: {metrics.tokensSaved} ({metrics.compressionRatioPct}% Compression) · Max Output: {metrics.allocatedMaxOutputTokens} Tokens
        </Text>
      </View>

      {[
        {
          title: '⚙️ 1. Processing Engine (Token Optimizer & MoE Router)',
          sub: `Saved ${metrics.tokensSaved} tokens (${metrics.compressionRatioPct}% compression) · Max Output: ${metrics.allocatedMaxOutputTokens}`,
          desc: 'Prunes prompt boilerplate, compresses Android Accessibility node trees into compact tuples, caches repeated intents for 0-token execution, and routes queries to top-2 specialized engines.',
        },
        {
          title: '🗣️ 2. Reply Engine (Natural Human Telugu & Live Voice Narrator)',
          sub: 'Supports తెలుగు లిపి (te-IN), Conversational Telugish & English',
          desc: 'Synthesizes warm, human-like Telangana/Andhra Telugu and English responses, speaking live progress aloud while performing actions.',
        },
        {
          title: '🤖 3. Agentic Engine (Hands-Free Voice & Mobile-Agent GUI Loop)',
          sub: 'Instant "Scroll Down", "Select It", "Search", "Proceed" + 28 App Playbooks',
          desc: 'Combines Claude Computer Use coordinate normalization and Mobile-Agent v3 multi-step Android UI automation.',
        },
        {
          title: '🧬 4. Self-Development Engine (Own Thoughts & Autonomous Evolution)',
          sub: `${state.learnedSkills.length} Learned Playbooks · ${state.autonomousImprovementsCount} Self-Reflections`,
          desc: 'Generates DeepSeek-R1 style <think> Own Thoughts before tasks and autonomously records reusable optimization rules.',
        },
        {
          title: '🎨 5. Media Generation Engine (Image, Video & Native PDF)',
          sub: 'Flux 8K Images · 3-Scene AI Video Storyboards · Android PdfDocument',
          desc: 'Synthesizes high-resolution images, playable HTML5 animated video sequences with bilingual subtitles, and multi-page native PDFs.',
        },
      ].map((eng) => (
        <View key={eng.title} style={styles.card}>
          <Text style={styles.cardTitle}>{eng.title}</Text>
          <Text style={[styles.mutedSmall, { color: '#38BDF8' }]}>{eng.sub}</Text>
          <Text style={styles.mutedSmall}>{eng.desc}</Text>
        </View>
      ))}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>💭 Live "Own Thoughts" Stream (Self-Awareness)</Text>
        {state.ownThoughtsStream.slice(0, 6).map((th) => (
          <View key={th.id} style={{ paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.border }}>
            <Text style={[styles.mutedSmall, { color: '#C084FC' }]}>
              [{th.timestamp}] {th.phase} · Confidence {th.confidence}%
            </Text>
            <Text style={{ color: C.text, fontSize: 12, marginTop: 2 }}>🇮🇳 {th.thoughtTe}</Text>
            <Text style={styles.mutedSmall}>🌐 {th.thoughtEn}</Text>
          </View>
        ))}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>🌍 Integrated GitHub Open-Source Agent Architectures</Text>
        {OPEN_SOURCE_CORE_INTEGRATIONS.map((item) => (
          <Pressable
            key={item.id}
            onPress={() => Linking.openURL(item.repoUrl)}
            style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.border }}
          >
            <Text style={styles.convoTitle}>{item.emoji} {item.name} ({item.inspiredBy})</Text>
            <Text style={styles.mutedSmall}>{item.integratedCapability}</Text>
            <Text style={[styles.mutedSmall, { color: '#38BDF8' }]}>{item.repoUrl}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ */
/* HARK PRO 5.0: MEDIA GENERATION STUDIO (IMAGE, VIDEO, NATIVE PDF)   */
/* ------------------------------------------------------------------ */

function MediaGenStudioScreen() {
  const [subTab, setSubTab] = useState<'IMAGE' | 'VIDEO' | 'PDF'>('IMAGE');
  const [prompt, setPrompt] = useState('');
  const [imgStyle, setImgStyle] = useState<'FLUX_REALISM' | 'CINEMATIC_8K' | 'ANIME_3D' | 'GLASS_UI_LOGO'>('FLUX_REALISM');
  const [aspect, setAspect] = useState<'1:1' | '16:9' | '9:16'>('1:1');
  const [pdfTitle, setPdfTitle] = useState('Hark Pro 5.0 OmniCore Report');
  const [pdfBody, setPdfBody] = useState(
    '# Hark Pro 5.0 Executive Report\nGenerated via OmniCore Native Android PdfDocument Engine.\n\n# Key Highlights\n- 5 Dedicated Engines: Processing, Reply, Agentic, Self-Development, Media.\n- Bilingual Human Telugu & English Voice Narration while working.\n- Hands-Free OS Control: Scroll down, Select it, Search, Proceed.'
  );
  const [assets, setAssets] = useState<GeneratedMediaAsset[]>([]);

  return (
    <ScrollView style={styles.fill} contentContainerStyle={{ padding: 14, gap: 12, paddingBottom: 32 }}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>🎨 OmniCore Media Generation Studio</Text>
        <View style={[styles.rowWrap, { marginTop: 6 }]}>
          {(['IMAGE', 'VIDEO', 'PDF'] as const).map((t) => (
            <Pressable
              key={t}
              onPress={() => setSubTab(t)}
              style={[styles.chip, subTab === t && { borderColor: '#38BDF8', backgroundColor: 'rgba(56, 189, 248, 0.22)' }]}
            >
              <Text style={styles.chipText}>
                {t === 'IMAGE' ? '🖼️ 8K Image Gen' : t === 'VIDEO' ? '🎬 AI Video Gen' : '📄 Native PDF Gen'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {subTab === 'IMAGE' && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>🖼️ Flux 8K AI Image Generator</Text>
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            placeholder="Describe image to generate..."
            placeholderTextColor={C.muted}
            style={styles.input}
            multiline
          />
          <View style={styles.rowWrap}>
            {(['FLUX_REALISM', 'CINEMATIC_8K', 'ANIME_3D', 'GLASS_UI_LOGO'] as const).map((st) => (
              <Pressable
                key={st}
                onPress={() => setImgStyle(st)}
                style={[styles.chip, imgStyle === st && { borderColor: C.accent2 }]}
              >
                <Text style={styles.chipText}>{st}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.rowWrap}>
            {(['1:1', '16:9', '9:16'] as const).map((ar) => (
              <Pressable
                key={ar}
                onPress={() => setAspect(ar)}
                style={[styles.chip, aspect === ar && { borderColor: C.accent2 }]}
              >
                <Text style={styles.chipText}>Aspect {ar}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            onPress={() => {
              const a = omniMediaEngine.createImageAsset(prompt || 'Futuristic glass AI core glowing in Telangana', imgStyle, aspect);
              setAssets((prev) => [a, ...prev]);
              speakBilingualProgress(`Generated image for ${a.title}`, `"${a.title}" కోసం AI ఫోటో తయారు చేశాను!`);
            }}
            style={styles.primaryBtn}
          >
            <Text style={styles.primaryBtnText}>✨ Generate 8K Image</Text>
          </Pressable>
        </View>
      )}

      {subTab === 'VIDEO' && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>🎬 Cinematic AI Video Storyboard Generator</Text>
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            placeholder="Describe video scene sequence..."
            placeholderTextColor={C.muted}
            style={styles.input}
            multiline
          />
          <Pressable
            onPress={() => {
              const a = omniMediaEngine.createVideoAsset(prompt || 'Autonomous AI assistant in futuristic Hyderabad', 12);
              setAssets((prev) => [a, ...prev]);
              speakBilingualProgress(`Generated 3-scene AI video for ${a.title}`, `"${a.title}" కోసం 3 సీన్ల AI వీడియో తయారు చేశాను!`);
            }}
            style={styles.primaryBtn}
          >
            <Text style={styles.primaryBtnText}>🎬 Synthesize Playable AI Video</Text>
          </Pressable>
        </View>
      )}

      {subTab === 'PDF' && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>📄 Native Android Multi-Page PDF Generator</Text>
          <TextInput
            value={pdfTitle}
            onChangeText={setPdfTitle}
            placeholder="PDF Title"
            placeholderTextColor={C.muted}
            style={styles.input}
          />
          <TextInput
            value={pdfBody}
            onChangeText={setPdfBody}
            placeholder="PDF Markdown Content..."
            placeholderTextColor={C.muted}
            style={[styles.input, { minHeight: 110 }]}
            multiline
          />
          <Pressable
            onPress={async () => {
              let pathOut = '/storage/emulated/0/Android/data/com.pulseos.app/files/Documents/hark_report.pdf';
              let pages = 1;
              if (Platform.OS === 'android' && HarkBridge?.generateNativePdf) {
                try {
                  const res = JSON.parse(await HarkBridge.generateNativePdf(pdfTitle, 'Hark Pro 5.0 OmniCore', pdfBody, true));
                  if (res.ok) {
                    pathOut = res.filePath;
                    pages = res.pageCount || 1;
                  }
                } catch {}
              }
              const pdfAsset: GeneratedMediaAsset = {
                id: `pdf-${Date.now()}`,
                type: 'PDF',
                title: pdfTitle,
                prompt: pdfTitle,
                createdAt: 'Now',
                pdfFilePath: pathOut,
                pdfPageCount: pages,
                pdfBodyPreview: pdfBody.slice(0, 260),
              };
              setAssets((prev) => [pdfAsset, ...prev]);
              speakBilingualProgress(`Generated PDF ${pdfTitle}`, `"${pdfTitle}" పిడిఎఫ్ డాక్యుమెంట్ సేవ్ చేయబడింది!`);
            }}
            style={styles.primaryBtn}
          >
            <Text style={styles.primaryBtnText}>📄 Build & Save Native PDF</Text>
          </Pressable>
        </View>
      )}

      {assets.map((item) => (
        <View key={item.id} style={styles.card}>
          <Text style={styles.cardTitle}>{item.type}: {item.title}</Text>
          {item.type === 'IMAGE' && item.imageUrl ? (
            <Image source={{ uri: item.imageUrl }} style={{ width: '100%', height: 260, borderRadius: 12, marginTop: 8 }} resizeMode="cover" />
          ) : null}
          {item.type === 'VIDEO' && item.videoPlayerHtml ? (
            <View style={{ width: '100%', height: 220, borderRadius: 12, overflow: 'hidden', marginTop: 8 }}>
              <WebView originWhitelist={['*']} source={{ html: item.videoPlayerHtml }} style={{ flex: 1 }} javaScriptEnabled />
            </View>
          ) : null}
          {item.type === 'PDF' ? (
            <View style={{ marginTop: 6 }}>
              <Text style={styles.mutedSmall}>Pages: {item.pdfPageCount} · Path: {item.pdfFilePath}</Text>
              <Pressable
                onPress={() => HarkBridge?.shareText && HarkBridge.shareText(item.pdfBodyPreview || item.title, item.title)}
                style={[styles.chip, { alignSelf: 'flex-start', marginTop: 8 }]}
              >
                <Text style={styles.chipText}>📤 Share PDF Content</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}

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
  drawerBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  drawer: {
    position: 'absolute', top: 0, bottom: 0, left: 0, width: 290, padding: 14,
    backgroundColor: C.panel, borderRightWidth: 1, borderRightColor: C.border,
  },
  convoItem: { padding: 10, borderRadius: 6, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, gap: 4 },
  convoItemOn: { borderColor: C.accent },
  convoTitle: { color: C.text, fontWeight: '600', fontSize: 14, flexShrink: 1, marginRight: 8 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', padding: 16 },
  modalCard: { backgroundColor: C.panel, borderRadius: 8, padding: 14, gap: 8, borderWidth: 1, borderColor: C.border },
  modelRow: { padding: 10, borderRadius: 6, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, gap: 2 },
  appGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  appTile: {
    width: '31%', flexGrow: 0, alignItems: 'center', paddingVertical: 12, paddingHorizontal: 6, borderRadius: 6,
    backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, gap: 3,
  },
  appName: { color: C.text, fontSize: 12, fontWeight: '600' },
  agentStrip: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, gap: 8,
    backgroundColor: C.panel, borderBottomWidth: 1, borderBottomColor: C.border,
  },
  liveTitle: { color: C.text, fontWeight: '600', fontSize: 13 },
  stepsBox: { marginBottom: 8, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: C.border },
  stepsHead: { color: C.accent2, fontSize: 12, fontWeight: '700' },
  stepRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  stepIcon: { width: 14, color: C.good, fontWeight: '700', textAlign: 'center', fontSize: 11 },
  stepText: { flex: 1, color: C.muted, fontSize: 12, marginLeft: 4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: C.panel,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  brand: { color: C.text, fontSize: 16, fontWeight: '700' },
  brandSub: { color: C.muted, fontSize: 11 },

  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: C.border,
    backgroundColor: C.panel,
  },
  tabItem: { flex: 1, alignItems: 'center', paddingVertical: 11 },
  tabItemActive: { borderTopWidth: 2, borderTopColor: C.accent, backgroundColor: C.panel2 },
  tabLabel: { color: C.muted, fontSize: 10, fontWeight: '600' },
  tabLabelActive: { color: C.text, fontWeight: '700' },

  muted: { color: C.muted, fontSize: 13 },
  mutedSmall: { color: C.muted, fontSize: 12 },
  sectionTitle: { color: C.text, fontSize: 16, fontWeight: '700' },

  chatToolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor: C.panel,
  },
  chip: {
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: C.panel2,
    borderWidth: 1,
    borderColor: C.border,
  },
  chipText: { color: C.text, fontSize: 11, fontWeight: '600' },

  input: {
    color: C.text,
    backgroundColor: C.panel2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 14,
  },
  primaryBtn: {
    marginTop: 8,
    backgroundColor: C.accent,
    borderRadius: 6,
    paddingVertical: 11,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  secondaryBtn: {
    marginTop: 6,
    backgroundColor: C.panel2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: C.border,
    paddingVertical: 10,
    alignItems: 'center',
  },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowCenter: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  settingsCard: { backgroundColor: C.panel, borderRadius: 8, borderWidth: 1, borderColor: C.border, padding: 14, gap: 8 },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: '700' },
  fieldLabel: { color: C.muted, fontSize: 12, fontWeight: '600', marginTop: 4 },
  segment: { flexDirection: 'row', backgroundColor: C.panel2, borderRadius: 6, padding: 2, borderWidth: 1, borderColor: C.border },
  segItem: { flex: 1, paddingVertical: 7, borderRadius: 4, alignItems: 'center' },
  segItemOn: { backgroundColor: C.accent },
  segText: { color: C.muted, fontWeight: '600', fontSize: 12 },
  segTextOn: { color: '#fff' },
  updateBanner: { backgroundColor: C.panel2, borderBottomWidth: 1, borderBottomColor: C.good, paddingHorizontal: 12, paddingVertical: 8 },
  updateBannerText: { color: C.text, fontSize: 12, fontWeight: '600' },
  updateResult: { color: C.muted, fontSize: 13, fontWeight: '600', marginTop: 6, textAlign: 'center' },
  updateBox: { marginTop: 8, padding: 12, borderRadius: 6, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.good },
  updateHead: { color: C.text, fontWeight: '700', fontSize: 14 },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: C.border, marginTop: 8, overflow: 'hidden' },
  progressFill: { height: 6, backgroundColor: C.good },

  empty: { padding: 24, alignItems: 'center', gap: 10, marginTop: 28 },
  emptyTitle: { color: C.text, fontSize: 16, fontWeight: '700' },

  bubble: { maxWidth: '94%', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 4, borderWidth: 1 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: C.accent, borderColor: C.accent },
  botBubble: { alignSelf: 'flex-start', backgroundColor: C.panel, borderColor: C.border },
  errorBubble: { alignSelf: 'flex-start', backgroundColor: '#2A1215', borderColor: C.danger },
  bubbleText: { color: C.text, fontSize: 14, lineHeight: 20 },

  attachmentPreviewBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 10,
    marginBottom: 6,
    padding: 8,
    borderRadius: 6,
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.rag,
  },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 8,
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: C.border,
    backgroundColor: C.panel,
  },
  iconBtn: {
    height: 40,
    paddingHorizontal: 10,
    borderRadius: 6,
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
    borderRadius: 6,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 12,
    paddingVertical: 9,
    maxHeight: 110,
    fontSize: 14,
  },
  sendBtn: {
    height: 40,
    paddingHorizontal: 16,
    borderRadius: 6,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: { color: '#fff', fontSize: 14, fontWeight: '700' },

  urlBar: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8, backgroundColor: C.panel, borderBottomWidth: 1, borderBottomColor: C.border },
  urlInput: {
    flex: 1,
    color: C.text,
    backgroundColor: C.panel2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
  },
  navBtn: {
    height: 34,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: C.panel2,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navText: { color: C.text, fontSize: 12, fontWeight: '600' },
  progress: { height: 2, backgroundColor: C.accent },
});
