import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  DeviceEventEmitter,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  NativeModules,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Speech from 'expo-speech';
import * as FileSystem from 'expo-file-system';

import {
  buildAgenticRagContext,
  DEFAULT_RAG_PLAYBOOKS,
  ingestDocumentIntoRag,
  loadRagIndex,
  parsePulseVoiceCommand,
  PULSE_APP_CATALOG,
  PulseParsedIntent,
  RagChunk,
  saveRagIndex,
  syncUserVaultToRag,
  VoiceLanguageMode,
} from './pulseFeatures';

const { PulseBridge } = NativeModules;

/* ------------------------------------------------------------------ */
/* Minimalist Pulse OS Theme                                          */
/* ------------------------------------------------------------------ */

const C = {
  bg: '#090C12',
  surface: '#111622',
  surface2: '#182032',
  border: '#1F293B',
  text: '#F8FAFC',
  muted: '#8B9BB4',
  accent: '#6366F1',
  accentSoft: 'rgba(99, 102, 241, 0.16)',
  cyan: '#38BDF8',
  good: '#10B981',
  warn: '#F59E0B',
  danger: '#EF4444',
};

const STORAGE_SETTINGS = 'pulseos.settings.v3';
const STORAGE_CONVOS = 'pulseos.convos.v2';
const STORAGE_USER_AUTH = 'pulseos.user_auth.v2';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const FAST_MODEL = 'gemini-2.5-flash-lite';
const DEFAULT_UPDATE_REPO = 'RedChip6261/pulse-os-android';

type Tab = 'PULSE' | 'VOICE' | 'APPS';

type Settings = {
  apiKey: string;
  model: string;
  voiceOn: boolean;
  voiceLang: VoiceLanguageMode;
  ragEnabled: boolean;
  autoCheckUpdates: boolean;
};

const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: DEFAULT_MODEL,
  voiceOn: true,
  voiceLang: 'BILINGUAL_AUTO',
  ragEnabled: true,
  autoCheckUpdates: true,
};

type UserProfile = {
  name: string;
  email: string;
  phone: string;
  address: string;
};

const DEFAULT_PROFILE: UserProfile = {
  name: '',
  email: '',
  phone: '',
  address: '',
};

type AttachmentItem = {
  uri: string;
  name: string;
  mimeType: string;
  kind: 'image' | 'video' | 'document' | 'link';
  base64?: string;
  textContent?: string;
};

type AutomationStep = {
  step?: number;
  action: string;
  target?: string;
  value?: string;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  attachment?: AttachmentItem;
  ts: number;
};

type InstalledApp = {
  label: string;
  packageName: string;
};

