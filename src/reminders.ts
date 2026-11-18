/*
 * Pulse OS — local reminders (expo-notifications). Parses "remind me at 6pm to…" on the phone,
 * falls back to flash-lite for unusual phrasing, and always asks for confirmation before scheduling.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { generateJSON } from './gemini';

export const STORAGE_REMINDERS = 'pulseos.reminders.v1';
const CHANNEL_ID = 'reminders';

export type Repeat = 'none' | 'daily' | 'weekly';
export type ReminderDraft = { title: string; at: number; repeat: Repeat };
export type Reminder = ReminderDraft & { id: string; notificationId: string; createdAt: number };

let configured = false;
export function configureNotifications() {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
  if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Reminders',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 150, 250],
      sound: 'default',
    }).catch(() => undefined);
  }
}

export async function ensureNotificationPermission(): Promise<boolean> {
  const cur = await Notifications.getPermissionsAsync();
  if (cur.granted) return true;
  if (!cur.canAskAgain) return false;
  const req = await Notifications.requestPermissionsAsync();
  return req.granted;
}

export async function loadReminders(): Promise<Reminder[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_REMINDERS);
    const list: Reminder[] = raw ? JSON.parse(raw) : [];
    // Drop one-off reminders that already fired and anything the OS no longer has scheduled.
    const scheduled = await Notifications.getAllScheduledNotificationsAsync().catch(() => null);
    const ids = scheduled ? new Set(scheduled.map((n) => n.identifier)) : null;
    const now = Date.now();
    const alive = (Array.isArray(list) ? list : []).filter((r) => (r.repeat !== 'none' || r.at > now - 60000) && (!ids || ids.has(r.notificationId)));
    if (alive.length !== list.length) await saveReminders(alive);
    return alive.sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
}

async function saveReminders(list: Reminder[]) {
  await AsyncStorage.setItem(STORAGE_REMINDERS, JSON.stringify(list));
}

export async function scheduleReminder(d: ReminderDraft): Promise<Reminder> {
  configureNotifications();
  if (!(await ensureNotificationPermission())) {
    throw new Error('Notifications are off for Pulse OS. Allow them in Android Settings > Apps > Pulse OS > Notifications.');
  }
  if (d.repeat === 'none' && d.at <= Date.now() + 5000) throw new Error('That time has already passed.');
  const when = new Date(d.at);
  const trigger: Notifications.NotificationTriggerInput =
    d.repeat === 'daily'
      ? { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: when.getHours(), minute: when.getMinutes(), channelId: CHANNEL_ID }
      : d.repeat === 'weekly'
        ? { type: Notifications.SchedulableTriggerInputTypes.WEEKLY, weekday: when.getDay() + 1, hour: when.getHours(), minute: when.getMinutes(), channelId: CHANNEL_ID }
        : { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when, channelId: CHANNEL_ID };
  const notificationId = await Notifications.scheduleNotificationAsync({
    content: { title: 'Reminder', body: d.title, sound: 'default', data: { kind: 'pulse-reminder' } },
    trigger,
  });
  const r: Reminder = { ...d, id: 'r_' + Date.now().toString(36), notificationId, createdAt: Date.now() };
  const list = await loadReminders();
  await saveReminders([...list, r]);
  return r;
}

export async function cancelReminder(id: string): Promise<Reminder[]> {
  const list = await loadReminders();
  const r = list.find((x) => x.id === id);
  if (r) await Notifications.cancelScheduledNotificationAsync(r.notificationId).catch(() => undefined);
  const next = list.filter((x) => x.id !== id);
  await saveReminders(next);
  return next;
}

/* ------------------------------ Parsing ------------------------------ */

