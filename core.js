/* ترويقة — الحسابات الأساسية (v2)
   Pure functions, no DOM: menu parsing, live estimates, bill split with flexible charges,
   payments and running balances. Loaded by the page and by the test script. */
(function (root) {
  'use strict';

  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
  const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

  function latinDigits(s) {
    return String(s == null ? '' : s)
      .replace(/[٠-٩]/g, d => AR_DIGITS.indexOf(d))
      .replace(/[۰-۹]/g, d => FA_DIGITS.indexOf(d))
      .replace(/٫/g, '.')
      .replace(/،/g, ',');
  }
  function num(v) {
    const n = parseFloat(latinDigits(v).replace(/,/g, ''));
    return isFinite(n) ? n : 0;
  }
  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function fmtMoney(n) {
    const v = round2(num(n));
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }

  /* Egyptian-friendly phone → international digits for wa.me */
  function waPhone(p, cc) {
    cc = cc || '20';
    let d = latinDigits(p).replace(/\D/g, '');
    if (!d) return '';
    if (d.startsWith('00')) d = d.slice(2);
    if (d.startsWith(cc)) return d;
    if (d.startsWith('0')) return cc + d.slice(1);
    if (d.length === 10 && d.startsWith('1')) return cc + d;
    return d;
  }
  function isValidPhone(p) {
    const d = latinDigits(p).replace(/\D/g, '');
    return d.length >= 10 && d.length <= 15;
  }

  /* ---------------- Menu import ----------------
     Works with three kinds of text:
     1. One item per line:              فول بالزيت الحار - 20
     2. Text copied from talabat.com:   name / (name again) / description / EGP 30.00
     3. Section lines:                  # مشروبات   or   #### Drinks   or   مشروبات:
  */
  const CUR = '(?:egp|le|l\\.e\\.?|ج\\.?\\s?م\\.?|جنيه|جنية)';
  const PRICE_LINE = new RegExp('^(?:' + CUR + '\\s*)?\\d+(?:[.,]\\d{1,2})?(?:\\s*' + CUR + ')?(?:\\s+(?:' + CUR + '\\s*)?\\d+(?:[.,]\\d{1,2})?(?:\\s*' + CUR + ')?)*$', 'i');
  const HAS_CUR = new RegExp(CUR, 'i');
  const NOISE = /^(loading|add|\+|أضف|اضف|إضافة|new|جديد|popular|الأكثر طلبا|picks for you.*|\d+\s*(egp|ج\.?م)?\s*&\s*less|.*min\.?\s*order.*|.*الحد الأدنى.*|order:.*)$/i;
  const NO_PRICE = /^(price on selection|السعر حسب الاختيار|حسب الاختيار)$/i;

  function lastNumber(latin) {
    const all = latin.match(/\d+(?:[.,]\d{1,2})?/g);
    return all ? num(all[all.length - 1].replace(',', '.')) : 0;
  }
  function looksLikeDescription(s) {
    const words = s.split(/\s+/).length;
    return /[.!،,]$/.test(s) || words > 6 || s.length > 38;
  }
  function cleanName(s) {
    return s.replace(/^[\s\-–—:|,=•*.]+|[\s\-–—:|,=•*.]+$/g, '').trim();
  }

  // the price shown next to a currency on a line ("EGP 12.00", "12.00 ج.م"); the last one wins (old price is struck through)
  function currencyPrice(latin) {
    // a line is written either "EGP 12.00" or "12.00 ج.م"; read it in its own direction
    const before = [], after = [];
    let m;
    const a = new RegExp('(?:' + CUR + ')\\s*(\\d+(?:[.,]\\d{1,2})?)', 'gi');
    while ((m = a.exec(latin))) before.push(m[1]);
    const b = new RegExp('(\\d+(?:[.,]\\d{1,2})?)\\s*(?:' + CUR + ')', 'gi');
    while ((m = b.exec(latin))) after.push(m[1]);
    const startsWithCur = new RegExp('^\\W*(?:' + CUR + ')', 'i').test(latin);
    const list = (startsWithCur && before.length) || !after.length ? before : after;
    const last = list[list.length - 1];
    return last ? num(last.replace(',', '.')) : 0;
  }
  function isPriceLine(latin) {
    if (!HAS_CUR.test(latin) || !currencyPrice(latin)) return false;
    const rest = latin.replace(new RegExp(CUR, 'gi'), '').replace(/[\d.,\-–—:|/\\()\s]/g, '');
    return rest.length <= 4;    // allow a little recognition noise around the price
  }

  /* Text recognised from screenshots has its own habits: long descriptions wrap onto several lines,
     and stray marks appear. Join wrapped lines so each item is name / description / price. */
  function joinWrapped(lines) {
    const out = [];
    for (const line of lines) {
      const prev = out[out.length - 1];
      if (prev && prev.length > 28 && !isPriceLine(latinDigits(prev)) && !isPriceLine(latinDigits(line)) && !/^#/.test(line)
          && !/[.!؟?]$/.test(prev)) {
        out[out.length - 1] = prev + ' ' + line;
      } else out.push(line);
    }
    return out;
  }

  function parseMenu(text, opts) {
    opts = opts || {};
    const items = [];
    const skipped = [];
    let category = '';
    let buf = [];

    const flushAs = (price) => {
      // de-duplicate consecutive identical lines (talabat repeats the name as image text)
      const lines = buf.filter((l, i) => i === 0 || l !== buf[i - 1]);
      buf = [];
      if (!lines.length) return;
      let name, cat = null;
      if (lines.length === 1) name = lines[0];
      else {
        const last = lines[lines.length - 1];
        if (looksLikeDescription(last)) {
          name = lines[lines.length - 2];
          if (lines.length === 3 && lines[0].length <= 30) cat = lines[0];
        } else {
          name = last;
          if (lines.length === 2 && lines[0].length <= 30 && !looksLikeDescription(lines[0])) cat = lines[0];
        }
      }
      name = cleanName(name);
      if (cat) category = cleanName(cat);
      if (!name) return;
      if (price > 0) items.push({ name, price: round2(price), category });
      else skipped.push(name);
    };

    let lines = String(text || '').replace(/[\u200e\u200f\u202a-\u202e]/g, '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim());
    if (opts.ocr) lines = joinWrapped(lines.filter(Boolean));
    for (const line of lines) {
      if (!line) continue;
      const latin = latinDigits(line);
      if (/^#/.test(line)) { buf = []; category = cleanName(line.replace(/^#+/, '').replace(/[\u{1F300}-\u{1FAFF}\u2B50]/gu, '')); continue; }
      if (NOISE.test(latin)) continue;
      if (NO_PRICE.test(line)) { flushAs(0); continue; }
      if (/[:：]$/.test(line) && !/\d/.test(latin)) { buf = []; category = cleanName(line.replace(/[:：]$/, '')); continue; }
      if (isPriceLine(latin)) { flushAs(currencyPrice(latin)); continue; }
      if (!opts.ocr && PRICE_LINE.test(latin) && buf.length) { flushAs(lastNumber(latin)); continue; }
      // single-line item: text followed by a price at the end
      const m = latin.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:egp|le|ج\.?\s?م\.?|جنيه|جنية)?\.?\s*$/i);
      const hasCur = HAS_CUR.test(latin.slice(m ? m.index : 0));
      if (m && (!opts.ocr || hasCur) && /[^\d\s.,\-–—:|=•*]/.test(latin.slice(0, m.index))) {
        if (buf.length) { skipped.push(...buf.filter(b => !looksLikeDescription(b)).slice(-1)); buf = []; }
        const name = cleanName(line.slice(0, m.index).replace(new RegExp(CUR + '\\s*$', 'i'), ''));
        const price = num(m[1].replace(',', '.'));
        if (name && price > 0) items.push({ name, price: round2(price), category });
        else skipped.push(line);
        continue;
      }
      buf.push(line);
      if (buf.length > 6) buf.shift();
    }
    const seen = new Set();
    const unique = items.filter(it => { const k = it.name + '|' + it.price; if (seen.has(k)) return false; seen.add(k); return true; });
    return { items: unique, skipped };
  }


  /* ---------------- Talabat receipt ("تفاصيل الطلب") ----------------
     Input: lines read from a receipt screenshot, each { ar, en } — the same line read once with the
     Arabic model (good for names) and once with the English model (good for digits).
     Output: items with quantity, line total and unit price, plus the charges and totals. */
  const RECEIPT_FIELDS = [
    ['subtotal', /(المجموع الفرعي|المجموع|الإجمالي الفرعي|subtotal|sub total|items total)/i],
    ['total', /(قيمة الطلب|الإجمالي|المبلغ الإجمالي|order total|^total|total amount|grand total)/i],
    ['delivery', /(رسوم التوصيل|التوصيل|delivery)/i],
    ['service', /(رسوم الخدمة|الخدمة|service)/i],
    ['discount', /(خصم|الخصم|قسيمة|كوبون|عرض|discount|voucher|coupon|promo)/i],
    ['tax', /(ضريبة|القيمة المضافة|vat|tax)/i],
    ['tip', /(إكرامية|اكرامية|بقشيش|tip)/i],
    ['other', /(رسوم|تغليف|fee|packaging|small order)/i]
  ];
  const SKIP_RECEIPT = /(طريقة الدفع|وقت التوصيل|رقم الهاتف|عرض الإيصال|احصل على مساعدة|payment method|delivery time|mobile number|view receipt|get help)/i;
  const hasArabic = s => /[؀-ۿ]/.test(s);

  function moneyIn(s) {
    const t = latinDigits(s);
    const all = t.match(/\d{1,5}[.,]\d{2}(?!\d)/g);
    if (all) return num(all[all.length - 1].replace(',', '.'));
    const cur = currencyPrice(t);
    return cur || null;
  }
  const MARK = '[x×X»«*•]';
  function qtyIn(en, ar) {
    const e = latinDigits(en || '');
    let m = e.match(/[x×X]\s*(\d{1,2})\s*$/) || e.match(/[x×X]\s*(\d{1,2})\b/) || e.match(/\b(\d{1,2})\s*[x×X]\b/);
    if (m) return +m[1];
    const a = latinDigits(ar || '');
    m = a.match(new RegExp('^\\s*(\\d{1,2})\\s*' + MARK)) || a.match(new RegExp(MARK + '\\s*(\\d{1,2})\\s*$')) || a.match(new RegExp('^\\s*' + MARK + '+\\s*(\\d{1,2})\\b'));
    return m ? +m[1] : 0;
  }
  const looksLikeItem = (ar, en) => new RegExp('^\\s*\\d{0,2}\\s*' + MARK).test(latinDigits(ar)) || /[x×X]\s*\d{1,2}\s*$/.test(latinDigits(en));
  function receiptName(ar, en, hadQty) {
    const src = hasArabic(ar) ? ar : en;
    let n = latinDigits(src).replace(/[‎‏]/g, '');
    n = n.replace(new RegExp('^\\s*\\d{1,2}\\s*' + MARK + '+\\s*'), '').replace(new RegExp('^\\s*' + MARK + '+\\s*\\d{0,2}\\s*'), '');
    n = n.replace(new RegExp('\\s*' + MARK + '\\s*\\d{1,2}\\s*$'), '');
    if (hadQty) n = n.replace(/^\s*\d{1,2}\s+/, '');
    n = n.replace(new RegExp('\\s*\\d+(?:[.,]\\d+)?\\s*(?:' + CUR + '|a\\.?z|ac|az|حم|\\.?\\s*م)?\\.?\\s*$', 'i'), '');
    n = n.replace(new RegExp('^\\s*(?:' + CUR + '|a\\.?z)\\s*\\d+(?:[.,]\\d+)?\\s*', 'i'), '');
    n = n.replace(new RegExp('\\s*(?:' + CUR + ')\\s*$', 'i'), '').replace(/[«»*•]/g, '');
    return cleanName(n);
  }
  const DATE_RE = /(\d{1,2})\/(\d{1,2})\/(20\d{2})/;
  function receiptMeta(lines) {
    const meta = { restaurant: '', date: '', orderNo: '' };
    for (let i = 0; i < lines.length; i++) {
      const ar = latinDigits(lines[i].ar || ''), en = latinDigits(lines[i].en || '');
      const d = (en.match(DATE_RE) || ar.match(DATE_RE));
      if (d && !meta.date) {
        meta.date = d[3] + '-' + d[2].padStart(2, '0') + '-' + d[1].padStart(2, '0');
        const words = s => String(s || '').replace(/[^؀-ۿA-Za-z\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
        let name = words(lines[i - 1] && lines[i - 1].ar).join(' ');
        if (!name) name = words(ar).filter(w => /[؀-ۿ]/.test(w)).join(' ');
        if (name && !/تفاصيل|order/i.test(name) && name.split(' ').some(w => w.length >= 3)) meta.restaurant = name;
      }
      if (/رقم الطلب|order (no|number|#)/i.test(ar + ' ' + en)) {
        const n = (en.match(/\d{7,}/) || ar.match(/\d{7,}/));
        if (n) meta.orderNo = n[0];
      }
    }
    return meta;
  }

  function parseReceipt(lines) {
    const items = [], fees = [];
    const out = { items, fees, subtotal: null, total: null };
    Object.assign(out, receiptMeta(lines || []));
    let started = false, last = null, part = 0;
    const seenPrev = new Set(), seenThis = new Set();
    for (const raw of lines || []) {
      if (raw.sep) { part++; for (const k of seenThis) seenPrev.add(k); seenThis.clear(); last = null; continue; }
      const ar = String(raw.ar || raw.text || '').replace(/\s+/g, ' ').trim();
      const en = String(raw.en || '').replace(/\s+/g, ' ').trim();
      const label = hasArabic(ar) ? ar : en;
      if (!label || SKIP_RECEIPT.test(label) || SKIP_RECEIPT.test(en)) { last = null; continue; }
      let price = moneyIn(en);
      if (price == null) { const p = moneyIn(ar); if (p) price = p; }
      const qty = qtyIn(en, ar);
      const isItem = qty || looksLikeItem(ar, en);
      let kind = null;
      for (const [k, re] of RECEIPT_FIELDS) if (re.test(label) || re.test(en)) { kind = k; break; }
      if (isItem && !kind) {
        started = true;
        const name = receiptName(ar, en, !!qty);
        if (!name) continue;
        const it = { qty: qty || 1, total: price != null ? round2(price) : null, name, note: '' };
        it.unit = it.total != null ? round2(it.total / it.qty) : null;
        if (!qty || price == null) it.unsure = true;
        if (!hasArabic(ar) && lines.some(l => hasArabic(l.ar || ''))) it.nameUnsure = true;
        const key = it.name + '|' + it.qty + '|' + it.total;
        if (part > 0 && seenPrev.has(key)) { last = null; continue; }   // same line seen at the bottom of the previous screenshot
        seenThis.add(key);
        items.push(it); last = it;
        continue;
      }
      if (price != null && (started || kind)) {
        if (kind === 'subtotal') out.subtotal = round2(price);
        else if (kind === 'total') out.total = round2(price);
        else if (kind) fees.push({ kind, label: cleanName(label.replace(new RegExp('[-−]?\\d+(?:[.,]\\d+)?\\s*(?:' + CUR + '|a\\.?z|ac|az|حم)?\\.?', 'gi'), '')) || kind, amount: round2(Math.abs(price)) });
        last = null;
        continue;
      }
      // a short line under an item, with no price or quantity, is that item's option / note ("عيش شامي")
      if (price == null && last && started && label.length <= 60 && !HAS_CUR.test(latinDigits(label))) {
        last.note = last.note ? last.note + '، ' + cleanName(label) : cleanName(label);
        continue;
      }
      last = null;
    }
    // one unreadable price? the subtotal tells us what it must be
    const known = items.filter(i => i.total != null && !(out.subtotal != null && i.total > out.subtotal));
    items.forEach(i => { if (i.total != null && out.subtotal != null && i.total > out.subtotal) { i.total = null; i.unit = null; i.unsure = true; } });
    const missing = items.filter(i => i.total == null);
    if (missing.length === 1 && out.subtotal != null) {
      const gap = round2(out.subtotal - known.reduce((s, i) => s + i.total, 0));
      if (gap > 0) { missing[0].total = gap; missing[0].unit = round2(gap / missing[0].qty); missing[0].fromGap = true; }
    }
    const itemsSum = round2(items.reduce((s, i) => s + (i.total || 0), 0));
    out.itemsSum = itemsSum;
    const feeSum = round2(fees.reduce((s, f) => s + (f.kind === 'discount' ? -f.amount : f.amount), 0));
    out.checks = {
      subtotal: out.subtotal == null ? null : Math.abs(out.subtotal - itemsSum) < 0.06,
      total: out.total == null ? null : Math.abs(out.total - round2((out.subtotal != null ? out.subtotal : itemsSum) + feeSum)) < 0.06
    };
    const svc = fees.find(f => f.kind === 'service');
    if (svc && (out.subtotal || itemsSum)) out.servicePct = Math.round(svc.amount / (out.subtotal || itemsSum) * 1000) / 10;
    return out;
  }

  /* 0..1 letter-level likeness, to catch reading slips like «مايونيز» / «مابيونيز» */
  function sameItem(a, b) {
    const x = normName(a), y = normName(b);
    if (x === y) return true;
    if (Math.abs(x.length - y.length) > 3) return false;
    const m = x.length, n = y.length, d = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    return d[m][n] <= Math.max(1, Math.floor(Math.max(m, n) * 0.12));
  }

  /* a line whose quantity couldn't be read: if the menu knows the unit price, the total tells the quantity */
  function inferQty(rc, menu) {
    for (const it of rc.items) {
      if (it.total == null || !(it.unsure || it.fromGap)) continue;
      const best = (menu || []).map(m => ({ m, s: similarity(m.name, it.name) })).sort((a, b) => b.s - a.s)[0];
      if (!best || best.s < 0.5 || !(num(best.m.price) > 0)) continue;
      const q = it.total / num(best.m.price);
      if (Math.abs(q - Math.round(q)) < 0.01 && Math.round(q) >= 1) { it.qty = Math.round(q); it.unit = round2(it.total / it.qty); it.qtyInferred = true; }
    }
    return rc;
  }

  /* how alike two item names are (0..1), for matching what people ordered to receipt lines */
  function normName(s) {
    return latinDigits(String(s || '').toLowerCase())
      .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[ًٌٍَُِّْـ]/g, '')
      .replace(/(ساندوتش|سندوتش|ساندويتش|sandwich|طبق|plate)/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  function similarity(a, b) {
    const A = normName(a).split(' ').filter(Boolean), B = normName(b).split(' ').filter(Boolean);
    if (!A.length || !B.length) return 0;
    const setB = new Set(B);
    const common = A.filter(w => setB.has(w) || B.some(x => x.length > 3 && (x.startsWith(w) || w.startsWith(x)))).length;
    return common / Math.max(A.length, B.length);
  }

  /* ---------------- Orders ---------------- */
  function memberSubtotal(m) {
    return round2(((m && m.items) || []).reduce((s, it) => s + num(it.price) * (num(it.qty) || 0), 0));
  }
  function eaters(cart) {
    const ms = cart.members || {};
    return Object.keys(ms).filter(k => ms[k].status !== 'out' && memberSubtotal(ms[k]) > 0);
  }

  /* Live estimate while people are still choosing.
     cart.estimate = { delivery, service, taxPct, tip } — typical charges saved with the restaurant.
     Returns the expected share of `key` (pass extraSub to preview adding an item). */
  function estimateFor(cart, key, extraSub) {
    const e = Object.assign({ delivery: 0, service: 0, servicePct: 0, taxPct: 0, tip: 0 }, cart.estimate || {});
    const ms = cart.members || {};
    const subs = {};
    for (const k of Object.keys(ms)) if (ms[k].status !== 'out') subs[k] = memberSubtotal(ms[k]);
    subs[key] = round2((subs[key] || 0) + (extraSub || 0));
    const keys = Object.keys(subs).filter(k => subs[k] > 0);
    const food = keys.reduce((s, k) => s + subs[k], 0);
    const sub = subs[key] || 0;
    if (sub <= 0) return { sub: 0, delivery: 0, fees: 0, tax: 0, total: 0, people: keys.length, food };
    const ratio = food > 0 ? sub / food : 0;
    const delivery = round2(num(e.delivery) / Math.max(1, keys.length));
    const fees = round2((num(e.service) + num(e.tip)) * ratio + sub * num(e.servicePct) / 100);
    const tax = round2(sub * num(e.taxPct) / 100);
    return { sub, delivery, fees, tax, total: round2(sub + delivery + fees + tax), people: keys.length, food };
  }

  /* Charges added at checkout. Each charge:
       { id, kind: delivery|service|tax|tip|shortage|discount|other, label, amount,
         split: 'equal' | 'share' | 'person', person: memberKey }
     equal  = same amount for everyone who ordered
     share  = in proportion to each person's food
     person = all of it on one person (falls back to equal if that person did not order) */
  const DEFAULT_SPLIT = { delivery: 'equal', service: 'share', tax: 'share', tip: 'equal', shortage: 'equal', discount: 'share', other: 'equal' };

  function computeBill(cart, prevBalances) {
    const ms = cart.members || {};
    const charges = (cart.charges || []).filter(c => num(c.amount) !== 0);
    const rows = eaters(cart).map(k => ({
      key: k, name: ms[k].name, phone: ms[k].phone, guest: !!ms[k].guest,
      items: (ms[k].items || []).filter(it => num(it.qty) > 0),
      subtotal: memberSubtotal(ms[k]), lines: [], exact: 0
    }));
    const food = round2(rows.reduce((s, r) => s + r.subtotal, 0));
    const n = rows.length;
    let chargesTotal = 0;
    for (const c of charges) {
      const sign = c.kind === 'discount' ? -1 : 1;
      const amount = round2(num(c.amount)) * sign;
      chargesTotal += amount;
      let split = c.split || DEFAULT_SPLIT[c.kind] || 'equal';
      if (split === 'person' && !rows.some(r => r.key === c.person)) split = 'equal';
      for (const r of rows) {
        let part = 0;
        if (split === 'equal') part = amount / Math.max(1, n);
        else if (split === 'share') part = food > 0 ? amount * r.subtotal / food : 0;
        else if (split === 'person') part = r.key === c.person ? amount : 0;
        part = round2(part);
        if (part !== 0) r.lines.push({ id: c.id, kind: c.kind, label: c.label, value: part });
      }
    }
    chargesTotal = round2(chargesTotal);
    for (const r of rows) r.exact = round2(r.subtotal + r.lines.reduce((s, l) => s + l.value, 0));
    rows.sort((a, b) => b.subtotal - a.subtotal || a.name.localeCompare(b.name));
    const grand = round2(food + chargesTotal);
    if (rows.length) { // piaster leftovers from splitting go to the biggest order
      const diff = round2(grand - rows.reduce((s, r) => s + r.exact, 0));
      if (diff) rows[0].exact = round2(rows[0].exact + diff);
    }
    const payments = cart.payments || {};
    for (const r of rows) {
      r.total = cart.roundUp ? Math.ceil(r.exact - 0.0001) : r.exact;
      if (r.key === cart.ownerId) {           // the host paid the restaurant, so their own share is settled
        Object.assign(r, { isHost: true, prev: 0, net: r.total, payment: null, paid: r.total, reported: 0, remaining: 0, state: 'host' });
        continue;
      }
      r.prev = round2((prevBalances && prevBalances[r.key]) || 0);   // + credit / − owed, with this same host
      r.net = round2(r.total - r.prev);                               // what to ask for now
      const p = payments[r.key];
      r.payment = p || null;
      r.paid = p && p.status === 'confirmed' ? round2(num(p.amount)) : 0;
      r.reported = p && p.status === 'reported' ? round2(num(p.amount)) : 0;
      r.remaining = round2(Math.max(0, r.net - r.paid));
      r.state = !p ? 'unpaid' : p.status === 'reported' ? 'reported' : (r.paid + 0.001 >= r.net ? 'paid' : 'partial');
    }
    const collected = round2(rows.reduce((s, r) => s + r.total, 0));
    const paidSum = round2(rows.reduce((s, r) => s + r.paid, 0));
    return { rows, food, chargesTotal, grand, collected, extra: round2(collected - grand), paidSum, people: n };
  }

  /* Running balances between each person and each host, across placed orders.
     Money is owed to whoever paid the restaurant, so balances are kept per (person, host) pair.
     balance > 0 → the person has credit with that host; balance < 0 → the person owes that host. */
  function balances(carts, opts) {
    opts = opts || {};
    const pairs = {};   // pairs[host][person] = { balance, name, phone, carts: [] }
    const list = (carts || [])
      .filter(c => (c.stage === 'ordered' || c.stage === 'settled') && c.id !== opts.excludeId)
      .filter(c => !opts.before || c.createdAt < opts.before)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const c of list) {
      const host = c.ownerId;
      pairs[host] = pairs[host] || {};
      const prev = {};
      for (const k of Object.keys(pairs[host])) prev[k] = pairs[host][k].balance;
      const bill = computeBill(c, prev);
      for (const r of bill.rows) {
        if (r.isHost) continue;
        const p = pairs[host][r.key] = pairs[host][r.key] || { key: r.key, host, hostName: c.ownerName, hostPhone: c.ownerPhone, name: r.name, phone: r.phone, balance: 0, carts: [] };
        p.name = r.name; p.phone = r.phone || p.phone; p.hostName = c.ownerName; p.hostPhone = c.ownerPhone;
        p.balance = round2(p.balance + r.paid - r.total);
        p.carts.push({ id: c.id, total: r.total, paid: r.paid, state: r.state, reported: r.reported, at: c.createdAt, rest: c.restaurant && c.restaurant.name });
      }
    }
    return pairs;
  }
  /* the balances one cart's bill should start from: this host's pairs from earlier orders */
  function prevFor(carts, cart) {
    const pairs = balances(carts, { excludeId: cart.id, before: cart.createdAt });
    const out = {};
    const mine = pairs[cart.ownerId] || {};
    for (const k of Object.keys(mine)) out[k] = mine[k].balance;
    return out;
  }

  /* Combined order for placing it on Talabat / by phone */
  function aggregate(cart) {
    const map = new Map();
    const ms = cart.members || {};
    for (const k of Object.keys(ms)) {
      const m = ms[k];
      if (m.status === 'out') continue;
      for (const it of (m.items || [])) {
        const qty = num(it.qty);
        if (qty <= 0) continue;
        const note = (it.note || '').trim();
        const key = it.name.trim() + '|' + num(it.price) + '|' + note;
        if (!map.has(key)) map.set(key, { name: it.name.trim(), price: num(it.price), note, qty: 0, who: [], custom: !!it.custom && !!it.noPrice });
        const row = map.get(key);
        row.qty += qty;
        row.who.push({ name: m.name, qty });
      }
    }
    const lines = Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, 'ar') || a.note.localeCompare(b.note));
    lines.forEach(l => { l.total = round2(l.qty * l.price); });
    return { lines, pieces: lines.reduce((s, l) => s + l.qty, 0), total: round2(lines.reduce((s, l) => s + l.total, 0)) };
  }

  function tallyVotes(cart) {
    const counts = {};
    for (const rid of (cart.candidates || [])) counts[rid] = 0;
    for (const k of Object.keys(cart.votes || {})) {
      const rid = cart.votes[k];
      if (rid in counts) counts[rid]++;
    }
    const order = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    return { counts, leader: order[0] || null, total: Object.keys(cart.votes || {}).length };
  }

  const api = { parseReceipt, inferQty, sameItem, similarity, normName, latinDigits, num, round2, fmtMoney, waPhone, isValidPhone, parseMenu, memberSubtotal, eaters, estimateFor, computeBill, balances, prevFor, aggregate, tallyVotes, DEFAULT_SPLIT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TarweeqaCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
