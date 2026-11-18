/*
 * Pulse OS — the assistant brain shared by Chat and Hands-Free: system prompt, conversation history → Gemini contents,
 * and the on-device commands (remember/forget, reminders, open-an-app) that answer instantly.
 */
import type { Attachment } from './attachments';
import type { ActionLink } from './actions';
import type { GeminiContent, GeminiPart, Source } from './gemini';
import type { ReminderDraft } from './reminders';

export type ReminderCard = { kind: 'reminder'; draft: ReminderDraft; status: 'pending' | 'set' | 'cancelled' | 'error'; error?: string };

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  ts: number;
  attachment?: Attachment;
  sources?: Source[];
  actions?: ActionLink[];
  card?: ReminderCard;
  searched?: boolean;
  streaming?: boolean;
};

export type UserProfile = { name: string; email: string; phone: string; address: string };

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export function buildSystemPrompt(opts: { profile: UserProfile; memory: string; knowledge?: string; voice?: boolean }): string {
  const now = new Date();
  const when = now.toLocaleString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  const p = opts.profile;
  const profile = [p.name && `Name: ${p.name}`, p.address && `Home: ${p.address}`, p.email && `Email: ${p.email}`, p.phone && `Phone: ${p.phone}`].filter(Boolean).join(' | ');
  return [
    'You are Pulse, a sharp, warm personal assistant on the user\'s Android phone. The user is in India (timezone Asia/Kolkata, ₹, km).',
    `Now: ${when} IST.`,
    'Style: answer first. Usually 1–3 short sentences or a tight "- " list; add detail only when asked or truly needed. Plain text, light markdown only (no headings, no tables). No filler, no restating the question.',
    'Reply in the user\'s language (English, Telugu or Hinglish) and match their tone.',
    'Use the conversation so far: resolve "it", "that", "there", "same" from earlier turns. When a file or image is attached, answer about it directly.',
    'Be accurate: if search results are provided, rely on them and give concrete facts (names, numbers, dates). If unsure or the info may be outdated, say so in a few words. Never invent prices, phone numbers, addresses or timings.',
    'Pulse can open apps, the dialer, SMS/WhatsApp composers, Maps and Calendar, and set phone reminders; it cannot tap or read inside other apps. For multi-step website tasks (booking, shopping, forms) suggest the Computer tab.',
    opts.voice
      ? 'This is a spoken conversation: keep it to 1–2 short sentences, no lists, no links, no ACTIONS line.'
      : [
          'When a quick action would clearly help, end with ONE line exactly like: ACTIONS: [{"type":"maps","label":"Directions","query":"…"}] (max 3 items). Types:',
          '{"type":"maps","query"} {"type":"call","phone"} {"type":"sms","phone","body"} {"type":"whatsapp","phone","text"} {"type":"email","to","subject","body"}',
          '{"type":"calendar","title","start":"ISO 8601 +05:30","end","location"} {"type":"reminder","title","at":"ISO 8601 +05:30"} {"type":"web","url"} — each may have a short "label".',
          'Only use phone numbers/URLs that appear in the conversation or search results. Omit the ACTIONS line when nothing is useful (most answers).',
        ].join('\n'),
    profile ? `User profile: ${profile}` : '',
    opts.memory ? `What you know about the user (use quietly; never recite unless asked):\n${opts.memory}` : '',
    opts.knowledge ? `User's saved notes that may help:\n${opts.knowledge}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Older builds stored replies as JSON ({direct_response…}); keep only the human text. */
export function cleanLegacyText(text: string): string {
  const t = (text || '').trim();
  if (!t.startsWith('{') || !/direct_response/.test(t)) return t;
  try {
    const j = JSON.parse(t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
    return String(j.direct_response || '').trim() || t;
  } catch {
    const m = t.match(/"direct_response"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse(`"${m[1]}"`) : t;
  }
}

function describeAttachment(a: Attachment) {
  return a.kind === 'image' ? `[The user attached an image "${a.name}" earlier]` : `[The user attached the file "${a.name}" earlier]`;
}

/**
 * Converts chat history to Gemini contents: correct order, roles user/model, strictly alternating,
 * starting and ending with the user. Attachments ride on the exact turn they were sent with.
 */
export function buildContents(history: ChatMessage[], maxTurns = 24, maxInlineTurns = 3): GeminiContent[] {
  const usable = history.filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.streaming && (m.text.trim() || m.attachment || m.card));
  const recent = usable.slice(-maxTurns);
  let inlineLeft = maxInlineTurns;
  const withParts: { role: 'user' | 'model'; parts: GeminiPart[] }[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    const parts: GeminiPart[] = [];
    if (m.role === 'user' && m.attachment) {
      const a = m.attachment;
      if (inlineLeft > 0 && (a.base64 || a.textContent)) {
        inlineLeft -= 1;
        if (a.base64) parts.push({ inlineData: { mimeType: a.mimeType, data: a.base64 } });
        if (a.textContent) parts.push({ text: `[Attached file: ${a.name}]\n${a.textContent.slice(0, 60000)}` });
      } else {
        parts.push({ text: describeAttachment(a) });
      }
    }
    let text = m.role === 'assistant' ? cleanLegacyText(m.text) : m.text;
    if (m.card?.kind === 'reminder') {
      text = `${text}\n(Reminder card "${m.card.draft.title}" at ${new Date(m.card.draft.at).toLocaleString('en-IN')} — ${m.card.status})`.trim();
    }
    if (text.trim()) parts.push({ text });
    if (!parts.length) continue;
    withParts.unshift({ role: m.role === 'user' ? 'user' : 'model', parts });
  }
  // Merge consecutive turns with the same role (e.g. two user messages after an error).
  const merged: GeminiContent[] = [];
  for (const c of withParts) {
    const last = merged[merged.length - 1];
    if (last && last.role === c.role) last.parts.push(...c.parts);
    else merged.push({ role: c.role, parts: [...c.parts] });
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  while (merged.length && merged[merged.length - 1].role !== 'user') merged.pop();
  return merged;
}

/** Strips heavy base64 before persisting chats (it is kept in memory for the session). */
export function forStorage(list: ChatMessage[]): ChatMessage[] {
  return list
    .filter((m) => !m.streaming)
    .slice(-80)
    .map((m) => (m.attachment ? { ...m, attachment: { ...m.attachment, base64: undefined, textContent: m.attachment.textContent?.slice(0, 4000) } } : m));
}
