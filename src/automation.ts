/*
 * Pulse OS — Multi-Step Automation Skill Engine
 * Executes compound natural-language commands and saved multi-step workflows
 * completely on-device without requiring any third-party API key.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Linking, Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import { parsePulseVoiceCommand } from '../pulseFeatures';
import { ActionLink, openApp, runOpenIntent } from './actions';
import { makeMemory, MemoryItem, parseMemoryCommand, toMemoryText } from './memory';
import { describeWhen, isReminderRequest, parseReminderLocal, Reminder, ReminderDraft } from './reminders';

const STORAGE_WORKFLOWS = 'pulseos.workflows.v1';

export type WorkflowStepKind =
  | 'open_app'
  | 'open_setting'
  | 'memory_add'
  | 'reminder_create'
  | 'briefing'
  | 'maps_query'
  | 'command';

export type WorkflowStep = {
  id: string;
  kind: WorkflowStepKind;
  label: string;
  target?: string;
  query?: string;
};

export type AutomationWorkflow = {
  id: string;
  name: string;
  trigger: string;
  description: string;
  builtin?: boolean;
  steps: WorkflowStep[];
  createdAt: number;
};

export type StepExecutionLog = {
  label: string;
  status: 'done' | 'needs_confirm' | 'skipped' | 'error';
  detail: string;
};

export type AutomationRunResult = {
  workflowName: string;
  summary: string;
  logs: StepExecutionLog[];
  reminder?: ReminderDraft;
  actions: ActionLink[];
};

export const DEFAULT_WORKFLOWS: AutomationWorkflow[] = [
  {
    id: 'wf_morning',
    name: 'Morning Briefing',
    trigger: 'morning briefing',
    description: 'Checks time, upcoming reminders, and key saved memories.',
    builtin: true,
    createdAt: 1700000001000,
    steps: [
      { id: 's1', kind: 'briefing', label: 'Compile time, reminders & memory briefing' },
    ],
  },
  {
    id: 'wf_focus',
    name: 'Study & Focus Mode',
    trigger: 'focus mode',
    description: 'Sets a 45-minute break reminder and opens Display settings.',
    builtin: true,
    createdAt: 1700000002000,
    steps: [
      { id: 's1', kind: 'reminder_create', label: 'Set 45-minute focus break reminder', query: 'in 45 minutes take a focus break' },
      { id: 's2', kind: 'open_setting', label: 'Open Display settings', target: 'android.settings.DISPLAY_SETTINGS' },
    ],
  },
  {
    id: 'wf_commute',
    name: 'Quick Commute',
    trigger: 'commute check',
    description: 'Opens Maps for traffic check and readies Spotify.',
    builtin: true,
    createdAt: 1700000003000,
    steps: [
      { id: 's1', kind: 'maps_query', label: 'Open Maps traffic', query: 'traffic near me' },
      { id: 's2', kind: 'open_app', label: 'Open Spotify', target: 'spotify' },
    ],
  },
  {
    id: 'wf_network',
    name: 'Connectivity Check',
    trigger: 'check network',
    description: 'Opens Wi-Fi settings so you can verify your connection.',
    builtin: true,
    createdAt: 1700000004000,
    steps: [
      { id: 's1', kind: 'open_setting', label: 'Open Wi-Fi settings', target: 'android.settings.WIFI_SETTINGS' },
    ],
  },
];

export async function loadWorkflows(): Promise<AutomationWorkflow[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_WORKFLOWS);
    if (!raw) {
      await AsyncStorage.setItem(STORAGE_WORKFLOWS, JSON.stringify(DEFAULT_WORKFLOWS));
      return DEFAULT_WORKFLOWS;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_WORKFLOWS;
    return parsed;
  } catch {
    return DEFAULT_WORKFLOWS;
  }
}

export async function saveWorkflows(list: AutomationWorkflow[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_WORKFLOWS, JSON.stringify(list.slice(0, 40)));
}

/** Splits compound instructions like "open youtube and search music, then remind me at 6pm to stretch". */
export function splitCompoundClauses(input: string): string[] {
  const normalized = input
    .replace(/\s*;\s*/g, ' || ')
    .replace(/,?\s+\band\s+then\b\s+/gi, ' || ')
    .replace(/,?\s+\bthen\b\s+/gi, ' || ')
    .replace(/,?\s+\bafter\s+that\b\s+/gi, ' || ');
  const parts = normalized
    .split('||')
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  if (parts.length > 1) return parts;

  // Also split "remember X and remind me Y" or "open X and remind me Y"
  const andMatch = input.match(/^(.+?)\s+and\s+((?:remind\s+me|remember\s+|open\s+|call\s+|message\s+|text\s+|whatsapp\s+).+)$/i);
  if (andMatch) {
    return [andMatch[1].trim(), andMatch[2].trim()];
  }
  return [input.trim()];
}

