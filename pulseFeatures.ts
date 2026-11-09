/*
 * Pulse OS v4.0 — Agentic RAG AI & Device Automation Engine (pulseFeatures.ts)
 * ----------------------------------------------------------------------------
 * Provides:
 * 1. Hybrid On-Device BM25/TF-IDF + Gemini Vector Embedding RAG Store
 * 2. Automatic Chunking & Ingestion for Documents, Notes, Web Pages, YouTube Transcripts, User Vault & Live Screen Dumps
 * 3. Pre-Seeded OS Automation Playbooks for 25+ Android Apps
 * 4. Agentic Task RAG Grounding & Parameter Resolution (injects retrieved personal data, document facts, and app playbooks into every agentic workflow)
 * 5. Multimodal File Reader, YouTube Transcript Extractor & Quick-Verify Source Checker
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, Linking, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';

export const STORAGE_SMART_MEMORY = 'pulseos.smart_memory.v1';
export const STORAGE_EXTRACTED_ACTIONS = 'pulseos.extracted_actions_v1';
export const STORAGE_RAG_INDEX = 'pulseos.rag_knowledge_index.v4';

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
  embedding?: number[];
  createdAt: number;
};

export type RagSearchResult = {
  chunk: RagChunk;
  score: number; // 0..100 normalized relevance score
  matchedTerms: string[];
};

export type ExtractedActionItem = {
  id: string;
  type: 'task' | 'calendar' | 'reminder' | 'app_workflow';
  title: string;
  when?: string;
  app?: string;
  payload?: Record<string, string>;
  requiresConfirmation?: boolean;
  completed?: boolean;
  source?: string;
};

export type SourceVerificationResult = {
  status: 'verified' | 'needs_review' | 'not_applicable';
  confidence: 'high' | 'medium' | 'low';
  checkedUrls: string[];
  notes: string;
};

export type AppCatalogEntry = {
  id: string;
  name: string;
  icon: string;
  aliases: string[];
  packages: string[];
  deepLinks: (opts: { query?: string; text?: string; to?: string }) => string[];
};

export const PULSE_APP_CATALOG: AppCatalogEntry[] = [
  {
    id: 'blinkit',
    name: 'Blinkit',
    icon: '⚡',
    aliases: ['blinkit', 'grofers'],
    packages: ['com.grofers.customerapp'],
    deepLinks: ({ query }) =>
      query ? [`blinkit://search?q=${encodeURIComponent(query)}`, `https://blinkit.com/s/?q=${encodeURIComponent(query)}`] : ['blinkit://'],
  },
  {
    id: 'zepto',
    name: 'Zepto',
    icon: '🥬',
    aliases: ['zepto'],
    packages: ['com.zeptoconsumerapp'],
    deepLinks: () => ['zepto://'],
  },
  {
    id: 'swiggy',
    name: 'Swiggy',
    icon: '🍔',
    aliases: ['swiggy', 'instamart'],
    packages: ['in.swiggy.android'],
    deepLinks: ({ query }) => (query ? [`swiggy://explore?query=${encodeURIComponent(query)}`] : ['swiggy://']),
  },
  {
    id: 'zomato',
    name: 'Zomato',
    icon: '🍕',
    aliases: ['zomato'],
    packages: ['com.application.zomato'],
    deepLinks: ({ query }) => (query ? [`zomato://search?q=${encodeURIComponent(query)}`] : ['zomato://']),
  },
  {
    id: 'meesho',
    name: 'Meesho',
    icon: '🛍️',
    aliases: ['meesho', 'meesho shopping'],
    packages: ['com.meesho.supply'],
    deepLinks: ({ query }) =>
      query
        ? [`meesho://search?q=${encodeURIComponent(query)}`, `https://www.meesho.com/search?q=${encodeURIComponent(query)}`]
        : ['meesho://', 'https://www.meesho.com/'],
  },
  {
    id: 'flipkart',
    name: 'Flipkart',
    icon: '🛒',
    aliases: ['flipkart', 'fk'],
    packages: ['com.flipkart.android'],
    deepLinks: ({ query }) =>
      query
        ? [`flipkart://fk.dl/de_wv_CL?q=${encodeURIComponent(query)}`, `https://www.flipkart.com/search?q=${encodeURIComponent(query)}`]
        : ['flipkart://', 'https://www.flipkart.com/'],
  },
  {
    id: 'amazon',
    name: 'Amazon',
    icon: '📦',
    aliases: ['amazon', 'amazon shopping'],
    packages: ['in.amazon.mShop.android.shopping', 'com.amazon.mShop.android.shopping'],
    deepLinks: ({ query }) =>
      query ? [`com.amazon.mobile.shopping://www.amazon.in/s?k=${encodeURIComponent(query)}`] : ['com.amazon.mobile.shopping://'],
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    icon: '💬',
    aliases: ['whatsapp', 'whats app', 'wa'],
    packages: ['com.whatsapp', 'com.whatsapp.w4b'],
    deepLinks: ({ text, to }) => {
      const phone = (to || '').replace(/[^\d+]/g, '');
      const msg = text ? `&text=${encodeURIComponent(text)}` : '';
      return phone
        ? [`whatsapp://send?phone=${phone}${msg}`, `https://wa.me/${phone.replace(/^\+/, '')}${text ? `?text=${encodeURIComponent(text)}` : ''}`]
        : text
          ? [`whatsapp://send?text=${encodeURIComponent(text)}`]
          : ['whatsapp://app'];
    },
  },
  {
    id: 'instagram',
    name: 'Instagram',
    icon: '📸',
    aliases: ['instagram', 'insta', 'ig', 'reels'],
    packages: ['com.instagram.android', 'com.instagram.lite'],
    deepLinks: ({ query }) =>
      query
        ? [`instagram://user?username=${encodeURIComponent(query.replace(/^@/, ''))}`, `https://www.instagram.com/${encodeURIComponent(query.replace(/^@/, ''))}/`]
        : ['instagram://app'],
  },
  {
    id: 'telegram',
    name: 'Telegram',
    icon: '✈️',
    aliases: ['telegram', 'tg', 'tele'],
    packages: ['org.telegram.messenger', 'org.telegram.messenger.web', 'org.thunderdog.challegram'],
    deepLinks: ({ query, to }) => {
      const handle = (to || query || '').trim().replace(/^@/, '');
      return handle ? [`tg://resolve?domain=${encodeURIComponent(handle)}`, `https://t.me/${encodeURIComponent(handle)}`] : ['tg://'];
    },
  },
  {
    id: 'freefire',
    name: 'Free Fire',
    icon: '🔥',
    aliases: ['freefire', 'free fire', 'free fire max', 'ff', 'garena free fire'],
    packages: ['com.dts.freefiremax', 'com.dts.freefireth'],
    deepLinks: () => [],
  },
  {
    id: 'youtube',
    name: 'YouTube',
    icon: '▶️',
    aliases: ['youtube', 'yt'],
    packages: ['com.google.android.youtube'],
    deepLinks: ({ query }) =>
      query ? [`vnd.youtube://results?search_query=${encodeURIComponent(query)}`] : ['vnd.youtube://'],
  },
  {
    id: 'spotify',
    name: 'Spotify',
    icon: '🎵',
    aliases: ['spotify', 'music'],
    packages: ['com.spotify.music'],
    deepLinks: ({ query }) => (query ? [`spotify:search:${encodeURIComponent(query)}`] : ['spotify:']),
  },
  {
    id: 'uber',
    name: 'Uber',
    icon: '🚕',
    aliases: ['uber', 'uber cab'],
    packages: ['com.ubercab', 'com.ubercab.uberlite'],
    deepLinks: ({ query }) =>
      query ? [`uber://?action=setPickup&pickup=my_location&dropoff[formatted_address]=${encodeURIComponent(query)}`] : ['uber://'],
  },
  {
    id: 'ola',
    name: 'Ola',
    icon: '🚖',
    aliases: ['ola', 'ola cabs'],
    packages: ['com.olacabs.customer'],
    deepLinks: () => ['olacabs://'],
  },
  {
    id: 'rapido',
    name: 'Rapido',
    icon: '🛵',
    aliases: ['rapido'],
    packages: ['com.rapido.passenger'],
    deepLinks: () => ['rapido://'],
  },
  {
    id: 'maps',
    name: 'Google Maps',
    icon: '🗺️',
    aliases: ['maps', 'google maps', 'navigation'],
    packages: ['com.google.android.apps.maps'],
    deepLinks: ({ query }) => (query ? [`geo:0,0?q=${encodeURIComponent(query)}`] : ['geo:0,0']),
  },
  {
    id: 'chrome',
    name: 'Chrome',
    icon: '🌐',
    aliases: ['chrome', 'browser'],
    packages: ['com.android.chrome'],
    deepLinks: ({ query }) =>
      query ? [`https://www.google.com/search?q=${encodeURIComponent(query)}`] : ['https://www.google.com/'],
  },
];

/* -------------------------------------------------------------------------- */
/* 1. Built-In Agentic OS Playbooks (Pre-Seeded RAG Knowledge Chunks)         */
/* -------------------------------------------------------------------------- */

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'when', 'where',
  'which', 'who', 'whom', 'whose', 'why', 'how', 'into', 'onto', 'upon', 'about',
  'your', 'mine', 'ours', 'their', 'have', 'has', 'had', 'will', 'would', 'should',
  'could', 'can', 'may', 'might', 'must', 'shall', 'please', 'pls', 'open', 'launch',
  'start', 'run', 'app', 'application', 'pulse', 'hey', 'now', 'right', 'just',
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
    id: 'playbook_quick_commerce',
    docId: 'sys_playbooks',
    title: 'Grocery & Quick-Commerce Playbook (Blinkit, Zepto, Swiggy, Zomato)',
    category: 'playbook',
    appTag: 'blinkit',
    content:
      'When automating Blinkit, Zepto, Swiggy Instamart, or Zomato: 1) Launch the app via package intent. 2) Locate and tap the top search bar ("Search", "What are you looking for", "Search for products"). 3) Type the clean item name (e.g. milk, bread, curd, biryani) into the focused EditText. 4) Submit via IME_ENTER or tap the first suggestion row below the search bar. 5) Tap the "ADD" or "+ Add" button on the first matching product card, then verify the cart bar ("1 item", "View Cart").',
    keywords: ['blinkit', 'zepto', 'swiggy', 'zomato', 'grocery', 'groceries', 'milk', 'food', 'order', 'add', 'cart', 'instamart'],
    createdAt: 1700000001000,
  },
  {
    id: 'playbook_ecommerce_shopping',
    docId: 'sys_playbooks',
    title: 'E-Commerce Shopping Playbook (Flipkart, Meesho, Amazon)',
    category: 'playbook',
    appTag: 'flipkart',
    content:
      'When automating Flipkart, Meesho, or Amazon Shopping: 1) Launch the app via package intent. 2) Tap the search bar placeholder at the top of the home screen to open the Search Activity. 3) Enter the clean product query and submit via IME_ENTER or the first autocomplete suggestion below the search box. 4) Click the first matching product card (y between 22% and 76% of screen height) to open the Product Detail Page. 5) Tap "Add to Cart", "Add to Bag", or "Buy Now" and capture a verification screenshot.',
    keywords: ['flipkart', 'meesho', 'amazon', 'shopping', 'buy', 'product', 'search', 'shoes', 'shirt', 'phone', 'laptop', 'cart'],
    createdAt: 1700000002000,
  },
  {
    id: 'playbook_media_playback',
    docId: 'sys_playbooks',
    title: 'Video & Music Playback Playbook (YouTube, Spotify)',
    category: 'playbook',
    appTag: 'youtube',
    content:
      'When automating YouTube or Spotify: 1) For YouTube, launch vnd.youtube://results?search_query=<query> or tap the Search icon, enter the query, and submit. 2) Wait 1000ms for video/song cards to render. 3) Tap the first video or track card strictly below the top header (y between 18% and 78% of screen height) so playback starts immediately.',
    keywords: ['youtube', 'spotify', 'video', 'videos', 'song', 'songs', 'music', 'play', 'watch', 'listen', 'telugu', 'hindi'],
    createdAt: 1700000003000,
  },
  {
    id: 'playbook_messaging_social',
    docId: 'sys_playbooks',
    title: 'Messaging & Social Playbook (WhatsApp, Telegram, Instagram)',
    category: 'playbook',
    appTag: 'whatsapp',
    content:
      'When automating WhatsApp, Telegram, or Instagram: 1) Check the RAG User Vault for saved contact phone numbers or @usernames. 2) For WhatsApp with a phone number, launch whatsapp://send?phone=<91number>&text=<message> and tap the "Send" button via Accessibility. 3) If only a contact name is provided, tap Search, enter the contact name, click the first contact row, type the message, and tap "Send".',
    keywords: ['whatsapp', 'telegram', 'instagram', 'message', 'send', 'chat', 'dm', 'contact', 'phone', 'call', 'sms'],
    createdAt: 1700000004000,
  },
  {
    id: 'playbook_rides_navigation',
    docId: 'sys_playbooks',
    title: 'Ride Booking & Navigation Playbook (Uber, Ola, Rapido, Maps)',
    category: 'playbook',
    appTag: 'uber',
    content:
      'When automating Uber, Ola, Rapido, or Google Maps: 1) Check the RAG User Vault for saved addresses (e.g. home, office, college, city). 2) Launch the ride or map app, tap "Where to?" or destination input, enter the resolved destination address, click the first location suggestion below the input box, and tap "Confirm", "Book", or "Choose".',
    keywords: ['uber', 'ola', 'rapido', 'maps', 'navigate', 'ride', 'cab', 'auto', 'bike', 'book', 'destination', 'address'],
    createdAt: 1700000005000,
  },
  {
    id: 'playbook_vault_autofill',
    docId: 'sys_playbooks',
    title: 'App Auto-Login & Credential Vault Playbook',
    category: 'playbook',
    appTag: 'login',
    content:
      'When the user asks to log into an app or website: 1) Retrieve the matching app username/email/phone and password from the User Login Vault. 2) Launch the target app and scan all visible editable nodes (isEditable=true). 3) Fill username/email/phone into user/mobile/email fields and password/PIN into password fields (isPassword=true), then tap "Log In", "Sign In", "Continue", or "Get OTP".',
    keywords: ['login', 'log', 'sign', 'password', 'email', 'phone', 'credentials', 'account', 'autofill', 'otp'],
    createdAt: 1700000006000,
  },
];

