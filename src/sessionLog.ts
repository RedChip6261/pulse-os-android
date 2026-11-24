/*
 * Pulse OS — Session & Action Logging Persistence
 * Records full automation sessions, per-step action logs (action type, target, status, latency ms, token usage),
 * error/loop-guard events, and reusable macro sequences. Bounded retention via AsyncStorage.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const STORAGE_SESSION_LOG = 'pulseos.session_log.v1';
export const STORAGE_MACROS = 'pulseos.macros.v1';

const MAX_SESSIONS = 50;
const MAX_MACROS = 30;

export type ActionType =
  | 'open_app'
  | 'open_setting'
  | 'maps_query'
  | 'maps_directions'
  | 'command'
  | 'memory_add'
  | 'reminder_create'
  | 'briefing'
  | 'tap'
  | 'type'
  | 'scroll'
  | 'click'
  | 'launch_app'
  | 'wait'
  | 'proceed'
  | 'maps'
  | 'knowledge'
  | 'web_lookup'
  | 'web';

export type StepStatus = 'done' | 'needs_confirm' | 'skipped' | 'error';

export type StepLog = {
  stepId: string;
  actionType: ActionType;
  target?: string;
  query?: string;
  status: StepStatus;
  detail?: string;
  latencyMs?: number;
  tokenUsage?: number;
};

export type SessionStatus = 'running' | 'completed' | 'error' | 'halted';

export type SessionLog = {
  id: string;
  startedAt: number;
  endedAt?: number;
  workflowName: string;
  source: 'workflow' | 'agent' | 'bridge' | 'handsfree';
  status: SessionStatus;
  steps: StepLog[];
  summary: string;
  error?: string;
  loopGuardHit?: boolean;
  totalTokens?: number;
};

export type LoopGuardEvent = {
  id: string;
  at: number;
  sessionId?: string;
  action: string;
  payload?: string;
  repeatCount: number;
  detail: string;
};

export type MacroSequence = {
  id: string;
  name: string;
  trigger: string;
  steps: { actionType: ActionType; target?: string; query?: string; label: string }[];
  sourceSessionId?: string;
  createdAt: number;
  lastUsedAt?: number;
  useCount: number;
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ------------------------------ Sessions ------------------------------ */

export async function loadSessionLogs(): Promise<SessionLog[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_SESSION_LOG);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveSessionLogs(list: SessionLog[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_SESSION_LOG, JSON.stringify(list.slice(0, MAX_SESSIONS)));
}

/** Inserts or replaces a session, newest first, keeping the store bounded. */
export async function appendSession(entry: SessionLog): Promise<void> {
  try {
    const list = await loadSessionLogs();
    const idx = list.findIndex((s) => s.id === entry.id);
    if (idx >= 0) list[idx] = entry;
    else list.unshift(entry);
    list.sort((a, b) => b.startedAt - a.startedAt);
    await saveSessionLogs(list);
  } catch {}
}

export function newSession(workflowName: string, source: SessionLog['source'] = 'workflow'): SessionLog {
  return {
    id: uid(),
    startedAt: Date.now(),
    workflowName,
    source,
    status: 'running',
    steps: [],
    summary: '',
  };
}

export function finishSession(entry: SessionLog, status: SessionLog['status'] = 'completed'): SessionLog {
  const done = entry.steps.filter((s) => s.status === 'done').length;
  const failed = entry.steps.filter((s) => s.status === 'error').length;
  const tokens = entry.steps.reduce((sum, s) => sum + (s.tokenUsage || 0), 0);
  return {
    ...entry,
    endedAt: Date.now(),
    status,
    totalTokens: tokens || undefined,
    summary:
      `${entry.steps.length} steps · ${done} done` +
      (failed ? ` · ${failed} failed` : '') +
      (entry.loopGuardHit ? ' · loop guard tripped' : '') +
      (tokens ? ` · ${tokens} tokens` : ''),
  };
}

export function makeStepLog(
  actionType: ActionType,
  opts: {
    target?: string;
    query?: string;
    status?: StepStatus;
    detail?: string;
    latencyMs?: number;
    tokenUsage?: number;
  } = {},
): StepLog {
  return {
    stepId: uid(),
    actionType,
    target: opts.target,
    query: opts.query,
    status: opts.status || 'done',
    detail: opts.detail,
    latencyMs: opts.latencyMs,
    tokenUsage: opts.tokenUsage,
  };
}

/* ------------------------------ Loop guard ------------------------------ */

export async function recordLoopGuardEvent(event: Omit<LoopGuardEvent, 'id' | 'at'>): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_SESSION_LOG);
    const parsed = raw ? JSON.parse(raw) : [];
    const list: SessionLog[] = Array.isArray(parsed) ? parsed : [];
    const target = event.sessionId ? list.find((s) => s.id === event.sessionId) : list[0];
    if (target) {
      target.loopGuardHit = true;
      target.status = 'halted';
      target.steps.push(
        makeStepLog('command', {
          status: 'error',
          detail: `Loop guard tripped on ${event.action} (x${event.repeatCount})`,
          target: event.action,
        }),
      );
      await saveSessionLogs(list);
    }
  } catch {}
}

