/*
 * Pulse OS — Hark Pro Home Panels, Proactive Cards & Projects Workspace
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ProactiveCard = {
  id: string;
  badge: string;
  title: string;
  subtitle: string;
  actionLabel: string;
  prompt: string;
  kind: 'chat' | 'handoff' | 'project';
};

export type CustomPanelItem = {
  id: string;
  label: string;
  value: string;
  done?: boolean;
};

export type CustomPanel = {
  id: string;
  title: string;
  icon: string;
  subtitle: string;
  type: 'tracker' | 'checklist' | 'feed';
  items: CustomPanelItem[];
  unit?: string;
};

export type ProjectWorkspace = {
  id: string;
  name: string;
  icon: string;
  description: string;
  notes: string[];
  tasks: { id: string; text: string; done: boolean }[];
  updatedAt: number;
};

const STORAGE_PANELS = 'pulseos.hark_panels.v1';
const STORAGE_PROJECTS = 'pulseos.hark_projects.v1';
const STORAGE_DISMISSED = 'pulseos.hark_dismissed.v1';

export const DEFAULT_PROACTIVE_CARDS: ProactiveCard[] = [
  {
    id: 'card-briefing',
    badge: 'PROACTIVE · MORNING',
    title: 'Daily Briefing & Priority Check',
    subtitle: 'Review your schedule, weather, and top priorities for today in one tap.',
    actionLabel: 'Run Briefing',
    prompt: 'Give me my daily briefing with weather, reminders, and top priorities',
    kind: 'chat',
  },
  {
    id: 'card-handoff-deals',
    badge: 'HANDOFF² · LIVE BROWSER',
    title: 'Compare Tech & Headphone Deals',
    subtitle: 'Watch Handoff² open the live browser, search, compare prices, and highlight top options.',
    actionLabel: 'Launch Handoff²',
    prompt: 'Search Amazon for wireless headphones deals',
    kind: 'handoff',
  },
  {
    id: 'card-inbox-zero',
    badge: 'PROJECT · WORKFLOW',
    title: 'Inbox & Task Triage',
    subtitle: 'Organize pending follow-ups, draft quick replies, and clear today’s action items.',
    actionLabel: 'Open Workspace',
    prompt: 'Help me triage my tasks and draft my top follow-up messages for today',
    kind: 'project',
  },
  {
    id: 'card-handoff-video',
    badge: 'HANDOFF² · MEDIA',
    title: 'Find & Watch AI Demos on YouTube',
    subtitle: 'Let the visual browser agent search YouTube and open the top video automatically.',
    actionLabel: 'Watch in Handoff²',
    prompt: 'Open YouTube and search AI assistant demos',
    kind: 'handoff',
  },
];

export const DEFAULT_PANELS: CustomPanel[] = [
  {
    id: 'panel-expenses',
    title: 'Daily Spend & Budget',
    icon: '💳',
    subtitle: 'Live expense tracker · Tap + to log',
    type: 'tracker',
    unit: '₹',
    items: [
      { id: 'e1', label: 'Coffee & Breakfast', value: '180' },
      { id: 'e2', label: 'Metro / Commute', value: '120' },
      { id: 'e3', label: 'Cloud & Tools', value: '450' },
    ],
  },
  {
    id: 'panel-habits',
    title: 'Daily Focus & Workout',
    icon: '⚡',
    subtitle: 'Interactive habit & workout checklist',
    type: 'checklist',
    items: [
      { id: 'h1', label: '30m Morning Workout / Walk', value: 'Done', done: true },
      { id: 'h2', label: 'Deep Work Sprint (90 mins)', value: 'Pending', done: false },
      { id: 'h3', label: 'Review Inbox & Reminders', value: 'Pending', done: false },
    ],
  },
  {
    id: 'panel-ainews',
    title: 'AI & Creator Radar',
    icon: '🌐',
    subtitle: 'Curated topics · Tap any item to explore',
    type: 'feed',
    items: [
      { id: 'n1', label: 'On-Device Autonomous Agents & Handoff² Workflows', value: 'Explore →' },
      { id: 'n2', label: 'Next-Gen Mobile Personal OS & Voice Loops', value: 'Explore →' },
      { id: 'n3', label: 'Creator Automation & Script Pipelines', value: 'Explore →' },
    ],
  },
];

export const DEFAULT_PROJECTS: ProjectWorkspace[] = [
  {
    id: 'proj-inbox',
    name: 'Inbox Zero & Comms',
    icon: '📬',
    description: 'Triage important messages, draft replies, and track follow-ups.',
    notes: [
      'Rule 1: Flag urgent client or team messages first.',
      'Rule 2: Keep drafted replies under 4 sentences.',
    ],
    tasks: [
      { id: 't1', text: 'Review morning priority messages', done: true },
      { id: 't2', text: 'Draft weekly status update', done: false },
    ],
    updatedAt: Date.now(),
  },
  {
    id: 'proj-creator',
    name: 'Creator Studio & Tutorials',
    icon: '🎬',
    description: 'Research topics, outline technical articles, and test code workflows.',
    notes: [
      'Focus on authentic first-person creator workflows and clean formatting.',
    ],
    tasks: [
      { id: 't3', text: 'Outline next technical tutorial post', done: false },
      { id: 't4', text: 'Verify live links and screenshots', done: false },
    ],
    updatedAt: Date.now() - 3600 * 1000,
  },
  {
    id: 'proj-shopping',
    name: 'Smart Shopping & Deals',
    icon: '🛍️',
    description: 'Handoff² price comparisons, wishlists, and product research.',
    notes: [
      'Use Handoff² to compare prices across Amazon and Flipkart before deciding.',
    ],
    tasks: [
      { id: 't5', text: 'Compare wireless headphones under ₹5,000', done: false },
    ],
    updatedAt: Date.now() - 7200 * 1000,
  },
];

export async function loadCustomPanels(): Promise<CustomPanel[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_PANELS);
    if (!raw) return DEFAULT_PANELS;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_PANELS;
  } catch {
    return DEFAULT_PANELS;
  }
}

export async function saveCustomPanels(panels: CustomPanel[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_PANELS, JSON.stringify(panels));
  } catch {}
}

export async function loadProjects(): Promise<ProjectWorkspace[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_PROJECTS);
    if (!raw) return DEFAULT_PROJECTS;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_PROJECTS;
  } catch {
    return DEFAULT_PROJECTS;
  }
}

export async function saveProjects(projects: ProjectWorkspace[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_PROJECTS, JSON.stringify(projects));
  } catch {}
}

export async function loadDismissedCards(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_DISMISSED);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveDismissedCards(ids: string[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_DISMISSED, JSON.stringify(ids));
  } catch {}
}

/**
 * Builds a brand-new live Custom Panel from a natural language description
 * (just like Hark Pro's "Build a new panel — Describe what you want to see").
 */
