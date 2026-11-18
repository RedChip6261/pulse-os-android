/*
 * Pulse OS — Core Voice Intent Engine, Knowledge Vault (RAG) & Device Automation
 * Built cleanly from scratch for Pulse OS.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export const STORAGE_SMART_MEMORY = 'pulseos.smart_memory.v1';
export const STORAGE_RAG_INDEX = 'pulseos.rag_knowledge_index.v5';

export type VoiceLanguageMode = 'BILINGUAL_AUTO' | 'en-IN' | 'te-IN';

export type RagCategory =
  | 'playbook'
  | 'user_vault'
  | 'document'
  | 'note'
  | 'web_clip'
  | 'screen_dump'
  | 'task_memory';

export type RagChunk = {
  id: string;
  docId: string;
  title: string;
  category: RagCategory;
  content: string;
  keywords: string[];
  appTag?: string;
  sourceUrl?: string;
  createdAt: number;
};

export type RagSearchResult = {
  chunk: RagChunk;
  score: number;
  matchedTerms: string[];
};

export type PulseIntentType =
  | 'OPEN_APP'
  | 'SEND_MESSAGE'
  | 'CALL_CONTACT'
  | 'READ_EMAILS'
  | 'CREATE_EMAIL'
  | 'SEND_EMAIL'
  | 'DELETE_EMAIL'
  | 'SCROLL'
  | 'CLICK_TEXT'
  | 'SELECT_ITEM'
  | 'PROCEED'
  | 'SEARCH_IN_APP'
  | 'GLOBAL_NAV'
  | 'READ_SCREEN'
  | 'HARDWARE_CONTROL'
  | 'APP_WORKFLOW'
  | 'CONVERSATION';

export interface PulseParsedIntent {
  type: PulseIntentType;
  confidence: number;
  app?: string;
  recipient?: string;
  message?: string;
  subject?: string;
  query?: string;
  direction?: 'down' | 'up' | 'left' | 'right';
  globalAction?: 'back' | 'home' | 'recents' | 'notifications' | 'quick_settings';
  hardwareAction?: 'torch_on' | 'torch_off' | 'volume';
  volumePct?: number;
  platform?: 'whatsapp' | 'sms' | 'telegram' | 'auto';
  spokenAckEn: string;
  spokenAckTe: string;
}

/* -------------------------------------------------------------------------- */
/* App Aliases & Packages                                                     */
/* -------------------------------------------------------------------------- */

export interface AppCatalogEntry {
  id: string;
  name: string;
  icon: string;
  aliases: string[];
  packages: string[];
}