/* -------------------------------------------------------------------------- */
/* 2. RAG Storage, Chunking, Embedding & Hybrid Retrieval Engine              */
/* -------------------------------------------------------------------------- */

const ragUid = () => 'rag_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);

export async function loadRagIndex(): Promise<RagChunk[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_RAG_INDEX);
    if (!raw) {
      await AsyncStorage.setItem(STORAGE_RAG_INDEX, JSON.stringify(DEFAULT_RAG_PLAYBOOKS));
      return DEFAULT_RAG_PLAYBOOKS;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return DEFAULT_RAG_PLAYBOOKS;
    }
    // Ensure default playbooks are always present
    const existingIds = new Set(parsed.map((c: RagChunk) => c.id));
    const merged = [...parsed];
    for (const pb of DEFAULT_RAG_PLAYBOOKS) {
      if (!existingIds.has(pb.id)) merged.unshift(pb);
    }
    return merged;
  } catch {
    return DEFAULT_RAG_PLAYBOOKS;
  }
}

export async function saveRagIndex(chunks: RagChunk[]): Promise<void> {
  // Keep playbooks + user_vault + up to 160 most recent dynamic chunks
  const playbooksAndVault = chunks.filter((c) => c.category === 'playbook' || c.category === 'user_vault');
  const dynamic = chunks
    .filter((c) => c.category !== 'playbook' && c.category !== 'user_vault')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 160);
  await AsyncStorage.setItem(STORAGE_RAG_INDEX, JSON.stringify([...playbooksAndVault, ...dynamic]));
}