export function isReminderRequest(text: string): boolean {
  return /^(?:hey |ok )?(?:pulse[,\s]+)?(?:please\s+|can you\s+|could you\s+)?(?:remind me|set (?:a |an )?(?:reminder|alarm)|create (?:a )?reminder|add (?:a )?reminder|don'?t let me forget)\b/i.test(text.trim());
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parseClock(h: string, m?: string, ap?: string): { h: number; m: number } | null {
  let hour = Number(h);
  const min = m ? Number(m) : 0;
  if (!Number.isFinite(hour) || hour > 23 || min > 59) return null;
  const a = (ap || '').toLowerCase().replace(/\./g, '');
  if (a === 'pm' && hour < 12) hour += 12;
  if (a === 'am' && hour === 12) hour = 0;
  return { h: hour, m: min };
}

/** Fast on-device parser for the common phrasings. Returns null when unsure (then flash-lite is asked). */
export function parseReminderLocal(text: string, now = new Date()): ReminderDraft | null {
  let s = ' ' + text.trim().replace(/[.!]+$/, '') + ' ';
  s = s.replace(/^\s*(?:hey |ok )?(?:pulse[,\s]+)?(?:please\s+|can you\s+|could you\s+)?(?:remind me|set (?:a |an )?(?:reminder|alarm)|create (?:a )?reminder|add (?:a )?reminder|don'?t let me forget)\s*/i, ' ');
  let repeat: Repeat = 'none';
  let date: Date | null = null;
  let timeSet = false;
  const base = new Date(now.getTime());

  const take = (re: RegExp) => {
    const m = s.match(re);
    if (m) s = s.replace(m[0], ' ');
    return m;
  };

  const rel = take(/\b(?:in|after)\s+(an?|\d+(?:\.\d+)?)\s*(min(?:ute)?s?|hours?|hrs?|h)\b/i);
  if (rel) {
    const n = /^an?$/i.test(rel[1]) ? 1 : Number(rel[1]);
    const ms = /^h/i.test(rel[2]) ? n * 3600e3 : n * 60e3;
    date = new Date(base.getTime() + ms);
    timeSet = true;
  }
  if (take(/\b(every ?day|daily|every morning|every night|every evening)\b/i)) repeat = 'daily';
  const wk = take(/\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (wk) repeat = 'weekly';

  let dayOffset: number | null = null;
  if (take(/\btomorrow\b/i)) dayOffset = 1;
  else if (take(/\b(today|tonight|this evening|this afternoon)\b/i)) dayOffset = 0;
  const onDay = wk ? wk : take(/\b(?:on\s+)?(?:this\s+|next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (onDay) {
    const target = WEEKDAYS.indexOf(onDay[1].toLowerCase());
    let diff = (target - base.getDay() + 7) % 7;
    if (diff === 0 && !wk) diff = 7;
    dayOffset = diff;
  }

  let clock: { h: number; m: number } | null = null;
  const t1 = take(/\b(?:at|by|@)?\s*(\d{1,2})(?::|\.)(\d{2})\s*(am|pm|a\.m\.|p\.m\.)?\b/i);
  if (t1) clock = parseClock(t1[1], t1[2], t1[3]);
  if (!clock) {
    const t2 = take(/\b(?:at|by|@)?\s*(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)\b/i);
    if (t2) clock = parseClock(t2[1], undefined, t2[2]);
  }
  if (!clock) {
    const t3 = take(/\bat\s+(\d{1,2})\b(?!\s*(?:min|hour|h\b))/i);
    if (t3) {
      const h = Number(t3[1]);
      // "at 6" with no am/pm: the next upcoming 6 o'clock (6pm if 6am already passed today).
      clock = parseClock(String(h));
      if (clock && h <= 12) {
        const cand = new Date(base);
        cand.setHours(h, 0, 0, 0);
        if (cand.getTime() <= base.getTime() && h < 12) clock = { h: h + 12, m: 0 };
      }
    }
  }
  if (!clock) {
    if (take(/\b(?:in the )?morning\b/i)) clock = { h: 9, m: 0 };
    else if (take(/\b(?:at )?noon\b/i)) clock = { h: 12, m: 0 };
    else if (take(/\b(?:in the )?evening\b/i)) clock = { h: 18, m: 0 };
    else if (take(/\b(?:at )?night\b/i)) clock = { h: 21, m: 0 };
  }

  if (!timeSet) {
    if (!clock && dayOffset === null && repeat === 'none') return null;
    if (!clock) clock = { h: 9, m: 0 };
    const d = new Date(base);
    d.setSeconds(0, 0);
    d.setHours(clock.h, clock.m);
    if (dayOffset !== null) d.setDate(d.getDate() + dayOffset);
    else if (d.getTime() <= base.getTime()) d.setDate(d.getDate() + 1);
    date = d;
  }

  let title = s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:to|that|about|for)\s+/i, '')
    .replace(/\s+(?:to|at|on|by)$/i, '')
    .trim();
  title = title.replace(/^to\s+/i, '');
  if (!title || title.length < 2) return null;
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return date ? { title, at: date.getTime(), repeat } : null;
}

export async function parseReminderAI(apiKey: string, text: string, now = new Date()): Promise<ReminderDraft | null> {
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const tz = `${sign}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`;
  const local = new Date(now.getTime() + off * 60000).toISOString().slice(0, 19) + tz;
  const out: any = await generateJSON(
    apiKey,
    'Extract a phone reminder from the request. Reply JSON {"title": short imperative text, "at": ISO 8601 local datetime with offset, "repeat": "none"|"daily"|"weekly"} or {"title":""} if no clear time is given. ' +
      'Resolve relative dates from NOW. If only a time is given and it already passed today, use tomorrow.',
    `NOW: ${local} (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getDay()]})\nREQUEST: ${text}`,
  );
  const at = Date.parse(String(out?.at || ''));
  const title = String(out?.title || '').trim();
  if (!title || !Number.isFinite(at)) return null;
  const repeat: Repeat = out?.repeat === 'daily' || out?.repeat === 'weekly' ? out.repeat : 'none';
  return { title, at, repeat };
}

export function describeWhen(d: ReminderDraft): string {
  const date = new Date(d.at);
  const time = date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
  if (d.repeat === 'daily') return `Every day at ${time}`;
  if (d.repeat === 'weekly') return `Every ${date.toLocaleDateString('en-IN', { weekday: 'long' })} at ${time}`;
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const day = same(date, today) ? 'Today' : same(date, tomorrow) ? 'Tomorrow' : date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${time}`;
}