export const PULSE_APP_CATALOG: AppCatalogEntry[] = [
  { id: 'whatsapp', name: 'WhatsApp', icon: '💬', aliases: ['whatsapp', 'whats app', 'wa', 'watsapp'], packages: ['com.whatsapp', 'com.whatsapp.w4b'] },
  { id: 'gmail', name: 'Gmail', icon: '📧', aliases: ['gmail', 'mail', 'email', 'mails', 'emails'], packages: ['com.google.android.gm'] },
  { id: 'youtube', name: 'YouTube', icon: '▶️', aliases: ['youtube', 'yt', 'you tube'], packages: ['com.google.android.youtube'] },
  { id: 'instagram', name: 'Instagram', icon: '📸', aliases: ['instagram', 'insta', 'ig'], packages: ['com.instagram.android', 'com.instagram.lite'] },
  { id: 'telegram', name: 'Telegram', icon: '✈️', aliases: ['telegram', 'tg'], packages: ['org.telegram.messenger', 'org.telegram.messenger.web', 'org.thunderdog.challegram'] },
  { id: 'sms', name: 'Messages', icon: '✉️', aliases: ['sms', 'messages', 'message app', 'text messages'], packages: ['com.google.android.apps.messaging'] },
  { id: 'phone', name: 'Phone', icon: '📞', aliases: ['phone', 'dialer', 'call app'], packages: ['com.google.android.dialer', 'com.android.dialer'] },
  { id: 'chrome', name: 'Chrome', icon: '🌐', aliases: ['chrome', 'browser', 'google chrome'], packages: ['com.android.chrome'] },
  { id: 'maps', name: 'Maps', icon: '🗺️', aliases: ['maps', 'google maps', 'navigation'], packages: ['com.google.android.apps.maps'] },
  { id: 'spotify', name: 'Spotify', icon: '🎵', aliases: ['spotify', 'music'], packages: ['com.spotify.music'] },
  { id: 'blinkit', name: 'Blinkit', icon: '⚡', aliases: ['blinkit', 'grofers'], packages: ['com.grofers.customerapp'] },
  { id: 'zepto', name: 'Zepto', icon: '🥬', aliases: ['zepto'], packages: ['com.zeptoconsumerapp'] },
  { id: 'swiggy', name: 'Swiggy', icon: '🍔', aliases: ['swiggy', 'instamart'], packages: ['in.swiggy.android'] },
  { id: 'zomato', name: 'Zomato', icon: '🍕', aliases: ['zomato'], packages: ['com.application.zomato'] },
  { id: 'flipkart', name: 'Flipkart', icon: '🛒', aliases: ['flipkart', 'fk'], packages: ['com.flipkart.android'] },
  { id: 'amazon', name: 'Amazon', icon: '📦', aliases: ['amazon'], packages: ['in.amazon.mShop.android.shopping', 'com.amazon.mShop.android.shopping'] },
  { id: 'meesho', name: 'Meesho', icon: '🛍️', aliases: ['meesho'], packages: ['com.meesho.supply'] },
  { id: 'uber', name: 'Uber', icon: '🚕', aliases: ['uber'], packages: ['com.ubercab', 'com.ubercab.uberlite'] },
  { id: 'ola', name: 'Ola', icon: '🚖', aliases: ['ola'], packages: ['com.olacabs.customer'] },
  { id: 'rapido', name: 'Rapido', icon: '🛵', aliases: ['rapido'], packages: ['com.rapido.passenger'] },
  { id: 'phonepe', name: 'PhonePe', icon: '🟣', aliases: ['phonepe', 'phone pe'], packages: ['com.phonepe.app'] },
  { id: 'gpay', name: 'Google Pay', icon: '💳', aliases: ['gpay', 'google pay'], packages: ['com.google.android.apps.nbu.paisa.user'] },
  { id: 'paytm', name: 'Paytm', icon: '💠', aliases: ['paytm'], packages: ['net.one97.paytm'] },
  { id: 'calendar', name: 'Calendar', icon: '📅', aliases: ['calendar'], packages: ['com.google.android.calendar'] },
  { id: 'playstore', name: 'Play Store', icon: '▶️', aliases: ['playstore', 'play store'], packages: ['com.android.vending'] },
  { id: 'settings', name: 'Settings', icon: '⚙️', aliases: ['settings', 'device settings'], packages: ['com.android.settings'] },
];

/* -------------------------------------------------------------------------- */
/* PulseVoiceIntentEngine: Zero-Latency Natural Command Parser                */
/* -------------------------------------------------------------------------- */

function stripPolitePrefix(s: string): string {
  return s
    .replace(/^(?:hey\s+pulse|pulse|ok\s+pulse|please|can\s+you|could\s+you|would\s+you|just|kindly|pls)\s+/gi, '')
    .replace(/^(?:please|can\s+you|just)\s+/gi, '')
    .replace(/[.!?]+$/g, '')
    .trim();
}

