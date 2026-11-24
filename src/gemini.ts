/*
 * Pulse OS — Gemini client (streaming chat, Google Search grounding, JSON helper).
 * Fastest models first; never gemini-1.x / 2.x (2.5 reroutes on Dec 1 2026) and never pro models.
 */

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
export const DEFAULT_MODEL = 'gemini-flash-lite-latest';
export const MODEL_CHAIN = ['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-3.5-flash-lite', 'gemini-3.5-flash'];
export const MODEL_CHOICES: { id: string; label: string }[] = [
  { id: 'gemini-flash-lite-latest', label: 'Fast' },
  { id: 'gemini-flash-latest', label: 'Smart' },
];
const FORBIDDEN_MODEL = /(gemini-(1|2)\.|(^|-)pro($|-)|gemini-pro)/i;

export function sanitizeModel(model?: string): string {
  const m = String(model || '').trim();
  if (!m || FORBIDDEN_MODEL.test(m) || !MODEL_CHAIN.includes(m)) return DEFAULT_MODEL;
  return m;
}

export type Source = { title: string; uri: string };
export type GeminiPart = { text?: string; inlineData?: { mimeType: string; data: string } };
export type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };

export type TokenUsage = { prompt: number; candidates: number; total: number };

export type StreamResult = { text: string; sources: Source[]; model: string; searched: boolean; usage?: TokenUsage };

function thinkingFor(model: string) {
  // Lite models: near-off thinking for speed. Other flash models: low.
  return /lite/i.test(model) ? { thinkingLevel: 'minimal' } : { thinkingLevel: 'low' };
}

function buildBody(opts: {
  system: string;
  contents: GeminiContent[];
  search: boolean;
  thinking: boolean;
  model: string;
  maxTokens?: number;
  temperature?: number;
}) {
  return JSON.stringify({
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: opts.contents,
    ...(opts.search ? { tools: [{ google_search: {} }] } : {}),
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: opts.maxTokens ?? 2048,
      ...(opts.thinking ? { thinkingConfig: thinkingFor(opts.model) } : {}),
    },
  });
}

function addSources(into: Source[], meta: any) {
  const chunks: any[] = meta?.groundingChunks || [];
  for (const c of chunks) {
    const uri = c?.web?.uri;
    if (!uri || into.some((s) => s.uri === uri)) continue;
    into.push({ uri: String(uri), title: String(c?.web?.title || c?.web?.domain || 'Source') });
  }
}

type Attempt = { ok: boolean; status: number; text: string; sources: Source[]; error?: string; aborted?: boolean; usage?: TokenUsage };

function readUsage(meta: any): TokenUsage | undefined {
  const u = meta?.usageMetadata;
  if (!u) return undefined;
  const prompt = Number(u.promptTokenCount || 0);
  const candidates = Number(u.candidatesTokenCount || 0);
  const total = Number(u.totalTokenCount || prompt + candidates);
  if (!prompt && !candidates && !total) return undefined;
  return { prompt, candidates, total };
}

function streamOnce(apiKey: string, model: string, body: string, onPartial?: (t: string) => void, signal?: AbortSignal): Promise<Attempt> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let seen = 0;
    let buffer = '';
    let full = '';
    const sources: Source[] = [];
    let usage: TokenUsage | undefined;
    let done = false;
    const finish = (r: Attempt) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const pump = () => {
      const chunk = xhr.responseText.slice(seen);
      seen = xhr.responseText.length;
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      let changed = false;
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j: any = JSON.parse(data);
          const cand = j?.candidates?.[0];
          for (const p of cand?.content?.parts ?? []) {
            if (!p?.thought && typeof p?.text === 'string') {
              full += p.text;
              changed = true;
            }
          }
          if (cand?.groundingMetadata) addSources(sources, cand.groundingMetadata);
          const u = readUsage(j);
          if (u) usage = u;
        } catch {}
      }
      if (changed && onPartial) onPartial(full);
    };
    if (signal) {
      if (signal.aborted) return finish({ ok: false, status: 0, text: '', sources, aborted: true, usage });
      signal.addEventListener('abort', () => {
        try {
          xhr.abort();
        } catch {}
        finish({ ok: full.length > 0, status: 0, text: full.trim(), sources, aborted: true, usage });
      });
    }
    xhr.open('POST', GEMINI_BASE + encodeURIComponent(model) + ':streamGenerateContent?alt=sse');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('x-goog-api-key', apiKey);
    xhr.timeout = 60000;
    xhr.onprogress = () => {
      if (xhr.status === 200) pump();
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        buffer += '\n';
        pump();
        finish({ ok: true, status: 200, text: full.trim(), sources, usage });
      } else {
        let msg = `Gemini HTTP ${xhr.status}`;
        try {
          const parsed = JSON.parse(xhr.responseText);
          const apiMsg = (Array.isArray(parsed) ? parsed[0] : parsed)?.error?.message;
          if (apiMsg) msg = apiMsg;
        } catch {}
        finish({ ok: false, status: xhr.status, text: '', sources, error: msg, usage });
      }
    };
    xhr.onerror = () => finish(full ? { ok: true, status: 200, text: full.trim(), sources, usage } : { ok: false, status: 0, text: '', sources, error: 'Network error', usage });
    xhr.ontimeout = () => finish(full ? { ok: true, status: 200, text: full.trim(), sources, usage } : { ok: false, status: 0, text: '', sources, error: 'Request timed out', usage });
    xhr.send(body);
  });
}

