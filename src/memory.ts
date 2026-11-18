/*
 * Pulse OS — Memory: durable facts about the user, kept on the phone (AsyncStorage).
 * Auto-learned in the background with flash-lite, plus "remember X" / "forget X" commands.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { generateJSON } from './gemini';

export const STORAGE_MEMORY = 'pulseos.memory.v1';
const MAX_MEMORIES = 200;

export type MemoryCategory = 'identity' | 'preference' | 'place' | 'person' | 'work' | 'health' | 'other';
export type MemoryItem = {
  id: string;
  text: string;
  category: MemoryCategory;
  source: 'auto' | 'manual';
  createdAt: number;
  updatedAt: number;
};

const CATEGORIES: MemoryCategory[] = ['identity', 'preference', 'place', 'person', 'work', 'health', 'other'];
// Never keep secrets in memory.
const SECRET_RE = /(password|passcode|\botp\b|\bpin\b|cvv|card number|\b\d{12,19}\b|aadhaar|\b\d{4}\s?\d{4}\s?\d{4}\b|api key|AIza[0-9A-Za-z_-]{20,})/i;

const mid = () => 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export async function loadMemories(): Promise<MemoryItem[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_MEMORY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((m) => m && typeof m.text === 'string') : [];
  } catch {
    return [];
  }
}

export async function saveMemories(list: MemoryItem[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_MEMORY, JSON.stringify(list.slice(0, MAX_MEMORIES)));
}

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9\u0C00-\u0C7F\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(s: string) {
  return norm(s)
    .split(' ')
    .filter((w) => w.length > 2 && !['the', 'and', 'that', 'user', 'my', 'is', 'are', 'about', 'with', 'for'].includes(w));
}

export function similarity(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  A.forEach((w) => {
    if (B.has(w)) hit += 1;
  });
  return hit / Math.min(A.size, B.size);
}

export function makeMemory(text: string, category: MemoryCategory = 'other', source: 'auto' | 'manual' = 'manual'): MemoryItem | null {
  const clean = text.replace(/\s+/g, ' ').trim().replace(/[.]+$/, '');
  if (clean.length < 3 || clean.length > 300 || SECRET_RE.test(clean)) return null;
  const now = Date.now();
  return { id: mid(), text: clean, category: CATEGORIES.includes(category) ? category : 'other', source, createdAt: now, updatedAt: now };
}

/** Adds items, replacing near-duplicates (newer wins). */
export function mergeMemories(list: MemoryItem[], add: MemoryItem[]): MemoryItem[] {
  let next = [...list];
  for (const m of add) {
    const dupe = next.find((x) => norm(x.text) === norm(m.text) || similarity(x.text, m.text) >= 0.85);
    if (dupe) next = next.map((x) => (x.id === dupe.id ? { ...x, text: m.text, category: m.category, updatedAt: Date.now() } : x));
    else next = [m, ...next];
  }
  return next.slice(0, MAX_MEMORIES);
}

/** Compact block for the system prompt. */
export function memorySummary(list: MemoryItem[], maxChars = 1500): string {
  if (!list.length) return '';
  const lines: string[] = [];
  let used = 0;
  const ordered = [...list].sort((a, b) => {
    const pri = (m: MemoryItem) => (m.category === 'identity' ? 0 : m.category === 'preference' ? 1 : 2);
    return pri(a) - pri(b) || b.updatedAt - a.updatedAt;
  });
  for (const m of ordered) {
    const line = `- ${m.text}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/* ------------------------------ Commands ------------------------------ */

export type MemoryCommand =
  | { kind: 'remember'; text: string }
  | { kind: 'forget'; text: string }
  | { kind: 'forget_all' }
  | { kind: 'list' }
  | null;

export function parseMemoryCommand(raw: string): MemoryCommand {
  const t = raw.trim().replace(/^(hey |ok )?pulse[,\s]+/i, '');
  if (/^(what do you (remember|know) about me|what have you remembered|show (my )?memor(y|ies))\??$/i.test(t)) return { kind: 'list' };
  if (/^forget (everything|all)( about me| you know)?\.?$/i.test(t)) return { kind: 'forget_all' };
  if (/^do you remember\b/i.test(t) || /\?$/.test(t)) return null;
  const rem = t.match(/^(?:please\s+)?(?:remember|note down|keep in mind|don'?t forget)(?:\s+that)?[:,]?\s+(.{3,})$/i);
  if (rem && !/^to\s/i.test(rem[1])) return { kind: 'remember', text: rem[1] };
  const fg = t.match(/^(?:please\s+)?forget(?:\s+that|\s+about)?[:,]?\s+(.{2,})$/i);
  if (fg) return { kind: 'forget', text: fg[1] };
  return null;
}

/** Turns "I live in Hyderabad" style input into a third-person memory line. */
export function toMemoryText(text: string): string {
  let s = text.trim().replace(/[.!]+$/, '');
  s = s
    .replace(/^i am\b/i, 'User is')
    .replace(/^i'm\b/i, 'User is')
    .replace(/^i\b/i, 'User')
    .replace(/^my\b/i, "User's");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function findMatches(list: MemoryItem[], query: string): MemoryItem[] {
  const q = norm(query);
  return list.filter((m) => norm(m.text).includes(q) || similarity(m.text, query) >= 0.5);
}

/* ------------------------------ Auto-extraction ------------------------------ */

const EXTRACT_PROMPT = [
  'You maintain a small memory of durable facts about the user of a personal assistant app.',
  'From the USER MESSAGE only, extract facts worth remembering for months: their name, where they live/work/study, family and friends (name + relation),',
  'stable preferences (food, language, brands, routines), devices, goals, important dates. Ignore questions, one-off requests, small talk and anything about other people the user is only asking about.',
  'Never store passwords, OTPs, PINs, card/bank/ID numbers or anything secret.',
  'Write each fact as a short third-person line ("User lives in Hyderabad", "User\'s sister is Priya").',
  'If a fact updates an existing memory, return it in "update" with that memory id.',
  'Reply JSON: {"add":[{"text":string,"category":"identity"|"preference"|"place"|"person"|"work"|"health"|"other"}],"update":[{"id":string,"text":string}]}. Return empty arrays when nothing qualifies (most messages).',
].join('\n');

export function worthExtracting(userText: string): boolean {
  const t = userText.trim();
  if (t.split(/\s+/).length < 4) return false;
  return /\b(i|i'm|im|i've|my|me|mine|we|our|us)\b/i.test(t) || /(నేను|నా )/.test(t);
}

export async function extractMemories(apiKey: string, existing: MemoryItem[], userText: string): Promise<{ add: MemoryItem[]; update: { id: string; text: string }[] }> {
  const known = existing
    .slice(0, 60)
    .map((m) => `${m.id}: ${m.text}`)
    .join('\n');
  const out: any = await generateJSON(apiKey, EXTRACT_PROMPT, `EXISTING MEMORIES:\n${known || '(none)'}\n\nUSER MESSAGE:\n${userText.slice(0, 1500)}`);
  const add = (Array.isArray(out?.add) ? out.add : [])
    .slice(0, 5)
    .map((a: any) => makeMemory(String(a?.text || ''), a?.category, 'auto'))
    .filter(Boolean) as MemoryItem[];
  const update = (Array.isArray(out?.update) ? out.update : [])
    .filter((u: any) => u && existing.some((m) => m.id === u.id) && typeof u.text === 'string' && !SECRET_RE.test(u.text))
    .slice(0, 5)
    .map((u: any) => ({ id: String(u.id), text: String(u.text).trim() }));
  return { add, update };
}
