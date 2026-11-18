/*
 * Pulse OS — Hark-Style Autonomous Visual Computer Agent
 * Parses natural-language goals, observes live WebView DOM (inputs, links, coordinates, text),
 * and drives the browser step-by-step like a human using the device.
 */

export type DomInput = { id: number; placeholder: string; name: string; type: string; x: number; y: number };
export type DomLink = { id: number; text: string; href: string; x: number; y: number };
export type DomSnapshot = { url: string; title: string; inputs: DomInput[]; links: DomLink[]; text: string };

const SITE_MAP: Record<string, string> = {
  amazon: 'https://www.amazon.in',
  flipkart: 'https://www.flipkart.com',
  youtube: 'https://m.youtube.com',
  wikipedia: 'https://en.m.wikipedia.org',
  wiki: 'https://en.m.wikipedia.org',
  google: 'https://www.google.com',
  myntra: 'https://www.myntra.com',
  swiggy: 'https://www.swiggy.com',
  zomato: 'https://www.zomato.com',
  reddit: 'https://www.reddit.com',
  github: 'https://github.com',
  linkedin: 'https://www.linkedin.com',
};

export const BUY_GUARD_RE = /\b(buy\s*now|pay\s*now|checkout|place\s*order|proceed\s*to\s*buy|confirm\s*payment|delete\s*account)\b/i;

export function parseHumanGoal(rawGoal: string): {
  startUrl: string;
  searchQuery: string;
  clickHint: string;
  wantsOpenResult: boolean;
  wantsCompare: boolean;
} {
  const g = rawGoal.trim();
  const lower = g.toLowerCase();

  let startUrl = '';
  const urlMatch = g.match(/(https?:\/\/\S+|(?:[a-z0-9-]+\.)+(?:com|in|org|net|io|dev|co)(?:\/\S*)?)/i);
  if (urlMatch) {
    startUrl = /^https?:\/\//i.test(urlMatch[1]) ? urlMatch[1] : `https://${urlMatch[1]}`;
  } else {
    for (const [key, url] of Object.entries(SITE_MAP)) {
      if (new RegExp(`\\b${key}\\b`, 'i').test(lower)) {
        startUrl = url;
        break;
      }
    }
  }
  if (!startUrl) startUrl = 'https://www.google.com';

  let q = g
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\b(?:open|go\s+to|visit|navigate\s+to|on|in|and|then|please|can\s+you|search\s+for|search|find|look\s+up|compare|check|play|watch|show\s+me|get\s+me)\b/gi, ' ');
  for (const key of Object.keys(SITE_MAP)) {
    q = q.replace(new RegExp(`\\b${key}(?:\\.com|\\.in)?\\b`, 'gi'), ' ');
  }
  q = q.replace(/\s+/g, ' ').trim();

  return {
    startUrl,
    searchQuery: q,
    clickHint: q,
    wantsOpenResult: /\b(play|watch|open\s+(?:the\s+)?first|click|select)\b/i.test(lower),
    wantsCompare: /\b(compare|best|cheapest|price|prices|deals|review|reviews|top)\b/i.test(lower),
  };
}

export const OBSERVE_DOM_JS = `
(function(){
  try {
    var vw = window.innerWidth || 1, vh = window.innerHeight || 1;
    var inputs = [];
    document.querySelectorAll('[data-pulse-in],[data-pulse-lk]').forEach(function(e){
      e.removeAttribute('data-pulse-in'); e.removeAttribute('data-pulse-lk');
    });
    var inEls = Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,[role=searchbox],[contenteditable=true]'));
    var nIn = 0;
    for (var i=0; i<inEls.length && nIn<12; i++) {
      var el = inEls[i], r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 14 || r.bottom < 0 || r.top > vh) continue;
      nIn++;
      el.setAttribute('data-pulse-in', String(nIn));
      inputs.push({
        id: nIn,
        placeholder: (el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').slice(0, 50),
        name: (el.getAttribute('name') || el.id || '').slice(0, 30),
        type: (el.getAttribute('type') || 'text').toLowerCase(),
        x: Math.max(0.05, Math.min(0.95, (r.left + r.width/2) / vw)),
        y: Math.max(0.05, Math.min(0.95, (r.top + r.height/2) / vh))
      });
    }
    var links = [];
    var lkEls = Array.from(document.querySelectorAll('a[href],button,[role=button]'));
    var nLk = 0;
    for (var j=0; j<lkEls.length && nLk<35; j++) {
      var a = lkEls[j], ar = a.getBoundingClientRect();
      if (ar.width < 16 || ar.height < 14 || ar.bottom < 0 || ar.top > vh) continue;
      var txt = (a.innerText || a.getAttribute('aria-label') || a.getAttribute('title') || '').replace(/\\s+/g,' ').trim();
      if (!txt || txt.length < 2) continue;
      nLk++;
      a.setAttribute('data-pulse-lk', String(nLk));
      links.push({
        id: nLk,
        text: txt.slice(0, 80),
        href: (a.getAttribute('href') || '').slice(0, 140),
        x: Math.max(0.05, Math.min(0.95, (ar.left + ar.width/2) / vw)),
        y: Math.max(0.05, Math.min(0.95, (ar.top + ar.height/2) / vh))
      });
    }
    var text = (document.body ? document.body.innerText : '').replace(/[ \\t]+/g,' ').replace(/\\s*\\n\\s*/g,'\\n').slice(0, 2200);
    window.ReactNativeWebView.postMessage(JSON.stringify({
      t: 'dom',
      url: location.href,
      title: document.title,
      inputs: inputs,
      links: links,
      text: text
    }));
  } catch (e) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ t: 'dom_err', msg: String(e) }));
  }
})(); true;
`;

export function buildTypeAndSubmitJs(inputId: number, query: string): string {
  return `
    (function(){
      var el = document.querySelector('[data-pulse-in="${inputId}"]');
      if (!el) return;
      el.focus();
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (setter && setter.set) setter.set.call(el, ${JSON.stringify(query)});
      else el.value = ${JSON.stringify(query)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (el.form) el.form.submit();
      else {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      }
    })(); true;
  `;
}