type UpdateInfo = {
  available: boolean;
  latestBuild: number;
  currentBuild: number;
  tag: string;
  sizeBytes: number;
  browserDownloadUrl: string;
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ------------------------------------------------------------------ */
/* Speech Helper (Coordinates TTS with Continuous Hands-Free Mic)     */
/* ------------------------------------------------------------------ */

function speakPulse(
  enText: string,
  teText?: string,
  langMode: VoiceLanguageMode = 'BILINGUAL_AUTO',
  onFinished?: () => void,
) {
  const cleanEn = (enText || '').trim();
  const cleanTe = (teText || '').trim();
  const hasTeluguChars = /[\u0C00-\u0C7F]/.test(cleanEn);
  const useTe =
    langMode === 'te-IN'
      ? Boolean(cleanTe || hasTeluguChars)
      : langMode === 'BILINGUAL_AUTO' && hasTeluguChars;
  const textToSpeak = useTe ? cleanTe || cleanEn : cleanEn;
  if (!textToSpeak) {
    onFinished?.();
    return;
  }
  const language = useTe ? 'te-IN' : 'en-IN';

  if (Platform.OS === 'android' && PulseBridge?.pauseHandsFreeListening) {
    PulseBridge.pauseHandsFreeListening().catch(() => undefined);
  }
  Speech.stop();
  Speech.speak(textToSpeak.slice(0, 420), {
    language,
    rate: 0.98,
    pitch: 1.0,
    onDone: () => {
      if (Platform.OS === 'android' && PulseBridge?.resumeHandsFreeListening) {
        PulseBridge.resumeHandsFreeListening().catch(() => undefined);
      }
      onFinished?.();
    },
    onStopped: () => {
      if (Platform.OS === 'android' && PulseBridge?.resumeHandsFreeListening) {
        PulseBridge.resumeHandsFreeListening().catch(() => undefined);
      }
    },
    onError: () => {
      if (Platform.OS === 'android' && PulseBridge?.resumeHandsFreeListening) {
        PulseBridge.resumeHandsFreeListening().catch(() => undefined);
      }
      onFinished?.();
    },
  });
}

/* ------------------------------------------------------------------ */
/* Native OS & App Execution Engine                                   */
/* ------------------------------------------------------------------ */

async function launchAppSmart(nameOrPkg: string, query = ''): Promise<{ ok: boolean; label: string; msg: string }> {
  const clean = nameOrPkg.trim();
  const lower = clean.toLowerCase();
  const cat = PULSE_APP_CATALOG.find(
    (a) => a.id === lower || a.name.toLowerCase() === lower || a.aliases.includes(lower),
  );
  const label = cat ? cat.name : clean;
  const targetKey = cat ? cat.id : clean;

  if (Platform.OS === 'android' && PulseBridge?.launchApp) {
    try {
      const ok = await PulseBridge.launchApp(targetKey, query);
      if (ok) {
        return {
          ok: true,
          label,
          msg: query ? `Opened ${label} for "${query}".` : `Opened ${label}.`,
        };
      }
    } catch {}
  }

  if (Platform.OS === 'android' && cat) {
    for (const pkg of cat.packages) {
      try {
        if (PulseBridge?.launchApp) {
          const ok = await PulseBridge.launchApp(pkg, '');
          if (ok) return { ok: true, label, msg: `Opened ${label}.` };
        }
      } catch {}
    }
  }

  return { ok: false, label, msg: `Could not find "${label}" on this device.` };
}

async function resolveContactIfNeeded(nameOrPhone: string): Promise<{ name: string; phone: string }> {
  const clean = nameOrPhone.trim();
  const digits = clean.replace(/[^\d+]/g, '');
  if (digits.length >= 7) {
    return { name: clean, phone: digits };
  }
  if (Platform.OS === 'android' && PulseBridge?.lookupContactPhone) {
    try {
      const res = await PulseBridge.lookupContactPhone(clean);
      if (res?.found && res?.phone) {
        return { name: String(res.name || clean), phone: String(res.phone) };
      }
    } catch {}
  }
  return { name: clean, phone: '' };
}

async function executePulseIntent(
  intent: PulseParsedIntent,
  rawText: string,
): Promise<{ handled: boolean; replyText: string; spokenEn: string; spokenTe: string }> {
  switch (intent.type) {
    case 'HARDWARE_CONTROL': {
      if (Platform.OS === 'android' && PulseBridge) {
        if (intent.hardwareAction === 'torch_on') {
          await PulseBridge.toggleTorch?.(true);
        } else if (intent.hardwareAction === 'torch_off') {
          await PulseBridge.toggleTorch?.(false);
        } else if (intent.hardwareAction === 'volume' && typeof intent.volumePct === 'number') {
          await PulseBridge.setVolume?.(intent.volumePct);
        }
      }
      return {
        handled: true,
        replyText: intent.spokenAckEn,
        spokenEn: intent.spokenAckEn,
        spokenTe: intent.spokenAckTe,
      };
    }

    case 'SCROLL': {
      if (Platform.OS === 'android' && PulseBridge?.scrollScreen) {
        await PulseBridge.scrollScreen(intent.direction || 'down');
      }
      return {
        handled: true,
        replyText: intent.spokenAckEn,
        spokenEn: intent.spokenAckEn,
        spokenTe: intent.spokenAckTe,
      };
    }

    case 'GLOBAL_NAV': {
      if (Platform.OS === 'android' && PulseBridge?.globalAction) {
        await PulseBridge.globalAction(intent.globalAction || 'back');
      }
      return {
        handled: true,
        replyText: intent.spokenAckEn,
        spokenEn: intent.spokenAckEn,
        spokenTe: intent.spokenAckTe,
      };
    }

    case 'CLICK_TEXT': {
      const ok = Platform.OS === 'android' && PulseBridge?.clickByText
        ? await PulseBridge.clickByText(intent.query || '')
        : false;
      const msg = ok ? `Tapped "${intent.query}".` : `Could not find "${intent.query}" on screen.`;
      return { handled: true, replyText: msg, spokenEn: msg, spokenTe: intent.spokenAckTe };
    }

    case 'SELECT_ITEM': {
      if (Platform.OS === 'android' && PulseBridge?.selectBestVisibleNode) {
        await PulseBridge.selectBestVisibleNode(intent.query || '');
      }
      return {
        handled: true,
        replyText: intent.spokenAckEn,
        spokenEn: intent.spokenAckEn,
        spokenTe: intent.spokenAckTe,
      };
    }

    case 'PROCEED': {
      if (Platform.OS === 'android' && PulseBridge?.proceedAction) {
        await PulseBridge.proceedAction();
      }
      return {
        handled: true,
        replyText: intent.spokenAckEn,
        spokenEn: intent.spokenAckEn,
        spokenTe: intent.spokenAckTe,
      };
    }

    case 'SEARCH_IN_APP': {
      if (Platform.OS === 'android' && PulseBridge?.performInAppSearch) {
        await PulseBridge.performInAppSearch(intent.query || '');
      }
      return {
        handled: true,
        replyText: intent.spokenAckEn,
        spokenEn: intent.spokenAckEn,
        spokenTe: intent.spokenAckTe,
      };
    }

    case 'READ_SCREEN': {
      let summary = 'Unable to read screen. Make sure Pulse OS Assistive Bridge is enabled in Settings.';
      if (Platform.OS === 'android' && PulseBridge?.dumpScreenNodes) {
        const dump = await PulseBridge.dumpScreenNodes().catch(() => '');
        if (dump && String(dump).trim()) {
          summary = String(dump).slice(0, 600);
        }
      }
      return {
        handled: true,
        replyText: summary,
        spokenEn: summary.slice(0, 260),
        spokenTe: intent.spokenAckTe,
      };
    }

    case 'OPEN_APP': {
      const res = await launchAppSmart(intent.app || intent.query || rawText, '');
      return {
        handled: true,
        replyText: res.msg,
        spokenEn: res.msg,
        spokenTe: res.ok ? `${res.label} ఓపెన్ చేస్తున్నాను.` : res.msg,
      };
    }

    case 'APP_WORKFLOW': {
      const res = await launchAppSmart(intent.app || '', intent.query || '');
      return {
        handled: true,
        replyText: res.msg,
        spokenEn: res.msg,
        spokenTe: res.ok ? `${res.label} లో ${intent.query} చేస్తున్నాను.` : res.msg,
      };
    }

    case 'CALL_CONTACT': {
      const target = await resolveContactIfNeeded(intent.recipient || '');
      if (target.phone && Platform.OS === 'android' && PulseBridge?.dialPhone) {
        await PulseBridge.dialPhone(target.phone, false);
        const msg = `Calling ${target.name} (${target.phone}).`;
        return { handled: true, replyText: msg, spokenEn: msg, spokenTe: `${target.name} కు కాల్ చేస్తున్నాను.` };
      }
      const res = await launchAppSmart('phone', '');
      return {
        handled: true,
        replyText: target.phone ? res.msg : `Contact "${intent.recipient}" not found. Opened Phone dialer.`,
        spokenEn: `Opened Phone dialer.`,
        spokenTe: 'ఫోన్ డయలర్ ఓపెన్ చేస్తున్నాను.',
      };
    }

    case 'SEND_MESSAGE': {
      const target = await resolveContactIfNeeded(intent.recipient || '');
      const text = intent.message || '';
      if (intent.platform === 'sms') {
        if (target.phone && Platform.OS === 'android' && PulseBridge?.sendSms) {
          await PulseBridge.sendSms(target.phone, text);
          const msg = `Opened SMS to ${target.name}${text ? `: "${text}"` : ''}.`;
          return { handled: true, replyText: msg, spokenEn: msg, spokenTe: `${target.name} కు SMS సిద్ధం చేశాను.` };
        }
        await launchAppSmart('sms', '');
        return { handled: true, replyText: 'Opened Messages.', spokenEn: 'Opened Messages.', spokenTe: 'మెసేజెస్ ఓపెన్ చేస్తున్నాను.' };
      }
      if (Platform.OS === 'android' && PulseBridge?.sendWhatsAppMessage) {
        const ok = await PulseBridge.sendWhatsAppMessage(target.phone || target.name, text);
        if (ok) {
          const msg = `Sending WhatsApp message to ${target.name}${text ? `: "${text}"` : ''}.`;
          return { handled: true, replyText: msg, spokenEn: msg, spokenTe: `${target.name} కు వాట్సాప్ మెసేజ్ పంపుతున్నాను.` };
        }
      }
      const res = await launchAppSmart('whatsapp', '');
      return { handled: true, replyText: res.msg, spokenEn: res.msg, spokenTe: intent.spokenAckTe };
    }

    case 'READ_EMAILS': {
      await launchAppSmart('gmail', '');
      let emailDump = '';
      if (Platform.OS === 'android' && PulseBridge?.readVisibleEmails) {
        await new Promise((r) => setTimeout(r, 1400));
        emailDump = await PulseBridge.readVisibleEmails().catch(() => '');
      }
      const msg = emailDump
        ? `Recent emails in Gmail:\n${emailDump}`
        : 'Opened Gmail. Enable Pulse OS Assistive Bridge in Settings to hear inbox emails read aloud.';
      return {
        handled: true,
        replyText: msg,
        spokenEn: emailDump ? `Here are your recent emails: ${emailDump.slice(0, 260)}` : 'Opened Gmail.',
        spokenTe: emailDump ? 'మీ మెయిల్స్ చదువుతున్నాను.' : 'జిమెయిల్ ఓపెన్ చేస్తున్నాను.',
      };
    }

    case 'CREATE_EMAIL':
    case 'SEND_EMAIL': {
      if (intent.type === 'SEND_EMAIL' && !intent.recipient && !intent.message && !intent.subject) {
        const ok = Platform.OS === 'android' && PulseBridge?.sendVisibleEmail
          ? await PulseBridge.sendVisibleEmail()
          : false;
        const msg = ok ? 'Sent the email.' : 'Tap Send in Gmail or specify recipient, subject, and message.';
        return { handled: true, replyText: msg, spokenEn: msg, spokenTe: intent.spokenAckTe };
      }
      if (Platform.OS === 'android' && PulseBridge?.composeEmail) {
        await PulseBridge.composeEmail(
          intent.recipient || '',
          intent.subject || '',
          intent.message || '',
          intent.type === 'SEND_EMAIL',
        );
        const msg =
          intent.type === 'SEND_EMAIL'
            ? `Sending email${intent.recipient ? ` to ${intent.recipient}` : ''}.`
            : `Created email draft${intent.recipient ? ` to ${intent.recipient}` : ''}.`;
        return { handled: true, replyText: msg, spokenEn: msg, spokenTe: intent.spokenAckTe };
      }
      return { handled: false, replyText: '', spokenEn: '', spokenTe: '' };
    }

    case 'DELETE_EMAIL': {
      const ok = Platform.OS === 'android' && PulseBridge?.deleteVisibleEmail
        ? await PulseBridge.deleteVisibleEmail(intent.query || '')
        : false;
      const msg = ok
        ? 'Deleted the email.'
        : 'Could not delete email automatically. Open the email in Gmail and ensure Assistive Bridge is enabled.';
      return { handled: true, replyText: msg, spokenEn: msg, spokenTe: intent.spokenAckTe };
    }

    default:
      return { handled: false, replyText: '', spokenEn: '', spokenTe: '' };
  }
}

/* ------------------------------------------------------------------ */
/* Gemini Streaming Client (For General Q&A & Complex Reasoning)      */
/* ------------------------------------------------------------------ */

const FALLBACK_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-flash-latest',
  'gemini-2.5-flash-lite',
];

