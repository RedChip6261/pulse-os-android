/*
 * Pulse OS — Custom Conversational Agent (Zero Third-Party API Keys, Zero Quota Limits)
 * Combines:
 *   1. Multi-step automation workflows & natural device intents
 *   2. Context-aware human-like conversational dialogue (with turn history)
 *   3. Free, no-key open-web knowledge (Wikipedia, DuckDuckGo, Open-Meteo weather, Dictionary, Exchange rates)
 *   4. On-device RAG (Saved Notes), Memories, Reminders, Profile & Local Document/Image analysis
 *   5. Safe math & unit conversions
 */
import { buildAgenticRagContext, RagChunk } from '../pulseFeatures';
import { ActionLink } from './actions';
import { ChatMessage, UserProfile } from './assistant';
import type { Attachment } from './attachments';
import { AutomationWorkflow, executeAutomation, looksLikeAutomation } from './automation';
import { runLocalCommand, MemoryOps } from './commands';
import { describeWhen, Reminder, ReminderDraft } from './reminders';
import { loadMacros, loadSessionLogs, macroFromSession, saveMacro, deleteMacro, sessionStats, syncBridgeSession, appendSession, finishSession, makeStepLog, newSession, ActionType, SessionLog, StepStatus } from './sessionLog';
import { getAutomationGuardState, haltAutomation, hideTacticalHUD, resumeAutomation, showTacticalHUD } from './bridge';

export type LocalAgentResponse = {
  text: string;
  actions?: ActionLink[];
  sources?: { title: string; uri: string }[];
  reminder?: ReminderDraft;
  handled: boolean;
};

/* ------------------------------------------------------------------ */
/* Safe Math & Unit Conversions                                       */
/* ------------------------------------------------------------------ */

