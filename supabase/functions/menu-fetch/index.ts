// ترويقة — menu-fetch: the admin pastes a restaurant/menu link, this function opens that ONE page
// and returns the menu it finds. Admins only (checked with the app's own sign-in token).
//
// POST { token, url }            → { kind: 'items', items:[{name,price,category}], title }
//                                 | { kind: 'text', text, images:[url…], title }   (the app reads the text itself)
//                                 | { kind: 'image', dataUrl }                      (a menu picture: the app reads it on the phone)
//                                 | { kind: 'fail', reason }                        (blocked, not found, PDF, sign-in wall…)
// POST { token, url, image: true } → fetch a picture found on the page, as { kind: 'image', dataUrl }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const MAX_HTML = 6_000_000, MAX_IMG = 6_000_000;
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';

// ---------- only public web addresses (no internal hosts) ----------
function privateHost(h: string): boolean {
  h = h.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !h.includes(':')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:');
  return false;
}
async function safeUrl(raw: string): Promise<URL | null> {
  let u: URL; try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || (u.port && !['80', '443'].includes(u.port))) return null;
  if (privateHost(u.hostname)) return null;
  try {   // the name must not point inside either
    const ips = [...await Deno.resolveDns(u.hostname, 'A').catch(() => []), ...await Deno.resolveDns(u.hostname, 'AAAA').catch(() => [])];
    if (ips.some(ip => privateHost(ip))) return null;
  } catch { /* resolver not available: the name check above stands */ }
  return u;
}
async function get(raw: string, accept: string): Promise<Response | { fail: string }> {
  let url = raw;
  for (let hop = 0; hop < 5; hop++) {
    const u = await safeUrl(url);
    if (!u) return { fail: 'badUrl' };
    let res: Response;
    try {
      res = await fetch(u.href, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA, 'Accept': accept, 'Accept-Language': 'ar-EG,ar;q=0.9,en;q=0.8' } });
    } catch { return { fail: 'unreachable' }; }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location')!, u).href; continue; }
    if (res.status === 401 || res.status === 403 || res.status === 429) return { fail: 'blocked' };
    if (res.status === 404 || res.status === 410) return { fail: 'notFound' };
    if (!res.ok) return { fail: 'http' + res.status };
    return res;
  }
  return { fail: 'redirects' };
}
async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  const len = +(res.headers.get('content-length') || 0);
  if (len > cap) return null;
  const reader = res.body!.getReader(); const parts: Uint8Array[] = []; let n = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > cap) { reader.cancel(); return null; } parts.push(value); }
  const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function b64(bytes: Uint8Array): string { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }

// ---------- menus inside the page's data (Talabat and most modern sites keep the whole menu as JSON) ----------
const NAME_KEYS = ['name', 'title', 'itemName', 'item_name', 'productName', 'nm', 'label'];
const PRICE_KEYS = ['price', 'Price', 'itemPrice', 'unitPrice', 'basePrice', 'base_price', 'finalPrice', 'final_price', 'amount', 'pr', 'oldPrice'];
const LIST_KEYS = ['items', 'menuItems', 'menu_items', 'products', 'hasMenuItem', 'dishes', 'itm', 'children', 'hasMenuSection'];
const txt = (v: unknown) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : (v && typeof v === 'object' && typeof (v as any).ar === 'string') ? (v as any).ar.trim() : '';
function priceOf(o: any): number | null {
  for (const k of PRICE_KEYS) {
    let v = o[k];
    if (v && typeof v === 'object') v = v.value ?? v.amount ?? v.price;
    if (typeof v === 'string') v = parseFloat(v.replace(/[^\d.]/g, ''));
    if (typeof v === 'number' && isFinite(v) && v > 0 && v < 100000) return Math.round(v * 100) / 100;
  }
  const off = o.offers; if (off) { const p = priceOf(Array.isArray(off) ? off[0] || {} : off); if (p != null) return p; }
  return null;
}
function nameOf(o: any): string { for (const k of NAME_KEYS) { const s = txt(o[k]); if (s && s.length <= 90 && !/^https?:/.test(s)) return s; } return ''; }
function collect(root: unknown) {
  const out: { name: string; price: number; category: string }[] = [];
  const seen = new Set<string>(); let steps = 0;
  const walk = (n: any, cat: string, depth: number) => {
    if (!n || typeof n !== 'object' || depth > 40 || ++steps > 400000) return;
    if (Array.isArray(n)) { for (const x of n) walk(x, cat, depth + 1); return; }
    const name = nameOf(n), price = priceOf(n);
    if (name && price != null && !LIST_KEYS.some(k => Array.isArray(n[k]) && n[k].length)) {
      const key = name + '|' + price;
      if (!seen.has(key)) { seen.add(key); out.push({ name, price, category: cat }); }
    }
    let here = cat;   // a named object holding a list of items is a menu section
    if (name && price == null && LIST_KEYS.some(k => Array.isArray(n[k]) && n[k].some((x: any) => x && typeof x === 'object'))) here = name;
    for (const k of Object.keys(n)) if (k !== 'offers') walk(n[k], here, depth + 1);
  };
  walk(root, '', 0);
  return out;
}
function decode(s: string) {
  return s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function jsonBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html))) {
    const attrs = m[1], body = m[2].trim();
    if (!body) continue;
    if (/application\/(ld\+)?json/i.test(attrs) || /id=["']__NEXT_DATA__["']/i.test(attrs)) { try { out.push(JSON.parse(body)); } catch { /* not JSON */ } }
    else {   // state assigned in a script: window.__INITIAL_STATE__ = {...}
      const a = body.match(/^(?:window\.)?__[A-Z_]+__\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
      if (a) { try { out.push(JSON.parse(a[1])); } catch { /* not JSON */ } }
    }
  }
  return out;
}
function pageText(html: string) {
  return decode(html.replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|td|th|h[1-6]|section|article|span|a|button|dt|dd|label)>/gi, '$&\n')
    .replace(/<[^>]+>/g, ' '))
    .split('\n').map(l => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean)
    .filter((l, i, a) => l !== a[i - 1]).join('\n').slice(0, 80000);
}
function menuImages(html: string, base: URL): string[] {
  const out: string[] = []; const re = /<(img|a)\b[^>]*>/gi; let m;
  while ((m = re.exec(html)) && out.length < 8) {
    const tag = m[0];
    const src = (tag.match(/\b(?:data-src|src|href)=["']([^"']+)["']/i) || [])[1];
    if (!src || !/\.(jpe?g|png|webp)(\?|$)/i.test(src)) continue;
    if (!/menu|منيو|قائمة|منيـو/i.test(tag)) continue;
    try { const u = new URL(decode(src), base).href; if (!out.includes(u)) out.push(u); } catch { /* bad link */ }
  }
  return out;
}

async function isAdmin(token: string): Promise<boolean> {
  if (!token || token.length < 16) return false;
  const url = Deno.env.get('SUPABASE_URL')!, key = Deno.env.get('SUPABASE_ANON_KEY')!;
  try {
    const r = await fetch(url + '/rest/v1/rpc/tq_hello', { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_token: token }) });
    const d = await r.json();
    return !!(d && d.person && d.person.isAdmin);
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ kind: 'fail', reason: 'method' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ kind: 'fail', reason: 'badRequest' }, 400); }
  if (!await isAdmin(String(body.token || ''))) return json({ kind: 'fail', reason: 'adminsOnly' }, 403);
  const url = String(body.url || '').trim();
  if (!url) return json({ kind: 'fail', reason: 'badUrl' });

  const res = await get(url, body.image ? 'image/*' : 'text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5');
  if ('fail' in res) return json({ kind: 'fail', reason: res.fail });
  const type = (res.headers.get('content-type') || '').toLowerCase();

  if (type.startsWith('image/')) {
    const bytes = await readCapped(res, MAX_IMG);
    if (!bytes) return json({ kind: 'fail', reason: 'tooBig' });
    return json({ kind: 'image', dataUrl: `data:${type.split(';')[0]};base64,${b64(bytes)}` });
  }
  if (body.image) return json({ kind: 'fail', reason: 'notImage' });
  if (type.includes('pdf')) return json({ kind: 'fail', reason: 'pdf' });
  if (type && !type.includes('html') && !type.includes('xml') && !type.includes('text')) return json({ kind: 'fail', reason: 'type' });

  const bytes = await readCapped(res, MAX_HTML);
  if (!bytes) return json({ kind: 'fail', reason: 'tooBig' });
  const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const title = decode(((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim()).slice(0, 120);
  if (/captcha|cf-chl|access denied|attention required|pardon our interruption/i.test(title + html.slice(0, 3000))) return json({ kind: 'fail', reason: 'blocked', title });

  let items: { name: string; price: number; category: string }[] = [];
  for (const b of jsonBlocks(html)) { const found = collect(b); if (found.length > items.length) items = found; }
  if (items.length >= 3) return json({ kind: 'items', items: items.slice(0, 1500), title });

  const text = pageText(html);
  const images = menuImages(html, new URL(res.url || url));
  if (text.length < 40 && !images.length) return json({ kind: 'fail', reason: 'empty', title });
  return json({ kind: 'text', text, images, title });
});