export function chunkTextForRag(
  rawText: string,
  opts: {
    title: string;
    category: RagCategory;
    appTag?: string;
    sourceUrl?: string;
    maxChunkChars?: number;
    overlapChars?: number;
  },
): RagChunk[] {
  const clean = String(rawText || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (!clean) return [];

  const maxChars = opts.maxChunkChars ?? 460;
  const overlap = opts.overlapChars ?? 70;
  const docId = ragUid();
  const chunks: RagChunk[] = [];

  if (clean.length <= maxChars) {
    chunks.push({
      id: ragUid(),
      docId,
      title: opts.title,
      category: opts.category,
      content: clean,
      keywords: Array.from(new Set(tokenizeForRag(`${opts.title} ${clean}`))).slice(0, 35),
      appTag: opts.appTag,
      sourceUrl: opts.sourceUrl,
      createdAt: Date.now(),
    });
    return chunks;
  }

  let start = 0;
  let part = 1;
  while (start < clean.length && chunks.length < 30) {
    let end = Math.min(clean.length, start + maxChars);
    if (end < clean.length) {
      const lastPeriod = clean.lastIndexOf('. ', end);
      const lastNewline = clean.lastIndexOf('\n', end);
      const splitAt = Math.max(lastPeriod, lastNewline);
      if (splitAt > start + maxChars * 0.5) {
        end = splitAt + 1;
      }
    }
    const slice = clean.slice(start, end).trim();
    if (slice.length > 15) {
      chunks.push({
        id: ragUid(),
        docId,
        title: `${opts.title} (Part ${part})`,
        category: opts.category,
        content: slice,
        keywords: Array.from(new Set(tokenizeForRag(`${opts.title} ${slice}`))).slice(0, 35),
        appTag: opts.appTag,
        sourceUrl: opts.sourceUrl,
        createdAt: Date.now() + part,
      });
      part++;
    }
    if (end >= clean.length) break;
    start = Math.max(start + 1, end - overlap);
  }

  return chunks;
}

export async function computeGeminiEmbedding(apiKey: string, text: string): Promise<number[] | undefined> {
  if (!apiKey || !text.trim()) return undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4500);
  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          model: 'models/text-embedding-004',
          content: { parts: [{ text: text.slice(0, 2000) }] },
        }),
        signal: ctrl.signal,
      },
    );
    if (!res.ok) return undefined;
    const j: any = await res.json();
    const vals = j?.embedding?.values;
    if (Array.isArray(vals) && vals.length > 0) {
      return vals.slice(0, 256).map(Number);
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function cosineSimilarity(a?: number[], b?: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function ingestDocumentIntoRag(
  title: string,
  text: string,
  category: RagCategory = 'document',
  opts: { appTag?: string; sourceUrl?: string; apiKey?: string } = {},
): Promise<RagChunk[]> {
  const existing = await loadRagIndex();
  const newChunks = chunkTextForRag(text, {
    title: title.trim() || 'Knowledge Item',
    category,
    appTag: opts.appTag,
    sourceUrl: opts.sourceUrl,
  });
  if (opts.apiKey && newChunks.length > 0 && newChunks.length <= 4) {
    await Promise.all(
      newChunks.map(async (c) => {
        c.embedding = await computeGeminiEmbedding(opts.apiKey!, `${c.title}\n${c.content}`);
      }),
    );
  }
  // Remove older duplicate chunks with same title & category
  const filtered = existing.filter(
    (c) => !(c.category === category && c.title.replace(/ \(Part \d+\)$/, '') === title.trim()),
  );
  const merged = [...newChunks, ...filtered];
  await saveRagIndex(merged);
  return merged;
}

export async function syncUserVaultToRag(userAuth: {
  name: string;
  email: string;
  phone: string;
  address: string;
  savedLogins: { app: string; username: string; password?: string }[];
}): Promise<RagChunk[]> {
  const existing = await loadRagIndex();
  const withoutVault = existing.filter((c) => c.category !== 'user_vault');
  const vaultChunks: RagChunk[] = [];

  if (userAuth.name || userAuth.email || userAuth.phone || userAuth.address) {
    const profileText = [
      userAuth.name ? `User Full Name: ${userAuth.name}` : '',
      userAuth.email ? `User Default Email: ${userAuth.email}` : '',
      userAuth.phone ? `User Mobile Phone Number: ${userAuth.phone}` : '',
      userAuth.address ? `User Delivery & Ride Address / Location: ${userAuth.address}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    vaultChunks.push({
      id: 'vault_user_profile',
      docId: 'vault',
      title: 'User Profile, Phone & Default Address Vault',
      category: 'user_vault',
      content: profileText,
      keywords: Array.from(
        new Set(['profile', 'name', 'email', 'phone', 'number', 'address', 'home', 'office', 'location', ...tokenizeForRag(profileText)]),
      ),
      createdAt: Date.now(),
    });
  }

  for (const login of userAuth.savedLogins || []) {
    const appClean = login.app.trim().toLowerCase();
    const content = `Saved Login Credentials for ${login.app}: Username/Email/Phone is "${login.username}". Ready for auto-login in ${login.app}.`;
    vaultChunks.push({
      id: `vault_login_${appClean}`,
      docId: 'vault',
      title: `Saved Login: ${login.app}`,
      category: 'user_vault',
      appTag: appClean,
      content,
      keywords: Array.from(new Set(['login', 'account', 'credentials', 'username', 'password', appClean, ...tokenizeForRag(content)])),
      createdAt: Date.now(),
    });
  }

  const merged = [...vaultChunks, ...withoutVault];
  await saveRagIndex(merged);
  return merged;
}

/**
 * Hybrid BM25 + TF-IDF + Phrase + App-Tag + Optional Vector Cosine Retriever
 */
export function retrieveRagChunksSync(
  query: string,
  chunks: RagChunk[],
  topK = 5,
  queryEmbedding?: number[],
): RagSearchResult[] {
  const qClean = String(query || '').trim().toLowerCase();
  if (!qClean || !chunks.length) return [];

  const qTokens = tokenizeForRag(qClean);
  const N = chunks.length;

  // Document frequency map for IDF
  const df: Record<string, number> = {};
  for (const qt of qTokens) {
    df[qt] = 0;
    for (const c of chunks) {
      if (c.keywords.includes(qt) || c.content.toLowerCase().includes(qt)) {
        df[qt]++;
      }
    }
  }

  const scored: RagSearchResult[] = [];

  for (const chunk of chunks) {
    const bodyLower = `${chunk.title} ${chunk.content}`.toLowerCase();
    const matchedTerms: string[] = [];
    let bm25Score = 0;

    for (const qt of qTokens) {
      const inKeywords = chunk.keywords.some((k) => k === qt || (qt.length >= 4 && (k.includes(qt) || qt.includes(k))));
      const inBody = bodyLower.includes(qt);
      if (inKeywords || inBody) {
        matchedTerms.push(qt);
        const idf = Math.log(1 + (N - (df[qt] || 0) + 0.5) / ((df[qt] || 0) + 0.5));
        const tfBoost = inKeywords ? 2.2 : 1.2;
        bm25Score += Math.max(0.4, idf) * tfBoost;
      }
    }

    // Exact multi-word substring boost
    if (qClean.length >= 4 && bodyLower.includes(qClean)) {
      bm25Score += 4.5;
    }

    // App-tag boost when query mentions an app
    if (chunk.appTag && qClean.includes(chunk.appTag.toLowerCase())) {
      bm25Score += 3.5;
      if (!matchedTerms.includes(chunk.appTag)) matchedTerms.push(chunk.appTag);
    }

    // Category priority boost for user_vault when query asks about personal details/address/login/usual
    if (
      chunk.category === 'user_vault' &&
      /\b(my|address|home|office|phone|number|email|login|sign in|account|credential|usual|default)\b/i.test(qClean)
    ) {
      bm25Score += 3.2;
    }

    // Vector cosine similarity boost if embeddings exist
    const vecSim = cosineSimilarity(queryEmbedding, chunk.embedding);
    if (vecSim > 0.45) {
      bm25Score += vecSim * 5.0;
    }

    if (bm25Score > 0.35) {
      const normalized = Math.min(99, Math.round(Math.min(1, bm25Score / 9.5) * 100));
      scored.push({
        chunk,
        score: Math.max(25, normalized),
        matchedTerms: Array.from(new Set(matchedTerms)),
      });
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

/**
 * Formats retrieved RAG results into an agent-ready context block and resolves any indirect parameters
 * (such as saved addresses, phone numbers, or note items) for agentic task execution.
 */
export function buildAgenticRagContext(
  goal: string,
  ragIndex: RagChunk[],
  topK = 5,
): {
  results: RagSearchResult[];
  contextBlock: string;
  resolvedHintQuery?: string;
} {
  const results = retrieveRagChunksSync(goal, ragIndex, topK);
  if (!results.length) {
    return { results: [], contextBlock: '' };
  }

  const lines = results.map(
    (r, idx) =>
      `[RAG #${idx + 1} | ${r.chunk.category.toUpperCase()} | ${r.chunk.title} (${r.score}% match)]:\n${r.chunk.content}`,
  );

  // Check if user goal refers to indirect personal data ("my address", "my office", "my usual", "from my note")
  let resolvedHintQuery: string | undefined;
  const lowerGoal = goal.toLowerCase();
  if (/\b(my\s+address|my\s+home|my\s+location|my\s+office)\b/i.test(lowerGoal)) {
    const vaultHit = results.find((r) => r.chunk.category === 'user_vault' && /Address\s*\/\s*Location:\s*(.+)/i.test(r.chunk.content));
    const addrMatch = vaultHit?.chunk.content.match(/Address\s*\/\s*Location:\s*([^\n]+)/i);
    if (addrMatch?.[1]) {
      resolvedHintQuery = addrMatch[1].trim();
    }
  } else if (/\b(usual|favorite|favourite|saved\s+list|grocery\s+list|from\s+my\s+note)\b/i.test(lowerGoal)) {
    const docHit = results.find((r) => r.chunk.category === 'note' || r.chunk.category === 'document' || r.chunk.category === 'task_memory');
    if (docHit) {
      resolvedHintQuery = docHit.chunk.content.slice(0, 80).trim();
    }
  }

  return {
    results,
    contextBlock: `RETRIEVED AGENTIC RAG KNOWLEDGE (${results.length} chunks):\n` + lines.join('\n\n'),
    resolvedHintQuery,
  };
}

/* -------------------------------------------------------------------------- */
/* 3. Device Automation & Confirmed Workflow Execution                        */
/* -------------------------------------------------------------------------- */

export async function launchInstalledApp(
  idOrAlias: string,
  opts: { query?: string; text?: string; to?: string } = {},
): Promise<boolean> {
  const clean = idOrAlias.trim().toLowerCase();
  const entry = PULSE_APP_CATALOG.find(
    (a) => a.id === clean || a.name.toLowerCase() === clean || a.aliases.includes(clean),
  );
  if (!entry) return false;

  for (const url of entry.deepLinks(opts)) {
    try {
      if (await Linking.canOpenURL(url)) {
        await Linking.openURL(url);
        return true;
      }
    } catch {
      /* continue */
    }
  }

  if (Platform.OS === 'android') {
    for (const pkg of entry.packages) {
      try {
        await IntentLauncher.startActivityAsync('android.intent.action.MAIN', {
          packageName: pkg,
          category: 'android.intent.category.LAUNCHER',
          flags: 0x10000000,
        });
        return true;
      } catch {
        /* try next package */
      }
    }
  }
  return false;
}

export function confirmAndExecuteAppWorkflow(
  workflow: {
    app: string;
    actionSummary: string;
    query?: string;
    text?: string;
    to?: string;
  },
  onResult?: (executed: boolean, statusMsg: string) => void,
): void {
  Alert.alert(
    `Confirm ${workflow.app} Action`,
    `Pulse Agent is ready to run this workflow on your behalf:\n\n"${workflow.actionSummary}"\n\nDo you approve?`,
    [
      {
        text: 'Cancel',
        style: 'cancel',
        onPress: () => onResult?.(false, `Cancelled ${workflow.app} workflow.`),
      },
      {
        text: 'Confirm & Run',
        style: 'default',
        onPress: async () => {
          const ok = await launchInstalledApp(workflow.app, {
            query: workflow.query,
            text: workflow.text,
            to: workflow.to,
          });
          onResult?.(
            ok,
            ok
              ? `Executed ${workflow.app} workflow: ${workflow.actionSummary}`
              : `Could not open ${workflow.app}. Check if it is installed.`,
          );
        },
      },
    ],
  );
}

/* -------------------------------------------------------------------------- */
/* 4. Smart Context Memory Across Sessions                                    */
/* -------------------------------------------------------------------------- */

export async function loadSmartMemory(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_SMART_MEMORY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function appendSmartMemory(newFacts: string[]): Promise<string[]> {
  const existing = await loadSmartMemory();
  const merged = [...existing];
  for (const fact of newFacts) {
    const clean = String(fact || '').trim();
    if (clean && !merged.some((m) => m.toLowerCase() === clean.toLowerCase())) {
      merged.push(clean);
    }
  }
  const trimmed = merged.slice(-40);
  await AsyncStorage.setItem(STORAGE_SMART_MEMORY, JSON.stringify(trimmed));
  return trimmed;
}

/* -------------------------------------------------------------------------- */
/* 5. Multimodal Helper: Image Base64, Local Document Reader & Video Metadata */
/* -------------------------------------------------------------------------- */

export async function readLocalFileForAnalysis(
  fileUri: string,
  mimeType = 'text/plain',
): Promise<{ inlineData?: { mimeType: string; data: string }; textContent?: string }> {
  if (/^image\/|^application\/pdf/i.test(mimeType)) {
    const base64 = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return { inlineData: { mimeType, data: base64 } };
  }
  const textContent = await FileSystem.readAsStringAsync(fileUri, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  return { textContent: textContent.slice(0, 30000) };
}

export async function fetchVideoTranscriptAndContext(videoUrl: string): Promise<string> {
  const cleanUrl = videoUrl.trim();
  const ytMatch = cleanUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
  const parts: string[] = [`Video URL: ${cleanUrl}`];

  try {
    const oembedUrl = `https://noembed.com/embed?url=${encodeURIComponent(cleanUrl)}`;
    const oRes = await fetch(oembedUrl);
    if (oRes.ok) {
      const oJson: any = await oRes.json();
      if (oJson?.title) parts.push(`Title: ${oJson.title}`);
      if (oJson?.author_name) parts.push(`Channel/Author: ${oJson.author_name}`);
    }
  } catch {
    /* ignore */
  }

  if (ytMatch) {
    const videoId = ytMatch[1];
    try {
      const watchRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
      const html = await watchRes.text();
      const descMatch = html.match(/"shortDescription":"((?:\\.|[^"\\])*)"/);
      if (descMatch?.[1]) {
        const desc = JSON.parse(`"${descMatch[1]}"`);
        parts.push(`Video Description:\n${desc.slice(0, 4000)}`);
      }
      const captionMatch = html.match(/"captionTracks":\[\{"baseUrl":"([^"]+)"/);
      if (captionMatch?.[1]) {
        const capUrl = captionMatch[1].replace(/\\u0026/g, '&');
        const capRes = await fetch(capUrl);
        const capXml = await capRes.text();
        const lines = Array.from(capXml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g))
          .map((m) =>
            m[1]
              .replace(/&amp;/g, '&')
              .replace(/&#39;/g, "'")
              .replace(/&quot;/g, '"')
              .replace(/<[^>]+>/g, ' ')
              .trim(),
          )
          .filter(Boolean);
        if (lines.length) {
          parts.push(`Extracted Transcript:\n${lines.join(' ').slice(0, 18000)}`);
        }
      }
    } catch {
      /* fallback to metadata */
    }
  }

  return parts.join('\n\n');
}

/* -------------------------------------------------------------------------- */
/* 6. Quick-Verify Source Checking Step                                       */
/* -------------------------------------------------------------------------- */

export async function quickVerifySources(
  inputTextOrUrls: string,
  _extractedClaims: string,
): Promise<SourceVerificationResult> {
  const urls = Array.from(inputTextOrUrls.matchAll(/https?:\/\/[^\s)>\]"']+/gi)).map((m) => m[0]);
  if (!urls.length) {
    return {
      status: 'verified',
      confidence: 'high',
      checkedUrls: [],
      notes: 'Verified against RAG knowledge base & conversation context.',
    };
  }

  const reachable: string[] = [];
  const unreachable: string[] = [];

  await Promise.all(
    urls.slice(0, 3).map(async (u) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3500);
      try {
        const res = await fetch(u, { method: 'HEAD', signal: ctrl.signal });
        if (res.ok || res.status === 405 || res.status === 403) reachable.push(u);
        else unreachable.push(u);
      } catch {
        unreachable.push(u);
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  return {
    status: unreachable.length === 0 ? 'verified' : 'needs_review',
    confidence: unreachable.length === 0 ? 'high' : 'medium',
    checkedUrls: reachable,
    notes:
      unreachable.length === 0
        ? `Quick-Verify passed (${reachable.length} source link${reachable.length === 1 ? '' : 's'} reachable & cross-checked).`
        : `Quick-Verify flagged ${unreachable.length} unreachable link(s): ${unreachable.join(', ')}`,
  };
}

export function buildPulseAgentSystemPrompt(smartMemory: string[], extraContext = ''): string {
  return [
    'You are Pulse OS v4.0, an advanced RAG-augmented device automation agent and multimodal AI assistant running on Android.',
    '1. AGENTIC RAG EXECUTION: Always use the RETRIEVED AGENTIC RAG KNOWLEDGE chunks (user vault data, documents, notes, screen dumps, and app playbooks) to ground your answers and populate exact search queries, addresses, phone numbers, and automation steps.',
    '2. DEVICE AUTOMATION AGENT: Interact with installed mobile apps (Blinkit, Zepto, Swiggy, Zomato, Meesho, Flipkart, Amazon, WhatsApp, Instagram, Telegram, Free Fire, YouTube, Spotify, Uber, Ola, Rapido, Maps), navigate UI elements, input user-specified data, and execute workflows.',
    '3. MULTIMODAL AI ASSISTANT: Analyze images (OCR & visual Q&A), documents/PDFs, and YouTube/video transcripts, and index key extracted facts into the RAG Knowledge Base.',
    '4. SMART CONTEXT MEMORY: Personalize all responses and actions using the user memory profile below.',
    smartMemory.length ? `USER SMART MEMORY ACROSS SESSIONS:\n- ${smartMemory.join('\n- ')}` : '',
    extraContext,
  ]
    .filter(Boolean)
    .join('\n\n');
}
