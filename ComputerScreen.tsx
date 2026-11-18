/*
 * Pulse OS cloud computer screen.
 * Shows the Codespace's own Chrome browser live, lets you tap and type on it,
 * and lets a Gemini agent run tasks on it while your phone does something else.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE = 'pulseos.computer.v1';
export const DEFAULT_COMPUTER_URL = 'https://scaling-space-telegram-jjg94w99g6pj255vv-3000.app.github.dev';
const SCREEN_RATIO = 860 / 412; // server viewport height / width

const C = {
  bg: '#090C12',
  surface: '#111622',
  surface2: '#182032',
  border: '#1F293B',
  text: '#F8FAFC',
  muted: '#8B9BB4',
  accent: '#6366F1',
  good: '#10B981',
  warn: '#F59E0B',
  danger: '#EF4444',
};

type Step = { n: number; at: string; action: string; detail: string };
type ComputerState = {
  ok: boolean;
  status: 'off' | 'idle' | 'running' | 'waiting' | 'done' | 'error';
  goal: string;
  url: string;
  title: string;
  steps: Step[];
  question: string;
  answer: string;
  error: string;
  model: string;
  browser: boolean;
};
type Cfg = { url: string; token: string };

function normalizeUrl(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '');
  if (!s) return DEFAULT_COMPUTER_URL;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z0-9-]+$/i.test(s)) return `https://${s}-3000.app.github.dev`; // bare codespace name
  return `https://${s}`;
}

export default function ComputerScreen({ active, geminiKey }: { active: boolean; geminiKey: string }) {
  const [cfg, setCfg] = useState<Cfg>({ url: DEFAULT_COMPUTER_URL, token: '' });
  const [setupOpen, setSetupOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [st, setSt] = useState<ComputerState | null>(null);
  const [conn, setConn] = useState<'unknown' | 'ok' | 'error'>('unknown');
  const [connMsg, setConnMsg] = useState('');
  const [frame, setFrame] = useState(0);
  const [shownFrame, setShownFrame] = useState(0);
  const [box, setBox] = useState({ w: 1, h: 1 });
  const [goal, setGoal] = useState('');
  const [addr, setAddr] = useState('');
  const [typed, setTyped] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const failCount = useRef(0);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE)
      .then((raw) => {
        if (raw) {
          const c = JSON.parse(raw);
          setCfg({ url: normalizeUrl(c.url || ''), token: c.token || '' });
          if (!c.token) setSetupOpen(true);
        } else {
          setSetupOpen(true);
        }
      })
      .catch(() => setSetupOpen(true))
      .finally(() => setLoaded(true));
  }, []);

  const saveCfg = useCallback((next: Cfg) => {
    const c = { url: normalizeUrl(next.url), token: next.token.trim() };
    setCfg(c);
    AsyncStorage.setItem(STORAGE, JSON.stringify(c)).catch(() => undefined);
  }, []);

  const headers = useCallback(
    (json = true): Record<string, string> => {
      const h: Record<string, string> = { Authorization: `Bearer ${cfg.token}` };
      if (json) h['Content-Type'] = 'application/json';
      if (geminiKey) h['x-gemini-key'] = geminiKey;
      return h;
    },
    [cfg.token, geminiKey],
  );

  const call = useCallback(
    async (path: string, body?: any) => {
      const r = await fetch(`${cfg.url}/api/computer${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let j: any = {};
      try {
        j = JSON.parse(text);
      } catch {
        throw new Error(r.status === 401 ? 'Wrong token.' : `Server answered ${r.status}. Is the Codespace running and port 3000 public?`);
      }
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    },
    [cfg.url, headers],
  );

  // Poll state while the tab is open (and keep polling while a task runs).
  useEffect(() => {
    if (!loaded || !cfg.token) return;
    const running = st?.status === 'running' || st?.status === 'waiting';
    if (!active && !running) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = (await call('/state')) as ComputerState;
        if (!alive) return;
        setSt(s);
        setConn('ok');
        setConnMsg('');
        failCount.current = 0;
      } catch (e: any) {
        if (!alive) return;
        failCount.current += 1;
        if (failCount.current >= 2) {
          setConn('error');
          setConnMsg(String(e?.message || e));
        }
      }
    };
    tick();
    const id = setInterval(tick, 1200);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active, loaded, cfg.token, call, st?.status]);

  // Refresh the screen image.
  useEffect(() => {
    if (!active || !cfg.token || conn !== 'ok' || !st?.browser) return;
    const id = setInterval(() => setFrame((f) => f + 1), 900);
    return () => clearInterval(id);
  }, [active, cfg.token, conn, st?.browser]);

  const run = useCallback(
    async (fn: () => Promise<any>) => {
      setBusy(true);
      try {
        await fn();
        setFrame((f) => f + 1);
      } catch (e: any) {
        setConnMsg(String(e?.message || e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const startTask = () => {
    const g = goal.trim();
    if (!g) return;
    run(async () => {
      await call('/task', { goal: g });
      setGoal('');
    });
  };

  const onLayout = (e: LayoutChangeEvent) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });

  const onTap = (e: any) => {
    const { locationX, locationY } = e.nativeEvent;
    run(() => call('/act', { type: 'tap', x: locationX / box.w, y: locationY / box.h }));
  };

  if (!loaded) {
    return (
      <View style={s.center}>
        <ActivityIndicator color={C.accent} />
      </View>
    );
  }

  const statusColor =
    conn === 'error' ? C.danger : st?.status === 'running' ? C.accent : st?.status === 'waiting' ? C.warn : conn === 'ok' ? C.good : C.muted;
  const statusText =
    conn === 'error'
      ? 'Not connected'
      : !st
        ? 'Connecting…'
        : st.status === 'running'
          ? 'Working'
          : st.status === 'waiting'
            ? 'Needs you'
            : st.status === 'done'
              ? 'Done'
              : st.status === 'error'
                ? 'Error'
                : st.browser
                  ? 'Ready'
                  : 'Asleep';
  const imgUri = `${cfg.url}/api/computer/screen.jpg?f=${frame}`;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
        <View style={s.rowBetween}>
          <View style={s.row}>
            <View style={[s.dot, { backgroundColor: statusColor }]} />
            <Text style={s.title}>Cloud computer</Text>
            <Text style={s.muted}>  {statusText}</Text>
          </View>
          <Pressable onPress={() => setSetupOpen((v) => !v)} style={s.pill}>
            <Text style={s.pillText}>{setupOpen ? 'Close' : 'Setup'}</Text>
          </Pressable>
        </View>

        {setupOpen && (
          <SetupCard
            cfg={cfg}
            onSave={(c) => {
              saveCfg(c);
              setSetupOpen(false);
              setConn('unknown');
              failCount.current = 0;
            }}
          />
        )}

        {!!connMsg && <Text style={s.error}>{connMsg}</Text>}

        {/* Task box */}
        <View style={s.card}>
          <TextInput
            value={goal}
            onChangeText={setGoal}
            placeholder="Tell the computer what to do…"
            placeholderTextColor={C.muted}
            style={s.input}
            multiline
            onSubmitEditing={startTask}
          />
          <View style={[s.row, { gap: 8, marginTop: 8 }]}>
            <Pressable onPress={startTask} disabled={busy || !cfg.token} style={[s.btn, { flex: 1 }]}>
              <Text style={s.btnText}>Run task</Text>
            </Pressable>
            {(st?.status === 'running' || st?.status === 'waiting') && (
              <Pressable onPress={() => run(() => call('/stop', {}))} style={[s.btn, { backgroundColor: C.danger }]}>
                <Text style={s.btnText}>Stop</Text>
              </Pressable>
            )}
          </View>
        </View>

        {/* Agent question */}
        {st?.status === 'waiting' && !!st.question && (
          <View style={[s.card, { borderColor: C.warn }]}>
            <Text style={s.body}>{st.question}</Text>
            <TextInput
              value={reply}
              onChangeText={setReply}
              placeholder="Your answer"
              placeholderTextColor={C.muted}
              style={[s.input, { marginTop: 8 }]}
            />
            <View style={[s.row, { gap: 8, marginTop: 8 }]}>
              <Pressable
                onPress={() =>
                  run(async () => {
                    await call('/answer', { text: 'yes' });
                    setReply('');
                  })
                }
                style={[s.btn, { flex: 1, backgroundColor: C.good }]}
              >
                <Text style={s.btnText}>Yes, go ahead</Text>
              </Pressable>
              <Pressable
                onPress={() =>
                  run(async () => {
                    await call('/answer', { text: reply.trim() || 'no' });
                    setReply('');
                  })
                }
                style={[s.btn, { flex: 1 }]}
              >
                <Text style={s.btnText}>Send answer</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Final answer */}
        {st?.status === 'done' && !!st.answer && (
          <View style={[s.card, { borderColor: C.good }]}>
            <Text style={s.body}>{st.answer}</Text>
          </View>
        )}

        {/* Address bar */}
        <View style={[s.row, { gap: 6 }]}>
          <Pressable onPress={() => run(() => call('/act', { type: 'back' }))} style={s.iconBtn}>
            <Text style={s.iconText}>‹</Text>
          </Pressable>
          <TextInput
            value={addr}
            onChangeText={setAddr}
            placeholder={st?.url || 'Search or type a URL'}
            placeholderTextColor={C.muted}
            style={[s.input, { flex: 1, paddingVertical: 8 }]}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={() => {
              const u = addr.trim();
              if (!u) return;
              run(async () => {
                await call('/act', { type: 'navigate', url: u });
                setAddr('');
              });
            }}
          />
          <Pressable onPress={() => run(() => call('/act', { type: 'reload' }))} style={s.iconBtn}>
            <Text style={s.iconText}>↻</Text>
          </Pressable>
        </View>

        {/* Live screen */}
        <View style={[s.screen, { aspectRatio: 1 / SCREEN_RATIO }]} onLayout={onLayout}>
          {cfg.token && conn === 'ok' && st?.browser ? (
            <Pressable onPress={onTap} style={StyleSheet.absoluteFill}>
              {/* Two stacked images: the old frame stays visible until the new one loads (no flicker). */}
              <Image
                source={{ uri: `${cfg.url}/api/computer/screen.jpg?f=${shownFrame}`, headers: headers(false) }}
                style={StyleSheet.absoluteFill}
                resizeMode="contain"
                fadeDuration={0}
              />
              <Image
                key={imgUri}
                source={{ uri: imgUri, headers: headers(false) }}
                style={[StyleSheet.absoluteFill, { opacity: 0 }]}
                fadeDuration={0}
                onLoad={() => setShownFrame(frame)}
              />
            </Pressable>
          ) : (
            <View style={s.center}>
              <Text style={s.muted}>
                {!cfg.token
                  ? 'Add your server token in Setup.'
                  : conn === 'error'
                    ? 'Start your Codespace, then come back.'
                    : 'The browser is asleep. Run a task or open a page to wake it.'}
              </Text>
            </View>
          )}
          {busy && <ActivityIndicator style={s.busy} color={C.accent} />}
        </View>
        {!!st?.title && <Text style={s.muted} numberOfLines={1}>{st.title}</Text>}

        {/* Manual controls */}
        <View style={[s.row, { gap: 6 }]}>
          <TextInput
            value={typed}
            onChangeText={setTyped}
            placeholder="Type into the page (tap a field first)"
            placeholderTextColor={C.muted}
            style={[s.input, { flex: 1, paddingVertical: 8 }]}
            autoCapitalize="none"
            secureTextEntry={false}
            onSubmitEditing={() =>
              run(async () => {
                await call('/act', { type: 'type', text: typed, submit: true });
                setTyped('');
              })
            }
          />
          <Pressable onPress={() => run(() => call('/act', { type: 'scroll', direction: 'up' }))} style={s.iconBtn}>
            <Text style={s.iconText}>▲</Text>
          </Pressable>
          <Pressable onPress={() => run(() => call('/act', { type: 'scroll', direction: 'down' }))} style={s.iconBtn}>
            <Text style={s.iconText}>▼</Text>
          </Pressable>
        </View>
        <Text style={s.mutedSmall}>Passwords and codes you type here go straight to the page and are never logged.</Text>

        {/* Steps */}
        {!!st?.steps?.length && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Steps{st.model ? `  ·  ${st.model}` : ''}</Text>
            {st.steps
              .slice(-10)
              .reverse()
              .map((x) => (
                <Text key={x.n} style={s.step} numberOfLines={2}>
                  <Text style={{ color: C.accent }}>{x.action}</Text> {x.detail}
                </Text>
              ))}
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function SetupCard({ cfg, onSave }: { cfg: Cfg; onSave: (c: Cfg) => void }) {
  const [url, setUrl] = useState(cfg.url);
  const [token, setToken] = useState(cfg.token);
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>Server</Text>
      <Text style={s.mutedSmall}>Your Codespace URL (or just its name) and the PULSE_TOKEN you set as a Codespace secret.</Text>
      <TextInput
        value={url}
        onChangeText={setUrl}
        placeholder={DEFAULT_COMPUTER_URL}
        placeholderTextColor={C.muted}
        style={[s.input, { marginTop: 8 }]}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        value={token}
        onChangeText={setToken}
        placeholder="PULSE_TOKEN"
        placeholderTextColor={C.muted}
        style={[s.input, { marginTop: 8 }]}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />
      <Pressable onPress={() => onSave({ url, token })} style={[s.btn, { marginTop: 10 }]}>
        <Text style={s.btnText}>Save</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 14, gap: 10, paddingBottom: 40 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  title: { color: C.text, fontSize: 16, fontWeight: '700' },
  muted: { color: C.muted, fontSize: 13 },
  mutedSmall: { color: C.muted, fontSize: 11 },
  body: { color: C.text, fontSize: 14, lineHeight: 20 },
  error: { color: C.danger, fontSize: 13 },
  card: { backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 12 },
  cardTitle: { color: C.text, fontSize: 14, fontWeight: '700', marginBottom: 6 },
  input: {
    backgroundColor: C.surface2,
    color: C.text,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    borderWidth: 1,
    borderColor: C.border,
  },
  btn: { backgroundColor: C.accent, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 14, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  pill: { borderWidth: 1, borderColor: C.border, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  pillText: { color: C.text, fontSize: 12, fontWeight: '600' },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: { color: C.text, fontSize: 18, fontWeight: '700' },
  screen: { width: '100%', backgroundColor: '#000', borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: C.border },
  busy: { position: 'absolute', top: 10, right: 10 },
  step: { color: C.muted, fontSize: 12, marginTop: 3 },
});