export function parsePulseVoiceCommand(
  rawInput: string,
  installedApps: { label: string; packageName: string }[] = [],
): PulseParsedIntent {
  const raw = rawInput.trim();
  const clean = stripPolitePrefix(raw);
  const lower = clean.toLowerCase();

  if (!clean) {
    return {
      type: 'CONVERSATION',
      confidence: 0,
      spokenAckEn: '',
      spokenAckTe: '',
    };
  }

  // 1. Hardware Controls (Flashlight / Volume)
  if (/\b(turn\s+on|enable|switch\s+on|on)\s+(?:the\s+)?(?:flashlight|torch|flash)\b/i.test(lower)) {
    return {
      type: 'HARDWARE_CONTROL',
      confidence: 0.98,
      hardwareAction: 'torch_on',
      spokenAckEn: 'Turning on the flashlight.',
      spokenAckTe: 'ఫ్లాష్‌లైట్ ఆన్ చేస్తున్నాను.',
    };
  }
  if (/\b(turn\s+off|disable|switch\s+off|off)\s+(?:the\s+)?(?:flashlight|torch|flash)\b/i.test(lower)) {
    return {
      type: 'HARDWARE_CONTROL',
      confidence: 0.98,
      hardwareAction: 'torch_off',
      spokenAckEn: 'Turning off the flashlight.',
      spokenAckTe: 'ఫ్లాష్‌లైట్ ఆఫ్ చేస్తున్నాను.',
    };
  }
  const volMatch = lower.match(/\b(?:set\s+|change\s+)?volume\s+(?:to\s+)?(\d{1,3})\s*%?\b/i);
  if (volMatch) {
    const pct = Math.min(100, Math.max(0, parseInt(volMatch[1], 10)));
    return {
      type: 'HARDWARE_CONTROL',
      confidence: 0.95,
      hardwareAction: 'volume',
      volumePct: pct,
      spokenAckEn: `Setting volume to ${pct} percent.`,
      spokenAckTe: `వాల్యూమ్ ${pct} శాతానికి పెడుతున్నాను.`,
    };
  }

  // 2. Scroll & Swipe Commands
  if (
    /^(?:scroll\s*down|go\s*down|swipe\s*down|down|move\s*down|kindiki|కిందికి|క్రిందికి)\b/i.test(lower) ||
    /\b(?:scroll\s+down|move\s+down|show\s+below|koncham\s+kindiki)\b/i.test(lower)
  ) {
    return {
      type: 'SCROLL',
      confidence: 0.97,
      direction: 'down',
      spokenAckEn: 'Scrolling down.',
      spokenAckTe: 'కిందికి స్క్రోల్ చేస్తున్నాను.',
    };
  }
  if (
    /^(?:scroll\s*up|go\s*up|swipe\s*up|up|move\s*up|paiki|పైకి)\b/i.test(lower) ||
    /\b(?:scroll\s+up|move\s+up|go\s+back\s+up|koncham\s+paiki)\b/i.test(lower)
  ) {
    return {
      type: 'SCROLL',
      confidence: 0.97,
      direction: 'up',
      spokenAckEn: 'Scrolling up.',
      spokenAckTe: 'పైకి స్క్రోల్ చేస్తున్నాను.',
    };
  }
  if (/^(?:scroll\s*left|swipe\s*left|left)\b/i.test(lower)) {
    return {
      type: 'SCROLL',
      confidence: 0.95,
      direction: 'left',
      spokenAckEn: 'Scrolling left.',
      spokenAckTe: 'ఎడమవైపుకు స్క్రోల్ చేస్తున్నాను.',
    };
  }
  if (/^(?:scroll\s*right|swipe\s*right|right)\b/i.test(lower)) {
    return {
      type: 'SCROLL',
      confidence: 0.95,
      direction: 'right',
      spokenAckEn: 'Scrolling right.',
      spokenAckTe: 'కుడివైపుకు స్క్రోల్ చేస్తున్నాను.',
    };
  }

  // 3. Global Navigation (Back, Home, Recents, Notifications)
  if (/^(?:go\s*back|back|venakki|వెనక్కి)$/i.test(lower)) {
    return {
      type: 'GLOBAL_NAV',
      confidence: 0.98,
      globalAction: 'back',
      spokenAckEn: 'Going back.',
      spokenAckTe: 'వెనక్కి వెళ్తున్నాను.',
    };
  }
  if (/^(?:go\s*home|home\s*screen|home|హోమ్)$/i.test(lower)) {
    return {
      type: 'GLOBAL_NAV',
      confidence: 0.98,
      globalAction: 'home',
      spokenAckEn: 'Going home.',
      spokenAckTe: 'హోమ్ స్క్రీన్‌కు వెళ్తున్నాను.',
    };
  }
  if (/^(?:recent\s*apps|recents|open\s*recents)$/i.test(lower)) {
    return {
      type: 'GLOBAL_NAV',
      confidence: 0.96,
      globalAction: 'recents',
      spokenAckEn: 'Opening recent apps.',
      spokenAckTe: 'రీసెంట్ యాప్స్ ఓపెన్ చేస్తున్నాను.',
    };
  }
  if (/^(?:open\s*notifications|show\s*notifications|notifications)$/i.test(lower)) {
    return {
      type: 'GLOBAL_NAV',
      confidence: 0.96,
      globalAction: 'notifications',
      spokenAckEn: 'Opening notifications.',
      spokenAckTe: 'నోటిఫికేషన్లు ఓపెన్ చేస్తున్నాను.',
    };
  }

  // 4. Read Screen
  if (
    /\b(?:read\s+(?:the\s+|my\s+)?screen|what\s+is\s+on\s+(?:my\s+|the\s+)?screen|స్క్రీన్\s*చదువు)\b/i.test(lower)
  ) {
    return {
      type: 'READ_SCREEN',
      confidence: 0.95,
      spokenAckEn: 'Reading your screen.',
      spokenAckTe: 'స్క్రీన్ చదువుతున్నాను.',
    };
  }

  // 5. Email Actions (Read, Delete, Create, Send)
  if (
    /\b(?:read|check|open|show)\s+(?:my\s+|the\s+|latest\s+)?(?:e?mails?|inbox|gmail)\b/i.test(lower) &&
    !/\b(?:send|create|compose|write|delete|remove)\b/i.test(lower)
  ) {
    return {
      type: 'READ_EMAILS',
      confidence: 0.96,
      app: 'gmail',
      spokenAckEn: 'Opening Gmail to read your emails.',
      spokenAckTe: 'మీ మెయిల్స్ చదవడానికి జిమెయిల్ ఓపెన్ చేస్తున్నాను.',
    };
  }

  if (/\b(?:delete|remove|trash)\s+(?:this\s+|the\s+|current\s+|first\s+)?(?:e?mail|message\s+in\s+gmail)\b/i.test(lower) || /\bdelete\s+mail\b/i.test(lower)) {
    const hint = clean
      .replace(/^(?:delete|remove|trash)\s+(?:this\s+|the\s+|current\s+|first\s+)?(?:e?mails?)\s*(?:from\s+)?/i, '')
      .trim();
    return {
      type: 'DELETE_EMAIL',
      confidence: 0.95,
      query: hint,
      spokenAckEn: 'Deleting the email.',
      spokenAckTe: 'మెయిల్ డిలీట్ చేస్తున్నాను.',
    };
  }

  if (/\b(?:send\s+(?:this\s+|the\s+)?(?:e?mail|mail))\b/i.test(lower) && !/\bto\s+/i.test(lower)) {
    return {
      type: 'SEND_EMAIL',
      confidence: 0.94,
      spokenAckEn: 'Sending the email.',
      spokenAckTe: 'మెయిల్ పంపుతున్నాను.',
    };
  }

  const emailComposeMatch = clean.match(
    /(?:create|compose|write|draft|send)\s+(?:a\s+|an\s+)?(?:e?mail|mail)(?:\s+to\s+([^\s]+@[^\s]+|[a-zA-Z0-9._-]+))?(?:\s+(?:with\s+)?subject\s+(.+?))?(?:\s+(?:body|saying|message|text)\s+(.+))?$/i,
  );
  if (emailComposeMatch && /\b(?:e?mail|mail)\b/i.test(lower)) {
    const isSend = /\bsend\b/i.test(lower);
    const to = (emailComposeMatch[1] || '').trim();
    const subject = (emailComposeMatch[2] || '').trim();
    const body = (emailComposeMatch[3] || '').trim();
    return {
      type: isSend ? 'SEND_EMAIL' : 'CREATE_EMAIL',
      confidence: 0.94,
      recipient: to,
      subject,
      message: body,
      spokenAckEn: isSend ? `Preparing and sending email${to ? ` to ${to}` : ''}.` : `Creating email${to ? ` to ${to}` : ''}.`,
      spokenAckTe: isSend ? 'మెయిల్ సిద్ధం చేసి పంపుతున్నాను.' : 'కొత్త మెయిల్ సిద్ధం చేస్తున్నాను.',
    };
  }

  // 6. Send Message (WhatsApp / SMS / Friend)
  // Patterns:
  // "send a message to Rahul saying hello"
  // "send whatsapp message to Mom I am coming"
  // "message Alex on WhatsApp how are you"
  // "send sms to 9876543210 hi"
  const msgMatch =
    clean.match(
      /(?:send\s+(?:a\s+)?(?:whatsapp\s+|sms\s+|text\s+)?messages?\s+to|message|text|whatsapp)\s+([a-zA-Z0-9+._\s]{1,30}?)(?:\s+(?:on\s+(?:whatsapp|sms|telegram))?\s*(?:saying|that|message|:|-)?\s+(.+))?$/i,
    );
  if (
    msgMatch &&
    (/\b(?:send\s+(?:a\s+)?(?:whatsapp\s+|sms\s+|text\s+)?message|message\s+to|text\s+to)\b/i.test(lower) ||
      /^(?:message|text|whatsapp)\s+[a-zA-Z0-9+]/i.test(lower))
  ) {
    let recipient = (msgMatch[1] || '').trim();
    let message = (msgMatch[2] || '').trim();
    recipient = recipient.replace(/\s+(?:on\s+whatsapp|on\s+sms|on\s+telegram)$/i, '').trim();
    const platform: PulseParsedIntent['platform'] = /\bsms\b/i.test(lower)
      ? 'sms'
      : /\btelegram\b/i.test(lower)
        ? 'telegram'
        : 'whatsapp';
    if (recipient) {
      return {
        type: 'SEND_MESSAGE',
        confidence: 0.94,
        recipient,
        message,
        platform,
        app: platform === 'sms' ? 'sms' : platform === 'telegram' ? 'telegram' : 'whatsapp',
        spokenAckEn: `Sending ${platform} message to ${recipient}.`,
        spokenAckTe: `${recipient} కు మెసేజ్ పంపుతున్నాను.`,
      };
    }
  }

  // 7. Call Contact
  const callMatch = clean.match(/^(?:call|dial|phone|ring)\s+(.+)$/i);
  if (callMatch) {
    const target = callMatch[1].trim();
    return {
      type: 'CALL_CONTACT',
      confidence: 0.94,
      recipient: target,
      spokenAckEn: `Calling ${target}.`,
      spokenAckTe: `${target} కు కాల్ చేస్తున్నాను.`,
    };
  }

  // 8. Select Item / Proceed / Click Text / Search
  if (
    /^(?:select\s*it|select\s*this|select\s+the\s+first|select\s+the\s+second|select\s+the\s+third|first\s+one|second\s+one|third\s+one|open\s+it|click\s+it|మొదటిది|రెండవది|సెలెక్ట్)/i.test(
      lower,
    )
  ) {
    return {
      type: 'SELECT_ITEM',
      confidence: 0.95,
      query: clean,
      spokenAckEn: 'Selecting item.',
      spokenAckTe: 'సెలెక్ట్ చేస్తున్నాను.',
    };
  }

  if (/^(?:proceed|continue|next|checkout|buy\s*now|confirm|submit|done|ముందుకు|కొనసాగించు)$/i.test(lower)) {
    return {
      type: 'PROCEED',
      confidence: 0.95,
      spokenAckEn: 'Proceeding.',
      spokenAckTe: 'ముందుకు వెళ్తున్నాను.',
    };
  }

  const clickMatch = clean.match(/^(?:click\s+on|click|tap\s+on|tap|press)\s+(.+)$/i);
  if (clickMatch) {
    const target = clickMatch[1].trim();
    return {
      type: 'CLICK_TEXT',
      confidence: 0.92,
      query: target,
      spokenAckEn: `Tapping ${target}.`,
      spokenAckTe: `${target} నొక్కుతున్నాను.`,
    };
  }

  const searchInAppMatch = clean.match(/^(?:search\s+for|search|find|look\s+up)\s+(.+?)(?:\s+(?:on|in)\s+([a-zA-Z0-9\s]+))?$/i);
  if (searchInAppMatch) {
    const q = searchInAppMatch[1].trim();
    const appHint = searchInAppMatch[2]?.trim();
    if (appHint) {
      return {
        type: 'APP_WORKFLOW',
        confidence: 0.92,
        app: appHint,
        query: q,
        spokenAckEn: `Searching for ${q} in ${appHint}.`,
        spokenAckTe: `${appHint} లో ${q} వెతుకుతున్నాను.`,
      };
    }
    return {
      type: 'SEARCH_IN_APP',
      confidence: 0.91,
      query: q,
      spokenAckEn: `Searching for ${q}.`,
      spokenAckTe: `${q} కోసం వెతుకుతున్నాను.`,
    };
  }

  // 9. Open Any App (Catalog or Installed Apps Fuzzy Match)
  const openAppMatch = clean.match(/^(?:open|launch|start|run|go\s+to)\s+(.+)$/i);
  if (openAppMatch) {
    let target = openAppMatch[1]
      .replace(/\s+(?:app|application|please|for\s+me|now)$/gi, '')
      .trim();

    // Check if there's an "and <action>" after the app name, e.g., "open youtube and play songs"
    const andSplit = target.match(/^([a-zA-Z0-9\s]{2,25}?)\s+(?:and|to)\s+(.+)$/i);
    if (andSplit) {
      const appPart = andSplit[1].trim();
      const actionPart = andSplit[2]
        .replace(/^(?:play|watch|listen\s+to|search\s+for|search|order|buy|book|find)\s+/i, '')
        .trim();
      return {
        type: 'APP_WORKFLOW',
        confidence: 0.92,
        app: appPart,
        query: actionPart,
        spokenAckEn: `Opening ${appPart} for ${actionPart}.`,
        spokenAckTe: `${appPart} ఓపెన్ చేసి ${actionPart} చేస్తున్నాను.`,
      };
    }

    // Match against catalog or installed apps
    const tLower = target.toLowerCase();
    const cat = PULSE_APP_CATALOG.find(
      (a) => a.id === tLower || a.name.toLowerCase() === tLower || a.aliases.includes(tLower),
    );
    const inst = installedApps.find((a) => {
      const l = a.label.toLowerCase();
      return l === tLower || l.includes(tLower) || tLower.includes(l);
    });

    const resolvedName = cat?.name || inst?.label || target;
    const resolvedTarget = cat?.id || inst?.packageName || target;
    return {
      type: 'OPEN_APP',
      confidence: 0.95,
      app: resolvedTarget,
      query: resolvedName,
      spokenAckEn: `Opening ${resolvedName}.`,
      spokenAckTe: `${resolvedName} ఓపెన్ చేస్తున్నాను.`,
    };
  }

  // 10. Implicit App Mention + Action (e.g. "YouTube Telugu songs", "Blinkit milk")
  for (const app of PULSE_APP_CATALOG) {
    for (const alias of [app.name.toLowerCase(), ...app.aliases]) {
      const rx = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (rx.test(lower)) {
        const stripped = clean
          .replace(rx, '')
          .replace(/\b(?:open|launch|in|on|and|search|order|buy|play|watch|for)\b/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (stripped.length >= 2) {
          return {
            type: 'APP_WORKFLOW',
            confidence: 0.88,
            app: app.id,
            query: stripped,
            spokenAckEn: `Opening ${app.name} for ${stripped}.`,
            spokenAckTe: `${app.name} లో ${stripped} చేస్తున్నాను.`,
          };
        }
      }
    }
  }

  return {
    type: 'CONVERSATION',
    confidence: 0.5,
    spokenAckEn: '',
    spokenAckTe: '',
  };
}

/* -------------------------------------------------------------------------- */
/* Pulse Knowledge Vault (Lightweight On-Device BM25 RAG)                     */
/* -------------------------------------------------------------------------- */

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'when', 'where',
  'which', 'who', 'why', 'how', 'into', 'about', 'your', 'have', 'has', 'had',
  'will', 'would', 'should', 'could', 'can', 'please', 'open', 'launch', 'app',
]);

