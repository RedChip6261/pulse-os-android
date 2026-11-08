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
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView, WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';
import * as Speech from 'expo-speech';

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

const DEFAULT_MODEL = 'gemini-1.5-flash';
const FALLBACK_MODEL = 'gemini-2.5-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

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

type Tab = 'CHAT' | 'WIDGETS' | 'WORKSPACE';

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
  ts: number;
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

async function callGemini(
  apiKey: string,
  model: string,
  history: ChatMessage[],
): Promise<{ reply: PulseReply; modelUsed: string }> {
  const contents = history
    .filter((m) => m.role !== 'error')
    .slice(-12)
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.role === 'assistant' && m.reply ? JSON.stringify(m.reply) : m.text }],
    }));

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: { temperature: 0.7, responseMimeType: 'application/json' },
  });

  const attempt = async (m: string) =>
    fetch(GEMINI_BASE + encodeURIComponent(m) + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body,
    });

  let modelUsed = model;
  let res = await attempt(model);
  if (res.status === 404 && model !== FALLBACK_MODEL) {
    modelUsed = FALLBACK_MODEL;
    res = await attempt(FALLBACK_MODEL);
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
/* App                                                                 */
/* ------------------------------------------------------------------ */

export default function App() {
  const [tab, setTab] = useState<Tab>('CHAT');
  const [voiceOn, setVoiceOn] = useState(false);
  const voiceRef = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_VOICE).then((v) => {
      const on = v === '1';
      voiceRef.current = on;
      setVoiceOn(on);
    });
  }, []);

  const toggleVoice = useCallback(() => {
    const next = !voiceRef.current;
    voiceRef.current = next;
    setVoiceOn(next);
    AsyncStorage.setItem(STORAGE_VOICE, next ? '1' : '0');
    if (next) speak('Voice readout on.');
    else Speech.stop();
  }, []);

  const say = useCallback((text: string) => {
    if (voiceRef.current) speak(text);
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" backgroundColor={C.bg} />
      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>Pulse OS</Text>
          <Text style={styles.brandSub}>{tab.charAt(0) + tab.slice(1).toLowerCase()}</Text>
        </View>
        <Pressable
          onPress={toggleVoice}
          accessibilityRole="switch"
          accessibilityState={{ checked: voiceOn }}
          accessibilityLabel="Voice readout"
          style={[styles.voiceBtn, voiceOn && styles.voiceBtnOn]}
        >
          <Text style={styles.voiceIcon}>{voiceOn ? '🔊' : '🔈'}</Text>
          <Text style={[styles.voiceText, voiceOn && { color: C.text }]}>{voiceOn ? 'ON' : 'OFF'}</Text>
        </Pressable>
      </View>

      <View style={{ flex: 1 }}>
        <View style={[styles.fill, tab !== 'CHAT' && styles.hidden]}>
          <ChatScreen say={say} />
        </View>
        <View style={[styles.fill, tab !== 'WIDGETS' && styles.hidden]}>
          <WidgetsScreen say={say} />
        </View>
        <View style={[styles.fill, tab !== 'WORKSPACE' && styles.hidden]}>
          <WorkspaceScreen say={say} />
        </View>
      </View>

      <View style={styles.tabBar}>
        {(['CHAT', 'WIDGETS', 'WORKSPACE'] as Tab[]).map((t) => (
          <Pressable
            key={t}
            onPress={() => setTab(t)}
            style={styles.tabItem}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t }}
          >
            <Text style={styles.tabIcon}>{t === 'CHAT' ? '💬' : t === 'WIDGETS' ? '🧩' : '🌐'}</Text>
            <Text style={[styles.tabLabel, tab === t && styles.tabLabelActive]}>{t}</Text>
            {tab === t ? <View style={styles.tabDot} /> : null}
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

/* ------------------------------------------------------------------ */
/* CHAT                                                                */
/* ------------------------------------------------------------------ */

function ChatScreen({ say }: { say: (t: string) => void }) {
  const [apiKey, setApiKey] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [modelDraft, setModelDraft] = useState(DEFAULT_MODEL);
  const [showSettings, setShowSettings] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  useEffect(() => {
    (async () => {
      const [k, m, h] = await Promise.all([
        AsyncStorage.getItem(STORAGE_API_KEY),
        AsyncStorage.getItem(STORAGE_MODEL),
        AsyncStorage.getItem(STORAGE_CHAT),
      ]);
      if (k) {
        setApiKey(k);
        setKeyDraft(k);
      }
      if (m) {
        setModel(m);
        setModelDraft(m);
      }
      if (h) {
        try {
          setMessages(JSON.parse(h));
        } catch {
          setMessages([]);
        }
      }
      if (!k) setShowSettings(true);
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (loaded) AsyncStorage.setItem(STORAGE_CHAT, JSON.stringify(messages.slice(-60)));
  }, [messages, loaded]);

  const saveSettings = async () => {
    const k = keyDraft.trim();
    const m = modelDraft.trim() || DEFAULT_MODEL;
    if (!k) {
      Alert.alert('API key needed', 'Paste your Gemini API key from Google AI Studio.');
      return;
    }
    await AsyncStorage.multiSet([
      [STORAGE_API_KEY, k],
      [STORAGE_MODEL, m],
    ]);
    setApiKey(k);
    setModel(m);
    setShowSettings(false);
  };

  const clearChat = () => {
    Alert.alert('Clear chat', 'Delete the whole conversation?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => setMessages([]) },
    ]);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!apiKey) {
      setShowSettings(true);
      return;
    }
    const userMsg: ChatMessage = { id: uid(), role: 'user', text, ts: Date.now() };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput('');
    setBusy(true);
    try {
      const { reply, modelUsed } = await callGemini(apiKey, model, next);
      if (modelUsed !== model) {
        setModel(modelUsed);
        setModelDraft(modelUsed);
        AsyncStorage.setItem(STORAGE_MODEL, modelUsed);
      }
      const botMsg: ChatMessage = {
        id: uid(),
        role: 'assistant',
        text: reply.direct_response,
        reply,
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
        <Text style={styles.muted} numberOfLines={1}>
          {apiKey ? 'Model: ' + model : 'No API key set'}
        </Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable onPress={() => setShowSettings((s) => !s)} style={styles.chip}>
            <Text style={styles.chipText}>⚙️ Key</Text>
          </Pressable>
          <Pressable onPress={clearChat} style={styles.chip}>
            <Text style={styles.chipText}>🗑 Clear</Text>
          </Pressable>
        </View>
      </View>

      {showSettings ? (
        <View style={styles.settings}>
          <Text style={styles.settingsTitle}>Gemini API key</Text>
          <Text style={styles.mutedSmall}>
            Stored only on this device. Get one free at aistudio.google.com.
          </Text>
          <TextInput
            value={keyDraft}
            onChangeText={setKeyDraft}
            placeholder="AIza..."
            placeholderTextColor={C.muted}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <Text style={[styles.settingsTitle, { marginTop: 8 }]}>Model</Text>
          <TextInput
            value={modelDraft}
            onChangeText={setModelDraft}
            placeholder={DEFAULT_MODEL}
            placeholderTextColor={C.muted}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <Pressable onPress={saveSettings} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Save</Text>
          </Pressable>
        </View>
      ) : null}

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 12, paddingBottom: 20 }}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>What's on your plate?</Text>
            <Text style={styles.muted}>
              Try: "Plan my week around a Friday exam" or "Help me budget for a trip to Goa".
            </Text>
          </View>
        }
        renderItem={({ item }) => <MessageBubble msg={item} say={say} />}
      />

      <View style={styles.composer}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder={apiKey ? 'Ask Pulse anything…' : 'Add your Gemini key first'}
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

function MessageBubble({ msg, say }: { msg: ChatMessage; say: (t: string) => void }) {
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
      </View>
      {r ? <ActionCard reply={r} say={say} /> : null}
    </View>
  );
}

function ActionCard({ reply, say }: { reply: PulseReply; say: (t: string) => void }) {
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

function WorkspaceScreen({ say }: { say: (t: string) => void }) {
  const webRef = useRef<WebView>(null);
  const [url, setUrl] = useState(HOME_URL);
  const [field, setField] = useState(HOME_URL);
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
    Alert.alert('Confirm task complete', 'Mark "' + label + '" as done?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Confirm',
        onPress: () => {
          setCompleted((prev) => [{ title: label, url: field, ts: Date.now() }, ...prev].slice(0, 20));
          say('Task complete: ' + label);
        },
      },
    ]);
  };

  const close = () => {
    setUrl(HOME_URL);
    setField(HOME_URL);
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
