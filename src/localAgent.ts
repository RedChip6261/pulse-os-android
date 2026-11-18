/*
 * Pulse OS — Custom Local Agent (Zero API Keys, Zero Rate Limits)
 * Handles multi-step automations, on-device RAG/notes, user profile/memories/reminders,
 * safe math/unit conversions, date/time, and structured device ActionLinks without any external API key.
 */
import { buildAgenticRagContext, RagChunk } from '../pulseFeatures';
import { ActionLink } from './actions';
import { UserProfile } from './assistant';
import { AutomationWorkflow, executeAutomation, looksLikeAutomation } from './automation';
import { runLocalCommand, MemoryOps } from './commands';
import { describeWhen, Reminder, ReminderDraft } from './reminders';

export type LocalAgentResponse = {
  text: string;
  actions?: ActionLink[];
  reminder?: ReminderDraft;
  handled: boolean;
};

/** Safe arithmetic evaluator for basic math expressions (no eval / Function). */
function tryEvalMath(raw: string): string | null {
  const cleaned = raw
    .toLowerCase()
    .replace(/^(?:what\s+is|calculate|calc|compute|solve|evaluate)\s+/i, '')
    .replace(/\bpercent\s+of\b/gi, '% of ')
    .replace(/[?=]/g, '')
    .trim();

  // Percentage: "15% of 2400"
  const pct = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*%\s*of\s*(-?\d+(?:\.\d+)?)$/);
  if (pct) {
    const res = (parseFloat(pct[1]) / 100) * parseFloat(pct[2]);
    return `${pct[1]}% of ${pct[2]} = **${Number(res.toFixed(4))}**`;
  }

  // Unit conversions
  const conv = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?|kg|kilograms?|lbs?|pounds?|c|celsius|f|fahrenheit|cm|in|inches)\s+(?:to|in)\s+(km|kilometers?|mi|miles?|kg|kilograms?|lbs?|pounds?|c|celsius|f|fahrenheit|cm|in|inches)$/i);
  if (conv) {
    const v = parseFloat(conv[1]);
    const from = conv[2].toLowerCase();
    const to = conv[3].toLowerCase();
    if (/^km|kilometer/.test(from) && /^mi|mile/.test(to)) return `${v} km = **${(v * 0.621371).toFixed(2)} miles**`;
    if (/^mi|mile/.test(from) && /^km|kilometer/.test(to)) return `${v} miles = **${(v * 1.60934).toFixed(2)} km**`;
    if (/^kg|kilogram/.test(from) && /^lb|pound/.test(to)) return `${v} kg = **${(v * 2.20462).toFixed(2)} lbs**`;
    if (/^lb|pound/.test(from) && /^kg|kilogram/.test(to)) return `${v} lbs = **${(v / 2.20462).toFixed(2)} kg**`;
    if (/^c|celsius/.test(from) && /^f|fahrenheit/.test(to)) return `${v}°C = **${((v * 9) / 5 + 32).toFixed(1)}°F**`;
    if (/^f|fahrenheit/.test(from) && /^c|celsius/.test(to)) return `${v}°F = **${(((v - 32) * 5) / 9).toFixed(1)}°C**`;
    if (from === 'cm' && /^in/.test(to)) return `${v} cm = **${(v / 2.54).toFixed(2)} in**`;
    if (/^in/.test(from) && to === 'cm') return `${v} in = **${(v * 2.54).toFixed(2)} cm**`;
  }

  // Strict arithmetic tokenizer (+, -, *, /, parentheses)
  if (!/^[\d\s+\-*/().]+$/.test(cleaned) || !/[+\-*/]/.test(cleaned)) return null;
  try {
    const tokens = cleaned.match(/\d+(?:\.\d+)?|[+\-*/()]/g);
    if (!tokens || tokens.length > 40) return null;
    let pos = 0;
    const peek = () => tokens[pos];
    const consume = () => tokens[pos++];

    const parseExpr = (): number => {
      let left = parseTerm();
      while (peek() === '+' || peek() === '-') {
        const op = consume();
        const right = parseTerm();
        left = op === '+' ? left + right : left - right;
      }
      return left;
    };
    const parseTerm = (): number => {
      let left = parseFactor();
      while (peek() === '*' || peek() === '/') {
        const op = consume();
        const right = parseFactor();
        if (op === '/' && right === 0) throw new Error('Division by zero');
        left = op === '*' ? left * right : left / right;
      }
      return left;
    };
    const parseFactor = (): number => {
      if (peek() === '+') {
        consume();
        return parseFactor();
      }
      if (peek() === '-') {
        consume();
        return -parseFactor();
      }
      if (peek() === '(') {
        consume();
        const val = parseExpr();
        if (consume() !== ')') throw new Error('Mismatched parenthesis');
        return val;
      }
      const num = Number(consume());
      if (!Number.isFinite(num)) throw new Error('Invalid number');
      return num;
    };

    const result = parseExpr();
    if (pos !== tokens.length || !Number.isFinite(result)) return null;
    const formatted = Number.isInteger(result) ? String(result) : String(Number(result.toFixed(6)));
    return `${cleaned} = **${formatted}**`;
  } catch {
    return null;
  }
}