export function tokenizeForRag(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9₹+@._-\s]/gi, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

export const DEFAULT_RAG_PLAYBOOKS: RagChunk[] = [
  {
    id: 'pb_messaging',
    docId: 'sys_playbooks',
    title: 'Messaging & Contacts Playbook (WhatsApp, SMS)',
    category: 'playbook',
    appTag: 'whatsapp',
    content: 'Resolve contact names using Android Contacts, open WhatsApp or SMS with prefilled message, and tap Send automatically.',
    keywords: ['whatsapp', 'message', 'sms', 'send', 'friend', 'contact'],
    createdAt: 1700000001000,
  },
  {
    id: 'pb_email',
    docId: 'sys_playbooks',
    title: 'Email Control Playbook (Gmail Read, Create, Send, Delete)',
    category: 'playbook',
    appTag: 'gmail',
    content: 'Open Gmail to read visible inbox threads aloud, compose/send emails via mailto intent, and delete emails via Delete/Trash accessibility action.',
    keywords: ['gmail', 'email', 'mail', 'read', 'create', 'send', 'delete'],
    createdAt: 1700000002000,
  },
];

export async function loadRagIndex(): Promise<RagChunk[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_RAG_INDEX);
    if (!raw) {
      await AsyncStorage.setItem(STORAGE_RAG_INDEX, JSON.stringify(DEFAULT_RAG_PLAYBOOKS));
      return DEFAULT_RAG_PLAYBOOKS;
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_RAG_PLAYBOOKS;
  } catch {
    return DEFAULT_RAG_PLAYBOOKS;
  }
}

