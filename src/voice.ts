/*
 * Pulse OS — voice: speech recognition (expo-speech-recognition, Android SpeechRecognizer) and text-to-speech (expo-speech).
 * Only one screen owns the microphone at a time; events for other owners are ignored.
 */
import { Platform } from 'react-native';
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import type { VoiceLanguageMode } from '../pulseFeatures';

export type MicOwner = 'chat' | 'handsfree' | null;
let owner: MicOwner = null;

export function micOwner(): MicOwner {
  return owner;
}

export function recognitionLang(mode: VoiceLanguageMode): string {
  return mode === 'te-IN' ? 'te-IN' : 'en-IN';
}

export type MicCheck = { ok: boolean; reason?: 'permission' | 'blocked' | 'unavailable'; message?: string };

export async function ensureMic(): Promise<MicCheck> {
  try {
    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      return {
        ok: false,
        reason: 'unavailable',
        message: 'Speech recognition isn\'t available. Install or enable "Speech Recognition & Synthesis by Google" (or the Google app), then try again.',
      };
    }
    const cur = await ExpoSpeechRecognitionModule.getPermissionsAsync();
    if (cur.granted) return { ok: true };
    if (!cur.canAskAgain) return { ok: false, reason: 'blocked', message: 'Microphone permission is blocked. Open Settings > Permissions > Microphone and allow it.' };
    const req = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (req.granted) return { ok: true };
    return { ok: false, reason: req.canAskAgain ? 'permission' : 'blocked', message: 'Pulse needs the microphone to hear you. Tap again and choose Allow.' };
  } catch (e: any) {
    return { ok: false, reason: 'unavailable', message: e?.message || 'Speech recognition failed to start.' };
  }
}

export function startListening(who: Exclude<MicOwner, null>, mode: VoiceLanguageMode, opts: { silenceMs?: number } = {}) {
  stopSpeaking();
  owner = who;
  ExpoSpeechRecognitionModule.start({
    lang: recognitionLang(mode),
    interimResults: true,
    continuous: false,
    maxAlternatives: 1,
    addsPunctuation: true,
    androidIntentOptions: {
      EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: opts.silenceMs ?? 1100,
      EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: opts.silenceMs ?? 1100,
      EXTRA_LANGUAGE_MODEL: 'free_form',
    },
  });
}

export function stopListening(abort = true) {
  try {
    if (abort) ExpoSpeechRecognitionModule.abort();
    else ExpoSpeechRecognitionModule.stop();
  } catch {}
}

export function releaseMic(who: MicOwner) {
  if (owner === who) {
    stopListening(true);
    owner = null;
  }
}

export const MIC_ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone permission is off. Allow it in Settings to use voice.',
  'service-not-allowed': 'The speech service is unavailable. Enable Google speech services and try again.',
  'language-not-supported': 'This language isn\'t supported by the speech service on this phone.',
  network: 'Speech recognition needs internet. Check your connection.',
  'audio-capture': 'The microphone is busy or unavailable.',
  busy: 'The speech service is busy. Trying again…',
  client: 'Speech recognition hiccup. Trying again…',
  unknown: 'Speech recognition stopped unexpectedly.',
};

/* ------------------------------ Text to speech ------------------------------ */

/** Removes markdown, links and the ACTIONS line so speech sounds natural. */
export function speakable(text: string): string {
  return text
    .replace(/\n?\s*ACTIONS:[\s\S]*$/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#>`|]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function ttsLanguage(text: string, mode: VoiceLanguageMode): string {
  if (mode === 'te-IN') return 'te-IN';
  return /[\u0C00-\u0C7F]/.test(text) ? 'te-IN' : 'en-IN';
}

export function speak(text: string, mode: VoiceLanguageMode, cb?: { onDone?: () => void; onStopped?: () => void }) {
  const t = speakable(text);
  if (!t) {
    cb?.onDone?.();
    return;
  }
  Speech.speak(t.slice(0, 3900), {
    language: ttsLanguage(t, mode),
    rate: Platform.OS === 'android' ? 1.05 : 1.0,
    pitch: 1.0,
    onDone: cb?.onDone,
    onStopped: cb?.onStopped,
    onError: cb?.onDone,
  });
}

export function stopSpeaking() {
  Promise.resolve(Speech.stop()).catch(() => undefined);
}