export async function runLocalAgent(
  input: string,
  ctx: {
    profile: UserProfile;
    memory: MemoryOps;
    reminders: Reminder[];
    knowledge: RagChunk[];
    workflows: AutomationWorkflow[];
    strictLocal: boolean; // true when user explicitly selected Local Agent or has no API key
  },
): Promise<LocalAgentResponse> {
  const q = input.trim();
  const lower = q.toLowerCase();

  // 1. Multi-step automation workflows & compound commands
  if (looksLikeAutomation(q, ctx.workflows)) {
    const auto = await executeAutomation(q, {
      workflows: ctx.workflows,
      memories: ctx.memory.list,
      reminders: ctx.reminders,
      addMemory: ctx.memory.add,
      userName: ctx.profile.name,
    });
    if (auto) {
      return {
        handled: true,
        text: auto.summary,
        actions: auto.actions.length ? auto.actions : undefined,
        reminder: auto.reminder,
      };
    }
  }

  // 2. Single instant device commands (memory, reminders, open apps, call, sms)
  const localCmd = await runLocalCommand(q, { apiKey: '', memory: ctx.memory }).catch(() => null);
  if (localCmd) {
    return {
      handled: true,
      text: localCmd.reply,
      reminder: localCmd.reminder,
    };
  }

  // 3. List workflows
  if (/\b(?:list|show|what\s+are)\s+(?:my\s+)?(?:workflows|automations|routines|skills)\b/i.test(lower)) {
    const list = ctx.workflows.map((w) => `- **${w.name}** (say "${w.trigger}"): ${w.description}`).join('\n');
    return {
      handled: true,
      text: `Available multi-step automations:\n${list}`,
    };
  }

  // 4. List reminders
  if (/\b(?:list|show|check|what\s+are)\s+(?:my\s+)?reminders?\b/i.test(lower)) {
    if (!ctx.reminders.length) {
      return { handled: true, text: 'You have no upcoming reminders. Say "remind me at 6pm to …" to add one.' };
    }
    const lines = ctx.reminders.slice(0, 10).map((r) => `- **${r.title}** · ${describeWhen(r)}`);
    return { handled: true, text: `Upcoming reminders:\n${lines.join('\n')}` };
  }

  // 5. Profile / identity lookup
  if (/\b(?:who\s+am\s+i|my\s+profile|my\s+details|my\s+email|my\s+phone|my\s+address)\b/i.test(lower)) {
    const p = ctx.profile;
    const parts = [
      p.name ? `- **Name:** ${p.name}` : '',
      p.email ? `- **Email:** ${p.email}` : '',
      p.phone ? `- **Phone:** ${p.phone}` : '',
      p.address ? `- **Home:** ${p.address}` : '',
    ].filter(Boolean);
    return {
      handled: true,
      text: parts.length ? `Your saved profile:\n${parts.join('\n')}` : 'Your profile is empty right now. Open your Profile page from the top bar to add your details.',
    };
  }

  // 6. Time & Date (IST)
  if (/\b(?:what\s+time|current\s+time|time\s+now|today'?s?\s+date|what\s+day\s+is\s+it|what\s+is\s+the\s+date)\b/i.test(lower)) {
    const now = new Date();
    const formatted = now.toLocaleString('en-IN', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    return { handled: true, text: `It is **${formatted} IST**.` };
  }

  // 7. Math & Unit conversions
  const math = tryEvalMath(q);
  if (math) {
    return { handled: true, text: math };
  }

  // 8. Directions / Maps quick action
  const mapMatch = q.match(/^(?:directions?\s+to|navigate\s+to|where\s+is|find\s+on\s+maps?)\s+(.+)$/i);
  if (mapMatch) {
    const place = mapMatch[1].trim();
    return {
      handled: true,
      text: `Tap below to open **${place}** in Google Maps.`,
      actions: [{ type: 'maps', label: `Maps: ${place}`, query: place }],
    };
  }

  // 9. On-device Knowledge Vault / Saved Notes + Memories search
  const rag = ctx.knowledge.length ? buildAgenticRagContext(q, ctx.knowledge, 3) : { results: [], contextBlock: '' };
  const memHits = ctx.memory.list.filter((m) => {
    const words = lower.split(/\s+/).filter((w) => w.length >= 3);
    return words.some((w) => m.text.toLowerCase().includes(w));
  });

  if (rag.results.length > 0 || memHits.length > 0) {
    const sections: string[] = [];
    if (rag.results.length > 0) {
      sections.push(
        rag.results.map((r) => `**${r.chunk.title}**\n${r.chunk.content}`).join('\n\n'),
      );
    }
    if (memHits.length > 0) {
      sections.push(`**From your memory:**\n${memHits.slice(0, 4).map((m) => `- ${m.text}`).join('\n')}`);
    }
    return { handled: true, text: sections.join('\n\n') };
  }

  // If in strict local mode (no API key or user chose Local Agent), always return a helpful, cap-free response.
  if (!ctx.strictLocal) {
    return { handled: false, text: '' };
  }

  if (/^(?:hi|hello|hey|namaste|good\s+(?:morning|afternoon|evening))\b/i.test(lower)) {
    const first = ctx.profile.name ? `, ${ctx.profile.name.split(' ')[0]}` : '';
    return {
      handled: true,
      text: `Hi${first}! Pulse Local Agent is active (no API key or usage limits). Ask me to run a multi-step workflow, set reminders, save memories, search your notes, calculate math, or open apps.`,
    };
  }

  if (/\b(?:what\s+can\s+you\s+do|help|capabilities|features)\b/i.test(lower)) {
    return {
      handled: true,
      text: [
        'Pulse Local Agent runs 100% on-device with no API keys or rate limits:',
        '- **Multi-step workflows:** e.g. "open YouTube and search music, then remind me at 6pm to stretch" or "morning briefing"',
        '- **Reminders & Memory:** "remind me at 8am to…", "remember I prefer…"',
        '- **Saved Notes & Profile:** searches your saved notes and personal details',
        '- **Math & Conversions:** e.g. "18% of 4500", "12 km to miles", "(240 + 60) / 5"',
        '- **Device & Maps:** open apps, dial numbers, compose WhatsApp/SMS/email, open Maps directions',
      ].join('\n'),
    };
  }

  return {
    handled: true,
    text: `Pulse Local Agent didn't find a matching note, memory, math expression, or device workflow for "${q}". Try a multi-step command (e.g. "open Maps for Hyderabad, then remind me in 30 min to leave"), save a note in Profile/Settings, or switch to Cloud AI in Settings if you want open-ended web answers.`,
  };
}
