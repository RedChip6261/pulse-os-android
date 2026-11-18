/*
 * Pulse OS — quick actions. Everything here only OPENS another app or screen with Android intents / links
 * (dialer, SMS composer, maps, calendar, an app's home screen). Nothing taps, types or reads inside other apps;
 * the user always presses the final button themselves.
 */
import { Linking, Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import { PULSE_APP_CATALOG, PulseParsedIntent } from '../pulseFeatures';

export type ActionLink =
  | { type: 'maps'; label?: string; query: string }
  | { type: 'call'; label?: string; phone: string }
  | { type: 'sms'; label?: string; phone: string; body?: string }
  | { type: 'whatsapp'; label?: string; phone?: string; text?: string }
  | { type: 'email'; label?: string; to: string; subject?: string; body?: string }
  | { type: 'calendar'; label?: string; title: string; start: string; end?: string; location?: string; details?: string }
  | { type: 'reminder'; label?: string; title: string; at: string }
  | { type: 'web'; label?: string; url: string };

const MARKER = /\n?\s*ACTIONS:\s*/;

/** Splits the model's optional trailing "ACTIONS: [...]" line from the visible answer. */
export function splitActions(raw: string): { text: string; actions: ActionLink[] } {
  const m = raw.match(MARKER);
  if (!m || m.index === undefined) return { text: raw.trim(), actions: [] };
  const text = raw.slice(0, m.index).trim();
  const rest = raw.slice(m.index + m[0].length).trim();
  let actions: ActionLink[] = [];
  try {
    const a = rest.indexOf('[');
    const b = rest.lastIndexOf(']');
    const parsed = JSON.parse(a >= 0 && b > a ? rest.slice(a, b + 1) : rest);
    if (Array.isArray(parsed)) actions = parsed.filter(validAction).slice(0, 3);
  } catch {}
  return { text, actions };
}

/** Visible text while streaming (hides a half-written ACTIONS line). */
export function visibleWhileStreaming(raw: string): string {
  const i = raw.search(/\n?\s*ACTIONS?:?\s*(\[|$)/);
  return (i >= 0 && raw.length - i < 1200 && /ACTIONS?:?\s*(\[|$)/.test(raw.slice(i)) ? raw.slice(0, i) : raw).trimEnd();
}

function validAction(a: any): a is ActionLink {
  if (!a || typeof a !== 'object') return false;
  switch (a.type) {
    case 'maps':
      return typeof a.query === 'string' && !!a.query;
    case 'call':
    case 'sms':
      return typeof a.phone === 'string' && /\d{3,}/.test(a.phone);
    case 'whatsapp':
      return !!(a.phone || a.text);
    case 'email':
      return typeof a.to === 'string' && a.to.includes('@');
    case 'calendar':
      return typeof a.title === 'string' && !!Date.parse(a.start);
    case 'reminder':
      return typeof a.title === 'string' && !!Date.parse(a.at);
    case 'web':
      return typeof a.url === 'string' && /^https?:\/\//i.test(a.url);
    default:
      return false;
  }
}

export function actionLabel(a: ActionLink): string {
  if (a.label) return a.label;
  switch (a.type) {
    case 'maps':
      return 'Open in Maps';
    case 'call':
      return `Call ${a.phone}`;
    case 'sms':
      return 'Text';
    case 'whatsapp':
      return 'WhatsApp';
    case 'email':
      return 'Email';
    case 'calendar':
      return 'Add to Calendar';
    case 'reminder':
      return 'Set reminder';
    case 'web':
      return 'Open link';
  }
}

const digits = (p: string) => p.replace(/[^\d+]/g, '');

function gcalDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Opens the action (reminder actions are handled by the caller with a confirmation card). */
export async function openAction(a: ActionLink): Promise<void> {
  switch (a.type) {
    case 'maps':
      return Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a.query)}`);
    case 'call':
      return Linking.openURL(`tel:${digits(a.phone)}`);
    case 'sms':
      return Linking.openURL(`sms:${digits(a.phone)}${a.body ? `?body=${encodeURIComponent(a.body)}` : ''}`);
    case 'whatsapp': {
      const p = a.phone ? digits(a.phone).replace(/^\+/, '') : '';
      const phone = p.length === 10 ? `91${p}` : p;
      return Linking.openURL(`https://wa.me/${phone}${a.text ? `?text=${encodeURIComponent(a.text)}` : ''}`);
    }
    case 'email': {
      const q = [a.subject ? `subject=${encodeURIComponent(a.subject)}` : '', a.body ? `body=${encodeURIComponent(a.body)}` : ''].filter(Boolean).join('&');
      return Linking.openURL(`mailto:${a.to}${q ? `?${q}` : ''}`);
    }
    case 'calendar': {
      const end = a.end && Date.parse(a.end) ? a.end : new Date(Date.parse(a.start) + 3600e3).toISOString();
      const url =
        'https://calendar.google.com/calendar/render?action=TEMPLATE' +
        `&text=${encodeURIComponent(a.title)}&dates=${gcalDate(a.start)}/${gcalDate(end)}` +
        (a.location ? `&location=${encodeURIComponent(a.location)}` : '') +
        (a.details ? `&details=${encodeURIComponent(a.details)}` : '');
      return Linking.openURL(url);
    }
    case 'web':
      return Linking.openURL(a.url);
    case 'reminder':
      return;
  }
}

/* ------------------------------ Open-an-app commands (no screen control) ------------------------------ */