function streamGeminiOnce(
  apiKey: string,
  model: string,
  body: string,
  onPartial?: (txt: string) => void,
): Promise<{ ok: boolean; status: number; text: string; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
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
            if (!p?.thought && typeof p?.text === 'string') {
              full += p.text;
              changed = true;
            }
          }
        } catch {}
      }
      if (changed && onPartial) onPartial(full);
    };
    xhr.open('POST', GEMINI_BASE + encodeURIComponent(model) + ':streamGenerateContent?alt=sse');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('x-goog-api-key', apiKey);
    xhr.timeout = 45000;
    xhr.onprogress = () => {
      if (xhr.status === 200) pump();
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        buffer += '\n';
        pump();
        resolve({ ok: true, status: 200, text: full.trim() || 'Done.' });
      } else {
        let msg = `Gemini HTTP ${xhr.status}`;
        try {
          const parsed = JSON.parse(xhr.responseText);
          const apiMsg = (Array.isArray(parsed) ? parsed[0] : parsed)?.error?.message;
          if (apiMsg) msg = apiMsg;
        } catch {}
        resolve({ ok: false, status: xhr.status, text: '', error: msg });
      }
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, text: '', error: 'Network error' });
    xhr.ontimeout = () =>
      resolve(
        full.trim()
          ? { ok: true, status: 200, text: full.trim() }
          : { ok: false, status: 0, text: '', error: 'Request timed out' },
      );
    xhr.send(body);
  });
}

