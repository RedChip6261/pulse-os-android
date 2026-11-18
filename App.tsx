/*
 * Pulse OS v6 — fast personal assistant for Android.
 * Tabs: Pulse (chat) · Hands-Free (voice loop) · Apps (open apps) · Computer (cloud browser).
 * No accessibility service, no overlay, no control of other apps: Pulse only opens apps/screens with intents and links.
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
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
import * as IntentLauncher from 'expo-intent-launcher';
import { useSpeechRecognitionEvent } from 'expo-speech-recognition';
import AuthScreen from './AuthScreen';
import ComputerScreen from './ComputerScreen';
import HandsFreeScreen from './HandsFreeScreen';
import ProfileScreen, { AgentMode } from './ProfileScreen';
import {
  buildAgenticRagContext,
  DEFAULT_RAG_PLAYBOOKS,
  ingestDocumentIntoRag,
  loadRagIndex,
  PULSE_APP_CATALOG,
  RagChunk,
  saveRagIndex,
  syncUserVaultToRag,
  VoiceLanguageMode,
} from './pulseFeatures';
import { ActionLink, actionLabel, openAction, openApp, splitActions, visibleWhileStreaming } from './src/actions';
import { buildContents, buildSystemPrompt, ChatMessage, cleanLegacyText, forStorage, uid, UserProfile } from './src/assistant';
import { Attachment, AttachmentError, pickDocument, pickImage, prettySize, takePhoto } from './src/attachments';
import { loadSessionUser, logoutUser, PublicUser, userToProfile } from './src/auth';
import { AutomationWorkflow, loadWorkflows, saveWorkflows } from './src/automation';
import { MemoryOps } from './src/commands';
import { DEFAULT_MODEL, looksTimeSensitive, MODEL_CHOICES, sanitizeModel, Source, streamChat } from './src/gemini';
import { runLocalAgent } from './src/localAgent';
import { extractMemories, loadMemories, makeMemory, memorySummary, MemoryItem, mergeMemories, saveMemories, worthExtracting } from './src/memory';
import { cancelReminder, configureNotifications, describeWhen, loadReminders, Reminder, ReminderDraft, scheduleReminder } from './src/reminders';
import { cancelDownload, checkForUpdate, downloadApk, installApk, installedBuild, openInstallPermissionSettings, openReleasePage, UpdateInfo } from './src/updates';
import { ensureMic, micOwner, MIC_ERRORS, releaseMic, speak, startListening, stopListening, stopSpeaking } from './src/voice';

/* ------------------------------------------------------------------ */
/* Theme & settings                                                   */
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
const SETTINGS_VERSION = 7;

type Tab = 'PULSE' | 'VOICE' | 'APPS' | 'COMPUTER';
type WebSearchMode = 'auto' | 'on' | 'off';

type Settings = {
  apiKey: string;
  model: string;
  agentMode: AgentMode;
  voiceOn: boolean; // speak chat replies aloud (OFF by default; Hands-Free always speaks)
  voiceLang: VoiceLanguageMode;
  ragEnabled: boolean;
  autoCheckUpdates: boolean;
  webSearch: WebSearchMode;
  memoryAuto: boolean;
  settingsVersion: number;
};

const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: DEFAULT_MODEL,
  agentMode: 'local',
  voiceOn: false,
  voiceLang: 'BILINGUAL_AUTO',
  ragEnabled: true,
  autoCheckUpdates: true,
  webSearch: 'auto',
  memoryAuto: true,
  settingsVersion: SETTINGS_VERSION,
};

function migrateSettings(raw: any): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  if (Number(raw?.settingsVersion) !== SETTINGS_VERSION) {
    s.voiceOn = false; // older builds spoke every reply in the background
    s.agentMode = 'local'; // default to Pulse's own API-key-free engine
    s.webSearch = 'auto';
    s.memoryAuto = raw?.memoryAuto ?? true;
    s.settingsVersion = SETTINGS_VERSION;
  }
  if (!['auto', 'local', 'cloud'].includes(s.agentMode)) s.agentMode = 'local';
  s.model = sanitizeModel(s.model); // drops gemini-pro / 2.x / 2.5 / unknown names
  if (!['auto', 'on', 'off'].includes(s.webSearch)) s.webSearch = 'auto';
  return s;
}

const DEFAULT_PROFILE: UserProfile = { name: '', email: '', phone: '', address: '' };
const appConfig = require('./app.json');
const APP_JSON_BUILD = Number(appConfig?.expo?.android?.versionCode ?? 36) || 36;

/* ------------------------------------------------------------------ */
/* App shell                                                          */
/* ------------------------------------------------------------------ */

