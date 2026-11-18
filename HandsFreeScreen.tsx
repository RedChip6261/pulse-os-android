/*
 * Pulse OS — Hands-Free: a reliable voice loop.
 * listen (expo-speech-recognition) → auto-send at end of speech → stream the reply → speak it (expo-speech, sentence by sentence)
 * → listen again. Tap the orb to interrupt (barge-in); the big Stop button ends the loop.
 * No accessibility service, no overlay, no control of other apps.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSpeechRecognitionEvent } from 'expo-speech-recognition';
import type { RagChunk, VoiceLanguageMode } from './pulseFeatures';
import { buildContents, buildSystemPrompt, ChatMessage, uid, UserProfile } from './src/assistant';
import { AutomationWorkflow } from './src/automation';
import { MemoryOps } from './src/commands';
import { looksTimeSensitive, streamChat } from './src/gemini';
import { runLocalAgent } from './src/localAgent';
import { describeWhen, Reminder, ReminderDraft, scheduleReminder } from './src/reminders';
import { ensureMic, micOwner, MIC_ERRORS, releaseMic, speak, speakable, startListening, stopListening, stopSpeaking } from './src/voice';

const C = {
  bg: '#090C12',
  surface: '#111622',
  surface2: '#182032',
  border: '#1F293B',
  text: '#F8FAFC',
  muted: '#8B9BB4',
  accent: '#6366F1',
  cyan: '#38BDF8',
  good: '#10B981',
  warn: '#F59E0B',
  danger: '#EF4444',
};

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';
const MAX_SILENT_RETRIES = 6;

export default function HandsFreeScreen(props: {
  active: boolean;
  apiKey: string;
  model: string;
  useLocalAgent?: boolean;
  voiceLang: VoiceLanguageMode;
  setVoiceLang: (l: VoiceLanguageMode) => void;
  profile: UserProfile;
  memorySummary: string;
  memory: MemoryOps;
  reminders: Reminder[];
  knowledge: RagChunk[];
  workflows: AutomationWorkflow[];
  onReminderSet: () => void;
  onAfterTurn: (userText: string) => void;
  openSettings: () => void;
}) {
  const { active, apiKey, model, voiceLang } = props;
  const [phase, setPhase] = useState<Phase>('idle');
  const [loopOn, setLoopOn] = useState(false);
  const [partial, setPartial] = useState('');
  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState('');
  const [error, setError] = useState<{ msg: string; settings?: boolean } | null>(null);
  const [turns, setTurns] = useState<ChatMessage[]>([]);

  const loopRef = useRef(false);
  const genRef = useRef(0);
  const finalRef = useRef('');
  const silentRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const pendingReminderRef = useRef<ReminderDraft | null>(null);
  const turnsRef = useRef<ChatMessage[]>([]);
  const propsRef = useRef(props);
  propsRef.current = props;

  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (phase !== 'listening') {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [phase, pulse]);

  const pushTurns = (add: ChatMessage[]) => {
    turnsRef.current = [...turnsRef.current, ...add].slice(-16);
    setTurns(turnsRef.current);
  };

  const listen = useCallback(() => {
    if (!loopRef.current) return;
    finalRef.current = '';
    setPartial('');
    setPhase('listening');
    try {
      startListening('handsfree', propsRef.current.voiceLang);
    } catch (e: any) {
      setError({ msg: e?.message || 'Could not start the microphone.' });
      setPhase('idle');
    }
  }, []);

  const stopAll = useCallback((label = 'Hands-Free stopped') => {
    loopRef.current = false;
    setLoopOn(false);
    genRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    stopSpeaking();
    releaseMic('handsfree');
    setPhase('idle');
    setPartial('');
    if (label) setReply((r) => r || '');
  }, []);

  // Speak the answer and listen again afterwards (only if this turn is still current).
  const speakThenListen = useCallback(
    (text: string, gen: number) => {
      setPhase('speaking');
      speak(text, propsRef.current.voiceLang, {
        onDone: () => {
          if (gen === genRef.current && loopRef.current) listen();
        },
      });
    },
    [listen],
  );

  const process = useCallback(
    async (spoken: string) => {
      const gen = ++genRef.current;
      const p = propsRef.current;
      setHeard(spoken);
      setReply('');
      setError(null);
      setPhase('thinking');

      // A pending reminder waits for "yes" / "no".
      const pending = pendingReminderRef.current;
      if (pending) {
        pendingReminderRef.current = null;
        if (/^(yes|yeah|yep|ok|okay|sure|do it|set it|haan|avunu|confirm)\b/i.test(spoken.trim())) {
          try {
            await scheduleReminder(pending);
            p.onReminderSet();
            const msg = `Done. I'll remind you ${describeWhen(pending).toLowerCase()}: ${pending.title}.`;
            setReply(msg);
            speakThenListen(msg, gen);
          } catch (e: any) {
            const msg = e?.message || 'Could not set the reminder.';
            setReply(msg);
            speakThenListen(msg, gen);
          }
          return;
        }
        if (/^(no|nope|cancel|don'?t|leave it|vaddu)\b/i.test(spoken.trim())) {
          setReply('Okay, cancelled.');
          speakThenListen('Okay, cancelled.', gen);
          return;
        }
      }

      const lower = spoken.trim().toLowerCase();

      // Voice control commands (stop, repeat, clear, language switch)
      if (/^(?:stop|stop\s+listening|pause|exit|bye|goodbye)$/i.test(lower)) {
        stopAll('Hands-Free paused');
        return;
      }
      if (/^(?:repeat|say\s+that\s+again|repeat\s+that)$/i.test(lower)) {
        const lastBot = [...turnsRef.current].reverse().find((t) => t.role === 'assistant');
        const msg = lastBot?.text || 'Nothing to repeat yet.';
        setReply(msg);
        speakThenListen(msg, gen);
        return;
      }
      if (/^(?:clear|new\s+chat|reset\s+chat)$/i.test(lower)) {
        turnsRef.current = [];
        setTurns([]);
        const msg = 'Conversation cleared. What next?';
        setReply(msg);
        speakThenListen(msg, gen);
        return;
      }
      if (/^(?:switch\s+to\s+telugu|telugu\s+mode)$/i.test(lower)) {
        p.setVoiceLang('te-IN');
        const msg = 'Switched to Telugu voice mode.';
        setReply(msg);
        speakThenListen(msg, gen);
        return;
      }
      if (/^(?:switch\s+to\s+english|english\s+mode)$/i.test(lower)) {
        p.setVoiceLang('en-IN');
        const msg = 'Switched to English voice mode.';
        setReply(msg);
        speakThenListen(msg, gen);
        return;
      }

      // Custom API-key-free Pulse Local Agent (multi-step workflows, commands, notes, math, reminders)
      const strictLocal = Boolean(p.useLocalAgent) || !p.apiKey.trim();
      const local = await runLocalAgent(spoken, {
        profile: p.profile,
        memory: p.memory,
        reminders: p.reminders,
        knowledge: p.knowledge,
        workflows: p.workflows,
        strictLocal,
      }).catch(() => null);

      if (gen !== genRef.current) return;
      if (local?.handled) {
        let msg = local.text;
        if (local.reminder) {
          pendingReminderRef.current = local.reminder;
          msg = `Set a reminder for ${describeWhen(local.reminder)}: ${local.reminder.title}? Say yes or no.`;
        }
        pushTurns([
          { id: uid(), role: 'user', text: spoken, ts: Date.now() },
          { id: uid(), role: 'assistant', text: msg, ts: Date.now() },
        ]);
        setReply(msg);
        speakThenListen(msg, gen);
        return;
      }

      if (!p.apiKey.trim()) {
        const msg = 'Add your Gemini API key in Settings so I can answer questions.';
        setReply(msg);
        speakThenListen(msg, gen);
        return;
      }

      const userMsg: ChatMessage = { id: uid(), role: 'user', text: spoken, ts: Date.now() };
      const contents = buildContents([...turnsRef.current, userMsg], 16, 0);
      const system = buildSystemPrompt({ profile: p.profile, memory: p.memorySummary, voice: true });
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      // Speak sentence by sentence while the answer streams in, so the first words come out fast.
      let spokenUpTo = 0;
      let outstanding = 0;
      let streamDone = false;
      const finishIfDone = () => {
        if (streamDone && outstanding === 0 && gen === genRef.current && loopRef.current) listen();
      };
      const enqueue = (chunk: string) => {
        const t = speakable(chunk);
        if (!t) return;
        outstanding += 1;
        setPhase('speaking');
        speak(t, p.voiceLang, {
          onDone: () => {
            outstanding -= 1;
            finishIfDone();
          },
        });
      };
      try {
        const res = await streamChat({
          apiKey: p.apiKey,
          model: p.model,
          system,
          contents,
          search: looksTimeSensitive(spoken),
          signal: ctrl.signal,
          onPartial: (full) => {
            if (gen !== genRef.current) return;
            setReply(full);
            const rest = full.slice(spokenUpTo);
            const m = rest.match(/^[\s\S]*[.!?।](\s|$)|^[\s\S]*\n/);
            if (m && m[0].trim().length > 12) {
              spokenUpTo += m[0].length;
              enqueue(m[0]);
            }
          },
        });
        if (gen !== genRef.current) return;
        setReply(res.text);
        const tail = res.text.slice(spokenUpTo);
        if (tail.trim()) enqueue(tail);
        pushTurns([userMsg, { id: uid(), role: 'assistant', text: res.text, ts: Date.now() }]);
        p.onAfterTurn(spoken);
        streamDone = true;
        finishIfDone();
      } catch (e: any) {
        if (gen !== genRef.current) return;
        const msg = e?.message || 'Something went wrong.';
        setError({ msg });
        streamDone = true;
        speakThenListen(msg, gen);
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
      }
    },
    [listen, speakThenListen],
  );

  /* ---------------- Speech recognition events (ignored unless Hands-Free owns the mic) ---------------- */

  useSpeechRecognitionEvent('result', (e) => {
    if (micOwner() !== 'handsfree') return;
    const t = e.results?.[0]?.transcript || '';
    setPartial(t);
    if (e.isFinal) finalRef.current = t;
  });

  useSpeechRecognitionEvent('error', (e) => {
    if (micOwner() !== 'handsfree' || !loopRef.current) return;
    const code = String(e.error);
    if (code === 'aborted' || code === 'no-speech' || code === 'speech-timeout') return; // handled on "end"
    if (code === 'not-allowed') {
      setError({ msg: MIC_ERRORS[code], settings: true });
      stopAll('');
      return;
    }
    setError({ msg: MIC_ERRORS[code] || e.message || 'Speech recognition error.' });
  });

  useSpeechRecognitionEvent('end', () => {
    if (micOwner() !== 'handsfree' || !loopRef.current) return;
    const text = finalRef.current.trim() || '';
    if (text) {
      silentRef.current = 0;
      setPartial('');
      process(text);
      return;
    }
    // Nothing heard: keep listening a few times, then pause to save battery.
    silentRef.current += 1;
    if (silentRef.current > MAX_SILENT_RETRIES) {
      stopAll('');
      setReply('');
      setError({ msg: 'Paused after a quiet minute. Tap the orb to talk again.' });
      return;
    }
    setTimeout(() => {
      if (loopRef.current && micOwner() === 'handsfree') listen();
    }, 250);
  });

  /* ---------------- Controls ---------------- */

  const begin = useCallback(async () => {
    setError(null);
    const ok = await ensureMic();
    if (!ok.ok) {
      setError({ msg: ok.message || 'Microphone unavailable.', settings: ok.reason === 'blocked' });
      return;
    }
    loopRef.current = true;
    setLoopOn(true);
    silentRef.current = 0;
    listen();
  }, [listen]);

  const onOrb = () => {
    if (!loopRef.current) {
      begin();
      return;
    }
    if (phase === 'listening') {
      stopListening(false); // "I'm done talking": finalize what was heard
      return;
    }
    // Barge-in: stop speaking/thinking and listen right away.
    genRef.current += 1;
    abortRef.current?.abort();
    stopSpeaking();
    silentRef.current = 0;
    listen();
  };

  // Leaving the tab (or the app going to background) ends the loop.
  useEffect(() => {
    if (!active && loopRef.current) stopAll('');
  }, [active, stopAll]);
  useEffect(() => () => stopAll(''), [stopAll]);

  const status =
    phase === 'listening' ? (partial ? 'Listening…' : 'Listening… speak now') : phase === 'thinking' ? 'Thinking…' : phase === 'speaking' ? 'Speaking… tap to interrupt' : loopOn ? 'Starting…' : 'Tap the orb to talk';
  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });

  return (
    <View style={s.root}>
      <View style={s.langRow}>
        {(
          [
            { id: 'BILINGUAL_AUTO', label: 'Auto' },
            { id: 'en-IN', label: 'English' },
            { id: 'te-IN', label: 'తెలుగు' },
          ] as { id: VoiceLanguageMode; label: string }[]
        ).map((l) => (
          <Pressable key={l.id} onPress={() => props.setVoiceLang(l.id)} style={[s.langPill, voiceLang === l.id && s.langPillOn]}>
            <Text style={[s.langText, voiceLang === l.id && s.langTextOn]}>{l.label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={s.center}>
        <Pressable onPress={onOrb} accessibilityRole="button" accessibilityLabel={status}>
          <Animated.View
            style={[
              s.orbOuter,
              phase === 'listening' && { borderColor: C.danger, backgroundColor: 'rgba(239,68,68,0.14)' },
              phase === 'speaking' && { borderColor: C.cyan },
              { transform: [{ scale: ringScale }] },
            ]}
          >
            <View style={[s.orbInner, phase === 'listening' && { backgroundColor: C.danger }, phase === 'speaking' && { backgroundColor: C.accent }]}>
              {phase === 'thinking' ? <ActivityIndicator color="#fff" size="large" /> : <Text style={s.orbLabel}>{phase === 'listening' ? '● REC' : phase === 'speaking' ? '🔊' : '🎙'}</Text>}
            </View>
          </Animated.View>
        </Pressable>
        <Text style={s.status}>{status}</Text>
        {!!partial && phase === 'listening' && <Text style={s.partial}>“{partial}”</Text>}
        {!!heard && phase !== 'listening' && <Text style={s.heard}>You: “{heard}”</Text>}
      </View>

      <ScrollView style={s.replyBox} contentContainerStyle={{ padding: 12 }}>
        {!!reply && <Text style={s.reply}>{reply}</Text>}
        {!reply && !error && turns.length === 0 && <Text style={s.hint}>Ask anything out loud. I'll answer, then listen again. Say "remind me at 6 to…" or "remember that…" too.</Text>}
        {!!error && (
          <View style={s.errorCard}>
            <Text style={s.errorText}>{error.msg}</Text>
            {error.settings && (
              <Pressable onPress={() => Linking.openSettings()} style={s.smallBtn}>
                <Text style={s.smallBtnText}>Open app settings</Text>
              </Pressable>
            )}
          </View>
        )}
        {!apiKey.trim() && (
          <Pressable onPress={props.openSettings} style={{ marginTop: 8 }}>
            <Text style={{ color: C.cyan, fontSize: 13 }}>Add a Gemini API key in Settings for full answers</Text>
          </Pressable>
        )}
      </ScrollView>

      <Pressable onPress={() => (loopOn ? stopAll() : begin())} style={[s.bigBtn, { backgroundColor: loopOn ? C.danger : C.accent }]}>
        <Text style={s.bigBtnText}>{loopOn ? '■  Stop Hands-Free' : '🎙  Start Hands-Free'}</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', paddingHorizontal: 20, paddingTop: 14, paddingBottom: 14 },
  langRow: { flexDirection: 'row', gap: 6, backgroundColor: C.surface, padding: 4, borderRadius: 22, borderWidth: 1, borderColor: C.border },
  langPill: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 18 },
  langPillOn: { backgroundColor: C.accent },
  langText: { color: C.muted, fontSize: 12, fontWeight: '600' },
  langTextOn: { color: '#fff' },
  center: { alignItems: 'center', marginTop: 22, gap: 12 },
  orbOuter: {
    width: 180,
    height: 180,
    borderRadius: 90,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(99,102,241,0.16)',
    borderWidth: 2,
    borderColor: 'rgba(99,102,241,0.4)',
  },
  orbInner: { width: 128, height: 128, borderRadius: 64, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface2 },
  orbLabel: { color: '#fff', fontSize: 22, fontWeight: '800' },
  status: { color: C.text, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  partial: { color: C.cyan, fontSize: 15, textAlign: 'center' },
  heard: { color: C.muted, fontSize: 13, textAlign: 'center' },
  replyBox: { alignSelf: 'stretch', flex: 1, marginTop: 14, backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.border },
  reply: { color: C.text, fontSize: 15, lineHeight: 22 },
  hint: { color: C.muted, fontSize: 13, lineHeight: 19 },
  errorCard: { marginTop: 8, padding: 10, borderRadius: 10, backgroundColor: 'rgba(239,68,68,0.12)', borderWidth: 1, borderColor: C.danger, gap: 8 },
  errorText: { color: C.text, fontSize: 13 },
  smallBtn: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: C.surface2 },
  smallBtnText: { color: C.text, fontSize: 12, fontWeight: '600' },
  bigBtn: { alignSelf: 'stretch', marginTop: 12, borderRadius: 16, paddingVertical: 18, alignItems: 'center' },
  bigBtnText: { color: '#fff', fontSize: 17, fontWeight: '800' },
});