export async function saveRagIndex(chunks: RagChunk[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_RAG_INDEX, JSON.stringify(chunks.slice(0, 120)));
}

export async function ingestDocumentIntoRag(
  title: string,
  text: string,
  category: RagCategory = 'document',
  opts: { appTag?: string; sourceUrl?: string } = {},
): Promise<RagChunk[]> {
  const existing = await loadRagIndex();
  const clean = text.trim().slice(0, 2000);
  if (!clean) return existing;
  const chunk: RagChunk = {
    id: 'rag_' + Date.now().toString(36),
    docId: 'doc_' + Date.now().toString(36),
    title: title.trim() || 'Note',
    category,
    content: clean,
    keywords: Array.from(new Set(tokenizeForRag(`${title} ${clean}`))).slice(0, 30),
    appTag: opts.appTag,
    sourceUrl: opts.sourceUrl,
    createdAt: Date.now(),
  };
  const next = [chunk, ...existing.filter((c) => c.title !== title.trim())];
  await saveRagIndex(next);
  return next;
}

export async function syncUserVaultToRag(userAuth: {
  name: string;
  email: string;
  phone: string;
  address: string;
}): Promise<RagChunk[]> {
  const existing = await loadRagIndex();
  const withoutVault = existing.filter((c) => c.category !== 'user_vault');
  const lines = [
    userAuth.name ? `Name: ${userAuth.name}` : '',
    userAuth.email ? `Email: ${userAuth.email}` : '',
    userAuth.phone ? `Phone: ${userAuth.phone}` : '',
    userAuth.address ? `Address: ${userAuth.address}` : '',
  ].filter(Boolean);
  if (!lines.length) {
    await saveRagIndex(withoutVault);
    return withoutVault;
  }
  const vaultChunk: RagChunk = {
    id: 'vault_profile',
    docId: 'vault',
    title: 'User Profile & Address',
    category: 'user_vault',
    content: lines.join('\n'),
    keywords: Array.from(new Set(['profile', 'name', 'email', 'phone', 'address', ...tokenizeForRag(lines.join(' '))])),
    createdAt: Date.now(),
  };
  const merged = [vaultChunk, ...withoutVault];
  await saveRagIndex(merged);
  return merged;
}

export function retrieveRagChunksSync(query: string, chunks: RagChunk[], topK = 4): RagSearchResult[] {
  const qTokens = tokenizeForRag(query);
  if (!qTokens.length || !chunks.length) return [];
  const results: RagSearchResult[] = [];
  for (const chunk of chunks) {
    const hay = `${chunk.title} ${chunk.content}`.toLowerCase();
    const matchedTerms = qTokens.filter((t) => hay.includes(t) || chunk.keywords.includes(t));
    if (matchedTerms.length > 0) {
      const score = Math.min(99, Math.round((matchedTerms.length / qTokens.length) * 85 + 14));
      results.push({ chunk, score, matchedTerms });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, topK);
}

export function buildAgenticRagContext(
  goal: string,
  ragIndex: RagChunk[],
  topK = 4,
): { results: RagSearchResult[]; contextBlock: string } {
  const results = retrieveRagChunksSync(goal, ragIndex, topK);
  if (!results.length) return { results: [], contextBlock: '' };
  const lines = results.map((r, i) => `[${i + 1}] ${r.chunk.title}: ${r.chunk.content}`);
  return {
    results,
    contextBlock: 'User Context & Knowledge:\n' + lines.join('\n'),
  };
}