export function looksLikeAutomation(input: string, workflows: AutomationWorkflow[]): boolean {
  const lower = input.trim().toLowerCase();
  if (/^(?:run|execute|start|trigger)\s+(?:workflow|automation|routine|skill)\b/i.test(lower)) return true;
  if (workflows.some((w) => lower === w.trigger.toLowerCase() || lower === w.name.toLowerCase() || lower.includes(`run ${w.trigger.toLowerCase()}`))) {
    return true;
  }
  return splitCompoundClauses(input).length >= 2;
}

export async function executeAutomation(
  input: string,
  ctx: {
    workflows: AutomationWorkflow[];
    memories: MemoryItem[];
    reminders: Reminder[];
    addMemory: (items: MemoryItem[]) => void;
    userName?: string;
  },
): Promise<AutomationRunResult | null> {
  const lower = input.trim().toLowerCase();

  // 1. Match saved workflow by name or trigger
  const matchedWf = ctx.workflows.find((w) => {
    const t = w.trigger.toLowerCase();
    const n = w.name.toLowerCase();
    return (
      lower === t ||
      lower === n ||
      lower === `run ${t}` ||
      lower === `start ${t}` ||
      lower === `run ${n}` ||
      lower.includes(t)
    );
  });

  if (matchedWf) {
    return runWorkflowSteps(matchedWf.name, matchedWf.steps, ctx);
  }

  // 2. Parse compound multi-step natural language command
  const clauses = splitCompoundClauses(input);
  if (clauses.length < 2) return null;

  const steps: WorkflowStep[] = clauses.map((c, idx) => ({
    id: `dyn_${idx}`,
    kind: 'command',
    label: c,
    query: c,
  }));

  return runWorkflowSteps('Multi-Step Automation', steps, ctx);
}