export default function App() {
  const [tab, setTabState] = useState<Tab>('PULSE');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [user, setUser] = useState<PublicUser | null>(null);
  const [guestMode, setGuestMode] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [profile, setProfile] = useState<UserProfile>(DEFAULT_PROFILE);
  const [ragIndex, setRagIndex] = useState<RagChunk[]>(DEFAULT_RAG_PLAYBOOKS);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [workflows, setWorkflows] = useState<AutomationWorkflow[]>([]);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [appActive, setAppActive] = useState(true);
  const [ready, setReady] = useState(false);
  const memoriesRef = useRef<MemoryItem[]>([]);

  useEffect(() => {
    stopSpeaking();
    configureNotifications();
    Promise.all([
      AsyncStorage.getItem(STORAGE_SETTINGS),
      AsyncStorage.getItem(STORAGE_USER_AUTH),
      loadRagIndex(),
      loadMemories(),
      loadReminders(),
      loadSessionUser(),
      loadWorkflows(),
    ]).then(([sRaw, pRaw, loadedRag, mem, rem, sessionUser, wf]) => {
      let s = DEFAULT_SETTINGS;
      try {
        s = migrateSettings(sRaw ? JSON.parse(sRaw) : null);
      } catch {}
      setSettings(s);
      AsyncStorage.setItem(STORAGE_SETTINGS, JSON.stringify(s)).catch(() => undefined);
      if (sessionUser) {
        setUser(sessionUser);
        setProfile(userToProfile(sessionUser));
      } else if (pRaw) {
        try {
          setProfile({ ...DEFAULT_PROFILE, ...JSON.parse(pRaw) });
        } catch {}
      }
      setRagIndex(loadedRag);
      memoriesRef.current = mem;
      setMemories(mem);
      setReminders(rem);
      setWorkflows(wf);
      setReady(true);
      if (s.autoCheckUpdates) {
        checkForUpdate(APP_JSON_BUILD)
          .then((u) => u.available && setUpdateInfo(u))
          .catch(() => undefined);
      }
    });
    // Voice must never keep talking in the background.
    const sub = AppState.addEventListener('change', (st) => {
      const on = st === 'active';
      setAppActive(on);
      if (!on) {
        stopSpeaking();
        releaseMic('chat');
      } else {
        loadReminders().then(setReminders).catch(() => undefined);
      }
    });
    return () => sub.remove();
  }, []);

  const setTab = useCallback((t: Tab) => {
    stopSpeaking();
    releaseMic('chat');
    setTabState(t);
  }, []);

  const patchSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      AsyncStorage.setItem(STORAGE_SETTINGS, JSON.stringify(next)).catch(() => undefined);
      return next;
    });
  }, []);

  const saveProfile = useCallback((next: UserProfile) => {
    setProfile(next);
    AsyncStorage.setItem(STORAGE_USER_AUTH, JSON.stringify(next)).catch(() => undefined);
    syncUserVaultToRag(next).then(setRagIndex).catch(() => undefined);
  }, []);

  /* ---------------- Memory ---------------- */
  const setMemoryList = useCallback((next: MemoryItem[]) => {
    memoriesRef.current = next;
    setMemories(next);
    saveMemories(next).catch(() => undefined);
  }, []);
  const memoryOps: MemoryOps = useMemo(
    () => ({
      list: memories,
      add: (items) => setMemoryList(mergeMemories(memoriesRef.current, items)),
      remove: (ids) => setMemoryList(memoriesRef.current.filter((m) => !ids.includes(m.id))),
      confirmClearAll: () =>
        Alert.alert('Forget everything?', 'This deletes every memory Pulse has about you.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Forget all', style: 'destructive', onPress: () => setMemoryList([]) },
        ]),
    }),
    [memories, setMemoryList],
  );
  const updateMemory = useCallback(
    (id: string, text: string) => setMemoryList(memoriesRef.current.map((m) => (m.id === id ? { ...m, text: text.trim(), updatedAt: Date.now() } : m)).filter((m) => m.text)),
    [setMemoryList],
  );

  /** Background: learn durable facts from what the user said (flash-lite, never blocks the chat). */
  const learnFrom = useCallback(
    (userText: string) => {
      if (!settings.memoryAuto || !settings.apiKey.trim() || !worthExtracting(userText)) return;
      extractMemories(settings.apiKey, memoriesRef.current, userText)
        .then(({ add, update }) => {
          if (!add.length && !update.length) return;
          let next = memoriesRef.current.map((m) => {
            const u = update.find((x) => x.id === m.id);
            return u ? { ...m, text: u.text, updatedAt: Date.now() } : m;
          });
          next = mergeMemories(next, add);
          setMemoryList(next);
        })
        .catch(() => undefined);
    },
    [settings.memoryAuto, settings.apiKey, setMemoryList],
  );

  const refreshReminders = useCallback(() => {
    loadReminders().then(setReminders).catch(() => undefined);
  }, []);

  const memSummary = useMemo(() => memorySummary(memories), [memories]);
  const knowledge = useMemo(() => ragIndex.filter((c) => c.category !== 'playbook'), [ragIndex]);

  if (!ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={C.accent} size="large" />
      </View>
    );
  }

  if (!user && !guestMode) {
    return (
      <AuthScreen
        onAuthenticated={(u) => {
          setUser(u);
          saveProfile(userToProfile(u));
          setGuestMode(false);
        }}
        onContinueGuest={() => setGuestMode(true)}
      />
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" backgroundColor={C.bg} />
      <View style={styles.header}>
        <View style={styles.rowCenter}>
          <View style={styles.pulseDot} />
          <Text style={styles.brand}>Pulse</Text>
        </View>
        <View style={[styles.rowCenter, { gap: 8 }]}>
          {updateInfo?.available ? (
            <Pressable onPress={() => setSettingsOpen(true)} style={[styles.pillBtn, { borderColor: C.good }]}>
              <View style={[styles.statusDot, { backgroundColor: C.good }]} />
              <Text style={styles.pillText}>Update</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => setProfileOpen(true)} style={styles.pillBtn}>
            <Text style={styles.pillText}>{profile.name ? profile.name.split(' ')[0] : 'Profile'}</Text>
          </Pressable>
          <Pressable onPress={() => setSettingsOpen(true)} style={styles.pillBtn}>
            <Text style={styles.pillText}>Settings</Text>
          </Pressable>
        </View>
      </View>

      <View style={{ flex: 1 }}>
        <View style={[styles.fill, tab !== 'PULSE' && styles.hidden]}>
          <ChatScreen
            active={tab === 'PULSE' && appActive}
            settings={settings}
            patchSettings={patchSettings}
            profile={profile}
            knowledge={knowledge}
            reminders={reminders}
            workflows={workflows}
            memSummary={memSummary}
            memory={memoryOps}
            learnFrom={learnFrom}
            onReminderSet={refreshReminders}
            openSettings={() => setSettingsOpen(true)}
          />
        </View>
        <View style={[styles.fill, tab !== 'VOICE' && styles.hidden]}>
          <HandsFreeScreen
            active={tab === 'VOICE' && appActive}
            voiceLang={settings.voiceLang}
            setVoiceLang={(l) => patchSettings({ voiceLang: l })}
            profile={profile}
            memory={memoryOps}
            reminders={reminders}
            knowledge={knowledge}
            workflows={workflows}
            onReminderSet={refreshReminders}
          />
        </View>
        <View style={[styles.fill, tab !== 'APPS' && styles.hidden]}>
          <AppsScreen />
        </View>
        <View style={[styles.fill, tab !== 'COMPUTER' && styles.hidden]}>
          <ComputerScreen active={tab === 'COMPUTER' && appActive} geminiKey={settings.apiKey} />
        </View>
      </View>

      <View style={styles.tabBar}>
        {(
          [
            { id: 'PULSE', label: 'Pulse' },
            { id: 'VOICE', label: 'Hands-Free' },
            { id: 'APPS', label: 'Apps' },
            { id: 'COMPUTER', label: 'Computer' },
          ] as { id: Tab; label: string }[]
        ).map((t) => {
          const on = tab === t.id;
          return (
            <Pressable key={t.id} onPress={() => setTab(t.id)} style={[styles.tabItem, on && styles.tabItemActive]}>
              <Text style={[styles.tabLabel, on && styles.tabLabelActive]}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <Modal visible={profileOpen} animationType="slide" onRequestClose={() => setProfileOpen(false)}>
        <SafeAreaView style={styles.root}>
          <ProfileScreen
            user={user}
            profile={profile}
            onSaveProfile={saveProfile}
            onUserUpdated={(u) => setUser(u)}
            onLogout={async () => {
              await logoutUser();
              setUser(null);
              setGuestMode(false);
              setProfileOpen(false);
            }}
            onOpenAuth={() => {
              setProfileOpen(false);
              setGuestMode(false);
            }}
            agentMode={settings.agentMode}
            setAgentMode={(m) => patchSettings({ agentMode: m })}
            voiceLang={settings.voiceLang}
            setVoiceLang={(l) => patchSettings({ voiceLang: l })}
            voiceOn={settings.voiceOn}
            setVoiceOn={(v) => {
              if (!v) stopSpeaking();
              patchSettings({ voiceOn: v });
            }}
            stats={{
              memories: memories.length,
              reminders: reminders.length,
              workflows: workflows.length,
              notes: knowledge.length,
            }}
            onClose={() => setProfileOpen(false)}
          />
        </SafeAreaView>
      </Modal>

      <Modal visible={settingsOpen} animationType="slide" onRequestClose={() => setSettingsOpen(false)}>
        <SafeAreaView style={styles.root}>
          <SettingsModalContent
            settings={settings}
            patchSettings={patchSettings}
            profile={profile}
            saveProfile={saveProfile}
            ragIndex={ragIndex}
            setRagIndex={setRagIndex}
            memories={memories}
            memoryOps={memoryOps}
            updateMemory={updateMemory}
            reminders={reminders}
            setReminders={setReminders}
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
/* 1. Chat                                                            */
/* ------------------------------------------------------------------ */

function ChatScreen({
  active,
  settings,
  patchSettings,
  profile,
  knowledge,
  reminders,
  workflows,
  memSummary,
  memory,
  learnFrom,
  onReminderSet,
  openSettings,
}: {
  active: boolean;
  settings: Settings;
  patchSettings: (p: Partial<Settings>) => void;
  profile: UserProfile;
  knowledge: RagChunk[];
  reminders: Reminder[];
  workflows: AutomationWorkflow[];
  memSummary: string;
  memory: MemoryOps;
  learnFrom: (t: string) => void;
  onReminderSet: () => void;
  openSettings: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachBusy, setAttachBusy] = useState(false);
  const [pending, setPending] = useState<Attachment | null>(null);
  const [notice, setNotice] = useState('');
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const nearBottom = useRef(true);
  const messagesRef = useRef<ChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const finalVoice = useRef('');

  const commit = useCallback((updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    setMessages((prev) => {
      const next = updater(prev);
      messagesRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_CONVOS)
      .then((raw) => {
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) {
          const clean: ChatMessage[] = parsed
            .filter((m: any) => m && typeof m.text === 'string' && m.id && !(m.role === 'error' && /exceeded your current quota|no longer available/i.test(m.text)))
            .map((m: any) => ({ ...m, text: m.role === 'assistant' ? cleanLegacyText(m.text) : m.text, streaming: false }));
          messagesRef.current = clean;
          setMessages(clean);
        }
      })
      .catch(() => undefined);
  }, []);

  // Persist (debounced, never mid-stream, without base64).
  useEffect(() => {
    if (busy) return;
    const t = setTimeout(() => {
      AsyncStorage.setItem(STORAGE_CONVOS, JSON.stringify(forStorage(messagesRef.current))).catch(() => undefined);
    }, 700);
    return () => clearTimeout(t);
  }, [messages, busy]);

  useEffect(() => {
    if (!active) {
      stopSpeaking();
      setSpeaking(false);
      if (listening) {
        releaseMic('chat');
        setListening(false);
      }
    }
  }, [active, listening]);

  const stopAll = () => {
    abortRef.current?.abort();
    stopSpeaking();
    setSpeaking(false);
  };

  const speakReply = (text: string) => {
    if (!settings.voiceOn) return;
    setSpeaking(true);
    speak(text, settings.voiceLang, { onDone: () => setSpeaking(false), onStopped: () => setSpeaking(false) });
  };

  const send = async (override?: string) => {
    const raw = (override ?? input).trim();
    const att = pending;
    if ((!raw && !att) || busy) return;
    stopSpeaking();
    setSpeaking(false);
    setNotice('');
    const text = raw || (att?.kind === 'image' ? 'What is in this image?' : 'Summarise this file.');
    const userMsg: ChatMessage = { id: uid(), role: 'user', text, attachment: att || undefined, ts: Date.now() };
    setInput('');
    setPending(null);
    nearBottom.current = true;
    commit((prev) => [...prev, userMsg]);

    // 1. Pulse Custom Engine (API-key-free, handles attachments, web knowledge, workflows, math, reminders)
    if (settings.agentMode !== 'cloud') {
      const local = await runLocalAgent(text, {
        profile,
        memory,
        reminders,
        knowledge,
        workflows,
        history: messagesRef.current,
        attachment: att || undefined,
        webEnabled: settings.webSearch !== 'off',
      }).catch(() => null);
      if (local?.handled) {
        commit((prev) => [
          ...prev,
          {
            id: uid(),
            role: 'assistant',
            text: local.text,
            actions: local.actions,
            sources: local.sources,
            ts: Date.now(),
            card: local.reminder ? { kind: 'reminder', draft: local.reminder, status: 'pending' } : undefined,
          },
        ]);
        if (!local.reminder) speakReply(local.text);
        return;
      }
    }

    // 2. Optional Cloud AI (only when explicitly switched to Cloud mode with a valid key)
    if (!settings.apiKey.trim()) {
      const fallback = await runLocalAgent(text, {
        profile,
        memory,
        reminders,
        knowledge,
        workflows,
        history: messagesRef.current,
        attachment: att || undefined,
        webEnabled: settings.webSearch !== 'off',
      });
      commit((prev) => [
        ...prev,
        {
          id: uid(),
          role: 'assistant',
          text: fallback.text,
          actions: fallback.actions,
          sources: fallback.sources,
          ts: Date.now(),
          card: fallback.reminder ? { kind: 'reminder', draft: fallback.reminder, status: 'pending' } : undefined,
        },
      ]);
      return;
    }
    const botId = uid();
    const history = [...messagesRef.current];
    const search = settings.webSearch === 'on' || (settings.webSearch === 'auto' && !att && looksTimeSensitive(text));
    commit((prev) => [...prev, { id: botId, role: 'assistant', text: '', ts: Date.now(), streaming: true, searched: search }]);
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Throttle UI updates while streaming (~16 fps) so long answers stay smooth.
    let latest = '';
    let timer: any = null;
    const flush = () => {
      timer = null;
      const shown = visibleWhileStreaming(latest);
      commit((prev) => prev.map((m) => (m.id === botId ? { ...m, text: shown } : m)));
    };
    try {
      const rag = settings.ragEnabled && knowledge.length ? buildAgenticRagContext(text, knowledge, 3).contextBlock : '';
      const res = await streamChat({
        apiKey: settings.apiKey,
        model: settings.model,
        system: buildSystemPrompt({ profile, memory: memSummary, knowledge: rag }),
        contents: buildContents(history),
        search,
        signal: ctrl.signal,
        onPartial: (full) => {
          latest = full;
          if (!timer) timer = setTimeout(flush, 60);
        },
      });
      if (timer) clearTimeout(timer);
      const { text: answer, actions } = splitActions(res.text || latest);
      commit((prev) =>
        prev.map((m) =>
          m.id === botId ? { ...m, text: answer || (ctrl.signal.aborted ? '(stopped)' : 'No answer.'), actions, sources: res.sources.slice(0, 6), searched: res.searched, streaming: false } : m,
        ),
      );
      if (!ctrl.signal.aborted) speakReply(answer);
      learnFrom(text);
    } catch (e: any) {
      if (timer) clearTimeout(timer);
      commit((prev) => prev.map((m) => (m.id === botId ? { ...m, role: 'error', text: e?.message || 'Request failed', streaming: false } : m)));
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setBusy(false);
    }
  };

  /* ---------------- Voice input (mic button) ---------------- */
  useSpeechRecognitionEvent('result', (e) => {
    if (micOwner() !== 'chat') return;
    const t = e.results?.[0]?.transcript || '';
    setInput(t);
    if (e.isFinal) finalVoice.current = t;
  });
  useSpeechRecognitionEvent('error', (e) => {
    if (micOwner() !== 'chat') return;
    const code = String(e.error);
    if (code !== 'aborted' && code !== 'no-speech' && code !== 'speech-timeout') setNotice(MIC_ERRORS[code] || e.message || 'Voice input error.');
  });
  useSpeechRecognitionEvent('end', () => {
    if (micOwner() !== 'chat') return;
    setListening(false);
    releaseMic('chat');
    const t = finalVoice.current.trim();
    finalVoice.current = '';
    if (t) send(t);
  });

  const onMic = async () => {
    if (listening) {
      stopListening(false);
      return;
    }
    stopAll();
    const ok = await ensureMic();
    if (!ok.ok) {
      setNotice(ok.message || 'Microphone unavailable.');
      return;
    }
    finalVoice.current = '';
    setListening(true);
    try {
      startListening('chat', settings.voiceLang, { silenceMs: 1500 });
    } catch (e: any) {
      setListening(false);
      setNotice(e?.message || 'Could not start voice input.');
    }
  };

  /* ---------------- Attachments ---------------- */
  const attach = async (how: 'camera' | 'gallery' | 'document') => {
    setAttachOpen(false);
    setAttachBusy(true);
    setNotice('');
    try {
      const a = how === 'camera' ? await takePhoto() : how === 'gallery' ? await pickImage() : await pickDocument();
      if (a) setPending(a);
    } catch (e: any) {
      setNotice(e instanceof AttachmentError ? e.message : `Couldn't attach that file: ${e?.message || e}`);
    } finally {
      setAttachBusy(false);
    }
  };

  /* ---------------- Cards & actions ---------------- */
  const setCard = (id: string, patch: Partial<NonNullable<ChatMessage['card']>>) =>
    commit((prev) => prev.map((m) => (m.id === id && m.card ? { ...m, card: { ...m.card, ...patch } } : m)));

  const confirmReminder = async (msg: ChatMessage) => {
    if (!msg.card) return;
    try {
      await scheduleReminder(msg.card.draft);
      setCard(msg.id, { status: 'set', error: undefined });
      onReminderSet();
    } catch (e: any) {
      setCard(msg.id, { status: 'error', error: e?.message || 'Could not set the reminder.' });
    }
  };

  const onAction = (a: ActionLink) => {
    if (a.type === 'reminder') {
      const draft: ReminderDraft = { title: a.title, at: Date.parse(a.at), repeat: 'none' };
      commit((prev) => [...prev, { id: uid(), role: 'assistant', text: `Set a reminder for ${describeWhen(draft)}?`, ts: Date.now(), card: { kind: 'reminder', draft, status: 'pending' } }]);
      return;
    }
    openAction(a).catch(() => setNotice("Couldn't open that on this phone."));
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    nearBottom.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 120;
  };

  const renderItem = useCallback(
    ({ item }: { item: ChatMessage }) => <MessageBubble item={item} onAction={onAction} onConfirmReminder={confirmReminder} onCancelReminder={(m) => setCard(m.id, { status: 'cancelled' })} />,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const searchLabel = settings.webSearch === 'on' ? 'Web: On' : settings.webSearch === 'off' ? 'Web: Off' : 'Web: Auto';
  const canSend = !busy && (!!input.trim() || !!pending);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        renderItem={renderItem}
        contentContainerStyle={{ padding: 14, paddingBottom: 20, flexGrow: 1 }}
        onScroll={onScroll}
        scrollEventThrottle={32}
        removeClippedSubviews
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={9}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => {
          if (nearBottom.current) listRef.current?.scrollToEnd({ animated: false });
        }}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyTitle}>Hi{profile.name ? `, ${profile.name.split(' ')[0]}` : ''}</Text>
            <Text style={styles.emptySub}>Ask anything, attach a photo or PDF, or set a reminder.</Text>
            <View style={styles.suggestionWrap}>
              {['Weather in Hyderabad today', 'Remind me at 6pm to call Amma', 'Remember I am vegetarian', 'Best biryani near Gachibowli'].map((ex) => (
                <Pressable key={ex} onPress={() => send(ex)} style={styles.suggestionPill}>
                  <Text style={styles.suggestionText}>{ex}</Text>
                </Pressable>
              ))}
            </View>
            {!settings.apiKey.trim() ? (
              <Pressable onPress={openSettings} style={{ marginTop: 18 }}>
                <Text style={{ color: C.cyan, fontSize: 13 }}>Add your Gemini API key in Settings</Text>
              </Pressable>
            ) : null}
          </View>
        }
      />

      {!!notice && (
        <Pressable onPress={() => setNotice('')} style={styles.noticeBar}>
          <Text style={styles.noticeText}>{notice}</Text>
        </Pressable>
      )}

      {pending ? (
        <View style={styles.attachBar}>
          {pending.kind === 'image' ? <Image source={{ uri: pending.uri }} style={styles.attachThumb} /> : <View style={styles.fileIcon}><Text style={styles.fileIconText}>{fileBadge(pending)}</Text></View>}
          <View style={{ flex: 1 }}>
            <Text style={styles.bodyText} numberOfLines={1}>
              {pending.name}
            </Text>
            <Text style={styles.mutedSmall}>{prettySize(pending.size)}</Text>
          </View>
          <Pressable onPress={() => setPending(null)} hitSlop={10}>
            <Text style={{ color: C.danger, fontSize: 13, fontWeight: '700' }}>✕</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.chipRow}>
        <Pressable
          onPress={() => patchSettings({ agentMode: settings.agentMode === 'auto' ? 'local' : settings.agentMode === 'local' ? 'cloud' : 'auto' })}
          style={[styles.chip, settings.agentMode === 'local' && styles.chipOn]}
        >
          <Text style={styles.chipText}>
            {settings.agentMode === 'local' ? '⚡ Local Agent' : settings.agentMode === 'cloud' ? '☁️ Cloud' : '🤖 Auto'}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => patchSettings({ webSearch: settings.webSearch === 'auto' ? 'on' : settings.webSearch === 'on' ? 'off' : 'auto' })}
          style={[styles.chip, settings.webSearch === 'on' && styles.chipOn]}
        >
          <Text style={styles.chipText}>🌐 {searchLabel}</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            if (settings.voiceOn) {
              stopSpeaking();
              setSpeaking(false);
            }
            patchSettings({ voiceOn: !settings.voiceOn });
          }}
          style={[styles.chip, settings.voiceOn && styles.chipOn]}
        >
          <Text style={styles.chipText}>{settings.voiceOn ? '🔊 Read aloud' : '🔇 Silent'}</Text>
        </Pressable>
        {speaking ? (
          <Pressable onPress={stopAll} style={[styles.chip, { borderColor: C.danger }]}>
            <Text style={styles.chipText}>■ Stop voice</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.composer}>
        <Pressable onPress={() => setAttachOpen(true)} style={styles.circleBtn} disabled={attachBusy}>
          {attachBusy ? <ActivityIndicator color={C.text} size="small" /> : <Text style={styles.circleBtnText}>+</Text>}
        </Pressable>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder={listening ? 'Listening…' : 'Message Pulse…'}
          placeholderTextColor={listening ? C.danger : C.muted}
          style={styles.composerInput}
          multiline
        />
        <Pressable onPress={onMic} style={[styles.circleBtn, listening && { borderColor: C.danger, backgroundColor: 'rgba(239,68,68,0.25)' }]}>
          <Text style={{ fontSize: 15, color: C.text }}>{listening ? '■' : '🎙'}</Text>
        </Pressable>
        {busy ? (
          <Pressable onPress={stopAll} style={[styles.sendBtn, { backgroundColor: C.danger }]}>
            <Text style={styles.sendText}>■</Text>
          </Pressable>
        ) : (
          <Pressable onPress={() => send()} disabled={!canSend} style={[styles.sendBtn, !canSend && { opacity: 0.45 }]}>
            <Text style={styles.sendText}>↑</Text>
          </Pressable>
        )}
      </View>

      <Modal visible={attachOpen} transparent animationType="fade" onRequestClose={() => setAttachOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setAttachOpen(false)}>
          <View style={styles.sheetCard}>
            <Text style={styles.sheetTitle}>Attach (up to 15 MB)</Text>
            <Pressable onPress={() => attach('camera')} style={styles.sheetRow}>
              <Text style={styles.sheetRowText}>📷  Take photo</Text>
            </Pressable>
            <Pressable onPress={() => attach('gallery')} style={styles.sheetRow}>
              <Text style={styles.sheetRowText}>🖼  Photo from gallery</Text>
            </Pressable>
            <Pressable onPress={() => attach('document')} style={styles.sheetRow}>
              <Text style={styles.sheetRowText}>📄  Document (PDF, Word, text, image)</Text>
            </Pressable>
            {messages.length > 0 ? (
              <Pressable
                onPress={() => {
                  stopAll();
                  messagesRef.current = [];
                  setMessages([]);
                  AsyncStorage.removeItem(STORAGE_CONVOS).catch(() => undefined);
                  setAttachOpen(false);
                }}
                style={styles.sheetRow}
              >
                <Text style={[styles.sheetRowText, { color: C.danger }]}>New chat (clear)</Text>
              </Pressable>
            ) : null}
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function fileBadge(a: Attachment) {
  if (/pdf/.test(a.mimeType)) return 'PDF';
  if (/word/.test(a.mimeType)) return 'DOC';
  return (a.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
}

function hostOf(uri: string, title: string) {
  if (title && !/^source$/i.test(title)) return title.replace(/^www\./, '');
  const m = uri.match(/^https?:\/\/([^/]+)/);
  return m ? m[1].replace(/^www\./, '') : 'source';
}

/** Light markdown: **bold** and "- " bullets. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*\n]+\*\*)/g);
  return (
    <Text selectable style={styles.bubbleText}>
      {parts.map((p, i) =>
        /^\*\*[^*]+\*\*$/.test(p) ? (
          <Text key={i} style={{ fontWeight: '700' }}>
            {p.slice(2, -2)}
          </Text>
        ) : (
          p.replace(/^\s*[*-]\s+/gm, '• ').replace(/^#{1,6}\s+/gm, '')
        ),
      )}
    </Text>
  );
}

const MessageBubble = memo(function MessageBubble({
  item,
  onAction,
  onConfirmReminder,
  onCancelReminder,
}: {
  item: ChatMessage;
  onAction: (a: ActionLink) => void;
  onConfirmReminder: (m: ChatMessage) => void;
  onCancelReminder: (m: ChatMessage) => void;
}) {
  const isUser = item.role === 'user';
  return (
    <View style={{ marginBottom: 10, alignItems: isUser ? 'flex-end' : 'flex-start' }}>
      <View style={[styles.bubble, isUser ? styles.userBubble : item.role === 'error' ? styles.errorBubble : styles.botBubble]}>
        {item.attachment?.kind === 'image' && item.attachment.uri ? (
          <Image source={{ uri: item.attachment.uri }} style={styles.msgImage} resizeMode="cover" />
        ) : null}
        {item.attachment && item.attachment.kind !== 'image' ? (
          <View style={styles.fileChip}>
            <Text style={styles.fileChipBadge}>{fileBadge(item.attachment)}</Text>
            <Text style={styles.fileChipName} numberOfLines={1}>
              {item.attachment.name}
            </Text>
          </View>
        ) : null}
        {item.streaming && !item.text ? (
          <View style={[styles.rowCenter, { gap: 8 }]}>
            <ActivityIndicator size="small" color={C.cyan} />
            <Text style={styles.mutedSmall}>{item.searched ? 'Searching the web…' : 'Thinking…'}</Text>
          </View>
        ) : isUser ? (
          <Text selectable style={styles.bubbleText}>
            {item.text}
          </Text>
        ) : (
          <RichText text={item.text} />
        )}

        {item.card?.kind === 'reminder' ? (
          <View style={styles.reminderCard}>
            <Text style={styles.reminderTitle}>⏰ {item.card.draft.title}</Text>
            <Text style={styles.mutedSmall}>{describeWhen(item.card.draft)}</Text>
            {item.card.status === 'pending' ? (
              <View style={[styles.rowCenter, { gap: 8, marginTop: 8 }]}>
                <Pressable onPress={() => onConfirmReminder(item)} style={[styles.smallBtn, { backgroundColor: C.good }]}>
                  <Text style={styles.smallBtnText}>Set reminder</Text>
                </Pressable>
                <Pressable onPress={() => onCancelReminder(item)} style={styles.smallBtn}>
                  <Text style={styles.smallBtnText}>Cancel</Text>
                </Pressable>
              </View>
            ) : (
              <Text style={[styles.mutedSmall, { marginTop: 6, color: item.card.status === 'set' ? C.good : item.card.status === 'error' ? C.danger : C.muted }]}>
                {item.card.status === 'set' ? '✓ Reminder set' : item.card.status === 'cancelled' ? 'Cancelled' : item.card.error}
              </Text>
            )}
            {item.card.status === 'error' ? (
              <Pressable onPress={() => onConfirmReminder(item)} style={[styles.smallBtn, { marginTop: 6, alignSelf: 'flex-start' }]}>
                <Text style={styles.smallBtnText}>Try again</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>

      {item.actions?.length ? (
        <View style={styles.actionRow}>
          {item.actions.map((a, i) => (
            <Pressable key={i} onPress={() => onAction(a)} style={styles.actionChip}>
              <Text style={styles.actionText}>{actionLabel(a)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {item.sources?.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxWidth: '92%' }} contentContainerStyle={styles.sourceRow}>
          {item.sources.map((s: Source, i: number) => (
            <Pressable key={s.uri} onPress={() => Linking.openURL(s.uri).catch(() => undefined)} style={styles.sourceChip}>
              <Text style={styles.sourceText} numberOfLines={1}>
                {i + 1}. {hostOf(s.uri, s.title)}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
});

/* ------------------------------------------------------------------ */
/* 2. Apps (opens apps with intents; no control inside them)          */
/* ------------------------------------------------------------------ */

function AppsScreen() {
  const [query, setQuery] = useState('');
  const [msg, setMsg] = useState('');
  const list = PULSE_APP_CATALOG.filter((a) => a.name.toLowerCase().includes(query.trim().toLowerCase()) || a.aliases.some((x) => x.includes(query.trim().toLowerCase())));
  const openSetting = (action: string) => IntentLauncher.startActivityAsync(action).catch(() => Linking.openSettings());
  return (
    <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 12 }}>
      <TextInput value={query} onChangeText={setQuery} placeholder="Search apps…" placeholderTextColor={C.muted} style={styles.searchInput} />
      <View style={[styles.rowCenter, { gap: 8, marginVertical: 10 }]}>
        <Pressable onPress={() => openSetting('android.settings.WIFI_SETTINGS')} style={styles.pillBtn}>
          <Text style={styles.pillText}>Wi-Fi</Text>
        </Pressable>
        <Pressable onPress={() => openSetting('android.settings.BLUETOOTH_SETTINGS')} style={styles.pillBtn}>
          <Text style={styles.pillText}>Bluetooth</Text>
        </Pressable>
        <Pressable onPress={() => openSetting('android.settings.DISPLAY_SETTINGS')} style={styles.pillBtn}>
          <Text style={styles.pillText}>Display</Text>
        </Pressable>
      </View>
      {!!msg && <Text style={[styles.mutedSmall, { marginBottom: 8 }]}>{msg}</Text>}
      <FlatList
        data={list}
        keyExtractor={(item) => item.id}
        numColumns={3}
        columnWrapperStyle={{ gap: 10 }}
        contentContainerStyle={{ gap: 10, paddingBottom: 24 }}
        renderItem={({ item }) => (
          <Pressable onPress={() => openApp(item.id).then((r) => setMsg(r.ok ? '' : r.msg))} style={styles.appCard}>
            <View style={styles.appBadge}>
              <Text style={styles.appBadgeText}>{item.icon}</Text>
            </View>
            <Text style={styles.appCardName} numberOfLines={1}>
              {item.name}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* 3. Settings                                                        */
/* ------------------------------------------------------------------ */

function SettingsModalContent({
  settings,
  patchSettings,
  profile,
  saveProfile,
  ragIndex,
  setRagIndex,
  memories,
  memoryOps,
  updateMemory,
  reminders,
  setReminders,
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
  memories: MemoryItem[];
  memoryOps: MemoryOps;
  updateMemory: (id: string, text: string) => void;
  reminders: Reminder[];
  setReminders: (r: Reminder[]) => void;
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
  const [newMemory, setNewMemory] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [showAllMem, setShowAllMem] = useState(false);
  const [checkingUpd, setCheckingUpd] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'downloading' | 'ready' | 'installing'>('idle');
  const [progress, setProgress] = useState(0);
  const [apkUri, setApkUri] = useState('');
  const [updStatus, setUpdStatus] = useState('');
  const build = installedBuild(APP_JSON_BUILD);

  useEffect(() => {
    loadReminders().then(setReminders).catch(() => undefined);
  }, [setReminders]);

  const handleCheckUpdate = async () => {
    setCheckingUpd(true);
    setUpdStatus('');
    try {
      const info = await checkForUpdate(APP_JSON_BUILD);
      setUpdateInfo(info.available ? info : null);
      setUpdStatus(info.available ? `Build ${info.latestBuild} is available (${prettySize(info.sizeBytes)}).` : `You're on the latest build (${info.currentBuild}).`);
    } catch (e: any) {
      setUpdStatus(e?.message || 'Update check failed');
    } finally {
      setCheckingUpd(false);
    }
  };

  const doInstall = async (uri: string) => {
    setPhase('installing');
    try {
      await installApk(uri);
      setUpdStatus('Android is showing the install screen. Tap Install to finish.');
    } catch (e: any) {
      setUpdStatus(`Couldn't open the installer: ${e?.message || e}. Allow "Install unknown apps" for Pulse OS, then tap Install again.`);
    } finally {
      setPhase('ready');
    }
  };

  const handleUpdate = async () => {
    if (!updateInfo) return;
    if (apkUri) return doInstall(apkUri);
    setPhase('downloading');
    setProgress(0);
    setUpdStatus('');
    try {
      const uri = await downloadApk(updateInfo, setProgress);
      setApkUri(uri);
      setPhase('ready');
      await doInstall(uri);
    } catch (e: any) {
      setPhase('idle');
      setUpdStatus(e?.message || 'Download failed');
    }
  };

  const visibleMem = showAllMem ? memories : memories.slice(0, 8);

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <Text style={styles.brand}>Settings</Text>
        <Pressable onPress={onClose} style={styles.pillBtn}>
          <Text style={styles.pillText}>Done</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        {/* Updates first when one is waiting */}
        <View style={[styles.card, updateInfo?.available && { borderColor: C.good }]}>
          <Text style={styles.cardTitle}>App update</Text>
          <Text style={styles.mutedSmall}>
            Version {appConfig?.expo?.version || '6.0.0'} · installed build {build}
          </Text>
          {updateInfo?.available ? (
            <>
              <Text style={styles.bodyText}>Build {updateInfo.latestBuild} is ready{updateInfo.sizeBytes ? ` (${prettySize(updateInfo.sizeBytes)})` : ''}.</Text>
              {!!updateInfo.notes && (
                <Text style={styles.mutedSmall} numberOfLines={3}>
                  {updateInfo.notes}
                </Text>
              )}
              {phase === 'downloading' ? (
                <View style={{ gap: 6 }}>
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
                  </View>
                  <View style={styles.rowBetween}>
                    <Text style={styles.mutedSmall}>Downloading… {Math.round(progress * 100)}%</Text>
                    <Pressable
                      onPress={() => {
                        cancelDownload();
                        setPhase('idle');
                      }}
                    >
                      <Text style={{ color: C.danger, fontSize: 12 }}>Cancel</Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <Pressable onPress={handleUpdate} disabled={phase === 'installing'} style={[styles.primaryBtn, { backgroundColor: C.good }]}>
                  <Text style={styles.primaryBtnText}>{phase === 'installing' ? 'Opening installer…' : apkUri ? 'Install now' : `Download & install build ${updateInfo.latestBuild}`}</Text>
                </Pressable>
              )}
              <Text style={styles.mutedSmall}>Android asks you to confirm "Install" once — that's normal. The first time it may ask to allow installs from Pulse OS.</Text>
              <Pressable onPress={() => openInstallPermissionSettings()}>
                <Text style={{ color: C.cyan, fontSize: 12 }}>Allow installs from Pulse OS</Text>
              </Pressable>
            </>
          ) : null}
          <Pressable onPress={handleCheckUpdate} disabled={checkingUpd} style={styles.secondaryBtn}>
            {checkingUpd ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Check for updates</Text>}
          </Pressable>
          {updStatus ? <Text style={styles.mutedSmall}>{updStatus}</Text> : null}
          <View style={[styles.rowBetween, { marginTop: 2 }]}>
            <Text style={styles.bodyText}>Check automatically</Text>
            <Switch value={settings.autoCheckUpdates} onValueChange={(v) => patchSettings({ autoCheckUpdates: v })} trackColor={{ false: C.border, true: C.accent }} thumbColor="#fff" />
          </View>
          <Pressable onPress={() => openReleasePage()}>
            <Text style={{ color: C.muted, fontSize: 12, textDecorationLine: 'underline' }}>Open release page</Text>
          </Pressable>
        </View>

        {/* AI */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Assistant</Text>
          <Text style={styles.fieldLabel}>Gemini API key</Text>
          <TextInput
            value={settings.apiKey}
            onChangeText={(t) => patchSettings({ apiKey: t })}
            placeholder="AIza..."
            placeholderTextColor={C.muted}
            secureTextEntry
            autoCapitalize="none"
            style={styles.input}
          />
          <Text style={styles.fieldLabel}>Model</Text>
          <View style={[styles.rowCenter, { gap: 8 }]}>
            {MODEL_CHOICES.map((m) => (
              <Pressable key={m.id} onPress={() => patchSettings({ model: m.id })} style={[styles.chip, settings.model === m.id && styles.chipOn]}>
                <Text style={styles.chipText}>
                  {m.label} · {m.id.replace('gemini-', '').replace('-latest', '')}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.fieldLabel}>Web search (Google, with sources)</Text>
          <View style={[styles.rowCenter, { gap: 8 }]}>
            {(['auto', 'on', 'off'] as WebSearchMode[]).map((m) => (
              <Pressable key={m} onPress={() => patchSettings({ webSearch: m })} style={[styles.chip, settings.webSearch === m && styles.chipOn]}>
                <Text style={styles.chipText}>{m === 'auto' ? 'Auto' : m === 'on' ? 'Always' : 'Off'}</Text>
              </Pressable>
            ))}
          </View>
          <View style={[styles.rowBetween, { marginTop: 4 }]}>
            <Text style={styles.bodyText}>Read chat replies aloud</Text>
            <Switch
              value={settings.voiceOn}
              onValueChange={(v) => {
                if (!v) stopSpeaking();
                patchSettings({ voiceOn: v });
              }}
              trackColor={{ false: C.border, true: C.accent }}
              thumbColor="#fff"
            />
          </View>
          <View style={styles.rowBetween}>
            <Text style={styles.bodyText}>Use my saved notes</Text>
            <Switch value={settings.ragEnabled} onValueChange={(v) => patchSettings({ ragEnabled: v })} trackColor={{ false: C.border, true: C.accent }} thumbColor="#fff" />
          </View>
        </View>

        {/* Memory */}
        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.cardTitle}>Memory ({memories.length})</Text>
            <Switch value={settings.memoryAuto} onValueChange={(v) => patchSettings({ memoryAuto: v })} trackColor={{ false: C.border, true: C.accent }} thumbColor="#fff" />
          </View>
          <Text style={styles.mutedSmall}>
            {settings.memoryAuto ? 'Pulse learns lasting facts from your chats (name, places, people, preferences). ' : 'Auto-learning is off. '}
            Say "remember …" or "forget …" anytime. Stored only on this phone.
          </Text>
          <View style={[styles.rowCenter, { gap: 8 }]}>
            <TextInput value={newMemory} onChangeText={setNewMemory} placeholder="Add a fact, e.g. I'm vegetarian" placeholderTextColor={C.muted} style={[styles.input, { flex: 1 }]} />
            <Pressable
              onPress={() => {
                const m = makeMemory(newMemory, 'other', 'manual');
                if (m) memoryOps.add([m]);
                setNewMemory('');
              }}
              style={[styles.smallBtn, { backgroundColor: C.accent }]}
            >
              <Text style={styles.smallBtnText}>Add</Text>
            </Pressable>
          </View>
          {visibleMem.map((m) =>
            editing?.id === m.id ? (
              <View key={m.id} style={[styles.rowCenter, { gap: 8 }]}>
                <TextInput value={editing.text} onChangeText={(t) => setEditing({ id: m.id, text: t })} style={[styles.input, { flex: 1 }]} autoFocus />
                <Pressable
                  onPress={() => {
                    updateMemory(m.id, editing.text);
                    setEditing(null);
                  }}
                  style={[styles.smallBtn, { backgroundColor: C.good }]}
                >
                  <Text style={styles.smallBtnText}>Save</Text>
                </Pressable>
              </View>
            ) : (
              <View key={m.id} style={styles.listRow}>
                <Pressable style={{ flex: 1 }} onPress={() => setEditing({ id: m.id, text: m.text })}>
                  <Text style={styles.bodyText}>{m.text}</Text>
                  <Text style={styles.mutedTiny}>
                    {m.category} · {m.source === 'auto' ? 'learned' : 'added'} · tap to edit
                  </Text>
                </Pressable>
                <Pressable onPress={() => memoryOps.remove([m.id])} hitSlop={8}>
                  <Text style={{ color: C.danger, fontSize: 12 }}>Delete</Text>
                </Pressable>
              </View>
            ),
          )}
          {memories.length > 8 ? (
            <Pressable onPress={() => setShowAllMem((v) => !v)}>
              <Text style={{ color: C.cyan, fontSize: 12 }}>{showAllMem ? 'Show less' : `Show all ${memories.length}`}</Text>
            </Pressable>
          ) : null}
          {memories.length > 0 ? (
            <Pressable onPress={memoryOps.confirmClearAll}>
              <Text style={{ color: C.danger, fontSize: 12 }}>Forget everything</Text>
            </Pressable>
          ) : null}
        </View>

        {/* Reminders */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Reminders ({reminders.length})</Text>
          <Text style={styles.mutedSmall}>Say or type "remind me at 6pm to …". You confirm each one before it's set.</Text>
          {reminders.length === 0 ? <Text style={styles.mutedSmall}>No upcoming reminders.</Text> : null}
          {reminders.map((r) => (
            <View key={r.id} style={styles.listRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.bodyText}>{r.title}</Text>
                <Text style={styles.mutedTiny}>{describeWhen(r)}</Text>
              </View>
              <Pressable onPress={() => cancelReminder(r.id).then(setReminders)} hitSlop={8}>
                <Text style={{ color: C.danger, fontSize: 12 }}>Cancel</Text>
              </Pressable>
            </View>
          ))}
        </View>

        {/* Profile */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Your profile</Text>
          <TextInput value={name} onChangeText={setName} placeholder="Name" placeholderTextColor={C.muted} style={styles.input} />
          <TextInput value={email} onChangeText={setEmail} placeholder="Email" placeholderTextColor={C.muted} autoCapitalize="none" style={styles.input} />
          <TextInput value={phone} onChangeText={setPhone} placeholder="Phone" placeholderTextColor={C.muted} keyboardType="phone-pad" style={styles.input} />
          <TextInput value={address} onChangeText={setAddress} placeholder="Home area / address" placeholderTextColor={C.muted} style={styles.input} />
          <Pressable
            onPress={() => {
              saveProfile({ name: name.trim(), email: email.trim(), phone: phone.trim(), address: address.trim() });
              Alert.alert('Saved', 'Profile updated.');
            }}
            style={styles.primaryBtn}
          >
            <Text style={styles.primaryBtnText}>Save profile</Text>
          </Pressable>
        </View>

        {/* Notes */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Saved notes ({ragIndex.filter((c) => c.category !== 'playbook').length})</Text>
          <TextInput value={noteTitle} onChangeText={setNoteTitle} placeholder="Note title" placeholderTextColor={C.muted} style={styles.input} />
          <TextInput value={noteBody} onChangeText={setNoteBody} placeholder="Details Pulse can look up…" placeholderTextColor={C.muted} multiline style={[styles.input, { minHeight: 64 }]} />
          <Pressable
            onPress={async () => {
              if (!noteTitle.trim() || !noteBody.trim()) return;
              setRagIndex(await ingestDocumentIntoRag(noteTitle.trim(), noteBody.trim(), 'note'));
              setNoteTitle('');
              setNoteBody('');
            }}
            style={styles.secondaryBtn}
          >
            <Text style={styles.primaryBtnText}>Add note</Text>
          </Pressable>
          {ragIndex
            .filter((c) => c.category !== 'playbook')
            .slice(0, 8)
            .map((c) => (
              <View key={c.id} style={styles.listRow}>
                <Text style={[styles.mutedSmall, { flex: 1 }]} numberOfLines={1}>
                  {c.title}
                </Text>
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
      </ScrollView>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Styles                                                             */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight ?? 0 : 0 },
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
  pulseDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: C.accent, marginRight: 9 },
  brand: { color: C.text, fontSize: 17, fontWeight: '700', letterSpacing: 0.2 },
  pillBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, paddingVertical: 6, borderRadius: 20, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { color: C.text, fontSize: 12, fontWeight: '600' },

  tabBar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg, paddingBottom: 4 },
  tabItem: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  tabItemActive: { borderTopWidth: 2, borderTopColor: C.accent },
  tabLabel: { color: C.muted, fontSize: 13, fontWeight: '600' },
  tabLabelActive: { color: C.text, fontWeight: '700' },

  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  emptyTitle: { color: C.text, fontSize: 26, fontWeight: '700', marginBottom: 8 },
  emptySub: { color: C.muted, fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 20 },
  suggestionWrap: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 },
  suggestionPill: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  suggestionText: { color: C.text, fontSize: 12, fontWeight: '500' },

  bubble: { maxWidth: '86%', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 16 },
  userBubble: { backgroundColor: C.accent, borderBottomRightRadius: 4 },
  botBubble: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderBottomLeftRadius: 4 },
  errorBubble: { backgroundColor: 'rgba(239,68,68,0.14)', borderWidth: 1, borderColor: C.danger },
  bubbleText: { color: C.text, fontSize: 15, lineHeight: 21 },
  msgImage: { width: 200, height: 150, borderRadius: 10, marginBottom: 6 },
  fileChip: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.25)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, marginBottom: 6, maxWidth: 240 },
  fileChipBadge: { color: '#fff', fontSize: 10, fontWeight: '800', backgroundColor: C.danger, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 2, overflow: 'hidden' },
  fileChipName: { color: C.text, fontSize: 12, flexShrink: 1 },

  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6, maxWidth: '92%' },
  actionChip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accent },
  actionText: { color: C.text, fontSize: 12, fontWeight: '600' },
  sourceRow: { gap: 6, marginTop: 6, paddingRight: 8 },
  sourceChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, backgroundColor: C.surface2, borderWidth: 1, borderColor: C.border, maxWidth: 180 },
  sourceText: { color: C.cyan, fontSize: 11, fontWeight: '600' },

  reminderCard: { marginTop: 8, padding: 10, borderRadius: 12, backgroundColor: C.surface2, borderWidth: 1, borderColor: C.border },
  reminderTitle: { color: C.text, fontSize: 14, fontWeight: '700', marginBottom: 2 },
  smallBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, backgroundColor: C.surface2, borderWidth: 1, borderColor: C.border },
  smallBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  noticeBar: { marginHorizontal: 12, marginBottom: 6, padding: 10, borderRadius: 10, backgroundColor: 'rgba(245,158,11,0.14)', borderWidth: 1, borderColor: C.warn },
  noticeText: { color: C.text, fontSize: 12 },
  attachBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: C.surface, borderTopWidth: 1, borderTopColor: C.border },
  attachThumb: { width: 44, height: 44, borderRadius: 8 },
  fileIcon: { width: 44, height: 44, borderRadius: 8, backgroundColor: C.surface2, alignItems: 'center', justifyContent: 'center' },
  fileIconText: { color: C.text, fontSize: 11, fontWeight: '800' },
  chipRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingTop: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  chipOn: { borderColor: C.accent, backgroundColor: C.accentSoft },
  chipText: { color: C.text, fontSize: 11, fontWeight: '600' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 12, paddingVertical: 8, gap: 8, backgroundColor: C.bg },
  circleBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  circleBtnText: { color: C.text, fontSize: 20, fontWeight: '500', lineHeight: 22 },
  composerInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    color: C.text,
    backgroundColor: C.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 14,
    paddingVertical: 9,
    fontSize: 15,
  },
  sendBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: C.accent },
  sendText: { color: '#fff', fontSize: 17, fontWeight: '700' },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheetCard: { backgroundColor: C.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, gap: 4, borderTopWidth: 1, borderTopColor: C.border },
  sheetTitle: { color: C.text, fontSize: 15, fontWeight: '700', marginBottom: 4 },
  sheetRow: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.border },
  sheetRowText: { color: C.text, fontSize: 15, fontWeight: '500' },

  searchInput: { color: C.text, backgroundColor: C.surface, borderRadius: 12, borderWidth: 1, borderColor: C.border, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14 },
  appCard: { flex: 1, maxWidth: '31.5%', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 6, borderRadius: 14, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, gap: 8 },
  appBadge: { width: 40, height: 40, borderRadius: 12, backgroundColor: C.surface2, alignItems: 'center', justifyContent: 'center' },
  appBadgeText: { color: C.text, fontSize: 18 },
  appCardName: { color: C.text, fontSize: 12, fontWeight: '600' },

  card: { backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 14, gap: 10 },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: '700' },
  fieldLabel: { color: C.muted, fontSize: 12, fontWeight: '600' },
  bodyText: { color: C.text, fontSize: 14 },
  mutedSmall: { color: C.muted, fontSize: 12 },
  mutedTiny: { color: C.muted, fontSize: 10, marginTop: 2 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.border },
  input: { color: C.text, backgroundColor: C.bg, borderRadius: 10, borderWidth: 1, borderColor: C.border, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14 },
  primaryBtn: { backgroundColor: C.accent, borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  secondaryBtn: { backgroundColor: C.surface2, borderRadius: 10, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  primaryBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  progressTrack: { height: 8, borderRadius: 4, backgroundColor: C.surface2, overflow: 'hidden' },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: C.good },
});
