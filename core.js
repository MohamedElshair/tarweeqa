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
  // one account per mobile, however it is typed: 01003863737 = +201003863737 = 00201003863737 = 0201003863737 → 201003863737
  // (same rules as tq_norm_phone in the database)
  function normPhone(p) {
    let d = latinDigits(p).replace(/\D/g, '');
    if (d.startsWith('00')) d = d.slice(2);
    if (d.startsWith('020') && d.length === 13) d = d.slice(1);
    if (d.startsWith('200') && d.length === 13) d = '20' + d.slice(3);
    if (d.startsWith('0') && d.length === 11) d = '20' + d.slice(1);
    else if (d.startsWith('1') && d.length === 10) d = '20' + d;
    return d;
  }
  // Egyptian mobile: 01 + 9 digits (10 digits after the leading 0)
  const isEgMobile = p => /^201[0125]\d{8}$/.test(normPhone(p));
  // the way people write it here: 01xxxxxxxxx
  const localMobile = p => { const d = normPhone(p); return /^20\d{10}$/.test(d) ? '0' + d.slice(2) : d; };
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
  /* screenshots (Talabat app): screen furniture that is never a menu item */
  const BOLD = '\u2063';   // marks a line printed in black/bold (item names) by the screenshot reader
  const OCR_NOISE = /(طلب جماعي|طلب جماعى|أضف منتجات|اضف منتجات|لتبدأ الطلب|لتبدا الطلب|الحد الأدنى|الحد الادنى|رسوم التوصيل|التوصيل خلال|توصيل مجاني|عرض السلة|اعرض السلة|ابحث في|ابحث عن|تقييم|مراجعات|دقيقة|دقائق|مفتوح الآن|مغلق|الأكثر طلب|الاكثر طلب|sponsored|min\.? ?order|delivery fee|view (basket|cart)|group order|add items worth|to start your order|talabat|طلبات برو|talabat pro)/i;
  const letterCount = s => (String(s).match(/[\p{L}]/gu) || []).length;
  // a line from a screenshot worth reading: enough letters, not mostly symbols and digits (status bar, icons)
  function ocrUseful(line) {
    const n = letterCount(line);
    return n >= 4 && n / Math.max(1, line.replace(/\s/g, '').length) >= 0.6;
  }
  /* tidy a name read from a screenshot: drop symbols, digits and the 1–2 letter crumbs OCR leaves at the ends */
  function cleanOcrName(s) {
    let w = String(s || '').replace(/[\u2063\u200e\u200f]/g, '').replace(/[<>«»*|_=~^\[\]{}()"'`؛;:!?؟،,…]+/g, ' ').replace(/\d+(?:[.,]\d+)?/g, ' ')
      .replace(/\.+/g, ' ').split(/\s+/).filter(Boolean);
    while (w.length > 2 && letterCount(w[w.length - 1]) <= 2) w.pop();
    while (w.length > 2 && letterCount(w[0]) <= 1) w.shift();
    const name = w.join(' ').trim();
    return w.some(x => letterCount(x) >= 3) && letterCount(name) >= 4 ? name : '';
  }
  // a section title read from a screenshot: a few real words, no stray letters
  const okCategory = c => !!c && c.split(' ').length <= 4 && c.split(' ').every(x => letterCount(x) >= 2);
  // the gray line under an item name: ends with a full stop or "and…", has a full stop inside, is long, or repeats the name and adds to it
  function ocrDescription(line, before) {
    if (looksLikeDescription(line) || /\.\s*\S/.test(line) || /\s(و|او|أو|مع|ب)$/.test(line)) return true;
    if (!before) return false;
    const A = new Set(normName(before).split(' ').filter(x => x.length > 2));
    const shared = normName(line).split(' ').filter(x => A.has(x)).length;
    return shared >= 2 && line.length > before.length;
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
      if (opts.ocr) {
        // Talabat card: [section title] / name / description / price. Names are black and bold, descriptions gray.
        const bolds = lines.filter(l => l.startsWith(BOLD));
        if (bolds.length) {
          const nm = cleanOcrName(bolds[bolds.length - 1].slice(1));
          if (bolds.length >= 2) { const c = cleanOcrName(bolds[bolds.length - 2].slice(1)); if (okCategory(c) && similarity(c, nm) < 0.5) category = c; }
          if (nm && price > 0) items.push({ name: nm, price: round2(price), category });
          else if (nm) skipped.push(nm);
          return;
        }
        // no ink information: the name is the line before the first description line
        const keep = [];
        for (const l of lines) { if (keep.length && ocrDescription(l, keep[keep.length - 1])) break; keep.push(l); }
        while (keep.length > 1 && ocrDescription(keep[keep.length - 1], keep[keep.length - 2])) keep.pop();
        while (keep.length > 1 && ocrDescription(keep[keep.length - 1], keep[keep.length - 2])) keep.pop();
        if (keep.length === 1 && looksLikeDescription(keep[0]) && lines.length === 1) { skipped.push(lines[0]); return; }
        const nm = cleanOcrName(keep[keep.length - 1]);
        if (keep.length >= 2 && keep[0].length <= 30) { const c = cleanOcrName(keep[keep.length - 2]); if (okCategory(c) && similarity(c, nm) < 0.5) category = c; }
        if (!nm) return;
        if (price > 0) items.push({ name: nm, price: round2(price), category });
        else skipped.push(nm);
        return;
      }
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
    // screenshots: drop screen furniture first, and the stray comma OCR leaves at line ends.
    // Wrapped description lines are not joined: each one is recognised as description on its own.
    if (opts.ocr) lines = lines.filter(l => l && !OCR_NOISE.test(l) && (l.match(/\|/g) || []).length < 2).map(l => l.replace(/[\s،,]+$/, ''));
    for (const line of lines) {
      if (!line) continue;
      const latin = latinDigits(line);
      if (/^#/.test(line)) { buf = []; category = cleanName(line.replace(/^#+/, '').replace(/[\u{1F300}-\u{1FAFF}\u2B50]/gu, '')); continue; }
      if (NOISE.test(latin)) continue;
      if (opts.ocr && OCR_NOISE.test(line)) { buf = []; continue; }
      if (opts.ocr && !isPriceLine(latin) && !ocrUseful(line)) continue;
      if (NO_PRICE.test(line)) { flushAs(0); continue; }
      if (/[:：]$/.test(line) && !/\d/.test(latin)) { buf = []; category = cleanName(line.replace(/[:：]$/, '')); continue; }
      if (isPriceLine(latin)) { flushAs(currencyPrice(latin)); continue; }
      if (!opts.ocr && PRICE_LINE.test(latin) && buf.length) { flushAs(lastNumber(latin)); continue; }
      // single-line item: text followed by a price at the end
      const m = latin.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:egp|le|ج\.?\s?م\.?|جنيه|جنية)?\.?\s*$/i);
      const hasCur = HAS_CUR.test(latin.slice(m ? m.index : 0));
      if (m && (!opts.ocr || hasCur) && /[^\d\s.,\-–—:|=•*]/.test(latin.slice(0, m.index))) {
        const rawName = line.slice(0, m.index).replace(new RegExp(CUR + '\\s*$', 'i'), '');
        if (opts.ocr && (!cleanOcrName(rawName) || (buf.length && ocrDescription(rawName, buf[buf.length - 1])))) {
          if (cleanOcrName(rawName)) buf.push(rawName);   // the description sits on the price's row: the name is above
          flushAs(num(m[1].replace(',', '.'))); continue;  // crumbs next to the price: the name is above
        }
        if (buf.length) { skipped.push(...buf.filter(b => !looksLikeDescription(b)).slice(-1)); buf = []; }
        const name = opts.ocr ? cleanOcrName(rawName) : cleanName(rawName);
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
    unique.forEach(it => { it.name = fixSpelling(it.name); });
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
    for (const it of items) if (typeof it.name === 'string') it.name = fixSpelling(it.name);
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


  /* ---------------- Spelling of item names ----------------
     Every item name is corrected before it is saved or shown: «سندويتش» → «ساندويتش», «معصر» → «معصفر», «جبنه» → «جبنة».
     Only words listed here change (so a correct «بانيه» is never touched). Add a new fix as one line: 'wrong': 'right'. */
  const SPELL = {
    'سندويتش': 'ساندويتش', 'سندوتش': 'ساندويتش', 'ساندوتش': 'ساندويتش', 'سندويش': 'ساندويتش', 'ساندويش': 'ساندويتش',
    'سندوش': 'ساندويتش', 'ساندوش': 'ساندويتش', 'سنودتش': 'ساندويتش', 'ساندتش': 'ساندويتش',
    'سندويتشات': 'ساندويتشات', 'سندوتشات': 'ساندويتشات', 'ساندوتشات': 'ساندويتشات', 'سندويشات': 'ساندويتشات',
    'معصر': 'معصفر', 'مقصفر': 'معصفر', 'معصفره': 'معصفرة', 'معصره': 'معصفرة',
    'طعميه': 'طعمية', 'جبنه': 'جبنة', 'جبنا': 'جبنة', 'بسطرمه': 'بسطرمة', 'بسطرما': 'بسطرمة', 'شكشوكه': 'شكشوكة',
    'طحينه': 'طحينة', 'سلطه': 'سلطة', 'كفته': 'كفتة', 'مسقعه': 'مسقعة', 'محمره': 'محمرة', 'بيضه': 'بيضة',
    'زبده': 'زبدة', 'قشطه': 'قشطة', 'حلاوه': 'حلاوة', 'مربه': 'مربى', 'مربة': 'مربى', 'مربا': 'مربى',
    'شاورمه': 'شاورما', 'شاورمة': 'شاورما', 'شورما': 'شاورما', 'بطاطه': 'بطاطا', 'بطاطة': 'بطاطا',
    'مكرونه': 'مكرونة', 'مكرونا': 'مكرونة', 'بشاميل': 'بشاميل', 'فطيره': 'فطيرة', 'كريمه': 'كريمة',
    'زيتونه': 'زيتونة', 'ليمونه': 'ليمونة', 'قهوه': 'قهوة', 'شوربه': 'شوربة', 'وجبه': 'وجبة', 'اضافه': 'إضافة',
    'سجق': 'سجق', 'سوسيس': 'سوسيس', 'هوتدوج': 'هوت دوج', 'هوت دوغ': 'هوت دوج',
    'اومليت': 'أومليت', 'أمليت': 'أومليت', 'امليت': 'أومليت', 'اومليط': 'أومليت',
    'اسكندراني': 'إسكندراني', 'اسكندرانى': 'إسكندراني', 'كرواسن': 'كرواسون', 'كرواسان': 'كرواسون', 'كرواصون': 'كرواسون',
    'ببسي': 'بيبسي', 'بيبسى': 'بيبسي', 'فلافيل': 'فلافل', 'مدمز': 'مدمس', 'مايونيز': 'مايونيز', 'مابيونيز': 'مايونيز', 'ماينيز': 'مايونيز',
    'بابغنوج': 'بابا غنوج', 'باباغنوج': 'بابا غنوج', 'بتنجان': 'باذنجان', 'بدنجان': 'باذنجان', 'رومى': 'رومي', 'بلدى': 'بلدي', 'شامى': 'شامي',
    'تنجان': 'باذنجان', 'بدنجان': 'باذنجان', 'مكس': 'ميكس', 'بوريه': 'بيوريه', 'بيوري': 'بيوريه', 'كاتشاب': 'كاتشب', 'كتشب': 'كاتشب', 'فرنساوى': 'فرنساوي', 'مقليه': 'مقلية',
    'سندتش': 'ساندويتش', 'سندوتشة': 'ساندويتش', 'ساده': 'سادة', 'عجه': 'عجة', 'محشيه': 'محشية', 'سمنه': 'سمنة', 'كبده': 'كبدة',
    'باتيبان': 'باتي بان', 'رغيق': 'رغيف', 'موززيلا': 'موتزاريلا', 'موزاريلا': 'موتزاريلا', 'موتزريلا': 'موتزاريلا', 'باكت': 'باكيت',
    'قدره': 'قدرة', 'كلوسلو': 'كول سلو', 'كولسلو': 'كول سلو', 'مشويه': 'مشوية', 'متبله': 'متبلة', 'عجينه': 'عجينة', 'علبه': 'علبة', 'خلطه': 'خلطة'
  };
  const spellKey = w => String(w).replace(/[ً-ْـ]/g, '').replace(/[إأآ]/g, 'ا');
  const SPELL_IX = Object.fromEntries(Object.entries(SPELL).map(([a, b]) => [spellKey(a), b]));
  const SPELL_PRE = ['وبال', 'بال', 'وال', 'لل', 'ال', 'و', 'ب'];
  function fixWord(w) {
    const k = spellKey(w);
    if (SPELL_IX[k]) return SPELL_IX[k];
    for (const pre of SPELL_PRE) {
      if (k.length > pre.length + 2 && k.startsWith(pre)) {
        const rest = SPELL_IX[k.slice(pre.length)];
        if (rest) return w.slice(0, pre.length) + rest;
      }
    }
    return w;
  }
  function fixSpelling(name) {
    if (name == null || typeof name !== 'string') return name;
    const s = name.replace(/ـ/g, '').replace(/\s+/g, ' ').trim();
    // two-word fixes first («هوت دوغ»), then word by word
    let out = s;
    for (const [a, b] of Object.entries(SPELL)) if (a.includes(' ') && out.includes(a)) out = out.split(a).join(b);
    return out.split(' ').map(fixWord).join(' ');
  }
  const fixList = list => Array.isArray(list) ? list.map(it => {
    if (!it || typeof it !== 'object') return it;
    const x = Object.assign({}, it);
    if (typeof x.name === 'string') x.name = fixSpelling(x.name);
    if (typeof x.category === 'string') x.category = fixSpelling(x.category);
    if (Array.isArray(x.opts)) x.opts = x.opts.map(o => o && typeof o.n === 'string' ? Object.assign({}, o, { n: fixSpelling(o.n), g: typeof o.g === 'string' ? fixSpelling(o.g) : o.g }) : o);
    if (Array.isArray(x.choices)) x.choices = fixList(x.choices);
    return x;
  }) : list;
  function fixMember(m) { return m && typeof m === 'object' && Array.isArray(m.items) ? Object.assign({}, m, { items: fixList(m.items) }) : m; }
  // a restaurant, a cart, or a patch for either: only item names, categories and option names change — never people's or restaurants' names
  function spellData(d) {
    if (!d || typeof d !== 'object') return d;
    const x = Object.assign({}, d);
    for (const k of Object.keys(x)) {
      if (k === 'items' || k === 'shared' || k === 'optGroups' || /\.items$/.test(k)) x[k] = fixList(x[k]);
      else if (k === 'members' && x[k] && typeof x[k] === 'object') x[k] = Object.fromEntries(Object.entries(x[k]).map(([a, m]) => [a, fixMember(m)]));
      else if (/^members\.[^.]+$/.test(k)) x[k] = fixMember(x[k]);
    }
    return x;
  }

  /* ---------------- Orders ---------------- */
  function memberSubtotal(m) {
    return round2(((m && m.items) || []).reduce((s, it) => s + num(it.price) * (num(it.qty) || 0), 0));
  }
  /* Shared items (a bottle of water, a big plate for the table): cart.shared = [{ id, name, price, qty, keys: [memberKey…] }].
     Each sharer gets an equal part as one line of their own; leftover piasters go to the first sharer. */
  function withShared(cart) {
    const sh = (cart && cart.shared || []).filter(x => num(x.price) * num(x.qty || 1) > 0 && (x.keys || []).length);
    if (!sh.length) return cart;
    const ms = {};
    for (const k of Object.keys(cart.members || {})) ms[k] = Object.assign({}, cart.members[k], { items: (cart.members[k].items || []).slice() });
    for (const x of sh) {
      const keys = x.keys.filter(k => ms[k] ? ms[k].status !== 'out' : true);
      if (!keys.length) continue;
      const total = round2(num(x.price) * (num(x.qty) || 1));
      const part = Math.floor(total / keys.length * 100) / 100;
      let left = round2(total - part * keys.length);
      keys.forEach(k => {
        if (!ms[k]) ms[k] = { name: k, status: 'in', items: [] };
        const v = round2(part + left); left = 0;
        ms[k].items.push({ id: 'sh_' + x.id, name: x.name, price: v, qty: 1, shared: x.id, sharedN: keys.length, sharedTotal: total, sharedQty: num(x.qty) || 1 });
      });
    }
    return Object.assign({}, cart, { members: ms });
  }
  function eaters(cart) {
    cart = withShared(cart);
    const ms = cart.members || {};
    return Object.keys(ms).filter(k => ms[k].status !== 'out' && memberSubtotal(ms[k]) > 0);
  }

  /* Live estimate while people are still choosing.
     cart.estimate = { delivery, service, tax, tip } (amounts as on the invoice; old ones may have servicePct/taxPct) — typical charges saved with the restaurant.
     Returns the expected share of `key` (pass extraSub to preview adding an item). */
  function estimateFor(cart, key, extraSub) {
    cart = withShared(cart);
    const e = Object.assign({ delivery: 0, service: 0, servicePct: 0, tax: 0, taxPct: 0, tip: 0 }, cart.estimate || {});
    const ms = cart.members || {};
    const subs = {};
    for (const k of Object.keys(ms)) if (ms[k].status !== 'out') subs[k] = memberSubtotal(ms[k]);
    subs[key] = round2((subs[key] || 0) + (extraSub || 0));
    const keys = Object.keys(subs).filter(k => subs[k] > 0);
    const food = keys.reduce((s, k) => s + subs[k], 0);
    const sub = subs[key] || 0;
    if (sub <= 0) return { sub: 0, delivery: 0, fees: 0, tax: 0, tq: 0, total: 0, people: keys.length, food };
    const ratio = food > 0 ? sub / food : 0;
    const delivery = round2(num(e.delivery) / Math.max(1, keys.length));
    const fees = round2((num(e.service) + num(e.tip)) * ratio + sub * num(e.servicePct) / 100);
    // service and tax are invoice amounts, shared by what each person ordered (old orders may still carry a %)
    const tax = round2(num(e.tax) * ratio + sub * num(e.taxPct) / 100);
    const tqc = cart.tqFee || {}, tqv = num(tqc.value);
    const tq = key === cart.ownerId || tqv <= 0 ? 0 : round2(tqc.mode === 'fixed' ? tqv : sub * tqv / 100);
    return { sub, delivery, fees, tax, tq, total: round2(sub + delivery + fees + tax + tq), people: keys.length, food };
  }

  /* Charges added at checkout. Each charge:
       { id, kind: delivery|service|tax|tip|shortage|discount|other, label, amount,
         split: 'equal' | 'share' | 'person', person: memberKey }
     equal  = same amount for everyone who ordered
     share  = in proportion to each person's food
     person = all of it on one person (falls back to equal if that person did not order) */
  const DEFAULT_SPLIT = { delivery: 'equal', service: 'share', tax: 'share', tip: 'equal', shortage: 'equal', discount: 'share', other: 'equal' };

  function computeBill(cart, prevBalances, opts) {
    const carried = (opts && opts.carried) || null;
    cart = withShared(cart);
    const ms = cart.members || {};
    const charges = (cart.charges || []).filter(c => num(c.amount) !== 0);
    const rows = eaters(cart).map(k => ({
      key: k, name: ms[k].name, phone: ms[k].phone, guest: !!ms[k].guest,
      items: (ms[k].items || []).filter(it => num(it.qty) > 0),
      subtotal: memberSubtotal(ms[k]), lines: [], exact: 0
    }));
    const food = round2(rows.reduce((s, r) => s + r.subtotal, 0));
    const n = rows.length;
    // host options: the host can stay out of the charges (the others share them) and/or take a fee per item
    const hostIn = rows.some(r => r.key === cart.ownerId);
    const exempt = !!cart.hostExempt && hostIn && n > 1;
    const payers = exempt ? rows.filter(r => r.key !== cart.ownerId) : rows;
    const payersFood = round2(payers.reduce((s, r) => s + r.subtotal, 0));
    let chargesTotal = 0;
    for (const c of charges) {
      const sign = c.kind === 'discount' ? -1 : 1;
      const amount = round2(num(c.amount)) * sign;
      chargesTotal += amount;
      let split = c.split || DEFAULT_SPLIT[c.kind] || 'equal';
      if (split === 'person' && !payers.some(r => r.key === c.person)) split = 'equal';
      if (split === 'share' && payersFood <= 0) split = 'equal';
      for (const r of rows) {
        let part = 0;
        if (exempt && r.key === cart.ownerId) part = 0;
        else if (split === 'equal') part = amount / Math.max(1, payers.length);
        else if (split === 'share') part = amount * r.subtotal / payersFood;
        else if (split === 'person') part = r.key === c.person ? amount : 0;
        part = round2(part);
        if (part !== 0) r.lines.push({ id: c.id, kind: c.kind, label: c.label, value: part });
      }
    }
    chargesTotal = round2(chargesTotal);
    for (const r of rows) r.exact = round2(r.subtotal + r.lines.reduce((s, l) => s + l.value, 0));
    rows.sort((a, b) => b.subtotal - a.subtotal || a.name.localeCompare(b.name));
    const grand = round2(food + chargesTotal);
    if (rows.length) { // piaster leftovers from splitting go to the biggest order that shares the charges
      const diff = round2(grand - rows.reduce((s, r) => s + r.exact, 0));
      const to = rows.find(r => !(exempt && r.key === cart.ownerId)) || rows[0];
      if (diff) to.exact = round2(to.exact + diff);
    }
    const fee = round2(num(cart.hostFee));
    let hostFees = 0;
    if (fee > 0) for (const r of rows) {
      if (r.key === cart.ownerId) continue;
      const q = r.items.reduce((s, it) => s + num(it.qty), 0);
      const v = round2(fee * q);
      if (!v) continue;
      r.lines.push({ id: 'hostFee', kind: 'hostFee', label: cart.hostFeeLabel || 'Host fee', value: v, perItem: fee, qty: q });
      r.exact = round2(r.exact + v); hostFees = round2(hostFees + v);
    }
    // Tarweeqa's commission: a % of each person's food, or a fixed amount per person (the host pays none)
    const tq = cart.tqFee || {}, tqv = num(tq.value);
    let tqFees = 0;
    if (tqv > 0) for (const r of rows) {
      if (r.key === cart.ownerId) continue;
      const v = round2(tq.mode === 'fixed' ? tqv : r.subtotal * tqv / 100);
      if (!v) continue;
      r.lines.push({ id: 'tqFee', kind: 'tqFee', label: cart.tqFeeLabel || 'Tarweeqa fee', value: v, pct: tq.mode === 'fixed' ? null : tqv });
      r.exact = round2(r.exact + v); tqFees = round2(tqFees + v);
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
      if (r.net <= 0.009 && r.state !== 'reported' && !r.paid) { r.state = 'paid'; r.byWallet = true; }   // the wallet covers this whole bill
      // still owed here, but a later order's bill already carries it: collect it there, not here
      if (carried && carried.has(r.key) && (r.state === 'unpaid' || r.state === 'partial') && r.remaining > 0.009) {
        r.carriedOwed = r.remaining; r.carriedTo = carried.get ? carried.get(r.key) : null; r.state = 'carried'; r.remaining = 0;
      }
    }
    const collected = round2(rows.reduce((s, r) => s + r.total, 0));
    const paidSum = round2(rows.reduce((s, r) => s + r.paid, 0));
    return { rows, food, chargesTotal, grand, collected, extra: round2(collected - grand - hostFees - tqFees), hostFees, tqFees, exempt, paidSum, people: n };
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

  /* Unpaid amounts from this host's earlier orders, one line per order, for the bill of `cart`:
     { personKey: [{ id, rest, at, due }] }. Their sum is what the bill adds as "owed from earlier orders". */
  function prevDetail(carts, cart) {
    const pairs = balances(carts, { excludeId: cart.id, before: cart.createdAt });
    const mine = pairs[cart.ownerId] || {};
    const out = {};
    for (const k of Object.keys(mine)) {
      if (mine[k].balance > 0.009) {
        // wallet: where the extra money came from (paid more than the bill)
        let left = round2(mine[k].balance); const list = [];
        for (const x of mine[k].carts.slice().reverse()) {
          if (left <= 0.009) break;
          const extra = round2(Math.min(left, Math.max(0, x.paid - x.total)));
          if (extra > 0.009) { list.unshift({ id: x.id, rest: x.rest || '', at: x.at, due: extra, credit: true }); left = round2(left - extra); }
        }
        out[k] = list; continue;
      }
      if (mine[k].balance > -0.009) continue;
      // walk the orders newest first and keep the unpaid ones until they explain the whole debt
      let left = round2(-mine[k].balance); const list = [];
      for (const x of mine[k].carts.slice().reverse()) {
        if (left <= 0.009) break;
        const due = round2(Math.min(left, Math.max(0, x.total - x.paid)));
        if (due > 0.009) { list.unshift({ id: x.id, rest: x.rest || '', at: x.at, due }); left = round2(left - due); }
      }
      out[k] = list;
    }
    return out;
  }
  /* People whose unpaid share of `cart` was moved onto a later bill of the same host: Map key → later cart id */
  function carriedKeys(carts, cart) {
    const out = new Map();
    for (const c of carts || []) {
      if (c.id === cart.id || c.ownerId !== cart.ownerId || !(c.stage === 'ordered' || c.stage === 'settled') || !(c.createdAt > cart.createdAt)) continue;
      for (const k of eaters(c)) if (k !== cart.ownerId && !out.has(k)) out.set(k, c.id);
    }
    return out;
  }

  /* Sort an item into a section by what it is (Egyptian breakfast menus): the main ingredient decides.
     Returns '' when nothing matches. */
  const CATS = [
    ['مشروبات', /(شاي|شاى|قهوه|نسكافيه|كابتشينو|عصير|مياه|ميه معدنيه|بيبسي|كوكا|كولا|سفن اب|سبرايت|مشروب|ينسون|كركديه|حليب|سحلب)/],
    ['حلويات', /(بسبوسه|كنافه|رز بلبن|ارز بلبن|مهلبيه|بقلاوه|شوكولات|نوتيلا|كيك|حلويات|حلاوه|قطايف|زلابيه|ام علي)/],
    ['فول', /(^|\s)فول(\s|$)/],
    ['فلافل', /(فلافل|طعميه)/],
    ['بطاطس', /(بطاطس|بطاطا|بوريه|بيوريه|مهروس|صوابع|شيبس|ودجز|wedges|فرايز|fries|potato)/],
    ['بيض وأومليت', /(بيض|اومليت|امليت|اومليط|شكشوكه)/],
    ['لحوم وفراخ', /(كبده|سجق|فراخ|فرخه|شاورما|برجر|برجير|لحم|بسطرمه|لانشون|هوت دوج|كفته|سوسيس|حواوشي|سمك|تونه)/],
    ['جبن', /(جبن|رومي|موتزاريلا|موزريلا|شيدر|قريش|براميلي|حلوم|لبنه)/],
    ['سلطات وأطباق جانبية', /(سلطه|طحينه|بابا غنوج|مخلل|بتنجان|باذنجان|حمص|بصل|طرشي|صوص)/],
    ['عيش وإضافات', /(عيش|خبز|رغيف|اضافه|اضافات|اكسترا|extra)/]
  ];
  function autoCategory(name) {
    const n = ' ' + normName(name) + ' ';
    for (const [cat, re] of CATS) if (re.test(n)) return cat;
    return '';
  }

  /* ---------------- Item options (e.g. eggs: fried / boiled) ----------------
     A restaurant keeps optGroups = [{ id, name, required, multi, max, choices: [{ id, name, price }] }]
     and each menu item lists the groups it uses in og = [groupId…].
     An ordered item keeps a copy of what was picked: opts = [{ g, n, p }] (group name, choice name, extra price),
     optDelta = the extra money, base = the item's own price, price = base + optDelta. */
  function groupsFor(menuItem, groups) {
    const ids = (menuItem && menuItem.og) || [];
    return ids.map(id => (groups || []).find(g => g.id === id)).filter(g => g && (g.choices || []).length);
  }
  function optText(it) { return ((it && it.opts) || []).map(o => o.n).join('، '); }
  function optDelta(it) { return round2(((it && it.opts) || []).reduce((s, o) => s + num(o.p), 0)); }
  // what goes next to the item's name everywhere: the picked options, then the person's own note
  function itemNote(it) { return [optText(it), String((it && it.note) || '').trim()].filter(Boolean).join(' — '); }
  // sel = { groupId: [choiceId…] } → { opts, delta, missing: [group names still to pick], over: [groups with too many] }
  function pickOptions(groups, sel) {
    const opts = [], missing = [], over = [];
    for (const g of groups || []) {
      const ids = ((sel || {})[g.id] || []).filter(id => (g.choices || []).some(c => c.id === id));
      if (g.required && !ids.length) missing.push(g.name);
      const max = g.multi ? (num(g.max) || 0) : 1;
      if (max && ids.length > max) over.push(g.name);
      for (const c of g.choices || []) if (ids.includes(c.id)) opts.push({ g: g.name, n: c.name, p: round2(num(c.price)) });
    }
    return { opts, delta: round2(opts.reduce((s, o) => s + o.p, 0)), missing, over };
  }
  function optKey(it) { return ((it && it.opts) || []).map(o => o.g + ':' + o.n).join('|'); }

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
        const note = itemNote(it);
        const key = it.name.trim() + '|' + num(it.price) + '|' + note;
        if (!map.has(key)) map.set(key, { name: it.name.trim(), price: num(it.price), note, opt: optText(it), userNote: String(it.note || '').trim(), qty: 0, who: [], custom: !!it.custom && !!it.noPrice });
        const row = map.get(key);
        row.qty += qty;
        row.who.push({ name: m.name, qty });
      }
    }
    for (const x of cart.shared || []) {   // shared items are ordered once, for the table
      const qty = num(x.qty) || 1;
      if (num(x.price) <= 0 || !(x.keys || []).length) continue;
      const key = x.name.trim() + '|' + num(x.price) + '|';
      if (!map.has(key)) map.set(key, { name: x.name.trim(), price: num(x.price), note: '', opt: '', userNote: '', qty: 0, who: [], custom: false });
      const row = map.get(key);
      row.qty += qty; row.shared = true;
      row.who.push({ name: x.keys.map(k => (ms[k] && ms[k].name) || k).join('+'), qty });
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

  /* distance on the map (straight line, km) — free, no Google call */
  function distanceKm(a, b) {
    if (!a || !b || !isFinite(a.lat) || !isFinite(a.lng) || !isFinite(b.lat) || !isFinite(b.lng)) return null;
    const R = 6371, rad = x => x * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // where a restaurant stands against the delivery point: near / far / unknown (no verified place or no delivery point)
  function reach(rest, point, defaultKm) {
    const km = distanceKm(point, rest && rest.place);
    const limit = num(rest && rest.deliveryKm) || defaultKm || 3;
    if (km == null) return { km: null, limit, state: rest && rest.place ? 'nopoint' : 'unverified' };
    return { km: round2(km), limit, state: km <= limit ? 'near' : 'far' };
  }

  const api = { fixSpelling, spellData, SPELL, normPhone, isEgMobile, localMobile, groupsFor, optText, optDelta, itemNote, pickOptions, optKey, distanceKm, reach, withShared, parseReceipt, inferQty, sameItem, similarity, normName, latinDigits, num, round2, fmtMoney, waPhone, isValidPhone, parseMenu, memberSubtotal, eaters, estimateFor, BOLD, autoCategory, computeBill, balances, prevFor, prevDetail, carriedKeys, aggregate, tallyVotes, DEFAULT_SPLIT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TarweeqaCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
