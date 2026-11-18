/*
 * Pulse OS — instant on-device commands shared by Chat and Hands-Free.
 */
import { parsePulseVoiceCommand } from '../pulseFeatures';
import { runOpenIntent } from './actions';
import { findMatches, makeMemory, MemoryItem, parseMemoryCommand, toMemoryText } from './memory';
import { describeWhen, isReminderRequest, parseReminderAI, parseReminderLocal, ReminderDraft } from './reminders';

export type MemoryOps = {
  list: MemoryItem[];
  add: (items: MemoryItem[]) => void;
  remove: (ids: string[]) => void;
  confirmClearAll: () => void;
};

export type CommandResult = { reply: string; reminder?: ReminderDraft } | null;

export async function runLocalCommand(text: string, ctx: { apiKey: string; memory: MemoryOps }): Promise<CommandResult> {
  // 1. Memory
  const mc = parseMemoryCommand(text);
  if (mc) {
    if (mc.kind === 'list') {
      const l = ctx.memory.list;
      return { reply: l.length ? `Here's what I remember:\n${l.slice(0, 25).map((m) => `- ${m.text}`).join('\n')}${l.length > 25 ? `\n…and ${l.length - 25} more in Settings > Memory.` : ''}` : "I haven't saved anything about you yet." };
    }
    if (mc.kind === 'forget_all') {
      ctx.memory.confirmClearAll();
      return { reply: 'Confirm on screen and I will clear everything I remember about you.' };
    }
    if (mc.kind === 'remember') {
      const m = makeMemory(toMemoryText(mc.text), 'other', 'manual');
      if (!m) return { reply: "I won't store that (it looks like a password, code or card number, or it's too long)." };
      ctx.memory.add([m]);
      return { reply: `Got it — I'll remember: ${m.text}` };
    }
    if (mc.kind === 'forget') {
      const hits = findMatches(ctx.memory.list, mc.text);
      if (!hits.length) return { reply: `I don't have anything saved about "${mc.text}".` };
      ctx.memory.remove(hits.map((h) => h.id));
      return { reply: hits.length === 1 ? `Forgotten: ${hits[0].text}` : `Forgot ${hits.length} things:\n${hits.map((h) => `- ${h.text}`).join('\n')}` };
    }
  }

  // 2. Reminders (always confirmed with a card before scheduling)
  if (isReminderRequest(text)) {
    let draft = parseReminderLocal(text);
    if (!draft && ctx.apiKey.trim()) draft = await parseReminderAI(ctx.apiKey, text).catch(() => null);
    if (!draft) return { reply: 'When should I remind you, and about what? For example: "remind me at 6pm to call Amma".' };
    return { reply: `Set a reminder for ${describeWhen(draft)}?`, reminder: draft };
  }

  // 3. Open an app / dialer / composer (no screen control)
  const intent = parsePulseVoiceCommand(text, []);
  if (intent.type !== 'CONVERSATION') {
    const reply = await runOpenIntent(intent).catch(() => null);
    if (reply) return { reply };
  }
  return null;
}