function tryEvalMath(raw: string): string | null {
  const cleaned = raw
    .toLowerCase()
    .replace(/^(?:what\s+is|what's|calculate|calc|compute|solve|evaluate)\s+/i, '')
    .replace(/\bpercent\s+of\b/gi, '% of ')
    .replace(/[?=]/g, '')
    .trim();

  const pct = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*%\s*of\s*(-?\d+(?:\.\d+)?)$/);
  if (pct) {
    const res = (parseFloat(pct[1]) / 100) * parseFloat(pct[2]);
    return `${pct[1]}% of ${pct[2]} is **${Number(res.toFixed(4))}**.`;
  }

  const conv = cleaned.match(
    /^(-?\d+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?|kg|kilograms?|lbs?|pounds?|c|celsius|f|fahrenheit|cm|in|inches)\s+(?:to|in)\s+(km|kilometers?|mi|miles?|kg|kilograms?|lbs?|pounds?|c|celsius|f|fahrenheit|cm|in|inches)$/i,
  );
  if (conv) {
    const v = parseFloat(conv[1]);
    const from = conv[2].toLowerCase();
    const to = conv[3].toLowerCase();
    if (/^km|kilometer/.test(from) && /^mi|mile/.test(to)) return `${v} km is **${(v * 0.621371).toFixed(2)} miles**.`;
    if (/^mi|mile/.test(from) && /^km|kilometer/.test(to)) return `${v} miles is **${(v * 1.60934).toFixed(2)} km**.`;
    if (/^kg|kilogram/.test(from) && /^lb|pound/.test(to)) return `${v} kg is **${(v * 2.20462).toFixed(2)} lbs**.`;
    if (/^lb|pound/.test(from) && /^kg|kilogram/.test(to)) return `${v} lbs is **${(v / 2.20462).toFixed(2)} kg**.`;
    if (/^c|celsius/.test(from) && /^f|fahrenheit/.test(to)) return `${v}°C is **${((v * 9) / 5 + 32).toFixed(1)}°F**.`;
    if (/^f|fahrenheit/.test(from) && /^c|celsius/.test(to)) return `${v}°F is **${(((v - 32) * 5) / 9).toFixed(1)}°C**.`;
    if (from === 'cm' && /^in/.test(to)) return `${v} cm is **${(v / 2.54).toFixed(2)} inches**.`;
    if (/^in/.test(from) && to === 'cm') return `${v} inches is **${(v * 2.54).toFixed(2)} cm**.`;
  }

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
    return `${cleaned} equals **${formatted}**.`;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Local Attachment Analyzer (Zero API Keys)                          */
/* ------------------------------------------------------------------ */

function analyzeAttachmentLocally(att: Attachment, question: string): LocalAgentResponse {
  const q = question.toLowerCase();
  if (att.textContent && att.textContent.trim()) {
    const text = att.textContent.trim();
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const words = text.split(/\s+/).filter(Boolean);
    const emails = Array.from(new Set(text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g) || []));
    const urls = Array.from(new Set(text.match(/https?:\/\/\S+/g) || []));

    // If user asks a specific question about the document, find matching sentences
    const qTerms = q.split(/\s+/).filter((w) => w.length >= 3 && !/^(what|does|this|file|document|say|about|the|and|for|with)$/.test(w));
    if (qTerms.length > 0 && !/summari|overview|what is in/.test(q)) {
      const hits = lines.filter((l) => qTerms.some((t) => l.toLowerCase().includes(t))).slice(0, 5);
      if (hits.length > 0) {
        return {
          handled: true,
          text: `From **${att.name}**:\n${hits.map((h) => `- ${h.slice(0, 240)}`).join('\n')}`,
        };
      }
    }

    const preview = lines.slice(0, 5).map((l) => l.slice(0, 220)).join('\n');
    const extras = [
      emails.length ? `Emails found: ${emails.slice(0, 3).join(', ')}` : '',
      urls.length ? `Links found: ${urls.length}` : '',
    ].filter(Boolean);

    return {
      handled: true,
      text: `**${att.name}** (${words.length} words, ${lines.length} lines)\n\n${preview}${extras.length ? `\n\n${extras.join(' · ')}` : ''}`,
    };
  }

  // Image or binary PDF (no extracted text)
  const sizeKb = Math.max(1, Math.round((att.size || 0) / 1024));
  if (att.kind === 'image') {
    return {
      handled: true,
      text: `I received your image **${att.name}** (${sizeKb} KB, ${att.mimeType}). On-device mode doesn't run cloud vision, so tell me what you'd like to do with it—save a note, set a reminder, or ask me anything else.`,
    };
  }
  return {
    handled: true,
    text: `I received **${att.name}** (${sizeKb} KB). For instant on-device reading and Q&A, attach `.concat('`.txt`, `.md`, `.csv`, `.json`, or `.docx` files.'),
  };
}

/* ------------------------------------------------------------------ */
/* Free Open-Web Knowledge (No API Keys, No Quota Limits)             */
/* ------------------------------------------------------------------ */

async function fetchJson(url: string, timeoutMs = 6000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchWeather(city: string): Promise<LocalAgentResponse | null> {
  const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`);
  const place = geo?.results?.[0];
  if (!place) return null;
  const wx = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto`,
  );
  const cur = wx?.current;
  if (!cur) return null;
  const code = Number(cur.weather_code);
  const desc =
    code === 0
      ? 'clear skies'
      : code <= 3
        ? 'partly cloudy'
        : code <= 48
          ? 'foggy'
          : code <= 67
            ? 'rainy'
            : code <= 77
              ? 'snowy'
              : code <= 82
                ? 'rain showers'
                : 'thunderstorms';
  const max = wx?.daily?.temperature_2m_max?.[0];
  const min = wx?.daily?.temperature_2m_min?.[0];
  const range = max !== undefined && min !== undefined ? ` Today's high is ${Math.round(max)}°C and low is ${Math.round(min)}°C.` : '';
  return {
    handled: true,
    text: `Right now in **${place.name}${place.admin1 ? `, ${place.admin1}` : ''}**, it's **${Math.round(cur.temperature_2m)}°C** (feels like ${Math.round(cur.apparent_temperature)}°C) with ${desc}, ${cur.relative_humidity_2m}% humidity, and ${Math.round(cur.wind_speed_10m)} km/h wind.${range}`,
    sources: [{ title: 'Open-Meteo', uri: 'https://open-meteo.com/' }],
  };
}

async function fetchCurrency(amount: number, from: string, to: string): Promise<LocalAgentResponse | null> {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  const data = await fetchJson(`https://open.er-api.com/v6/latest/${encodeURIComponent(f)}`);
  const rate = data?.rates?.[t];
  if (!rate) return null;
  const converted = (amount * rate).toFixed(2);
  return {
    handled: true,
    text: `${amount} ${f} is **${converted} ${t}** (1 ${f} = ${Number(rate.toFixed(4))} ${t}).`,
    sources: [{ title: 'ExchangeRate-API', uri: 'https://www.exchangerate-api.com/' }],
  };
}

async function fetchDefinition(word: string): Promise<LocalAgentResponse | null> {
  const data = await fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
  const entry = Array.isArray(data) ? data[0] : null;
  const meaning = entry?.meanings?.[0];
  const def = meaning?.definitions?.[0]?.definition;
  if (!def) return null;
  const ex = meaning?.definitions?.[0]?.example;
  return {
    handled: true,
    text: `**${entry.word}** (${meaning.partOfSpeech}): ${def}${ex ? `\nExample: "${ex}"` : ''}`,
    sources: [{ title: 'Dictionary API', uri: `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}` }],
  };
}

async function fetchOpenKnowledge(query: string): Promise<LocalAgentResponse | null> {
  // Clean question prefixes so Wikipedia / DuckDuckGo hit the exact topic
  const topic = query
    .replace(/^(?:who\s+is|who\s+was|what\s+is|what\s+are|what\s+was|tell\s+me\s+about|explain|describe|where\s+is|when\s+was)\s+/i, '')
    .replace(/^(?:a|an|the)\s+/i, '')
    .replace(/[?!.]+$/g, '')
    .trim();
  if (topic.length < 2) return null;

  // 1. Wikipedia search + summary
  const search = await fetchJson(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(topic)}&limit=1&namespace=0&format=json`);
  const bestTitle = search?.[1]?.[0];
  if (bestTitle) {
    const sum = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(bestTitle)}`);
    if (sum?.extract && !/may refer to:/i.test(sum.extract)) {
      const pageUrl = sum?.content_urls?.mobile?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(bestTitle)}`;
      // Keep to 2-3 crisp sentences for natural conversation
      const sentences = String(sum.extract).match(/[^.!?]+[.!?]+/g) || [sum.extract];
      return {
        handled: true,
        text: sentences.slice(0, 3).join(' ').trim(),
        sources: [{ title: `Wikipedia · ${bestTitle}`, uri: pageUrl }],
      };
    }
  }

  // 2. DuckDuckGo Instant Answer fallback
  const ddg = await fetchJson(`https://api.duckduckgo.com/?q=${encodeURIComponent(topic)}&format=json&no_html=1&skip_disambig=1`);
  if (ddg?.AbstractText) {
    return {
      handled: true,
      text: String(ddg.AbstractText),
      sources: ddg.AbstractURL ? [{ title: ddg.AbstractSource || 'DuckDuckGo', uri: ddg.AbstractURL }] : undefined,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Conversational Dialogue & Empathy Helpers                          */
/* ------------------------------------------------------------------ */

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function resolveFollowUp(input: string, history: ChatMessage[]): string {
  const lower = input.trim().toLowerCase();
  if (/^(?:tell\s+me\s+more|more\s+details|elaborate|go\s+on|continue|explain\s+more)$/i.test(lower)) {
    const lastUser = [...history].reverse().find((m) => m.role === 'user' && m.text.trim().toLowerCase() !== lower);
    if (lastUser) return lastUser.text;
  }
  return input;
}

/* ------------------------------------------------------------------ */
/* Session log & macro commands                                       */
/* ------------------------------------------------------------------ */

/**
 * Handles "show my session log", "save this as a macro", "list macros" and friends.
 * Returns null when the input isn't a session-log command.
 */
async function handleSessionLogCommand(input: string): Promise<string | null> {
  const lower = input.trim().toLowerCase();

  if (/\b(?:show|list|view|open)\b.*\b(?:session\s+log|activity\s+log|run\s+history|automation\s+log)\b/.test(lower)) {
    const sessions = await loadSessionLogs();
    // Sync the native bridge session (accessibility-service step logs) into the shared store.
    await syncBridgeSession().catch(() => undefined);
    const sessionsAfter = await loadSessionLogs();
    if (!sessionsAfter.length) return 'No automation sessions recorded yet.';
    const stats = sessionStats(sessionsAfter);
    const lines = sessionsAfter
      .slice(0, 10)
      .map((s) => {
        const when = new Date(s.startedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
        const guard = s.loopGuardHit ? ' · loop guard' : '';
        return `- **${s.workflowName}** · ${when} · ${s.summary}${guard}`;
      });
    return [
      `**Session log** (${stats.sessions} sessions · ${stats.steps} steps · ${stats.errors} errors${stats.tokens ? ` · ${stats.tokens} tokens` : ''}${stats.avgLatency ? ` · avg ${stats.avgLatency}ms` : ''})`,
      ...lines,
    ].join('\n');
  }

  if (/\b(?:list|show)\b.*\bmacros?\b/.test(lower)) {
    const macros = await loadMacros();
    if (!macros.length) return 'No macros saved yet. Run a workflow, then say "save this as a macro".';
    return [
      '**Saved macros:**',
      ...macros.map((m) => `- **${m.name}** (say "${m.trigger}") · ${m.steps.length} steps · used ${m.useCount}×`),
    ].join('\n');
  }

  if (/\bsave\b.*\b(?:as\s+)?(?:a\s+)?macro\b/.test(lower)) {
    const sessions = await loadSessionLogs();
    const latest = sessions.find((s) => s.status === 'completed' && s.steps.length);
    if (!latest) return 'No completed session to save yet — run a workflow first.';
    const macro = macroFromSession(latest);
    if (!macro) return 'That session had no reusable steps.';
    await saveMacro(macro);
    return `Saved macro **${macro.name}** (${macro.steps.length} steps). Say "${macro.trigger}" to replay it.`;
  }

  if (/\b(?:delete|remove|forget)\b.*\bmacros?\b/.test(lower)) {
    const macros = await loadMacros();
    if (!macros.length) return 'No macros saved yet.';
    const named = macros.find((m) => lower.includes(m.name.toLowerCase()) || lower.includes(m.trigger.toLowerCase()));
    if (!named) return `Which macro? I have: ${macros.map((m) => m.name).join(', ')}.`;
    await deleteMacro(named.id);
    return `Deleted macro **${named.name}**.`;
  }

  // Automation guard controls: halt / resume / status
  if (/\b(?:halt|pause|stop)\b.*\b(?:automation|guard|run)\b/.test(lower)) {
    const ok = await haltAutomation();
    return ok ? 'Automation halted. Say "resume automation" to continue.' : 'Automation is not running on this device.';
  }

  if (/\b(?:resume|continue|unpause)\b.*\b(?:automation|guard|run)\b/.test(lower)) {
    const ok = await resumeAutomation();
    return ok ? 'Automation resumed.' : 'Automation is not running on this device.';
  }

  if (/\b(?:automation|guard)\b.*\b(?:status|state)\b/.test(lower)) {
    const state = await getAutomationGuardState();
    if (!state) return 'The automation guard is only available on an Android build with the Pulse service enabled.';
    const lines = [
      `**Automation guard** · ${state.paused ? '⏸ paused' : '▶ running'}`,
      `- HUD: ${state.hudVisible ? 'visible' : 'hidden'}`,
      `- Repeat count: ${state.repeatActionCount}${state.lastActionSignature ? ` (${state.lastActionSignature})` : ''}`,
      state.lastLoopGuardHit ? `- Loop guard tripped: ${state.lastLoopGuardHit}` : '- Loop guard: clear',
    ];
    return lines.join('\n');
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Main Local Agent Entry Point                                       */
/* ------------------------------------------------------------------ */

export async function runLocalAgent(
  input: string,
  ctx: {
    profile: UserProfile;
    memory: MemoryOps;
    reminders: Reminder[];
    knowledge: RagChunk[];
    workflows: AutomationWorkflow[];
    history?: ChatMessage[];
    attachment?: Attachment;
    webEnabled?: boolean;
    voice?: boolean;
    source?: 'agent' | 'handsfree';
  },
): Promise<LocalAgentResponse> {
  const source = ctx.source || 'agent';
  const session = newSession('agent_turn', source);
  const startedAt = Date.now();
  const control = { skipPersist: false };

  // The tactical HUD mirrors what the native layer is doing right now.
  await showTacticalHUD('PULSE · working').catch(() => undefined);

  try {
    const res = await runLocalAgentCore(input, ctx, session, control);
    if (!control.skipPersist) {
      await appendSession(finishSession(session, 'completed')).catch(() => undefined);
    }
    return res;
  } catch (e: any) {
    session.steps.push(
      makeStepLog('command', {
        query: input,
        status: 'error',
        detail: e?.message || 'Agent turn failed.',
        latencyMs: Date.now() - startedAt,
      }),
    );
    await appendSession(finishSession(session, 'error')).catch(() => undefined);
    throw e;
  } finally {
    await hideTacticalHUD().catch(() => undefined);
  }
}

async function runLocalAgentCore(
  input: string,
  ctx: {
    profile: UserProfile;
    memory: MemoryOps;
    reminders: Reminder[];
    knowledge: RagChunk[];
    workflows: AutomationWorkflow[];
    history?: ChatMessage[];
    attachment?: Attachment;
    webEnabled?: boolean;
    voice?: boolean;
    source?: 'agent' | 'handsfree';
  },
  session: SessionLog,
  control: { skipPersist: boolean },
): Promise<LocalAgentResponse> {
  const q = resolveFollowUp(input.trim(), ctx.history || []);
  const lower = q.toLowerCase();
  const firstName = ctx.profile.name ? ctx.profile.name.split(' ')[0] : '';
  const startedAt = Date.now();
  const mark = (actionType: ActionType, detail: string, status: StepStatus = 'done', query?: string) => {
    session.steps.push(
      makeStepLog(actionType, { query, status, detail, latencyMs: Date.now() - startedAt }),
    );
  };

  // 0. Attachment handling (100% local, never hits external quota)
  if (ctx.attachment) {
    mark('command', 'Analyzed attachment locally.', 'done', q);
    return analyzeAttachmentLocally(ctx.attachment, q);
  }

  // 0b. Session-log commands: inspect recorded sessions, save/replay macros
  const logCmd = await handleSessionLogCommand(q).catch(() => null);
  if (logCmd) {
    mark('command', 'Handled session-log command.', 'done', q);
    return { handled: true, text: logCmd };
  }

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
      // The automation engine persists its own detailed session; don't double-log.
      control.skipPersist = true;
      return {
        handled: true,
        text: auto.summary,
        actions: auto.actions.length ? auto.actions : undefined,
        reminder: auto.reminder,
      };
    }
  }

  // 2. Instant device commands (memory, reminders, open apps, call, sms, email)
  const localCmd = await runLocalCommand(q, { apiKey: '', memory: ctx.memory }).catch(() => null);
  if (localCmd) {
    mark('command', localCmd.reply, 'done', q);
    return {
      handled: true,
      text: localCmd.reply,
      reminder: localCmd.reminder,
    };
  }

  // 3. List workflows
  if (/\b(?:list|show|what\s+are)\s+(?:my\s+)?(?:workflows|automations|routines|skills)\b/i.test(lower)) {
    const list = ctx.workflows.map((w) => `- **${w.name}** (say "${w.trigger}"): ${w.description}`).join('\n');
    mark('command', `Listed ${ctx.workflows.length} workflow(s).`, 'done', q);
    return { handled: true, text: `Here are your multi-step automations:\n${list}` };
  }

  // 4. List reminders
  if (/\b(?:list|show|check|what\s+are|any)\s+(?:my\s+)?reminders?\b/i.test(lower)) {
    mark('command', `Listed ${ctx.reminders.length} reminder(s).`, 'done', q);
    if (!ctx.reminders.length) {
      return { handled: true, text: 'You have no upcoming reminders right now. Just say "remind me at 6pm to..." whenever you want to add one.' };
    }
    const lines = ctx.reminders.slice(0, 10).map((r) => `- **${r.title}** · ${describeWhen(r)}`);
    return { handled: true, text: `Here are your upcoming reminders:\n${lines.join('\n')}` };
  }

  // 5. Profile / identity lookup
  if (/\b(?:who\s+am\s+i|my\s+profile|my\s+details|my\s+email|my\s+phone|my\s+address|what\s+is\s+my\s+name)\b/i.test(lower)) {
    const p = ctx.profile;
    const parts = [
      p.name ? `your name is **${p.name}**` : '',
      p.address ? `you're based in **${p.address}**` : '',
      p.email ? `email is **${p.email}**` : '',
      p.phone ? `phone is **${p.phone}**` : '',
    ].filter(Boolean);
    return {
      handled: true,
      text: parts.length ? `From your profile, ${parts.join(', ')}.` : 'Your profile is blank right now—tap your Profile button at the top to fill it in.',
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
    return { handled: true, text: `It's **${formatted} IST**.` };
  }

  // 7. Math & Unit conversions
  const math = tryEvalMath(q);
  if (math) return { handled: true, text: math };

  // 8. Natural conversational small talk & human-like interaction
  if (/^(?:hi|hello|hey|namaste|yo|hola|good\s+(?:morning|afternoon|evening|night))\b/i.test(lower)) {
    const hour = new Date().getHours();
    const tod = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
    const greetings = [
      `Hey${firstName ? ` ${firstName}` : ''}! Good ${tod}. How's your day going? What can we tackle together?`,
      `Hi${firstName ? ` ${firstName}` : ''}! Ready whenever you are—want to check something, run a workflow, or just chat?`,
      `Hello${firstName ? `, ${firstName}` : ''}! Good to hear from you. What's on your mind?`,
    ];
    return { handled: true, text: pick(greetings) };
  }

  if (/\b(?:how\s+are\s+you|how's\s+it\s+going|how\s+do\s+you\s+do|what's\s+up|wassup)\b/i.test(lower)) {
    return {
      handled: true,
      text: pick([
        `I'm doing great${firstName ? `, ${firstName}` : ''}, thanks for asking! Everything's running smoothly on-device. How are you doing today?`,
        `Doing awesome and running fast—zero limits! How's your day treating you?`,
      ]),
    };
  }

  if (/^(?:thanks|thank\s+you|thx|ty|appreciate\s+it|awesome|nice|great|cool)\b/i.test(lower)) {
    return {
      handled: true,
      text: pick([
        `Anytime${firstName ? `, ${firstName}` : ''}! Let me know if you need anything else.`,
        `You're welcome! Just say the word whenever you need a hand.`,
        `Happy to help! What's next?`,
      ]),
    };
  }

  if (/\b(?:who\s+are\s+you|what\s+is\s+your\s+name|tell\s+me\s+about\s+yourself)\b/i.test(lower)) {
    return {
      handled: true,
      text: `I'm Pulse, your personal assistant built right into your phone—no external API keys or rate limits. I can chat, look up live weather and facts, run multi-step workflows, manage your reminders and memories, and open your apps.`,
    };
  }

  if (/\b(?:tell\s+me\s+a\s+joke|make\s+me\s+laugh|joke)\b/i.test(lower)) {
    return {
      handled: true,
      text: pick([
        `Why do programmers prefer dark mode? Because light attracts bugs!`,
        `A SQL query walks into a bar, walks up to two tables, and asks: "Can I join you?"`,
        `Why did the developer go broke? Because they used up all their cache!`,
      ]),
    };
  }

  if (/\b(?:what\s+can\s+you\s+do|help|capabilities|features)\b/i.test(lower)) {
    return {
      handled: true,
      text: [
        `I run on Pulse's own engine with zero API keys or usage caps. You can ask me naturally to:`,
        `- **Look up facts & weather:** "Weather in Karimnagar", "Who is Nikola Tesla?", "Define serendipity", "100 USD to INR"`,
        `- **Run multi-step workflows:** "Morning briefing", "Open YouTube and search Telugu songs, then remind me at 6pm to stretch"`,
        `- **Remember & remind:** "Remember I'm vegetarian", "Remind me in 20 minutes to call Amma"`,
        `- **Search your notes & calculate:** Ask about your saved notes or type math/unit conversions`,
      ].join('\n'),
    };
  }

  // 9. Directions / Maps quick action
  const mapMatch = q.match(/(?:directions?\s+to|navigate\s+to|take\s+me\s+to|how\s+(?:do\s+i|to)\s+get\s+to|find\s+on\s+maps?|places?\s+near)\s+(.+)$/i);
  if (mapMatch) {
    const place = mapMatch[1].trim();
    mark('maps', `Opened Maps for "${place}".`, 'done', q);
    return {
      handled: true,
      text: `Sure—tap below to open **${place}** in Google Maps.`,
      actions: [{ type: 'maps', label: `Maps: ${place}`, query: place }],
    };
  }

  // 10. On-device Knowledge Vault / Saved Notes + Memories search
  const rag = ctx.knowledge.length ? buildAgenticRagContext(q, ctx.knowledge, 3) : { results: [], contextBlock: '' };
  const memHits = ctx.memory.list.filter((m) => {
    const words = lower.split(/\s+/).filter((w) => w.length >= 3);
    return words.some((w) => m.text.toLowerCase().includes(w));
  });
  if (rag.results.length > 0 || memHits.length > 0) {
    mark('knowledge', `Found ${rag.results.length} knowledge hit(s) and ${memHits.length} memory hit(s).`, 'done', q);
    const sections: string[] = [];
    if (rag.results.length > 0) {
      sections.push(rag.results.map((r) => `**${r.chunk.title}**\n${r.chunk.content}`).join('\n\n'));
    }
    if (memHits.length > 0) {
      sections.push(`From what I remember about you:\n${memHits.slice(0, 4).map((m) => `- ${m.text}`).join('\n')}`);
    }
    return { handled: true, text: sections.join('\n\n') };
  }

  // 11. Free Open-Web Live Lookups (Weather, Currency, Dictionary, Wikipedia, DuckDuckGo)
  if (ctx.webEnabled !== false) {
    const wxMatch = q.match(/\b(?:weather|temperature|forecast|rain)\s+(?:in|at|for)\s+([a-zA-Z\s]{2,40})/i);
    if (wxMatch) {
      mark('web_lookup', `Fetched weather for "${wxMatch[1].trim()}".`, 'done', q);
      const wx = await fetchWeather(wxMatch[1].trim());
      if (wx) return wx;
    } else if (/\b(?:weather|temperature|forecast)\b/i.test(lower)) {
      const city = ctx.profile.address?.split(',')[0]?.trim() || 'Hyderabad';
      mark('web_lookup', `Fetched weather for "${city}".`, 'done', q);
      const wx = await fetchWeather(city);
      if (wx) return wx;
    }

    const curMatch = q.match(/(\d+(?:\.\d+)?)\s*(usd|inr|eur|gbp|aud|cad|jpy|aed|dollars?|rupees?|euros?|pounds?)\s+(?:to|in)\s+(usd|inr|eur|gbp|aud|cad|jpy|aed|dollars?|rupees?|euros?|pounds?)/i);
    if (curMatch) {
      const norm = (s: string) =>
        s.toLowerCase().startsWith('dollar') ? 'USD' : s.toLowerCase().startsWith('rupee') ? 'INR' : s.toLowerCase().startsWith('euro') ? 'EUR' : s.toLowerCase().startsWith('pound') ? 'GBP' : s.toUpperCase();
      mark('web_lookup', `Fetched currency conversion.`, 'done', q);
      const res = await fetchCurrency(parseFloat(curMatch[1]), norm(curMatch[2]), norm(curMatch[3]));
      if (res) return res;
    }

    const defMatch = q.match(/^(?:define|meaning\s+of|what\s+does\s+(.+?)\s+mean)\s*([a-zA-Z-]+)?/i);
    if (defMatch) {
      const word = (defMatch[1] || defMatch[2] || '').trim();
      if (word && !/\s/.test(word)) {
        mark('web_lookup', `Fetched definition for "${word}".`, 'done', q);
        const res = await fetchDefinition(word);
        if (res) return res;
      }
    }

    const wiki = await fetchOpenKnowledge(q);
    if (wiki) {
      mark('web_lookup', `Fetched open knowledge result.`, 'done', q);
      return wiki;
    }
  }

  // 12. Natural conversational fallback with helpful web search action
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  mark('web', `Searched Google for "${q}".`, 'done', q);
  return {
    handled: true,
    text: ctx.voice
      ? `I heard "${q}". I don't have an exact offline answer for that yet, but you can ask me about weather, facts, reminders, workflows, or tell me what app to open.`
      : `I don't have a direct offline answer for "${q}", but you can search it on Google or ask me to open it in the Computer tab.`,
    actions: [{ type: 'web', label: 'Search Google', url: searchUrl }],
  };
}