const APP_LINKS: Record<string, { home: string; search?: (q: string) => string }> = {
  whatsapp: { home: 'whatsapp://send' },
  gmail: { home: 'googlegmail://', search: () => 'googlegmail://' },
  youtube: { home: 'https://www.youtube.com/', search: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` },
  instagram: { home: 'instagram://app' },
  telegram: { home: 'tg://' },
  sms: { home: 'sms:' },
  phone: { home: 'tel:' },
  chrome: { home: 'https://www.google.com/', search: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  maps: { home: 'geo:0,0', search: (q) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` },
  spotify: { home: 'spotify:', search: (q) => `spotify:search:${encodeURIComponent(q)}` },
  blinkit: { home: 'https://blinkit.com/', search: (q) => `https://blinkit.com/s/?q=${encodeURIComponent(q)}` },
  zepto: { home: 'https://www.zeptonow.com/' },
  swiggy: { home: 'swiggy://' },
  zomato: { home: 'zomato://' },
  flipkart: { home: 'https://www.flipkart.com/', search: (q) => `https://www.flipkart.com/search?q=${encodeURIComponent(q)}` },
  amazon: { home: 'https://www.amazon.in/', search: (q) => `https://www.amazon.in/s?k=${encodeURIComponent(q)}` },
  meesho: { home: 'https://www.meesho.com/' },
  uber: { home: 'uber://' },
  ola: { home: 'olacabs://' },
  rapido: { home: 'rapido://' },
  phonepe: { home: 'phonepe://' },
  gpay: { home: 'tez://upi/' },
  paytm: { home: 'paytmmp://' },
  calendar: { home: 'content://com.android.calendar/time/' },
  playstore: { home: 'market://search?q=', search: (q) => `market://search?q=${encodeURIComponent(q)}` },
  settings: { home: 'app-settings:' },
};

export function findApp(name: string) {
  const lower = name.trim().toLowerCase();
  return PULSE_APP_CATALOG.find((a) => a.id === lower || a.name.toLowerCase() === lower || a.aliases.includes(lower));
}

/** Opens an app's own home screen (or its search page). Returns a short status line. */
export async function openApp(name: string, query = ''): Promise<{ ok: boolean; msg: string }> {
  const cat = findApp(name);
  if (!cat) return { ok: false, msg: `I don't know an app called "${name}".` };
  const link = APP_LINKS[cat.id];
  if (query && link?.search) {
    try {
      await Linking.openURL(link.search(query));
      return { ok: true, msg: `Opened ${cat.name} for "${query}".` };
    } catch {}
  }
  if (cat.id === 'settings') {
    await Linking.openSettings();
    return { ok: true, msg: 'Opened Settings.' };
  }
  if (Platform.OS === 'android') {
    for (const pkg of cat.packages) {
      // The promise rejects quickly when the package isn't installed; otherwise it only settles when the user returns.
      const launched = await Promise.race([
        IntentLauncher.startActivityAsync('android.intent.action.MAIN', { packageName: pkg, category: 'android.intent.category.LAUNCHER' }).then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((r) => setTimeout(() => r(true), 700)),
      ]);
      if (launched) return { ok: true, msg: `Opened ${cat.name}.` };
    }
  }
  if (link) {
    try {
      await Linking.openURL(link.home);
      return { ok: true, msg: `Opened ${cat.name}.` };
    } catch {}
  }
  return { ok: false, msg: `${cat.name} doesn't seem to be installed.` };
}

/**
 * Runs the on-device command parser's result using only intents/links. Returns null when the message should go
 * to the AI instead (questions, searches, anything that would need screen control).
 */
export async function runOpenIntent(intent: PulseParsedIntent): Promise<string | null> {
  switch (intent.type) {
    case 'OPEN_APP': {
      const r = await openApp(intent.query || intent.app || '');
      return r.ok ? r.msg : null;
    }
    case 'APP_WORKFLOW': {
      // Only explicit "open X and …" / "search X on Y" forms; implicit mentions ("music for studying") go to the AI.
      if (intent.confidence < 0.9) return null;
      const r = await openApp(intent.app || '', intent.query || '');
      return r.ok ? r.msg : null;
    }
    case 'CALL_CONTACT': {
      const d = digits(intent.recipient || '');
      if (d.length >= 7) {
        await Linking.openURL(`tel:${d}`);
        return `Opening the dialer for ${d}. Tap call to connect.`;
      }
      return `I can't read your contacts. Say "call" with the number, e.g. "call 98480 22338".`;
    }
    case 'SEND_MESSAGE': {
      const d = digits(intent.recipient || '');
      const text = intent.message || '';
      if (intent.platform === 'sms') {
        await Linking.openURL(`sms:${d}${text ? `?body=${encodeURIComponent(text)}` : ''}`);
        return 'Opened a text message. Check it and tap send.';
      }
      const phone = d.length === 10 ? `91${d}` : d.replace(/^\+/, '');
      await Linking.openURL(`https://wa.me/${d.length >= 7 ? phone : ''}${text ? `?text=${encodeURIComponent(text)}` : ''}`);
      return d.length >= 7 ? 'Opened WhatsApp with your message. Tap send when ready.' : 'Opened WhatsApp with your message. Pick the chat, then tap send.';
    }
    case 'CREATE_EMAIL':
    case 'SEND_EMAIL': {
      if (!intent.recipient && !intent.subject && !intent.message) return null;
      const q = [intent.subject ? `subject=${encodeURIComponent(intent.subject)}` : '', intent.message ? `body=${encodeURIComponent(intent.message)}` : '']
        .filter(Boolean)
        .join('&');
      await Linking.openURL(`mailto:${intent.recipient || ''}${q ? `?${q}` : ''}`);
      return 'Opened an email draft. Review it and tap send.';
    }
    case 'READ_EMAILS': {
      const r = await openApp('gmail');
      return r.ok ? 'Opened Gmail.' : null;
    }
    default:
      // SCROLL / CLICK / READ_SCREEN / torch / etc. need control of other apps, which Pulse doesn't do.
      return null;
  }
}