async function callGeminiChat(
  apiKey: string,
  model: string,
  history: ChatMessage[],
  ragContext: string,
  profile: UserProfile,
  onPartial?: (txt: string) => void,
): Promise<string> {
  const cleanKey = apiKey.trim();
  const sys = [
    'You are Pulse OS, a minimalist, helpful, fast AI assistant on Android.',
    'Answer concisely and clearly in the same language the user uses (English or Telugu).',
    profile.name || profile.address || profile.email
      ? `User Profile: ${[profile.name, profile.email, profile.phone, profile.address].filter(Boolean).join(' | ')}`
      : '',
    ragContext,
  ]
    .filter(Boolean)
    .join('\n\n');

  const contents = history
    .filter((m) => m.role !== 'error' && (m.text.trim() || m.attachment))
    .slice(-10)
    .map((m) => {
      const parts: any[] = [];
      if (m.attachment?.base64 && m.attachment.mimeType) {
        parts.push({ inlineData: { mimeType: m.attachment.mimeType, data: m.attachment.base64 } });
      }
      if (m.attachment?.textContent) {
        parts.push({ text: `[File: ${m.attachment.name}]\n${m.attachment.textContent.slice(0, 20000)}` });
      }
      if (m.text.trim()) parts.push({ text: m.text });
      return { role: m.role === 'user' ? 'user' : 'model', parts };
    });

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: sys }] },
    contents,
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
  });

  const chain: string[] = [];
  if (model && !/1\.5|^gemini-pro$/i.test(model)) chain.push(model);
  for (const fb of FALLBACK_MODELS) {
    if (!chain.includes(fb)) chain.push(fb);
  }

  let lastErr = 'Request failed';
  for (const m of chain) {
    const res = await streamGeminiOnce(cleanKey, m, body, onPartial);
    if (res.ok) return res.text;
    lastErr = res.error || `Gemini HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403 || (res.status === 400 && /api key/i.test(lastErr))) {
      throw new Error('Invalid Gemini API key. Check it in Settings.');
    }
    if (res.status === 0 && lastErr === 'Network error') {
      throw new Error('No internet connection.');
    }
  }
  throw new Error(lastErr);
}

/* ------------------------------------------------------------------ */
/* OTA Update Helpers                                                 */
/* ------------------------------------------------------------------ */

const appConfig = require('./app.json');

function currentBuildNumber(): number {
  const n = Number(appConfig?.expo?.android?.versionCode ?? 36);
  return Number.isFinite(n) ? n : 36;
}

async function checkForUpdate(repo: string): Promise<UpdateInfo> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rel: any = await res.json();
  const asset = (rel.assets || []).find((a: any) => /\.apk$/i.test(String(a?.name)));
  if (!asset) throw new Error('No APK in latest release.');
  const m = String(rel.tag_name).match(/(\d+)\s*$/);
  const latestBuild = m ? parseInt(m[1], 10) : 0;
  const currentBuild = currentBuildNumber();
  return {
    available: latestBuild > currentBuild,
    latestBuild,
    currentBuild,
    tag: String(rel.tag_name),
    sizeBytes: Number(asset.size) || 0,
    browserDownloadUrl: String(asset.browser_download_url || ''),
  };
}

async function downloadAndInstallApk(info: UpdateInfo, onProgress: (f: number) => void) {
  const dest = (FileSystem.cacheDirectory || FileSystem.documentDirectory || '') + `pulse-os-${info.latestBuild}.apk`;
  await FileSystem.deleteAsync(dest, { idempotent: true });
  const task = FileSystem.createDownloadResumable(info.browserDownloadUrl, dest, {}, (p) => {
    const total = p.totalBytesExpectedToWrite > 0 ? p.totalBytesExpectedToWrite : info.sizeBytes;
    if (total > 0) onProgress(Math.min(1, p.totalBytesWritten / total));
  });
  const res = await task.downloadAsync();
  if (!res || (res.status && res.status >= 400)) throw new Error('Download failed');
  onProgress(1);
  if (Platform.OS === 'android' && PulseBridge?.installApk) {
    const ok = await PulseBridge.installApk(dest);
    if (ok) return;
  }
  if (info.browserDownloadUrl) {
    await Linking.openURL(info.browserDownloadUrl);
  }
}

/* ------------------------------------------------------------------ */
/* Main Pulse OS App                                                  */
/* ------------------------------------------------------------------ */

export default function App() {
  const [tab, setTab] = useState<Tab>('PULSE');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [profile, setProfile] = useState<UserProfile>(DEFAULT_PROFILE);
  const [ragIndex, setRagIndex] = useState<RagChunk[]>(DEFAULT_RAG_PLAYBOOKS);
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [bridgeActive, setBridgeActive] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [ready, setReady] = useState(false);

  const checkBridge = useCallback(async () => {
    if (Platform.OS !== 'android' || !PulseBridge?.isAccessibilityEnabled) return;
    try {
      const en = await PulseBridge.isAccessibilityEnabled();
      setBridgeActive(!!en);
    } catch {
      setBridgeActive(false);
    }
  }, []);

  useEffect(() => {
    Speech.stop();
    Promise.all([
      AsyncStorage.getItem(STORAGE_SETTINGS),
      AsyncStorage.getItem(STORAGE_USER_AUTH),
      loadRagIndex(),
    ]).then(async ([sRaw, pRaw, loadedRag]) => {
      if (sRaw) {
        try {
          setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(sRaw) });
        } catch {}
      }
      if (pRaw) {
        try {
          const parsedP = { ...DEFAULT_PROFILE, ...JSON.parse(pRaw) };
          setProfile(parsedP);
          if (Platform.OS === 'android' && PulseBridge?.syncUserLoginData) {
            PulseBridge.syncUserLoginData(JSON.stringify(parsedP)).catch(() => undefined);
          }
        } catch {}
      }
      setRagIndex(loadedRag);
      setReady(true);
      checkBridge();
      if (Platform.OS === 'android' && PulseBridge?.getInstalledApps) {
        PulseBridge.getInstalledApps()
          .then((list: any) => {
            if (Array.isArray(list)) setInstalledApps(list);
          })
          .catch(() => undefined);
      }
      checkForUpdate(DEFAULT_UPDATE_REPO)
        .then((u) => {
          if (u.available) setUpdateInfo(u);
        })
        .catch(() => undefined);
    });

    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') checkBridge();
    });
    return () => sub.remove();
  }, [checkBridge]);

  const patchSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      AsyncStorage.setItem(STORAGE_SETTINGS, JSON.stringify(next)).catch(() => undefined);
      return next;
    });
  }, []);

  const saveProfile = useCallback((next: UserProfile) => {
    setProfile(next);
    const json = JSON.stringify(next);
    AsyncStorage.setItem(STORAGE_USER_AUTH, json).catch(() => undefined);
    if (Platform.OS === 'android' && PulseBridge?.syncUserLoginData) {
      PulseBridge.syncUserLoginData(json).catch(() => undefined);
    }
    syncUserVaultToRag(next).then(setRagIndex).catch(() => undefined);
  }, []);

  if (!ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={C.accent} size="large" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" backgroundColor={C.bg} />

      {/* Minimalist Top Header */}
      <View style={styles.header}>
        <View style={styles.rowCenter}>
          <View style={styles.pulseDot} />
          <Text style={styles.brand}>Pulse OS</Text>
        </View>
        <View style={[styles.rowCenter, { gap: 8 }]}>
          <Pressable
            onPress={() => {
              if (Platform.OS === 'android' && PulseBridge?.openAccessibilitySettings) {
                PulseBridge.openAccessibilitySettings();
              } else {
                Linking.openSettings();
              }
            }}
            style={[styles.pillBtn, { borderColor: bridgeActive ? C.good : C.warn }]}
          >
            <View style={[styles.statusDot, { backgroundColor: bridgeActive ? C.good : C.warn }]} />
            <Text style={styles.pillText}>{bridgeActive ? 'OS Ready' : 'Enable OS'}</Text>
          </Pressable>
          <Pressable onPress={() => setSettingsOpen(true)} style={styles.pillBtn}>
            <Text style={styles.pillText}>Settings</Text>
          </Pressable>
        </View>
      </View>

      {/* Main Content */}
      <View style={{ flex: 1 }}>
        <View style={[styles.fill, tab !== 'PULSE' && styles.hidden]}>
          <PulseChatScreen
            settings={settings}
            profile={profile}
            ragIndex={ragIndex}
            installedApps={installedApps}
            openSettings={() => setSettingsOpen(true)}
          />
        </View>
        <View style={[styles.fill, tab !== 'VOICE' && styles.hidden]}>
          <HandsFreeScreen
            settings={settings}
            patchSettings={patchSettings}
            profile={profile}
            ragIndex={ragIndex}
            installedApps={installedApps}
            openSettings={() => setSettingsOpen(true)}
          />
        </View>
        <View style={[styles.fill, tab !== 'APPS' && styles.hidden]}>
          <AppsScreen installedApps={installedApps} />
        </View>
      </View>

      {/* Clean 3-Tab Bottom Navigation */}
      <View style={styles.tabBar}>
        {(
          [
            { id: 'PULSE', label: 'Pulse' },
            { id: 'VOICE', label: 'Hands-Free' },
            { id: 'APPS', label: 'Apps' },
          ] as { id: Tab; label: string }[]
        ).map((t) => {
          const active = tab === t.id;
          return (
            <Pressable
              key={t.id}
              onPress={() => setTab(t.id)}
              style={[styles.tabItem, active && styles.tabItemActive]}
            >
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* Clean Settings Modal */}
      <Modal visible={settingsOpen} animationType="slide" onRequestClose={() => setSettingsOpen(false)}>
        <SafeAreaView style={styles.root}>
          <SettingsModalContent
            settings={settings}
            patchSettings={patchSettings}
            profile={profile}
            saveProfile={saveProfile}
            ragIndex={ragIndex}
            setRagIndex={setRagIndex}
            bridgeActive={bridgeActive}
            updateInfo={updateInfo}
            setUpdateInfo={setUpdateInfo}
            onClose={() => setSettingsOpen(false)}
          />
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

/* ------------------------------------------------------------------ */
/* 1. PULSE CHAT SCREEN (Clean, Distraction-Free)                     */
/* ------------------------------------------------------------------ */

function PulseChatScreen({
  settings,
  profile,
  ragIndex,
  installedApps,
  openSettings,
}: {
  settings: Settings;
  profile: UserProfile;
  ragIndex: RagChunk[];
  installedApps: InstalledApp[];
  openSettings: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<AttachmentItem | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const isNearBottomRef = useRef(true);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_CONVOS)
      .then((raw) => {
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) setMessages(parsed);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (messages.length > 0) {
      AsyncStorage.setItem(STORAGE_CONVOS, JSON.stringify(messages.slice(-60))).catch(() => undefined);
    }
  }, [messages]);

  const send = async (overrideText?: string) => {
    const rawText = (overrideText ?? input).trim();
    const attached = pendingAttachment;
    if ((!rawText && !attached) || busy) return;

    const text =
      rawText ||
      (attached?.kind === 'image' ? 'Analyze this image.' : 'Summarize this file.');

    const userMsg: ChatMessage = {
      id: uid(),
      role: 'user',
      text,
      attachment: attached || undefined,
      ts: Date.now(),
    };

    setInput('');
    setPendingAttachment(null);
    setMessages((prev) => [...prev, userMsg]);

    // 1. Try local zero-latency PulseVoiceIntentEngine first (works with or without API key!)
    if (!attached) {
      const parsed = parsePulseVoiceCommand(text, installedApps);
      if (parsed.type !== 'CONVERSATION') {
        setBusy(true);
        try {
          const res = await executePulseIntent(parsed, text);
          if (res.handled) {
            const botMsg: ChatMessage = {
              id: uid(),
              role: 'assistant',
              text: res.replyText,
              ts: Date.now(),
            };
            setMessages((prev) => [...prev, botMsg]);
            if (settings.voiceOn) {
              speakPulse(res.spokenEn, res.spokenTe, settings.voiceLang);
            }
            return;
          }
        } finally {
          setBusy(false);
        }
      }
    }

    // 2. Conversational AI via Gemini
    if (!settings.apiKey.trim()) {
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: 'assistant',
          text: 'Device commands work offline, but general AI answers need a Gemini API key. Tap Settings to add one.',
          ts: Date.now(),
        },
      ]);
      return;
    }

    setBusy(true);
    const botId = uid();
    setMessages((prev) => [...prev, { id: botId, role: 'assistant', text: '…', ts: Date.now() }]);

    try {
      const rag = settings.ragEnabled ? buildAgenticRagContext(text, ragIndex, 4) : { contextBlock: '' };
      const answer = await callGeminiChat(
        settings.apiKey,
        settings.model,
        [...messages, userMsg],
        rag.contextBlock,
        profile,
        (partial) => {
          setMessages((prev) => prev.map((m) => (m.id === botId ? { ...m, text: partial } : m)));
        },
      );
      setMessages((prev) => prev.map((m) => (m.id === botId ? { ...m, text: answer } : m)));
      if (settings.voiceOn) {
        speakPulse(answer, '', settings.voiceLang);
      }
    } catch (e: any) {
      setMessages((prev) =>
        prev.map((m) => (m.id === botId ? { ...m, role: 'error', text: e?.message || 'Request failed' } : m)),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleMicTap = async () => {
    if (busy) return;
    Speech.stop();
    if (Platform.OS === 'android' && PulseBridge?.startVoiceRecognition) {
      try {
        setListening(true);
        const recLang = settings.voiceLang === 'te-IN' ? 'te-IN' : 'en-IN';
        const spoken: string = await PulseBridge.startVoiceRecognition(recLang);
        setListening(false);
        if (spoken && spoken.trim()) {
          await send(spoken.trim());
        }
      } catch {
        setListening(false);
      }
    }
  };

  const pickFile = async (kind: 'image' | 'document') => {
    setAttachOpen(false);
    if (Platform.OS === 'android' && PulseBridge?.pickMediaFile) {
      try {
        const res = await PulseBridge.pickMediaFile(kind);
        if (res?.uri) {
          setPendingAttachment({
            uri: String(res.uri),
            name: String(res.name || 'File'),
            mimeType: String(res.mimeType || 'application/octet-stream'),
            kind,
            base64: res.base64 ? String(res.base64) : undefined,
            textContent: res.textContent ? String(res.textContent) : undefined,
          });
        }
      } catch {}
    }
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    isNearBottomRef.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 80;
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 16, paddingBottom: 24, flexGrow: 1 }}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onContentSizeChange={() => {
          if (isNearBottomRef.current) listRef.current?.scrollToEnd({ animated: false });
        }}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyTitle}>Pulse OS</Text>
            <Text style={styles.emptySub}>
              Control your phone with natural commands or ask anything.
            </Text>
            <View style={styles.suggestionWrap}>
              {[
                'Open WhatsApp',
                'Send a message to Rahul saying hi',
                'Read my mails',
                'Scroll down',
              ].map((ex) => (
                <Pressable key={ex} onPress={() => send(ex)} style={styles.suggestionPill}>
                  <Text style={styles.suggestionText}>{ex}</Text>
                </Pressable>
              ))}
            </View>
            {!settings.apiKey.trim() ? (
              <Pressable onPress={openSettings} style={{ marginTop: 18 }}>
                <Text style={{ color: C.cyan, fontSize: 13 }}>Add Gemini API Key in Settings</Text>
              </Pressable>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <View
            style={[
              styles.bubble,
              item.role === 'user'
                ? styles.userBubble
                : item.role === 'error'
                  ? styles.errorBubble
                  : styles.botBubble,
            ]}
          >
            {item.attachment?.kind === 'image' && item.attachment.uri ? (
              <Image
                source={{ uri: item.attachment.uri }}
                style={{ width: 180, height: 130, borderRadius: 10, marginBottom: 6 }}
                resizeMode="cover"
              />
            ) : null}
            {item.attachment && item.attachment.kind !== 'image' ? (
              <Text style={{ color: C.cyan, fontSize: 12, marginBottom: 4 }}>{item.attachment.name}</Text>
            ) : null}
            <Text style={styles.bubbleText}>{item.text}</Text>
          </View>
        )}
      />

      {pendingAttachment ? (
        <View style={styles.attachBar}>
          <Text style={styles.mutedSmall} numberOfLines={1}>
            Attached: {pendingAttachment.name}
          </Text>
          <Pressable onPress={() => setPendingAttachment(null)}>
            <Text style={{ color: C.danger, fontSize: 12, fontWeight: '600' }}>Remove</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Single Clean Minimal Composer */}
      <View style={styles.composer}>
        <Pressable onPress={() => setAttachOpen(true)} style={styles.circleBtn}>
          <Text style={styles.circleBtnText}>+</Text>
        </Pressable>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Message or command Pulse…"
          placeholderTextColor={C.muted}
          style={styles.composerInput}
          multiline
          editable={!busy}
          onSubmitEditing={() => send()}
        />
        <Pressable
          onPress={handleMicTap}
          style={[styles.circleBtn, listening && { borderColor: C.danger, backgroundColor: 'rgba(239,68,68,0.2)' }]}
        >
          <Text style={{ fontSize: 15 }}>{listening ? '■' : '🎙'}</Text>
        </Pressable>
        <Pressable
          onPress={() => send()}
          disabled={busy || (!input.trim() && !pendingAttachment)}
          style={[styles.sendBtn, (busy || (!input.trim() && !pendingAttachment)) && { opacity: 0.45 }]}
        >
          {busy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.sendText}>↑</Text>}
        </Pressable>
      </View>

      <Modal visible={attachOpen} transparent animationType="fade" onRequestClose={() => setAttachOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setAttachOpen(false)}>
          <View style={styles.sheetCard}>
            <Text style={styles.sheetTitle}>Attach</Text>
            <Pressable onPress={() => pickFile('image')} style={styles.sheetRow}>
              <Text style={styles.sheetRowText}>Photo / Image</Text>
            </Pressable>
            <Pressable onPress={() => pickFile('document')} style={styles.sheetRow}>
              <Text style={styles.sheetRowText}>Document / PDF</Text>
            </Pressable>
            {messages.length > 0 ? (
              <Pressable
                onPress={() => {
                  setMessages([]);
                  AsyncStorage.removeItem(STORAGE_CONVOS).catch(() => undefined);
                  setAttachOpen(false);
                }}
                style={styles.sheetRow}
              >
                <Text style={[styles.sheetRowText, { color: C.danger }]}>Clear Chat</Text>
              </Pressable>
            ) : null}
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

/* ------------------------------------------------------------------ */
/* 2. HANDS-FREE VOICE ORB SCREEN (Fixed Continuous Mic + NLU)       */
/* ------------------------------------------------------------------ */

function HandsFreeScreen({
  settings,
  patchSettings,
  profile,
  ragIndex,
  installedApps,
  openSettings,
}: {
  settings: Settings;
  patchSettings: (p: Partial<Settings>) => void;
  profile: UserProfile;
  ragIndex: RagChunk[];
  installedApps: InstalledApp[];
  openSettings: () => void;
}) {
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState('Tap the orb to start Hands-Free Mode');
  const [partial, setPartial] = useState('');
  const [lastHeard, setLastHeard] = useState('');
  const [lastReply, setLastReply] = useState('');
  const [busy, setBusy] = useState(false);
  const activeRef = useRef(false);

  const processSpokenCommand = useCallback(
    async (spoken: string) => {
      const clean = spoken.trim();
      if (!clean) return;
      setLastHeard(clean);
      setPartial('');

      const parsed = parsePulseVoiceCommand(clean, installedApps);
      if (parsed.type !== 'CONVERSATION') {
        setStatus(parsed.spokenAckEn || 'Executing…');
        const res = await executePulseIntent(parsed, clean);
        if (res.handled) {
          setLastReply(res.replyText);
          setStatus(res.replyText);
          speakPulse(res.spokenEn, res.spokenTe, settings.voiceLang);
          return;
        }
      }

      if (!settings.apiKey.trim()) {
        const msg = 'Command not recognized locally. Add a Gemini API key in Settings for full conversational voice.';
        setLastReply(msg);
        setStatus(msg);
        speakPulse(msg, '', settings.voiceLang);
        return;
      }

      setBusy(true);
      setStatus('Thinking…');
      try {
        const rag = settings.ragEnabled ? buildAgenticRagContext(clean, ragIndex, 3) : { contextBlock: '' };
        const answer = await callGeminiChat(
          settings.apiKey,
          settings.model || FAST_MODEL,
          [{ id: 'v1', role: 'user', text: clean, ts: Date.now() }],
          rag.contextBlock,
          profile,
        );
        setLastReply(answer);
        setStatus('Speaking…');
        speakPulse(answer, '', settings.voiceLang, () => {
          if (activeRef.current) setStatus('Listening…');
        });
      } catch (e: any) {
        const err = e?.message || 'Voice error';
        setStatus(err);
      } finally {
        setBusy(false);
      }
    },
    [installedApps, settings.apiKey, settings.model, settings.ragEnabled, settings.voiceLang, ragIndex, profile],
  );

  useEffect(() => {
    const s1 = DeviceEventEmitter.addListener('PulseVoiceStatus', (evt) => {
      if (!activeRef.current) return;
      if (evt?.status === 'listening') setStatus('Listening…');
      else if (evt?.status === 'permission_requested') {
        setStatus('Microphone permission required');
        setActive(false);
        activeRef.current = false;
      }
    });
    const s2 = DeviceEventEmitter.addListener('PulseVoicePartial', (evt) => {
      if (evt?.partial) setPartial(String(evt.partial));
    });
    const s3 = DeviceEventEmitter.addListener('PulseVoiceResult', (evt) => {
      const tr = String(evt?.transcript || '').trim();
      if (tr) processSpokenCommand(tr);
    });
    return () => {
      s1.remove();
      s2.remove();
      s3.remove();
    };
  }, [processSpokenCommand]);

  const toggleHandsFree = async () => {
    if (active) {
      activeRef.current = false;
      setActive(false);
      setPartial('');
      setStatus('Hands-Free paused');
      Speech.stop();
      if (Platform.OS === 'android' && PulseBridge?.stopHandsFreeListening) {
        await PulseBridge.stopHandsFreeListening().catch(() => false);
      }
      return;
    }

    activeRef.current = true;
    setActive(true);
    setStatus('Starting microphone…');
    Speech.stop();

    const recLang = settings.voiceLang === 'te-IN' ? 'te-IN' : 'en-IN';
    if (Platform.OS === 'android' && PulseBridge?.startHandsFreeListening) {
      const ok = await PulseBridge.startHandsFreeListening(recLang).catch(() => false);
      if (ok) {
        setStatus('Listening…');
        return;
      }
      // Fallback to single-shot recognizer if continuous service unavailable
      if (PulseBridge?.startVoiceRecognition) {
        const spoken = await PulseBridge.startVoiceRecognition(recLang).catch(() => '');
        if (spoken && String(spoken).trim()) {
          await processSpokenCommand(String(spoken).trim());
        } else {
          activeRef.current = false;
          setActive(false);
          setStatus('Tap the orb to speak');
        }
        return;
      }
    }
    setStatus('Speech recognition unavailable on this device.');
    activeRef.current = false;
    setActive(false);
  };

  return (
    <View style={styles.voiceRoot}>
      {/* Language Selector */}
      <View style={styles.langRow}>
        {(
          [
            { id: 'BILINGUAL_AUTO', label: 'Auto' },
            { id: 'en-IN', label: 'English' },
            { id: 'te-IN', label: 'తెలుగు' },
          ] as { id: VoiceLanguageMode; label: string }[]
        ).map((l) => (
          <Pressable
            key={l.id}
            onPress={() => patchSettings({ voiceLang: l.id })}
            style={[styles.langPill, settings.voiceLang === l.id && styles.langPillOn]}
          >
            <Text style={[styles.langText, settings.voiceLang === l.id && styles.langTextOn]}>{l.label}</Text>
          </Pressable>
        ))}
      </View>

      {/* Breathing Minimalist Orb */}
      <View style={styles.orbCenter}>
        <Pressable
          onPress={toggleHandsFree}
          style={[
            styles.orbOuter,
            active && styles.orbOuterActive,
          ]}
        >
          <View style={[styles.orbInner, active && styles.orbInnerActive]}>
            {busy ? (
              <ActivityIndicator color="#fff" size="large" />
            ) : (
              <Text style={styles.orbLabel}>{active ? 'Listening' : 'Tap'}</Text>
            )}
          </View>
        </Pressable>

        <Text style={styles.voiceStatus}>{status}</Text>
        {partial ? <Text style={styles.voicePartial}>"{partial}"</Text> : null}
        {lastHeard && !partial ? <Text style={styles.voiceHeard}>You: "{lastHeard}"</Text> : null}
        {lastReply ? (
          <Text style={styles.voiceReply} numberOfLines={4}>
            {lastReply}
          </Text>
        ) : null}
      </View>

      {!settings.apiKey.trim() ? (
        <Pressable onPress={openSettings} style={{ marginBottom: 14 }}>
          <Text style={{ color: C.muted, fontSize: 12 }}>
            Add Gemini API key in Settings for conversational Q&A
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* 3. APPS & QUICK OS CONTROLS SCREEN                                 */
/* ------------------------------------------------------------------ */

function AppsScreen({ installedApps }: { installedApps: InstalledApp[] }) {
  const [query, setQuery] = useState('');
  const [torch, setTorch] = useState(false);

  const filtered = installedApps.filter((a) =>
    a.label.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const displayList =
    filtered.length > 0
      ? filtered
      : PULSE_APP_CATALOG.filter((a) =>
          a.name.toLowerCase().includes(query.trim().toLowerCase()),
        ).map((a) => ({ label: a.name, packageName: a.id }));

  const toggleTorch = async () => {
    if (Platform.OS === 'android' && PulseBridge?.toggleTorch) {
      const next = !torch;
      const ok = await PulseBridge.toggleTorch(next);
      if (ok) setTorch(next);
    }
  };

  return (
    <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 12 }}>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search apps…"
        placeholderTextColor={C.muted}
        style={styles.searchInput}
      />

      <View style={[styles.rowCenter, { gap: 8, marginVertical: 10 }]}>
        <Pressable onPress={toggleTorch} style={[styles.pillBtn, torch && { borderColor: C.warn }]}>
          <Text style={styles.pillText}>{torch ? 'Torch On' : 'Torch Off'}</Text>
        </Pressable>
        <Pressable
          onPress={() => PulseBridge?.openSystemSettings?.('wifi')}
          style={styles.pillBtn}
        >
          <Text style={styles.pillText}>Wi-Fi</Text>
        </Pressable>
        <Pressable
          onPress={() => PulseBridge?.openSystemSettings?.('bluetooth')}
          style={styles.pillBtn}
        >
          <Text style={styles.pillText}>Bluetooth</Text>
        </Pressable>
      </View>

      <FlatList
        data={displayList}
        keyExtractor={(item) => item.packageName}
        numColumns={3}
        columnWrapperStyle={{ gap: 10 }}
        contentContainerStyle={{ gap: 10, paddingBottom: 24 }}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => launchAppSmart(item.packageName, '')}
            style={styles.appCard}
          >
            <View style={styles.appBadge}>
              <Text style={styles.appBadgeText}>{item.label.slice(0, 1).toUpperCase()}</Text>
            </View>
            <Text style={styles.appCardName} numberOfLines={1}>
              {item.label}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* 4. SETTINGS MODAL (Cleanly Hides All Advanced Options)             */
/* ------------------------------------------------------------------ */

function SettingsModalContent({
  settings,
  patchSettings,
  profile,
  saveProfile,
  ragIndex,
  setRagIndex,
  bridgeActive,
  updateInfo,
  setUpdateInfo,
  onClose,
}: {
  settings: Settings;
  patchSettings: (p: Partial<Settings>) => void;
  profile: UserProfile;
  saveProfile: (p: UserProfile) => void;
  ragIndex: RagChunk[];
  setRagIndex: (c: RagChunk[]) => void;
  bridgeActive: boolean;
  updateInfo: UpdateInfo | null;
  setUpdateInfo: (u: UpdateInfo | null) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(profile.name);
  const [email, setEmail] = useState(profile.email);
  const [phone, setPhone] = useState(profile.phone);
  const [address, setAddress] = useState(profile.address);
  const [noteTitle, setNoteTitle] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [checkingUpd, setCheckingUpd] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [updStatus, setUpdStatus] = useState('');

  const handleSaveProfile = () => {
    saveProfile({
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      address: address.trim(),
    });
    Alert.alert('Saved', 'Profile updated.');
  };

  const handleAddNote = async () => {
    if (!noteTitle.trim() || !noteBody.trim()) return;
    const next = await ingestDocumentIntoRag(noteTitle.trim(), noteBody.trim(), 'note');
    setRagIndex(next);
    setNoteTitle('');
    setNoteBody('');
  };

  const handleCheckUpdate = async () => {
    setCheckingUpd(true);
    setUpdStatus('');
    try {
      const info = await checkForUpdate(DEFAULT_UPDATE_REPO);
      setUpdateInfo(info.available ? info : null);
      setUpdStatus(info.available ? `Build ${info.latestBuild} available` : 'Pulse OS is up to date.');
    } catch (e: any) {
      setUpdStatus(e?.message || 'Update check failed');
    } finally {
      setCheckingUpd(false);
    }
  };

  const handleInstallUpdate = async () => {
    if (!updateInfo) return;
    setInstalling(true);
    setProgress(0);
    try {
      await downloadAndInstallApk(updateInfo, setProgress);
    } catch (e: any) {
      setUpdStatus(e?.message || 'Install failed');
    } finally {
      setInstalling(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <Text style={styles.brand}>Settings</Text>
        <Pressable onPress={onClose} style={styles.pillBtn}>
          <Text style={styles.pillText}>Done</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        {/* Assistive Bridge */}
        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <View style={{ flex: 1, marginRight: 10 }}>
              <Text style={styles.cardTitle}>Pulse OS Assistive Bridge</Text>
              <Text style={styles.mutedSmall}>
                {bridgeActive ? 'Enabled — full app, email & scroll control active.' : 'Disabled — enable in Android Accessibility for full control.'}
              </Text>
            </View>
            <Pressable
              onPress={() => PulseBridge?.openAccessibilitySettings?.()}
              style={[styles.pillBtn, { borderColor: bridgeActive ? C.good : C.warn }]}
            >
              <Text style={styles.pillText}>{bridgeActive ? 'Active' : 'Enable'}</Text>
            </Pressable>
          </View>
        </View>

        {/* AI & Voice */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>AI & Voice</Text>
          <Text style={styles.fieldLabel}>Gemini API Key</Text>
          <TextInput
            value={settings.apiKey}
            onChangeText={(t) => patchSettings({ apiKey: t })}
            placeholder="AIza..."
            placeholderTextColor={C.muted}
            secureTextEntry
            autoCapitalize="none"
            style={styles.input}
          />
          <View style={[styles.rowBetween, { marginTop: 8 }]}>
            <Text style={styles.bodyText}>Speak replies aloud</Text>
            <Switch
              value={settings.voiceOn}
              onValueChange={(v) => patchSettings({ voiceOn: v })}
              trackColor={{ false: C.border, true: C.accent }}
              thumbColor="#fff"
            />
          </View>
          <View style={[styles.rowBetween, { marginTop: 6 }]}>
            <Text style={styles.bodyText}>Use Knowledge Vault (RAG)</Text>
            <Switch
              value={settings.ragEnabled}
              onValueChange={(v) => patchSettings({ ragEnabled: v })}
              trackColor={{ false: C.border, true: C.accent }}
              thumbColor="#fff"
            />
          </View>
        </View>

        {/* User Profile */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Your Profile</Text>
          <TextInput value={name} onChangeText={setName} placeholder="Name" placeholderTextColor={C.muted} style={styles.input} />
          <TextInput value={email} onChangeText={setEmail} placeholder="Email" placeholderTextColor={C.muted} autoCapitalize="none" style={styles.input} />
          <TextInput value={phone} onChangeText={setPhone} placeholder="Phone" placeholderTextColor={C.muted} keyboardType="phone-pad" style={styles.input} />
          <TextInput value={address} onChangeText={setAddress} placeholder="Saved Address" placeholderTextColor={C.muted} style={styles.input} />
          <Pressable onPress={handleSaveProfile} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Save Profile</Text>
          </Pressable>
        </View>

        {/* Knowledge Notes */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Knowledge Vault ({ragIndex.length})</Text>
          <TextInput value={noteTitle} onChangeText={setNoteTitle} placeholder="Note title" placeholderTextColor={C.muted} style={styles.input} />
          <TextInput value={noteBody} onChangeText={setNoteBody} placeholder="Details for Pulse to remember…" placeholderTextColor={C.muted} multiline style={[styles.input, { minHeight: 64 }]} />
          <Pressable onPress={handleAddNote} style={styles.secondaryBtn}>
            <Text style={styles.primaryBtnText}>Add to Vault</Text>
          </Pressable>
          {ragIndex.slice(0, 5).map((c) => (
            <View key={c.id} style={[styles.rowBetween, { paddingTop: 6, borderTopWidth: 1, borderTopColor: C.border }]}>
              <Text style={[styles.mutedSmall, { flex: 1 }]} numberOfLines={1}>{c.title}</Text>
              <Pressable
                onPress={() => {
                  const next = ragIndex.filter((x) => x.id !== c.id);
                  setRagIndex(next);
                  saveRagIndex(next);
                }}
              >
                <Text style={{ color: C.danger, fontSize: 11 }}>Delete</Text>
              </Pressable>
            </View>
          ))}
        </View>

        {/* Updates */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Pulse OS Updates</Text>
          <Text style={styles.mutedSmall}>
            Version {appConfig?.expo?.version || '5.2.0'} · Build {currentBuildNumber()}
          </Text>
          <Pressable onPress={handleCheckUpdate} disabled={checkingUpd} style={styles.secondaryBtn}>
            {checkingUpd ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Check for Updates</Text>}
          </Pressable>
          {updStatus ? <Text style={styles.mutedSmall}>{updStatus}</Text> : null}
          {updateInfo?.available ? (
            <Pressable onPress={handleInstallUpdate} disabled={installing} style={[styles.primaryBtn, { backgroundColor: C.good }]}>
              <Text style={styles.primaryBtnText}>
                {installing ? `Downloading ${Math.round(progress * 100)}%` : `Install Build ${updateInfo.latestBuild}`}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Minimalist Styles                                                  */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
    paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight ?? 0 : 0,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg },
  fill: { ...StyleSheet.absoluteFillObject },
  hidden: { display: 'none' },
  rowCenter: { flexDirection: 'row', alignItems: 'center' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor: C.bg,
  },
  pulseDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: C.accent,
    marginRight: 9,
  },
  brand: {
    color: C.text,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  pillBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { color: C.text, fontSize: 12, fontWeight: '600' },

  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: C.border,
    backgroundColor: C.bg,
    paddingBottom: 4,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
  },
  tabItemActive: {
    borderTopWidth: 2,
    borderTopColor: C.accent,
  },
  tabLabel: {
    color: C.muted,
    fontSize: 13,
    fontWeight: '600',
  },
  tabLabelActive: {
    color: C.text,
    fontWeight: '700',
  },

  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  emptyTitle: {
    color: C.text,
    fontSize: 26,
    fontWeight: '700',
    marginBottom: 8,
  },
  emptySub: {
    color: C.muted,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
  },
  suggestionWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
  },
  suggestionPill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  suggestionText: {
    color: C.text,
    fontSize: 12,
    fontWeight: '500',
  },

  bubble: {
    maxWidth: '84%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    marginBottom: 10,
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: C.accent,
    borderBottomRightRadius: 4,
  },
  botBubble: {
    alignSelf: 'flex-start',
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderBottomLeftRadius: 4,
  },
  errorBubble: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(239,68,68,0.14)',
    borderWidth: 1,
    borderColor: C.danger,
  },
  bubbleText: {
    color: C.text,
    fontSize: 14,
    lineHeight: 20,
  },

  attachBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: C.surface,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: C.border,
    backgroundColor: C.bg,
  },
  circleBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  circleBtnText: { color: C.text, fontSize: 20, fontWeight: '500', lineHeight: 22 },
  composerInput: {
    flex: 1,
    minHeight: 38,
    maxHeight: 110,
    color: C.text,
    backgroundColor: C.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 14,
    paddingVertical: 8,
    fontSize: 14,
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.accent,
  },
  sendText: { color: '#fff', fontSize: 17, fontWeight: '700' },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheetCard: {
    backgroundColor: C.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  sheetTitle: { color: C.text, fontSize: 15, fontWeight: '700', marginBottom: 4 },
  sheetRow: {
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  sheetRowText: { color: C.text, fontSize: 15, fontWeight: '500' },

  /* Hands-Free Screen */
  voiceRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 20,
  },
  langRow: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: C.surface,
    padding: 4,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: C.border,
  },
  langPill: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 18,
  },
  langPillOn: {
    backgroundColor: C.accent,
  },
  langText: { color: C.muted, fontSize: 12, fontWeight: '600' },
  langTextOn: { color: '#fff' },

  orbCenter: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  orbOuter: {
    width: 190,
    height: 190,
    borderRadius: 95,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.accentSoft,
    borderWidth: 1.5,
    borderColor: 'rgba(99, 102, 241, 0.35)',
  },
  orbOuterActive: {
    backgroundColor: 'rgba(56, 189, 248, 0.16)',
    borderColor: C.cyan,
  },
  orbInner: {
    width: 136,
    height: 136,
    borderRadius: 68,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
  },
  orbInnerActive: {
    backgroundColor: C.accent,
    borderColor: C.cyan,
  },
  orbLabel: {
    color: C.text,
    fontSize: 17,
    fontWeight: '700',
  },
  voiceStatus: {
    color: C.text,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 6,
  },
  voicePartial: {
    color: C.cyan,
    fontSize: 14,
    textAlign: 'center',
  },
  voiceHeard: {
    color: C.muted,
    fontSize: 13,
    textAlign: 'center',
  },
  voiceReply: {
    color: C.text,
    fontSize: 14,
    textAlign: 'center',
    backgroundColor: C.surface,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    marginTop: 4,
  },

  /* Apps Screen */
  searchInput: {
    color: C.text,
    backgroundColor: C.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
  },
  appCard: {
    flex: 1,
    maxWidth: '31.5%',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 6,
    borderRadius: 14,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    gap: 8,
  },
  appBadge: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: C.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  appBadgeText: { color: C.text, fontSize: 16, fontWeight: '700' },
  appCardName: { color: C.text, fontSize: 12, fontWeight: '600' },

  /* Settings Cards */
  card: {
    backgroundColor: C.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    gap: 10,
  },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: '700' },
  fieldLabel: { color: C.muted, fontSize: 12, fontWeight: '600' },
  bodyText: { color: C.text, fontSize: 14 },
  mutedSmall: { color: C.muted, fontSize: 12 },
  input: {
    color: C.text,
    backgroundColor: C.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
  },
  primaryBtn: {
    backgroundColor: C.accent,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },
  secondaryBtn: {
    backgroundColor: C.surface2,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: C.border,
  },
  primaryBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