/** Streams a chat answer. Falls back across models, and drops thinking/search config if a model rejects it. */
export async function streamChat(opts: {
  apiKey: string;
  model?: string;
  system: string;
  contents: GeminiContent[];
  search: boolean;
  onPartial?: (t: string) => void;
  signal?: AbortSignal;
}): Promise<StreamResult> {
  const key = opts.apiKey.trim();
  const first = sanitizeModel(opts.model);
  const chain = [first, ...MODEL_CHAIN.filter((m) => m !== first)];
  let lastErr = 'Request failed';
  for (const model of chain) {
    let thinking = true;
    let search = opts.search;
    for (let tries = 0; tries < 3; tries++) {
      const body = buildBody({ system: opts.system, contents: opts.contents, search, thinking, model });
      const r = await streamOnce(key, model, body, opts.onPartial, opts.signal);
      if (r.aborted) return { text: r.text, sources: r.sources, model, searched: search, usage: r.usage };
      if (r.ok && r.text) return { text: r.text, sources: r.sources, model, searched: search, usage: r.usage };
      if (r.ok && !r.text) {
        lastErr = 'Empty answer';
        break;
      }
      lastErr = r.error || `Gemini HTTP ${r.status}`;
      if (r.status === 401 || r.status === 403 || (r.status === 400 && /api key/i.test(lastErr))) {
        throw new Error('Invalid Gemini API key. Check it in Settings.');
      }
      if (r.status === 0 && lastErr === 'Network error') throw new Error('No internet connection.');
      if (r.status === 400 && thinking && /think/i.test(lastErr)) {
        thinking = false;
        continue;
      }
      if (r.status === 400 && search && /(tool|search|ground)/i.test(lastErr)) {
        search = false;
        continue;
      }
      break; // 404 / 429 / 5xx: next model
    }
  }
  throw new Error(lastErr);
}

/** Small non-streaming JSON call on the fastest model (memory extraction, reminder parsing). */
export async function generateJSON<T = any>(apiKey: string, system: string, user: string, timeoutMs = 15000): Promise<T> {
  let lastErr: any = null;
  for (const model of ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-flash-latest']) {
    for (const thinking of [true, false]) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(GEMINI_BASE + encodeURIComponent(model) + ':generateContent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey.trim() },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 800,
              responseMimeType: 'application/json',
              ...(thinking ? { thinkingConfig: thinkingFor(model) } : {}),
            },
          }),
          signal: ctrl.signal,
        });
        const j: any = await res.json().catch(() => ({}));
        if (!res.ok) {
          lastErr = new Error(j?.error?.message || `HTTP ${res.status}`);
          if (res.status === 400 && thinking && /think/i.test(String(lastErr.message))) continue;
          break;
        }
        const text = (j?.candidates?.[0]?.content?.parts || [])
          .filter((p: any) => !p.thought)
          .map((p: any) => p.text || '')
          .join('')
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/```\s*$/, '');
        const a = text.search(/[[{]/);
        return JSON.parse(a > 0 ? text.slice(a) : text) as T;
      } catch (e) {
        lastErr = e;
        break;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw lastErr || new Error('No model available');
}

/** Heuristic: should this message be grounded with Google Search? */
export function looksTimeSensitive(text: string): boolean {
  const t = text.toLowerCase();
  if (t.length < 6) return false;
  if (/\b(today|tonight|tomorrow|yesterday|now|current(ly)?|latest|recent(ly)?|this (week|month|year|weekend)|news|live|score|weather|forecast|temperature|rain|price|cost|rate|stock|share price|sensex|nifty|crypto|bitcoin|exchange rate|inr|usd|petrol|gold|release(d)?|launch(ed)?|update|schedule|fixture|result(s)?|election|traffic|open now|near me|nearby|timings?|showtimes?|trending|who won|winner|2025|2026|2027)\b/.test(t)) return true;
  // Factual lookups about the world (not personal, not creative).
  if (/^(who|what|when|where|which|how (much|many|old|far|long|tall))\b/.test(t) && !/\b(you|your|i|my|me)\b/.test(t)) return true;
  if (/\b(ceo|president|prime minister|chief minister|capital of|population|founded|address of|phone number|contact number|website|official site|is .+ open)\b/.test(t)) return true;
  return false;
}