export async function runWorkflowSteps(
  workflowName: string,
  steps: WorkflowStep[],
  ctx: {
    memories: MemoryItem[];
    reminders: Reminder[];
    addMemory: (items: MemoryItem[]) => void;
    userName?: string;
  },
): Promise<AutomationRunResult> {
  const logs: StepExecutionLog[] = [];
  const actions: ActionLink[] = [];
  let pendingReminder: ReminderDraft | undefined;

  for (const step of steps) {
    try {
      if (step.kind === 'briefing') {
        const now = new Date().toLocaleString('en-IN', {
          weekday: 'long',
          day: 'numeric',
          month: 'short',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });
        const remCount = ctx.reminders.length;
        const nextRem = ctx.reminders[0] ? `Next: "${ctx.reminders[0].title}" (${describeWhen(ctx.reminders[0])})` : 'No upcoming reminders';
        logs.push({
          label: step.label,
          status: 'done',
          detail: `${now} IST · ${remCount} reminder(s). ${nextRem}. ${ctx.memories.length} saved memories.`,
        });
        continue;
      }

      if (step.kind === 'open_setting' && step.target) {
        if (Platform.OS === 'android') {
          await IntentLauncher.startActivityAsync(step.target).catch(() => Linking.openSettings());
        } else {
          await Linking.openSettings();
        }
        logs.push({ label: step.label, status: 'done', detail: 'Opened system settings screen.' });
        continue;
      }

      if (step.kind === 'maps_query' && step.query) {
        const q = step.query;
        actions.push({ type: 'maps', label: `Maps: ${q}`, query: q });
        await Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`).catch(() => undefined);
        logs.push({ label: step.label, status: 'done', detail: `Opened Maps for "${q}".` });
        continue;
      }

      if (step.kind === 'open_app' && step.target) {
        const r = await openApp(step.target, step.query || '');
        logs.push({ label: step.label, status: r.ok ? 'done' : 'error', detail: r.msg });
        continue;
      }

      if (step.kind === 'memory_add' && step.query) {
        const m = makeMemory(toMemoryText(step.query), 'other', 'manual');
        if (m) {
          ctx.addMemory([m]);
          logs.push({ label: step.label, status: 'done', detail: `Saved: ${m.text}` });
        } else {
          logs.push({ label: step.label, status: 'skipped', detail: 'Skipped sensitive or empty memory.' });
        }
        continue;
      }

      if (step.kind === 'reminder_create' && step.query) {
        const draft = parseReminderLocal(step.query);
        if (draft) {
          pendingReminder = draft;
          logs.push({ label: step.label, status: 'needs_confirm', detail: `Ready to set: ${draft.title} (${describeWhen(draft)})` });
        } else {
          logs.push({ label: step.label, status: 'skipped', detail: 'Could not parse reminder time locally.' });
        }
        continue;
      }

      // Dynamic natural language clause
      const text = (step.query || step.label).trim();
      const mc = parseMemoryCommand(text);
      if (mc && mc.kind === 'remember') {
        const m = makeMemory(toMemoryText(mc.text), 'other', 'manual');
        if (m) {
          ctx.addMemory([m]);
          logs.push({ label: step.label, status: 'done', detail: `Saved memory: ${m.text}` });
        } else {
          logs.push({ label: step.label, status: 'skipped', detail: 'Skipped (sensitive or too long).' });
        }
        continue;
      }

      if (isReminderRequest(text)) {
        const draft = parseReminderLocal(text);
        if (draft) {
          pendingReminder = draft;
          logs.push({ label: step.label, status: 'needs_confirm', detail: `Confirm reminder: ${draft.title} (${describeWhen(draft)})` });
        } else {
          logs.push({ label: step.label, status: 'skipped', detail: 'Specify a time like "at 6pm" or "in 20 minutes".' });
        }
        continue;
      }

      const dirMatch = text.match(/(?:directions?\s+to|navigate\s+to|maps?\s+for)\s+(.+)$/i);
      if (dirMatch) {
        const q = dirMatch[1].trim();
        actions.push({ type: 'maps', label: `Directions: ${q}`, query: q });
        await Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`).catch(() => undefined);
        logs.push({ label: step.label, status: 'done', detail: `Opened Maps for "${q}".` });
        continue;
      }

      const intent = parsePulseVoiceCommand(text, []);
      if (intent.type !== 'CONVERSATION') {
        const res = await runOpenIntent(intent).catch(() => null);
        if (res) {
          logs.push({ label: step.label, status: 'done', detail: res });
          continue;
        }
      }

      logs.push({ label: step.label, status: 'skipped', detail: 'No matching device action for this step.' });
    } catch (e: any) {
      logs.push({ label: step.label, status: 'error', detail: e?.message || 'Step failed.' });
    }
  }

  const doneCount = logs.filter((l) => l.status === 'done' || l.status === 'needs_confirm').length;
  const lines = logs.map((l, i) => `${i + 1}. ${l.status === 'done' ? '✓' : l.status === 'needs_confirm' ? '⏰' : '•'} ${l.detail}`);
  return {
    workflowName,
    summary: `**${workflowName}** (${doneCount}/${logs.length} steps ready)\n${lines.join('\n')}`,
    logs,
    reminder: pendingReminder,
    actions,
  };
}