/* ------------------------------ Macros ------------------------------ */

export async function loadMacros(): Promise<MacroSequence[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_MACROS);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveMacros(list: MacroSequence[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_MACROS, JSON.stringify(list.slice(0, MAX_MACROS)));
}

export async function saveMacro(macro: MacroSequence): Promise<void> {
  const list = await loadMacros();
  const idx = list.findIndex((m) => m.id === macro.id || m.trigger.toLowerCase() === macro.trigger.toLowerCase());
  if (idx >= 0) list[idx] = macro;
  else list.unshift(macro);
  await saveMacros(list);
}

export async function deleteMacro(id: string): Promise<void> {
  const list = await loadMacros();
  await saveMacros(list.filter((m) => m.id !== id));
}

/** Turns a completed session into a reusable macro (only fully successful steps qualify). */
export function macroFromSession(entry: SessionLog, name?: string, trigger?: string): MacroSequence | null {
  const steps = entry.steps.filter((s) => s.status === 'done' || s.status === 'needs_confirm');
  if (!steps.length) return null;
  return {
    id: uid(),
    name: name?.trim() || entry.workflowName,
    trigger: trigger?.trim() || entry.workflowName.toLowerCase(),
    steps: steps.map((s) => ({
      actionType: s.actionType,
      target: s.target,
      query: s.query,
      label: s.detail || s.actionType,
    })),
    sourceSessionId: entry.id,
    createdAt: Date.now(),
    useCount: 0,
  };
}

/** Finds a saved macro whose trigger matches the user's phrasing. */
export function matchMacro(macros: MacroSequence[], input: string): MacroSequence | null {
  const lower = input.trim().toLowerCase();
  if (!lower) return null;
  return (
    macros.find((m) => lower === m.trigger.toLowerCase()) ||
    macros.find((m) => lower.includes(m.trigger.toLowerCase()) && m.trigger.length >= 3) ||
    null
  );
}

/* ------------------------------ Reporting ------------------------------ */

export function sessionStats(list: SessionLog[]) {
  const steps = list.reduce((n, s) => n + s.steps.length, 0);
  const errors = list.reduce((n, s) => n + s.steps.filter((x) => x.status === 'error').length, 0);
  const tokens = list.reduce((n, s) => n + (s.totalTokens || 0), 0);
  const latencies = list.flatMap((s) => s.steps.map((x) => x.latencyMs || 0)).filter((n) => n > 0);
  const avgLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  return { sessions: list.length, steps, errors, tokens, avgLatency };
}

/* --------------------------- Bridge session import --------------------------- */

/**
 * Converts a native bridge session (as persisted by the Kotlin accessibility
 * service) into the shared SessionLog shape so both layers report uniformly.
 */
export function bridgeSessionToLog(raw: string): SessionLog | null {
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    const steps: StepLog[] = Array.isArray(j.steps)
      ? j.steps.map((s: any) => ({
          stepId: uid(),
          actionType: (s.actionType || 'command') as ActionType,
          target: s.target || undefined,
          query: s.query || undefined,
          status: (s.status || 'done') as StepStatus,
          detail: s.detail || undefined,
          latencyMs: Number(s.latencyMs || 0),
        }))
      : [];
    return {
      id: String(j.id || uid()),
      startedAt: Number(j.startedAt || Date.now()),
      endedAt: Number(j.endedAt || Date.now()),
      workflowName: String(j.workflowName || 'bridge_session'),
      source: 'bridge',
      status: (j.status || 'completed') as SessionStatus,
      steps,
      summary: `${steps.length} steps · ${steps.filter((s) => s.status === 'done').length} done`,
      error: j.error || undefined,
      loopGuardHit: !!j.loopGuardHit,
    };
  } catch {
    return null;
  }
}

/** Imports a native bridge session into the shared session store. */
export async function importBridgeSession(raw: string): Promise<SessionLog | null> {
  const entry = bridgeSessionToLog(raw);
  if (!entry) return null;
  await appendSession(entry);
  return entry;
}

/**
 * Pulls the last session recorded by the native accessibility bridge and merges
 * it into the shared store. Returns null when the native module is unavailable.
 */
export async function syncBridgeSession(): Promise<SessionLog | null> {
  try {
    const { NativeModules } = require('react-native');
    const bridge = NativeModules?.PulseBridge;
    if (!bridge?.getAutomationResult) return null;
    const result = await bridge.getAutomationResult();
    const raw = result?.bridgeSession;
    if (!raw) return null;
    const entry = bridgeSessionToLog(raw);
    if (!entry) return null;
    const list = await loadSessionLogs();
    if (list.some((s) => s.id === entry.id)) return entry;
    await appendSession(entry);
    return entry;
  } catch {
    return null;
  }
}