export function buildPanelFromPrompt(prompt: string): CustomPanel {
  const p = prompt.trim();
  const lower = p.toLowerCase();
  const id = `panel-${Date.now().toString(36)}`;

  if (/\b(expense|spend|budget|money|cost|finance|bill)\b/i.test(lower)) {
    return {
      id,
      title: p.slice(0, 32) || 'Custom Budget Tracker',
      icon: '💰',
      subtitle: 'Built from prompt · Tap + to add entry',
      type: 'tracker',
      unit: '₹',
      items: [
        { id: `${id}-1`, label: 'Initial entry', value: '250' },
      ],
    };
  }

  if (/\b(news|feed|ai|tech|stock|crypto|market|update|weather)\b/i.test(lower)) {
    return {
      id,
      title: p.slice(0, 32) || 'Live Topic Radar',
      icon: '📡',
      subtitle: 'Built from prompt · Tap any row to query Pulse',
      type: 'feed',
      items: [
        { id: `${id}-1`, label: `Latest updates on ${p}`, value: 'Ask →' },
        { id: `${id}-2`, label: `Top trends & analysis for ${p}`, value: 'Ask →' },
      ],
    };
  }

  return {
    id,
    title: p.slice(0, 34) || 'Custom Goal Checklist',
    icon: '✨',
    subtitle: 'Built from prompt · Tap items to toggle',
    type: 'checklist',
    items: [
      { id: `${id}-1`, label: `Step 1: ${p}`, value: 'Pending', done: false },
      { id: `${id}-2`, label: 'Review progress & next actions', value: 'Pending', done: false },
    ],
  };
}
