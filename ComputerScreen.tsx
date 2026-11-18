/*
 * Pulse OS cloud computer screen (v3).
 * Shows the Codespace's own Chrome browser as a live MJPEG stream (react-native-webview <img>), follows the
 * agent through Server-Sent Events (XHR streaming), and lets you tap / swipe / type on the page.
 * Falls back to the old screenshot + state polling when the server is older.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView, WebViewMessageEvent } from 'react-native-webview';

const STORAGE = 'pulseos.computer.v1';
export const DEFAULT_COMPUTER_URL = 'https://scaling-space-telegram-jjg94w99g6pj255vv-3000.app.github.dev';
const VIEW_W = 412;
const VIEW_H = 860;
const STREAM_WIDTH = 618; // 1.5x the viewport: sharp on a 1080p screen, still light on mobile data
const STREAM_QUALITY = 55;

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
type Mode = 'unknown' | 'stream' | 'legacy';
type EngineMode = 'local' | 'cloud';

function normalizeUrl(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '');
  if (!s) return DEFAULT_COMPUTER_URL;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z0-9-]+$/i.test(s)) return `https://${s}-3000.app.github.dev`; // bare codespace name
  return `https://${s}`;
}

function toBrowserUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return 'https://www.google.com';
  if (/^https?:\/\//i.test(s)) return s;
  if (/\./.test(s) && !/\s/.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

/** The live screen page inside the WebView: one <img> fed by the MJPEG stream, plus tap/swipe capture. */
function streamHtml(src: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none}
img{position:absolute;inset:0;width:100%;height:100%;object-fit:fill;display:block;-webkit-user-drag:none}</style></head>
<body><img id="s" draggable="false" alt=""><script>
(function(){
  var img=document.getElementById('s'), SRC=${JSON.stringify(src)}, tries=0, live=false;
  function post(o){ try{ window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
  function load(){ live=false; img.src = SRC + '&r=' + Date.now(); }
  img.onload=function(){ tries=0; if(!live){ live=true; post({t:'live'}); } };
  img.onerror=function(){ post({t:'err'}); tries++; setTimeout(load, Math.min(6000, 600*tries)); };
  var sx=0, sy=0, st=0, ly=0, moved=false;
  document.addEventListener('touchstart', function(e){ var t=e.touches[0]; sx=t.clientX; sy=t.clientY; ly=sy; st=Date.now(); moved=false; }, {passive:true});
  document.addEventListener('touchmove', function(e){
    var t=e.touches[0]; var dy=ly-t.clientY;
    if(Math.abs(t.clientY-sy)>12 || Math.abs(t.clientX-sx)>12) moved=true;
    if(moved && Math.abs(dy)>24){ post({t:'scroll', dy: Math.round(dy * ${VIEW_H} / window.innerHeight * 1.6)}); ly=t.clientY; }
  }, {passive:true});
  document.addEventListener('touchend', function(e){
    if(moved || Date.now()-st>600) return;
    post({t:'tap', x: sx/window.innerWidth, y: sy/window.innerHeight});
  }, {passive:true});
  document.addEventListener('visibilitychange', function(){ if(!document.hidden) load(); });
  load();
})();
</script></body></html>`;
}

export default function ComputerScreen({ active, geminiKey }: { active: boolean; geminiKey?: string }) {
  const [engine, setEngine] = useState<EngineMode>('local');
  const [localUrl, setLocalUrl] = useState('https://www.google.com');
  const [localTitle, setLocalTitle] = useState('Google');
  const [localLoading, setLocalLoading] = useState(false);
  const [localAnswer, setLocalAnswer] = useState('');
  const [localSteps, setLocalSteps] = useState<Step[]>([]);
  const localWebRef = useRef<WebView>(null);

  const [cfg, setCfg] = useState<Cfg>({ url: DEFAULT_COMPUTER_URL, token: '' });
  const [setupOpen, setSetupOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [st, setSt] = useState<ComputerState | null>(null);
  const [conn, setConn] = useState<'unknown' | 'ok' | 'error'>('unknown');
  const [connMsg, setConnMsg] = useState('');
  const [mode, setMode] = useState<Mode>('unknown');
  const [streamLive, setStreamLive] = useState(false);
  const [streamKey, setStreamKey] = useState(0);
  const [frame, setFrame] = useState(0);
  const [shownFrame, setShownFrame] = useState(0);
  const [goal, setGoal] = useState('');
  const [addr, setAddr] = useState('');
  const [typed, setTyped] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [tapFx, setTapFx] = useState<{ x: number; y: number; k: number } | null>(null);
  const [screenTouch, setScreenTouch] = useState(false); // stops the page ScrollView stealing swipes from the live screen
  const [alwaysOn, setAlwaysOn] = useState(true);
  const boxRef = useRef({ w: 1, h: 1 });
  const wakingRef = useRef(false);

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
    setMode('unknown');
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

  // Detect server features once per config: new servers stream, old ones get polled.
  useEffect(() => {
    if (!loaded || !cfg.token || mode !== 'unknown') return;
    let alive = true;
    fetch(`${cfg.url}/health`)
      .then((r) => r.json())
      .then((h) => {
        if (!alive) return;
        setMode(Array.isArray(h?.computer_features) && h.computer_features.includes('stream') ? 'stream' : 'legacy');
      })
      .catch((e) => {
        if (!alive) return;
        setConn('error');
        setConnMsg(`Can't reach the server: ${String(e?.message || e)}. Start your Codespace, then come back.`);
        setTimeout(() => alive && setMode('unknown'), 5000);
      });
    return () => {
      alive = false;
    };
  }, [loaded, cfg.url, cfg.token, mode]);

  const running = st?.status === 'running' || st?.status === 'waiting';

  // State via Server-Sent Events over XHR streaming (EventSource can't send headers in RN).
  useEffect(() => {
    if (mode !== 'stream' || !cfg.token) return;
    if (!alwaysOn && !active && !running) return;
    let alive = true;
    let xhr: XMLHttpRequest | null = null;
    let retry: any = null;
    let backoff = 800;
    const connect = () => {
      if (!alive) return;
      const x = new XMLHttpRequest();
      xhr = x;
      let seen = 0;
      let buf = '';
      x.open('GET', `${cfg.url}/api/computer/events`);
      x.setRequestHeader('Authorization', `Bearer ${cfg.token}`);
      x.setRequestHeader('Accept', 'text/event-stream');
      x.onprogress = () => {
        if (x.status !== 200) return;
        const chunk = x.responseText.slice(seen);
        seen = x.responseText.length;
        buf += chunk;
        const blocks = buf.split('\n\n');
        buf = blocks.pop() || '';
        for (const b of blocks) {
          const data = b
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('\n');
          if (!data) continue;
          try {
            setSt(JSON.parse(data));
            setConn('ok');
            setConnMsg('');
            backoff = 800;
          } catch {}
        }
        // Recycle the connection before responseText grows large.
        if (seen > 2_000_000) x.abort();
      };
      const again = () => {
        if (!alive) return;
        if (x.status === 401) {
          setConn('error');
          setConnMsg('Wrong token. Check Setup.');
          return;
        }
        retry = setTimeout(connect, backoff);
        backoff = Math.min(6000, backoff * 1.7);
      };
      x.onerror = () => {
        setConn((c) => (c === 'ok' ? 'ok' : 'error'));
        again();
      };
      x.onload = again; // server closed the stream
      x.onabort = () => alive && (retry = setTimeout(connect, 100));
      x.send();
    };
    connect();
    return () => {
      alive = false;
      clearTimeout(retry);
      if (xhr) {
        xhr.onabort = null;
        xhr.abort();
      }
    };
  }, [mode, active, running, cfg.url, cfg.token]);

  // Legacy servers: poll /state and screenshots like before.
  useEffect(() => {
    if (mode !== 'legacy' || !cfg.token || (!alwaysOn && !active && !running)) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = (await call('/state')) as ComputerState;
        if (!alive) return;
        setSt(s);
        setConn('ok');
        setConnMsg('');
      } catch (e: any) {
        if (!alive) return;
        setConn('error');
        setConnMsg(String(e?.message || e));
      }
    };
    tick();
    const id = setInterval(tick, alwaysOn && !active ? 8000 : 1500);
    const id2 = active ? setInterval(() => setFrame((f) => f + 1), 1000) : null;
    return () => {
      alive = false;
      clearInterval(id);
      if (id2) clearInterval(id2);
    };
  }, [mode, alwaysOn, active, running, cfg.token, call]);

  // Always-On keepalive & auto-wake: keeps the remote browser warm and connected.
  useEffect(() => {
    if (!alwaysOn || !cfg.token || conn === 'error') return;
    if (st && !st.browser && !wakingRef.current) {
      wakingRef.current = true;
      call(mode === 'stream' ? '/wake' : '/act', mode === 'stream' ? {} : { type: 'reload' })
        .catch(() => undefined)
        .finally(() => {
          wakingRef.current = false;
        });
    }
    const id = setInterval(() => {
      call('/keepalive', {}).catch(() => call('/state').catch(() => undefined));
    }, 180000);
    return () => clearInterval(id);
  }, [alwaysOn, cfg.token, conn, st?.browser, mode, call]);

  const run = useCallback(async (fn: () => Promise<any>, quiet = false) => {
    if (!quiet) setBusy(true);
    try {
      await fn();
      setFrame((f) => f + 1);
    } catch (e: any) {
      setConnMsg(String(e?.message || e));
    } finally {
      if (!quiet) setBusy(false);
    }
  }, []);

  const addLocalStep = (action: string, detail: string) => {
    setLocalSteps((prev) => [...prev.slice(-14), { n: prev.length + 1, at: new Date().toISOString(), action, detail }]);
  };

  const runLocalComputerTask = (rawGoal: string) => {
    const clauses = rawGoal
      .split(/\s*(?:;|,|\bthen\b|\band\s+then\b)\s*/i)
      .map((c) => c.trim())
      .filter(Boolean);
    setLocalAnswer('');
    for (const clause of clauses) {
      const lower = clause.toLowerCase();
      if (/^(?:open|go\s+to|visit|navigate\s+to)\s+(.+)$/i.test(clause)) {
        const target = clause.replace(/^(?:open|go\s+to|visit|navigate\s+to)\s+/i, '').trim();
        const url = toBrowserUrl(target);
        setLocalUrl(url);
        addLocalStep('open', url);
      } else if (/^(?:search(?:\s+for)?|google|find)\s+(.+)$/i.test(clause)) {
        const q = clause.replace(/^(?:search(?:\s+for)?|google|find)\s+/i, '').trim();
        const url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
        setLocalUrl(url);
        addLocalStep('search', q);
      } else if (/^scroll\s+up/i.test(lower)) {
        localWebRef.current?.injectJavaScript('window.scrollBy({top:-500,behavior:"smooth"});true;');
        addLocalStep('scroll', 'up');
      } else if (/^scroll\s+down/i.test(lower)) {
        localWebRef.current?.injectJavaScript('window.scrollBy({top:500,behavior:"smooth"});true;');
        addLocalStep('scroll', 'down');
      } else if (/^(?:go\s+)?back$/i.test(lower)) {
        localWebRef.current?.goBack();
        addLocalStep('back', '');
      } else if (/^(?:reload|refresh)$/i.test(lower)) {
        localWebRef.current?.reload();
        addLocalStep('reload', '');
      } else if (/^(?:read|summari[sz]e)(?:\s+page)?$/i.test(lower)) {
        localWebRef.current?.injectJavaScript(
          'window.ReactNativeWebView.postMessage(JSON.stringify({t:"read",title:document.title,text:(document.body?document.body.innerText:"").slice(0,900)}));true;',
        );
        addLocalStep('read', 'Extracting page text');
      } else if (/^(?:click|tap|press)\s+(.+)$/i.test(clause)) {
        const target = clause.replace(/^(?:click|tap|press)\s+/i, '').trim().toLowerCase();
        localWebRef.current?.injectJavaScript(`
          (function(){
            var els = Array.from(document.querySelectorAll('a,button,input[type=submit],[role=button]'));
            var m = els.find(function(e){ return (e.innerText||e.value||e.getAttribute('aria-label')||'').toLowerCase().includes(${JSON.stringify(target)}); });
            if(m){ m.click(); window.ReactNativeWebView.postMessage(JSON.stringify({t:'clicked',label:m.innerText||${JSON.stringify(target)}})); }
          })(); true;
        `);
        addLocalStep('click', target);
      } else {
        const url = toBrowserUrl(clause);
        setLocalUrl(url);
        addLocalStep('open', url);
      }
    }
  };

  const startTask = () => {
    const g = goal.trim();
    if (!g) return;
    if (engine === 'local') {
      runLocalComputerTask(g);
      setGoal('');
      return;
    }
    run(async () => {
      await call('/task', { goal: g });
      setGoal('');
    });
  };

  const tapAt = (x: number, y: number) => {
    setTapFx({ x, y, k: Date.now() });
    run(() => call('/act', { type: 'tap', x, y }), true);
  };

  const onStreamMessage = (e: WebViewMessageEvent) => {
    let m: any;
    try {
      m = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (m.t === 'live') setStreamLive(true);
    else if (m.t === 'err') setStreamLive(false);
    else if (m.t === 'tap') tapAt(Number(m.x), Number(m.y));
    else if (m.t === 'scroll') run(() => call('/act', { type: 'scroll', dy: Number(m.dy) }), true);
  };

  const onLocalMessage = (e: WebViewMessageEvent) => {
    try {
      const m = JSON.parse(e.nativeEvent.data);
      if (m.t === 'read') setLocalAnswer(`${m.title}\n\n${m.text}`.trim());
      else if (m.t === 'clicked') addLocalStep('clicked', m.label || 'element');
    } catch {}
  };

  const streamSrc = `${cfg.url}/api/computer/stream?token=${encodeURIComponent(cfg.token)}&w=${STREAM_WIDTH}&q=${STREAM_QUALITY}`;
  const html = useMemo(() => streamHtml(streamSrc), [streamSrc]);

  useEffect(() => {
    if (!tapFx) return;
    const t = setTimeout(() => setTapFx(null), 350);
    return () => clearTimeout(t);
  }, [tapFx]);

  if (!loaded) {
    return (
      <View style={s.center}>
        <ActivityIndicator color={C.accent} />
      </View>
    );
  }

  const statusColor = engine === 'local' ? C.good : conn === 'error' ? C.danger : st?.status === 'running' ? C.accent : st?.status === 'waiting' ? C.warn : conn === 'ok' ? C.good : C.muted;
  const statusText =
    engine === 'local'
      ? localLoading
        ? 'Loading…'
        : 'Active · On-Device'
      : conn === 'error'
        ? 'Offline'
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
  const showScreen = engine === 'cloud' && !!cfg.token && conn === 'ok' && !!st?.browser;
  const legacyUri = `${cfg.url}/api/computer/screen.jpg?f=${frame}`;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled" scrollEnabled={!screenTouch}>
        <View style={[s.rowBetween, { flexWrap: 'wrap', gap: 8 }]}>
          <View style={s.row}>
            <View style={[s.dot, { backgroundColor: statusColor }]} />
            <Text style={s.title}>AI Computer</Text>
            <Text style={s.muted}> · {statusText}</Text>
          </View>
          <View style={[s.row, { gap: 6 }]}>
            <Pressable
              onPress={() => {
                setConnMsg('');
                setEngine((e) => (e === 'local' ? 'cloud' : 'local'));
              }}
              style={[s.pill, engine === 'local' && { borderColor: C.good }]}
            >
              <Text style={s.pillText}>{engine === 'local' ? '📱 On-Device' : '☁️ Cloud'}</Text>
            </Pressable>
            {engine === 'cloud' && (
              <Pressable onPress={() => setSetupOpen((v) => !v)} style={s.pill}>
                <Text style={s.pillText}>{setupOpen ? 'Close' : 'Setup'}</Text>
              </Pressable>
            )}
          </View>
        </View>

        {engine === 'cloud' && setupOpen && (
          <SetupCard
            cfg={cfg}
            onSave={(c) => {
              saveCfg(c);
              setSetupOpen(false);
              setConn('unknown');
            }}
          />
        )}

        {engine === 'cloud' && !!connMsg && <Text style={s.error}>{connMsg}</Text>}

        <View style={s.card}>
          <TextInput
            value={goal}
            onChangeText={setGoal}
            placeholder='Command (e.g. "Open Google.com", "Search Hyderabad news", "Read page")…'
            placeholderTextColor={C.muted}
            style={s.input}
            multiline
            onSubmitEditing={startTask}
          />
          <View style={[s.row, { gap: 8, marginTop: 8 }]}>
            <Pressable onPress={startTask} disabled={busy || (engine === 'cloud' && (!cfg.token || running))} style={[s.btn, { flex: 1 }, (busy || (engine === 'cloud' && running)) && { opacity: 0.5 }]}>
              <Text style={s.btnText}>Run task</Text>
            </Pressable>
            {engine === 'local' && (
              <Pressable onPress={() => runLocalComputerTask('read page')} style={[s.btn, { backgroundColor: C.surface2, borderWidth: 1, borderColor: C.border }]}>
                <Text style={s.btnText}>Read page</Text>
              </Pressable>
            )}
            {engine === 'cloud' && running && (
              <Pressable onPress={() => run(() => call('/stop', {}))} style={[s.btn, { backgroundColor: C.danger }]}>
                <Text style={s.btnText}>Stop</Text>
              </Pressable>
            )}
          </View>
        </View>

        {engine === 'local' && !!localAnswer && (
          <View style={[s.card, { borderColor: C.good }]}>
            <View style={s.rowBetween}>
              <Text style={s.cardTitle}>Page Summary</Text>
              <Pressable onPress={() => setLocalAnswer('')}>
                <Text style={{ color: C.muted, fontSize: 12 }}>Dismiss</Text>
              </Pressable>
            </View>
            <Text selectable style={s.body}>
              {localAnswer}
            </Text>
          </View>
        )}

        {engine === 'cloud' && st?.status === 'waiting' && !!st.question && (
          <View style={[s.card, { borderColor: C.warn }]}>
            <Text style={s.body}>{st.question}</Text>
            <TextInput value={reply} onChangeText={setReply} placeholder="Your answer" placeholderTextColor={C.muted} style={[s.input, { marginTop: 8 }]} />
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

        {engine === 'cloud' && st?.status === 'done' && !!st.answer && (
          <View style={[s.card, { borderColor: C.good }]}>
            <Text selectable style={s.body}>
              {st.answer}
            </Text>
          </View>
        )}
        {engine === 'cloud' && st?.status === 'error' && !!st.error && (
          <View style={[s.card, { borderColor: C.danger }]}>
            <Text style={s.body}>{st.error}</Text>
          </View>
        )}

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {[
            { label: 'Google', url: 'https://www.google.com' },
            { label: 'YouTube', url: 'https://m.youtube.com' },
            { label: 'Wikipedia', url: 'https://en.m.wikipedia.org' },
            { label: 'News', url: 'https://news.google.com' },
          ].map((q) => (
            <Pressable
              key={q.label}
              onPress={() => {
                if (engine === 'local') {
                  setLocalUrl(q.url);
                  addLocalStep('open', q.url);
                } else {
                  run(() => call('/act', { type: 'navigate', url: q.url }), true);
                }
              }}
              style={s.pill}
            >
              <Text style={s.pillText}>{q.label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        <View style={[s.row, { gap: 6 }]}>
          <Pressable
            onPress={() => (engine === 'local' ? localWebRef.current?.goBack() : run(() => call('/act', { type: 'back' }), true))}
            style={s.iconBtn}
          >
            <Text style={s.iconText}>‹</Text>
          </Pressable>
          <TextInput
            value={addr}
            onChangeText={setAddr}
            placeholder={(engine === 'local' ? localUrl : st?.url) || 'Search or type a URL'}
            placeholderTextColor={C.muted}
            style={[s.input, { flex: 1, paddingVertical: 8 }]}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={() => {
              const u = addr.trim();
              if (!u) return;
              if (engine === 'local') {
                const target = toBrowserUrl(u);
                setLocalUrl(target);
                addLocalStep('open', target);
                setAddr('');
              } else {
                run(async () => {
                  await call('/act', { type: 'navigate', url: u });
                  setAddr('');
                });
              }
            }}
          />
          <Pressable
            onPress={() => (engine === 'local' ? localWebRef.current?.reload() : run(() => call('/act', { type: 'reload' }), true))}
            style={s.iconBtn}
          >
            <Text style={s.iconText}>↻</Text>
          </Pressable>
        </View>

        <View
          style={[s.screen, { aspectRatio: VIEW_W / VIEW_H }]}
          onTouchStart={() => setScreenTouch(true)}
          onTouchEnd={() => setScreenTouch(false)}
          onTouchCancel={() => setScreenTouch(false)}
          onLayout={(e) => {
            boxRef.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
          }}
        >
          {engine === 'local' ? (
            <WebView
              ref={localWebRef}
              source={{ uri: localUrl }}
              onMessage={onLocalMessage}
              onLoadStart={() => setLocalLoading(true)}
              onLoadEnd={() => setLocalLoading(false)}
              onNavigationStateChange={(nav) => {
                if (nav.url) setLocalUrl(nav.url);
                if (nav.title) setLocalTitle(nav.title);
              }}
              style={{ flex: 1, backgroundColor: '#fff' }}
              javaScriptEnabled
              domStorageEnabled
              allowsBackForwardNavigationGestures
            />
          ) : showScreen && mode === 'stream' && active ? (
            <WebView
              key={`${streamKey}-${cfg.url}`}
              source={{ html, baseUrl: cfg.url }}
              originWhitelist={['*']}
              onMessage={onStreamMessage}
              style={{ flex: 1, backgroundColor: '#000' }}
              containerStyle={{ backgroundColor: '#000' }}
              scrollEnabled={false}
              overScrollMode="never"
              javaScriptEnabled
              domStorageEnabled={false}
              cacheEnabled={false}
              androidLayerType="hardware"
              setSupportMultipleWindows={false}
              onRenderProcessGone={() => setStreamKey((k) => k + 1)}
            />
          ) : showScreen && mode === 'legacy' ? (
            <Pressable
              onPress={(e) => tapAt(e.nativeEvent.locationX / boxRef.current.w, e.nativeEvent.locationY / boxRef.current.h)}
              style={StyleSheet.absoluteFill}
            >
              <Image source={{ uri: `${cfg.url}/api/computer/screen.jpg?f=${shownFrame}`, headers: headers(false) }} style={StyleSheet.absoluteFill} resizeMode="contain" fadeDuration={0} />
              <Image
                key={legacyUri}
                source={{ uri: legacyUri, headers: headers(false) }}
                style={[StyleSheet.absoluteFill, { opacity: 0 }]}
                fadeDuration={0}
                onLoad={() => setShownFrame(frame)}
              />
            </Pressable>
          ) : (
            <View style={s.center}>
              <Text style={[s.muted, { textAlign: 'center' }]}>
                {!cfg.token ? 'Add your server token in Setup, or tap 📱 On-Device above.' : conn === 'error' ? 'Cloud server unreachable. Tap 📱 On-Device above to browse immediately.' : 'Connecting…'}
              </Text>
              {!!cfg.token && conn === 'ok' && !st?.browser && (
                <Pressable onPress={() => run(() => call(mode === 'stream' ? '/wake' : '/act', mode === 'stream' ? {} : { type: 'reload' }))} style={[s.btn, { marginTop: 12 }]}>
                  <Text style={s.btnText}>Wake browser</Text>
                </Pressable>
              )}
            </View>
          )}
          {((engine === 'local' && localLoading) || (engine === 'cloud' && ((showScreen && mode === 'stream' && !streamLive) || busy))) && (
            <ActivityIndicator style={s.busy} color={C.accent} />
          )}
          {tapFx && <View pointerEvents="none" style={[s.tapFx, { left: tapFx.x * boxRef.current.w - 14, top: tapFx.y * boxRef.current.h - 14 }]} />}
        </View>
        {!!(engine === 'local' ? localTitle : st?.title) && (
          <Text style={s.muted} numberOfLines={1}>
            {engine === 'local' ? localTitle : st?.title}
          </Text>
        )}

        {engine === 'cloud' && (
          <View style={[s.row, { gap: 6 }]}>
            <TextInput
              value={typed}
              onChangeText={setTyped}
              placeholder="Type into the page (tap a field first)"
              placeholderTextColor={C.muted}
              style={[s.input, { flex: 1, paddingVertical: 8 }]}
              autoCapitalize="none"
              onSubmitEditing={() =>
                run(async () => {
                  await call('/act', { type: 'type', text: typed, submit: true });
                  setTyped('');
                }, true)
              }
            />
            <Pressable onPress={() => run(() => call('/act', { type: 'scroll', direction: 'up' }), true)} style={s.iconBtn}>
              <Text style={s.iconText}>▲</Text>
            </Pressable>
            <Pressable onPress={() => run(() => call('/act', { type: 'scroll', direction: 'down' }), true)} style={s.iconBtn}>
              <Text style={s.iconText}>▼</Text>
            </Pressable>
          </View>
        )}

        {!!(engine === 'local' ? localSteps : st?.steps)?.length && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Steps · {engine === 'local' ? 'On-Device AI Browser' : st?.model || 'Cloud'}</Text>
            {(engine === 'local' ? localSteps : st?.steps || [])
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
      <TextInput value={url} onChangeText={setUrl} placeholder={DEFAULT_COMPUTER_URL} placeholderTextColor={C.muted} style={[s.input, { marginTop: 8 }]} autoCapitalize="none" autoCorrect={false} />
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
  mutedSmall: { color: C.muted, fontSize: 11, marginTop: 6 },
  body: { color: C.text, fontSize: 14, lineHeight: 20 },
  error: { color: C.danger, fontSize: 13 },
  card: { backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 12 },
  cardTitle: { color: C.text, fontSize: 14, fontWeight: '700', marginBottom: 6 },
  input: { backgroundColor: C.surface2, color: C.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, borderWidth: 1, borderColor: C.border },
  btn: { backgroundColor: C.accent, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 14, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  pill: { borderWidth: 1, borderColor: C.border, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  pillText: { color: C.text, fontSize: 12, fontWeight: '600' },
  iconBtn: { width: 40, height: 40, borderRadius: 10, backgroundColor: C.surface2, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  iconText: { color: C.text, fontSize: 18, fontWeight: '700' },
  screen: { width: '100%', backgroundColor: '#000', borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: C.border },
  busy: { position: 'absolute', top: 10, right: 10 },
  step: { color: C.muted, fontSize: 12, marginTop: 3 },
  tapFx: { position: 'absolute', width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: C.accent, backgroundColor: 'rgba(99,102,241,0.25)' },
});
