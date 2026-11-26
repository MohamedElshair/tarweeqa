/* ترويقة — الواجهة (UI, v2) */
(function () {
  'use strict';

  const CFG = window.TARWEEQA_CONFIG || {};
  const I18N = window.TARWEEQA_I18N;
  const C = window.TarweeqaCore;
  const { LocalStore, CloudStore, SupaStore, rid, LS, clone } = window.TarweeqaStore;

  const S = {
    lang: LS.get('tarweeqa.lang') || 'ar',
    store: null, profile: null,
    gid: null, group: null, groups: [], restaurants: [], carts: [],
    route: { name: 'home' },
    draft: null, menuQuery: '', restQuery: '', actFor: null, sel: [],
    payMethod: {}, confirmKey: null, dirty: false, booted: false, fatal: null,
    pending: null,   // {gid, cid} from an invite / cart link
    history: {},     // restaurant name → price history rows
    rlist: {},       // restaurant name → saved receipts (no pictures)
    rview: null,     // the receipt open in the viewer
    sendQ: null,     // { cartId, keys, i } — sending invoices one by one
    invoiceView: null // standalone invoice page data
  };

  /* ---------- helpers ---------- */
  const $ = (sel, el) => (el || document).querySelector(sel);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  function t(key, vars) {
    let s = (I18N[S.lang] && I18N[S.lang][key]);
    if (s == null) s = I18N.ar[key];
    if (s == null) s = key;
    if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(vars[k]);
    return s;
  }
  const cur = () => (CFG.currency || {})[S.lang] || (S.lang === 'ar' ? 'ج.م' : 'EGP');
  const money = n => C.fmtMoney(n) + ' ' + cur();
  const comma = () => (S.lang === 'ar' ? '، ' : ', ');
  const loc = () => (S.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB');
  const fmtTime = ms => new Date(ms).toLocaleTimeString(loc(), { hour: 'numeric', minute: '2-digit' });
  const fmtDate = ms => new Date(ms).toLocaleDateString(loc(), { weekday: 'long', day: 'numeric', month: 'long' });
  function fmtAgo(ms) {
    if (!ms) return t('never');
    const d = Math.floor((startOfDay(Date.now()) - startOfDay(ms)) / 86400000);
    if (d <= 0) return t('today');
    if (d === 1) return t('yesterday');
    return t('daysAgo', { n: d });
  }
  function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  const isLocal = () => S.store && S.store.mode === 'local';
  const me = () => S.store.uid();
  const initial = n => (String(n || '?').trim()[0] || '?').toUpperCase();

  function fmtLeft(ms) {
    if (ms <= 0) return '0 ' + t('minShort');
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return h + t('hourShort') + ' ' + m + t('minShort');
    if (m >= 5) return m + ' ' + t('minShort');
    return m + ':' + String(sec).padStart(2, '0');
  }

  /* stage of an order as people see it */
  function stageOf(c) {
    if (!c) return 'closed';
    if (c.stage === 'ordering' && Date.now() >= c.closesAt) return 'closed';
    return c.stage;
  }
  const isOpenStage = st => st === 'voting' || st === 'ordering';
  const isActive = c => ['voting', 'ordering', 'closed'].includes(stageOf(c));
  const isHost = c => c && (c.ownerId === me() || isAdmin());
  const isAdmin = () => !!(S.group && (S.group.adminIds || []).includes(me()));
  const isOwner = () => !!(S.group && S.group.ownerId === me());
  const ADMIN_ROUTES = ['newOrder', 'restaurants', 'restaurant'];   // members only order: these screens are for admins
  const cartById = id => S.carts.find(c => c.id === id) || null;

  /* everyone in the group, plus anyone who joined this order */
  function people(c) {
    const out = {};
    const roster = (S.group && S.group.roster) || {};
    for (const k of Object.keys(roster)) out[k] = Object.assign({ key: k }, roster[k]);
    if (c) for (const k of Object.keys(c.members || {})) out[k] = Object.assign({ key: k }, out[k] || {}, { name: c.members[k].name, phone: c.members[k].phone || (out[k] || {}).phone, guest: c.members[k].guest || (out[k] || {}).guest });
    return out;
  }
  function personStatus(c, key) {
    const m = (c.members || {})[key];
    if (!m) return 'none';
    if (m.status === 'out') return 'out';
    if (m.done) return 'done';
    return (m.status === 'in' || C.memberSubtotal(m) > 0) ? 'picking' : 'none';
  }

  function waLink(phone, text) {
    const p = (isLocal() || !phone) ? '' : C.waPhone(phone, CFG.defaultCountryCode || '20');
    return 'https://wa.me/' + p + '?text=' + encodeURIComponent(text);
  }
  function baseUrl() {
    return (location.origin && location.origin !== 'null') ? location.origin + location.pathname : '';
  }
  const groupLink = gid => baseUrl() + '?g=' + encodeURIComponent(gid);
  const cartLink = c => baseUrl() + '?g=' + encodeURIComponent(c.groupId || S.gid) + '&c=' + encodeURIComponent(c.id);

  let toastTimer = null;
  function toast(msg, kind) {
    const el = $('#toast'); if (!el) return;
    el.textContent = msg; el.dataset.kind = kind || ''; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast(t('copied')); }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (e2) { }
      ta.remove(); toast(ok ? t('copied') : t('copyFail'), ok ? '' : 'warn');
    }
  }
  async function guard(p) {
    try { return await p; } catch (e) { console.warn(e); toast(t('errWrite'), 'warn'); return null; }
  }

  /* money between people: pairs[host][person] (see core.js) */
  let _pairs = null, _pairsKey = '';
  function pairs() {
    const k = S.carts.length + ':' + S.carts.map(c => c.id + (c._v || '')).join(',') + JSON.stringify(S.carts.map(c => [c.stage, c.payments, c.charges, c.roundUp]));
    if (k !== _pairsKey) { _pairs = C.balances(S.carts); _pairsKey = k; }
    return _pairs;
  }
  function prevFor(c) { return C.prevFor(S.carts, c); }

  /* ---------- rendering ---------- */
  let renderQueued = false;
  function render(force) {
    const app = $('#app');
    const ae = document.activeElement;
    if (!force && ae && app.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && !['checkbox', 'radio', 'button'].includes(ae.type)) {
      S.dirty = true; return;
    }
    S.dirty = false;
    document.documentElement.lang = S.lang;
    document.documentElement.dir = S.lang === 'ar' ? 'rtl' : 'ltr';
    document.title = t('appName');
    app.innerHTML = view();
    tick();
  }
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }
  function go(name, extra) {
    S.route = Object.assign({ name }, extra || {});
    S.confirmKey = null;
    if (name !== 'cart') S.actFor = null;
    if (!isLocal()) {
      try {
        let url = location.pathname;
        if (name === 'cart' && S.gid) url = '?g=' + encodeURIComponent(S.gid) + '&c=' + encodeURIComponent(extra.id);
        else if (S.gid) url = '?g=' + encodeURIComponent(S.gid);
        history.replaceState(null, '', url);
      } catch (e) { }
    }
    render(true);
    window.scrollTo(0, 0);
  }

  /* ---------- views ---------- */
  function adoptPayLink() {
    if (!S.profile || S.profile.instapayLink || !S.carts || !S.carts.length) return;
    const c = S.carts.filter(x => x.ownerId === me() && x.payInfo && x.payInfo.instapayLink).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!c) return;
    S.profile = Object.assign({}, S.profile, { instapay: S.profile.instapay || c.payInfo.instapay || '', instapayLink: c.payInfo.instapayLink });
    if (isLocal()) S.store.saveProfile(S.profile); else LS.set('tarweeqa.profile', S.profile);
    if (S.store.saveProfileRemote) S.store.saveProfileRemote(S.profile.name, { instapay: S.profile.instapay, instapayLink: S.profile.instapayLink, wallet: S.profile.wallet || '' }).catch(() => { });
  }
  function view() {
    if (S.invoiceView) return viewInvoice();
    adoptPayLink();
    if (S.fatal) return `<main class="page"><section class="panel"><h2>${esc(t('errFirebase'))}</h2><p class="muted mono">${esc(S.fatal)}</p></section></main>`;
    if (!S.booted) return `<div class="boot">${esc(t('appName'))}</div>`;
    if (!S.profile || !S.profile.name) return viewWelcome();
    if (!S.gid || !S.group) return viewStart();
    if (ADMIN_ROUTES.includes(S.route.name) && !isAdmin()) S.route = { name: 'home' };
    const r = S.route.name;
    const body = ({
      home: viewHome, newOrder: viewNewOrder, cart: viewCart, restaurants: viewRestaurants,
      restaurant: viewRestaurantEdit, money: viewMoney, group: viewGroup, profile: viewProfile
    }[r] || viewHome)();
    return shell(body) + receiptModal();
  }

  function shell(body) {
    const demo = isLocal();
    let acting = '';
    if (demo) {
      const ppl = S.store.people();
      acting = `<label class="acting"><span>${esc(t('actingAs'))}</span>
        <select id="acting" data-change="acting">${Object.keys(ppl).map(uid => `<option value="${esc(uid)}"${uid === me() ? ' selected' : ''}>${esc(ppl[uid].name)}</option>`).join('')}</select></label>`;
    }
    const r = S.route.name;
    const tab = (k, icon, label, extra) => `<button class="nav-btn${(r === k || (k === 'home' && ['cart', 'newOrder'].includes(r)) || (k === 'restaurants' && r === 'restaurant')) ? ' on' : ''}" data-act="nav" data-to="${k}">${icon}<span>${esc(label)}</span>${extra || ''}</button>`;
    const pend = pendingForMe().length;
    return `
      <header class="top">
        <button class="brand" data-act="nav" data-to="home">${logoSvg()}<span class="brand-txt"><b>${esc(t('appName'))}</b><small>${esc(S.group.name)}</small></span></button>
        <div class="top-actions">
          ${demo ? `<span class="chip chip-demo">${esc(t('demoChip'))}</span>` : ''}
          <button class="ghost small" data-act="lang">${esc(t('langSwitch'))}</button>
          <button class="avatar" data-act="nav" data-to="profile" aria-label="${esc(t('profile'))}">${esc(initial(S.profile.name))}</button>
        </div>
      </header>
      ${demo ? `<div class="demo-bar">${acting}<p>${esc(t('demoNote'))}</p></div>` : ''}
      <main class="page">${body}</main>
      <nav class="bottom-nav">
        ${tab('home', icoHome(), t('navHome'))}
        ${isAdmin() ? tab('restaurants', icoMenu(), t('navRestaurants')) : ''}
        ${tab('money', icoCoins(), t('navMoney'), pend ? `<i class="badge tnum">${pend}</i>` : '')}
        ${tab('group', icoPeople(), t('navGroup'))}
      </nav>`;
  }

  /* icons */
  function logoSvg() { return `<svg class="logo" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="22" r="15" fill="var(--accent)"/><path d="M8 22a12 12 0 0 0 24 0z" fill="var(--sun)"/><path d="M13 13c1-3 3-3 3-6M20 12c1-3 3-3 3-6M27 13c1-3 3-3 3-6" stroke="var(--fg)" stroke-width="2" fill="none" stroke-linecap="round" opacity=".55"/></svg>`; }
  const svg = d => `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const icoHome = () => svg('M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z');
  const icoMenu = () => svg('M5 4h14v16H5zM8 8h8M8 12h8M8 16h5');
  const icoCoins = () => svg('M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6');
  const icoPeople = () => svg('M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21c0-3.9 3.1-7 7-7s7 3.1 7 7M16 3.5a4 4 0 0 1 0 7.5M18.5 14.5c2.1.9 3.5 3.3 3.5 6.5');
  function plusIcon() { return `<svg viewBox="0 0 20 20" class="ico" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`; }
  function waIcon() { return `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path fill="currentColor" d="M12 2.2a9.7 9.7 0 0 0-8.4 14.6L2.3 21.7l5-1.3A9.7 9.7 0 1 0 12 2.2Zm0 17.7a8 8 0 0 1-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1 1 12 19.9Zm4.4-6c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.5.1l-.8.9c-.1.2-.3.2-.5.1a6.6 6.6 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.5-.4h-.5a.9.9 0 0 0-.6.3 2.7 2.7 0 0 0-.9 2c0 1.2.9 2.3 1 2.5.1.2 1.7 2.7 4.2 3.7 1.6.7 2.2.7 3 .6.5-.1 1.4-.6 1.6-1.1.2-.6.2-1 .1-1.1l-.5-.4Z"/></svg>`; }
  const wa = (href, label, cls) => `<a class="wa ${cls || 'small'}" href="${esc(href)}" target="_blank" rel="noopener">${waIcon()} ${esc(label)}</a>`;
  const back = to => `<div class="crumb"><button class="ghost small" data-act="nav" data-to="${to || 'home'}">‹ ${esc(t('back'))}</button></div>`;

  function statusChip(st) {
    const label = { voting: t('stVoting'), ordering: t('stOrdering'), closed: t('stClosed'), ordered: t('stOrdered'), settled: t('stSettled') }[st] || st;
    return `<span class="chip chip-${st}">${esc(label)}</span>`;
  }
  function personChip(s) {
    return {
      done: `<span class="chip chip-done">✓ ${esc(t('psDone'))}</span>`,
      picking: `<span class="chip chip-picking">${esc(t('psPicking'))}</span>`,
      none: `<span class="chip chip-none">${esc(t('psNone'))}</span>`,
      out: `<span class="chip chip-out">${esc(t('psOut'))}</span>`
    }[s];
  }

  /* ---------- welcome & start ---------- */
  function viewWelcome() {
    return `<main class="page welcome">
      <div class="welcome-mark">${logoSvg()}</div>
      <h1>${esc(t('welcomeTitle'))}</h1>
      <p class="lead">${esc(t('welcomeSub'))}</p>
      <form class="panel form" data-submit="welcome" novalidate>
        <label class="field"><span>${esc(t('yourPhone'))}</span><input id="w-phone" name="phone" type="tel" inputmode="tel" dir="ltr" autocomplete="tel" placeholder="01012345678"><small>${esc(t('phoneHint2'))}</small></label>
        <label class="field"><span>${esc(t('yourName'))}</span><input id="w-name" name="name" autocomplete="name"><small>${esc(t('nameHint'))}</small></label>
        <p class="form-error" id="w-err" hidden></p>
        <button class="primary block" type="submit">${esc(t('start'))}</button>
      </form>
      <button class="ghost small center" data-act="lang">${esc(t('langSwitch'))}</button>
    </main>`;
  }
  function viewStart() {
    if (S.pending && S.pending.gid) {
      const g = S.pending.group;
      if (S.pending.joining) return `<main class="page welcome"><div class="welcome-mark">${logoSvg()}</div><p class="lead">${esc(t('openingOrder'))}</p><div class="loading" aria-busy="true"></div></main>`;
      return `<main class="page welcome">
        <div class="welcome-mark">${logoSvg()}</div>
        ${g ? `<h1>${esc(t('joinTitle', { name: g.name }))}</h1><p class="lead">${esc(t('joinSub'))}</p>
          <button class="primary block big" data-act="joinGroup">${esc(t('joinBtn'))}</button>`
          : (S.pending.missing ? `<p class="empty">${esc(t('errGroup'))}</p>` : `<div class="loading" aria-busy="true"></div>`)}
      </main>`;
    }
    return `<main class="page welcome">
      <div class="welcome-mark">${logoSvg()}</div>
      <h1>${esc(t('startTitle'))}</h1>
      <p class="lead">${esc(t('startSub'))}</p>
      <form class="panel form" data-submit="createGroup" novalidate>
        <label class="field"><span>${esc(t('groupName'))}</span><input id="g-name" name="name" placeholder="${esc(t('groupNamePh'))}"></label>
        <button class="primary block" type="submit">${esc(t('createGroup'))}</button>
      </form>
      ${S.groups.length ? `<section class="panel"><p class="label">${esc(t('myGroups'))}</p>${S.groups.map(g => `<button class="row-link" data-act="switchGroup" data-id="${esc(g.id)}"><span><strong>${esc(g.name)}</strong></span><span class="chev">›</span></button>`).join('')}</section>` : ''}
      <p class="muted center small-text">${esc(t('haveInvite'))}</p>
    </main>`;
  }

  /* ---------- home ---------- */
  function viewHome() {
    const hour = new Date().getHours();
    const active = S.carts.filter(isActive).sort((a, b) => b.createdAt - a.createdAt);
    const recent = S.carts.filter(c => !isActive(c)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
    return `
      <section class="hello">
        <h1>${esc(hour < 12 ? t('morning') : t('hello'))}${comma()}${esc(S.profile.name)}</h1>
        <p class="muted">${esc(t('tagline'))}</p>
      </section>
      ${collectNag()}
      ${active.length ? `<section class="stack">${active.map(activeCard).join('')}</section>` : ''}
      ${isAdmin() ? `<button class="${active.length ? 'secondary' : 'primary'} block big" data-act="nav" data-to="newOrder">${plusIcon()} ${esc(active.length ? t('anotherOrder') : t('newOrder'))}</button>`
        : (active.length ? '' : `<p class="empty">${esc(t('memberNoOrder'))}</p>`)}
      ${moneySummary()}
      <section>
        <div class="section-head"><h2>${esc(t('recentOrders'))}</h2></div>
        ${recent.length ? `<ul class="cart-list">${recent.map(cartRow).join('')}</ul>` : `<p class="empty">${esc(t('noOrders'))}</p>`}
      </section>`;
  }

  function activeCard(c) {
    const st = stageOf(c);
    const ppl = people(c);
    const keys = Object.keys(ppl);
    const count = s => keys.filter(k => personStatus(c, k) === s).length;
    const mine = personStatus(c, me());
    let title, sub;
    if (st === 'voting') {
      const v = C.tallyVotes(c);
      title = t('votingTitle');
      sub = t('votesCount', { n: v.total, m: keys.filter(k => !k.startsWith('g_')).length });
    } else {
      title = c.restaurant.name;
      sub = `${t('cntDone', { n: count('done') })} · ${t('cntPicking', { n: count('picking') })} · ${t('cntNone', { n: count('none') })}`;
    }
    const est = st === 'ordering' && mine !== 'out' ? C.estimateFor(c, me()) : null;
    return `<button class="active-card state-${st}" data-act="openCart" data-id="${esc(c.id)}">
      <span class="ac-top">${statusChip(st)}<span class="tnum clock-sm">${st === 'voting' || st === 'ordering' ? `<span data-countdown="${c.closesAt}"></span>` : ''}</span></span>
      <strong class="ac-title">${esc(title)}</strong>
      <small class="muted">${esc(c.title || '')}${c.title ? ' · ' : ''}${esc(t('host'))}: ${esc(c.ownerId === me() ? t('you') : c.ownerName)}</small>
      <span class="ac-stats tnum">${esc(sub)}</span>
      ${st !== 'voting' ? `<span class="ac-me">${personChip(mine)}${est && est.total ? `<span class="tnum">${esc(t('yourEstimate'))} ≈ <b>${esc(money(est.total))}</b></span>` : ''}</span>` : ''}
    </button>`;
  }

  function cartRow(c) {
    const st = stageOf(c);
    const bill = C.computeBill(c, prevFor(c));
    const row = bill.rows.find(r => r.key === me());
    let right = '';
    if (c.ownerId === me()) {
      const open = bill.rows.filter(r => !r.isHost && r.state !== 'paid').length;
      right = open ? `<span class="chip chip-picking">${esc(t('waitingPay', { n: open }))}</span>` : `<span class="chip chip-done">✓ ${esc(t('allPaid'))}</span>`;
    } else if (row) {
      right = payChip(row, c);
    }
    return `<li><button class="cart-card state-${st}" data-act="openCart" data-id="${esc(c.id)}">
      <span class="cc-main"><strong>${esc(c.restaurant ? c.restaurant.name : t('votingTitle'))}</strong>
        <small class="muted">${esc(fmtAgo(c.createdAt))} · ${esc(t('host'))}: ${esc(c.ownerId === me() ? t('you') : c.ownerName)}${row ? ' · ' + esc(money(row.total)) : ''}</small></span>
      <span class="cc-side">${right || statusChip(st)}</span>
    </button></li>`;
  }

  function payChip(row, c) {
    if (row.isHost) return `<span class="chip chip-out">${esc(t('payHost'))}</span>`;
    if (row.state === 'paid') return `<span class="chip chip-done">✓ ${esc(t('payPaid'))}</span>`;
    if (row.state === 'reported') return `<span class="chip chip-picking">${esc(t('payReported'))}</span>`;
    const pr = pairs()[c.ownerId] && pairs()[c.ownerId][row.key];
    if (pr && pr.balance >= -0.009) return `<span class="chip chip-done">✓ ${esc(t('paySettledLater'))}</span>`;
    if (row.state === 'partial') return `<span class="chip chip-picking">${esc(t('payPartial', { a: C.fmtMoney(row.paid), b: C.fmtMoney(row.net) }))}</span>`;
    return `<span class="chip chip-warn">${esc(t('payUnpaid'))}</span>`;
  }

  function myDebts() {
    const P = pairs(); const owe = [], credit = [];
    for (const h of Object.keys(P)) {
      const p = P[h][me()];
      if (!p) continue;
      if (p.balance < -0.009) owe.push(p); else if (p.balance > 0.009) credit.push(p);
    }
    return { owe, credit };
  }
  function owedToMe() {
    const mine = pairs()[me()] || {};
    return Object.values(mine).filter(p => p.balance < -0.009).sort((a, b) => a.balance - b.balance);
  }
  function pendingForMe() {
    const out = [];
    for (const c of S.carts) {
      if (c.ownerId !== me()) continue;
      for (const k of Object.keys(c.payments || {})) if (c.payments[k].status === 'reported') out.push({ c, key: k, p: c.payments[k] });
    }
    return out;
  }

  function moneySummary() {
    const { owe, credit } = myDebts();
    const toMe = owedToMe();
    const pend = pendingForMe();
    if (!owe.length && !credit.length && !toMe.length && !pend.length) return '';
    const tot = list => C.round2(list.reduce((s, p) => s + Math.abs(p.balance), 0));
    return `<button class="money-card" data-act="nav" data-to="money">
      ${owe.length ? `<span class="mc-row warn"><span>${esc(t('youOwe'))}</span><b class="tnum">${esc(money(tot(owe)))}</b><small>${esc(owe.map(p => p.hostName).join(comma()))}</small></span>` : ''}
      ${toMe.length ? `<span class="mc-row"><span>${esc(t('owedToYou'))}</span><b class="tnum">${esc(money(tot(toMe)))}</b><small>${esc(t('peopleN', { n: toMe.length }))}</small></span>` : ''}
      ${credit.length ? `<span class="mc-row ok"><span>${esc(t('yourCredit'))}</span><b class="tnum">${esc(money(tot(credit)))}</b><small>${esc(credit.map(p => p.hostName).join(comma()))}</small></span>` : ''}
      ${pend.length ? `<span class="mc-row sun"><span>${esc(t('toConfirm'))}</span><b class="tnum">${pend.length}</b><small>${esc(t('toConfirmHint'))}</small></span>` : ''}
    </button>`;
  }

  /* ---------- start a new order ---------- */
  function viewNewOrder() {
    const def = new Date(Date.now() + (CFG.defaultCartMinutes || 30) * 60000);
    const hh = String(def.getHours()).padStart(2, '0'), mm = String(Math.ceil(def.getMinutes() / 5) * 5 % 60).padStart(2, '0');
    const q = S.restQuery.trim().toLowerCase();
    const list = S.restaurants.slice().sort((a, b) => (b.lastOrderedAt || 0) - (a.lastOrderedAt || 0));
    const n = S.sel.length;
    return `${back('home')}
      <h1>${esc(t('newOrder'))}</h1>
      <form class="form" data-submit="createCart" novalidate>
        <section class="panel">
          <div class="section-head"><p class="label">${esc(t('pickRest'))}</p><button type="button" class="ghost small" data-act="newRestaurant">${plusIcon()} ${esc(t('addRestaurant'))}</button></div>
          <p class="muted small-text">${esc(t('pickRestHint'))}</p>
          ${list.length > 5 ? `<input type="search" id="rest-search" data-input="restSearch" placeholder="${esc(t('searchRest'))}" value="${esc(S.restQuery)}">` : ''}
          ${list.length ? `<div class="rest-pick">${list.map(r => {
            const on = S.sel.includes(r.id);
            const f = r.fees || {};
            return `<label class="pick${on ? ' on' : ''}" data-name="${esc(r.name.toLowerCase())}"${q && !r.name.toLowerCase().includes(q) ? ' hidden' : ''}>
              <input type="checkbox" data-change="pickRest" value="${esc(r.id)}" ${on ? 'checked' : ''}>
              <span class="pick-main"><strong>${esc(r.name)}</strong>
                <small class="muted">${esc(t('itemsCount', { n: (r.items || []).length }))} · ${esc(t('lastOrdered'))}: ${esc(fmtAgo(r.lastOrderedAt))}${f.delivery ? ' · ' + esc(t('delivery')) + ' ' + esc(C.fmtMoney(f.delivery)) : ''}</small></span>
              ${on && n > 1 ? `<span class="pick-n tnum">${S.sel.indexOf(r.id) + 1}</span>` : ''}
            </label>`;
          }).join('')}</div>` : `<p class="empty">${esc(t('noRestaurants'))}</p>`}
        </section>
        <section class="panel">
          <div class="grid2">
            <label class="field"><span>${esc(t('closeTime'))}</span><input id="nc-time" name="time" type="time" value="${hh}:${mm}" class="tnum"><small>${esc(t('closeTimeHint'))}</small></label>
            <label class="field"><span>${esc(t('cartTitle'))}</span><input id="nc-title" name="title" placeholder="${esc(t('cartTitlePh'))}"></label>
          </div>
        </section>
        <section class="panel">
          <p class="label">${esc(t('payInfo'))}</p>
          <div class="grid2">
            <label class="field"><span>${esc(t('instapayAny'))}</span><input id="nc-insta" name="instapay" dir="ltr" value="${esc(instaValue(S.profile))}" placeholder="name@instapay / https://ipn.eg/…"></label>
            <label class="field"><span>${esc(t('wallet'))}</span><input id="nc-wallet" name="wallet" type="tel" dir="ltr" value="${esc(S.profile.wallet || '')}"></label>
          </div>
        </section>
        <button class="primary block big" type="submit" ${n ? '' : 'disabled'}>${esc(n > 1 ? t('startVote', { n }) : t('openCart'))}</button>
      </form>`;
  }

  /* ---------- cart ---------- */
  function viewCart() {
    const c = cartById(S.route.id);
    if (!c) return back('home') + `<p class="empty">${esc(t('errLoad'))}</p>`;
    const st = stageOf(c);
    const host = isHost(c);
    const tab = S.route.tab || 'mine';
    const ppl = people(c);
    const keys = Object.keys(ppl);
    const waiting = keys.filter(k => ['none', 'picking'].includes(personStatus(c, k)));
    const left = c.closesAt - Date.now();
    let banner = '';
    if (host && st === 'ordering' && waiting.length && left <= (CFG.reminderMinutesBeforeClose || 15) * 60000) {
      banner = `<div class="banner warn"><span>${esc(t('reminderBanner', { t: fmtLeft(left), n: waiting.length }))}</span><button class="small primary" data-act="tab" data-tab="people">${esc(t('goRemind'))}</button></div>`;
    } else if (host && st === 'ordering' && !waiting.length) {
      banner = `<div class="banner ok"><span>${esc(t('allDone'))}</span><button class="small primary" data-act="closeCart">${esc(t('closeNow'))}</button></div>`;
    } else if (host && st === 'closed') {
      banner = `<div class="banner ok"><span>${esc(t('closedPlace'))}</span><span class="btn-row tight"><button class="small secondary" data-act="reopen">${esc(t('reopenShort'))}</button><button class="small primary" data-act="tab" data-tab="order">${esc(t('tabOrder'))}</button></span></div>`;
    } else if (host && st === 'ordered') {
      banner = `<div class="banner soft"><span>${esc(t('orderedReopenHint'))}</span><button class="small secondary" data-act="reopen">${esc(t('reopenShort'))}</button></div>`;
    }
    const head = `${back('home')}
      <section class="cart-head">
        <div class="ch-title">
          <p class="eyebrow">${esc(c.title || fmtDate(c.createdAt))}</p>
          <h1>${esc(st === 'voting' ? t('votingTitle') : c.restaurant.name)}</h1>
          <p class="muted">${esc(t('host'))}: ${esc(c.ownerId === me() ? t('you') : c.ownerName)}</p>
        </div>
        <div class="ch-status">
          ${statusChip(st)}
          ${isOpenStage(st) ? `<span class="clock tnum" data-countdown="${c.closesAt}"></span>` : ''}
          <small class="muted tnum">${esc(t('closesAt', { t: fmtTime(c.closesAt) }))}</small>
        </div>
      </section>
      ${isOpenStage(st) ? shareBox(c, st) : ''}
      ${banner}`;
    if (st === 'voting') return head + votingView(c);
    if (tab === 'bill' && c.restaurant && !S.history[c.restaurant.name]) { S.history[c.restaurant.name] = []; loadHistory(c.restaurant.name, true); }
    const tabs = host ? [['mine', t('tabMine')], ['people', t('tabPeople') + ` <span class="tab-count tnum">${keys.length - waiting.length}/${keys.length}</span>`], ['order', t('tabOrder')], ['bill', t('tabBill')]]
      : [['mine', t('tabMine')], ['bill', t('tabMyBill')]];   // the others' orders are the host's business
    if (!tabs.some(([k]) => k === tab)) { S.route.tab = 'mine'; return viewCart(); }
    return `${head}
      <nav class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${k === tab}" class="tab${k === tab ? ' on' : ''}" data-act="tab" data-tab="${k}">${l}</button>`).join('')}</nav>
      <div class="tab-body">
        ${tab === 'mine' ? tabMine(c, st, host) : ''}
        ${tab === 'people' ? tabPeople(c, st, host) : ''}
        ${tab === 'order' ? tabOrder(c, st, host) : ''}
        ${tab === 'bill' ? tabBill(c, st, host) : ''}
      </div>`;
  }

  function inviteText(c, st) {
    if (st === 'voting') {
      const names = (c.candidates || []).map(id => (c.candidateInfo[id] || {}).name).join(comma());
      return t('msgVote', { names, time: fmtTime(c.closesAt), link: cartLink(c) });
    }
    return t('msgInvite', { rest: c.restaurant.name, time: fmtTime(c.closesAt), link: cartLink(c) });
  }
  function shareBox(c, st) {
    const link = cartLink(c);
    return `<section class="share">
      <p class="label">${esc(t('shareTitle'))}</p>
      <div class="share-row">
        <code class="link" dir="ltr">${esc(link)}</code>
        <button class="secondary small" data-act="copy" data-text="${esc(link)}">${esc(t('copyLink'))}</button>
        ${wa(waLink('', inviteText(c, st)), t('shareWa'))}
      </div>
      ${isLocal() ? `<small class="muted">${esc(t('demoLinkNote'))}</small>` : ''}
    </section>`;
  }

  /* voting */
  function votingView(c) {
    const v = C.tallyVotes(c);
    const myVote = (c.votes || {})[me()];
    const host = isHost(c);
    const ppl = people(c);
    const voters = Object.keys(ppl).filter(k => !k.startsWith('g_'));
    const notVoted = voters.filter(k => !(c.votes || {})[k]);
    const max = Math.max(1, ...Object.values(v.counts));
    return `<section class="stack">
      <p class="muted">${esc(t('voteHint'))}</p>
      ${(c.candidates || []).map(id => {
        const info = c.candidateInfo[id] || {};
        const n = v.counts[id] || 0;
        const who = Object.keys(c.votes || {}).filter(k => c.votes[k] === id).map(k => (ppl[k] || {}).name).filter(Boolean);
        return `<div class="vote-card${myVote === id ? ' mine' : ''}">
          <div class="vc-head"><strong>${esc(info.name)}</strong><span class="tnum vc-n">${n}</span></div>
          <span class="bar"><i style="width:${Math.round(n / max * 100)}%"></i></span>
          <small class="muted">${esc(t('itemsCount', { n: info.items || 0 }))}${info.delivery ? ' · ' + esc(t('delivery')) + ' ' + esc(C.fmtMoney(info.delivery)) : ''}${who.length ? ' · ' + esc(who.join(comma())) : ''}</small>
          <div class="btn-row">
            <button class="${myVote === id ? 'primary' : 'secondary'} small" data-act="vote" data-id="${esc(id)}">${myVote === id ? '✓ ' + esc(t('yourVote')) : esc(t('voteFor'))}</button>
            ${host ? `<button class="ghost small" data-act="lockRest" data-id="${esc(id)}">${esc(t('pickThis'))}</button>` : ''}
          </div>
        </div>`;
      }).join('')}
      ${notVoted.length ? `<p class="muted small-text">${esc(t('notVoted'))}: ${esc(notVoted.map(k => ppl[k].name).join(comma()))}</p>` : ''}
      ${host && notVoted.length ? wa(waLink('', t('msgVoteRemind', { names: notVoted.map(k => ppl[k].name).join(comma()), link: cartLink(c) })), t('remindVoters'), 'block') : ''}
      ${host && v.leader && v.total ? `<button class="primary block big" data-act="lockRest" data-id="${esc(v.leader)}">${esc(t('lockLeader', { name: (c.candidateInfo[v.leader] || {}).name }))}</button>` : ''}
    </section>`;
  }

  /* my order (or the host ordering for someone) */
  function tabMine(c, st, host) {
    const ppl = people(c);
    const key = (host && S.actFor && ppl[S.actFor]) ? S.actFor : me();
    const m = (c.members || {})[key] || { items: [], status: null, done: false };
    const open = st === 'ordering';
    const canEdit = open || (host && st === 'closed');
    const items = m.items || [];
    const forOther = key !== me();
    const who = forOther ? ppl[key].name : '';

    const picker = host ? `<label class="for-who"><span>${esc(t('orderingFor'))}</span>
      <select id="act-for" data-change="actFor">${Object.keys(ppl).map(k => `<option value="${esc(k)}"${k === key ? ' selected' : ''}>${esc(ppl[k].name)}${k === me() ? ' (' + esc(t('you')) + ')' : ''}</option>`).join('')}</select></label>` : '';

    const attend = canEdit ? `<div class="attend" role="group" aria-label="${esc(t('attendQ'))}">
        <p class="label">${esc(forOther ? t('attendQOther', { name: who }) : t('attendQ'))}</p>
        <div class="seg">
          <button class="${m.status && m.status !== 'out' ? 'on' : ''}" data-act="attend" data-v="in" aria-pressed="${m.status && m.status !== 'out'}">${esc(t('attendIn'))}</button>
          <button class="${m.status === 'out' ? 'on' : ''}" data-act="attend" data-v="out" aria-pressed="${m.status === 'out'}">${esc(t('attendOut'))}</button>
        </div>
      </div>` : '';

    if (m.status === 'out') {
      return `<section class="stack">${picker}${attend}<p class="empty">${esc(forOther ? t('outOther', { name: who }) : t('outOn'))}</p></section>`;
    }

    // live estimate
    const est = C.estimateFor(c, key);
    const prev = c.ownerId === key ? 0 : (prevFor(c)[key] || 0);
    const estBox = `<section class="estimate${est.total ? '' : ' empty-est'}">
      <div class="est-top"><span>${esc(forOther ? t('estimateFor', { name: who }) : t('yourEstimate'))}</span><b class="tnum">≈ ${esc(money(est.total ? C.round2(est.total - prev) : 0))}</b></div>
      ${est.total ? `<dl class="est-lines tnum">
        <div><dt>${esc(t('rowFood'))}</dt><dd>${esc(C.fmtMoney(est.sub))}</dd></div>
        ${est.delivery ? `<div><dt>${esc(t('estDelivery', { n: est.people }))}</dt><dd>${esc(C.fmtMoney(est.delivery))}</dd></div>` : ''}
        ${est.fees ? `<div><dt>${esc(t('rowFees'))}</dt><dd>${esc(C.fmtMoney(est.fees))}</dd></div>` : ''}
        ${est.tax ? `<div><dt>${esc(t('tax'))}</dt><dd>${esc(C.fmtMoney(est.tax))}</dd></div>` : ''}
        ${prev > 0.009 ? `<div class="ok"><dt>${esc(t('prevCredit'))}</dt><dd>−${esc(C.fmtMoney(prev))}</dd></div>` : ''}
        ${prev < -0.009 ? `<div class="warn"><dt>${esc(t('prevDebt'))}</dt><dd>+${esc(C.fmtMoney(-prev))}</dd></div>` : ''}
      </dl>
      <small class="muted">${esc(items.some(i => i.noPrice) ? t('estimateNoPrice') : t('estimateNote'))}</small>` : `<small class="muted">${esc(items.some(i => i.noPrice) ? t('estimateNoPrice') : t('estimateEmpty'))}</small>`}
    </section>`;

    // repeat last order from this restaurant
    let repeat = '';
    if (canEdit && !items.length) {
      const last = S.carts.filter(x => x.id !== c.id && x.restaurantId === c.restaurantId && x.members && x.members[key] && (x.members[key].items || []).length && x.members[key].status !== 'out')
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (last) {
        const li = last.members[key].items;
        repeat = `<button class="repeat" data-act="repeatLast" data-id="${esc(last.id)}">
          <span><strong>${esc(t('repeatLast'))}</strong><small class="muted">${esc(li.map(i => (i.qty > 1 ? i.qty + '× ' : '') + i.name).join(comma()))}</small></span>
          <b class="tnum">${esc(money(C.memberSubtotal(last.members[key])))}</b></button>`;
      }
    }

    const qtyById = {};
    for (const it of items) if (it.menuId) qtyById[it.menuId] = (qtyById[it.menuId] || 0) + C.num(it.qty);

    const myList = items.length ? `<ul class="my-items">${items.map(it => `<li>
        <div class="mi-top"><span class="mi-name">${esc(it.name)}${it.custom ? ` <small class="tag">${esc(t('notOnMenu'))}</small>` : ''}</span><span class="mi-price tnum">${it.noPrice ? esc(t('priceLater')) : esc(money(C.num(it.price) * C.num(it.qty)))}</span></div>
        <div class="mi-ctrl">
          ${canEdit ? `<div class="stepper">
            <button data-act="qty" data-id="${esc(it.id)}" data-d="-1" aria-label="-">−</button>
            <span class="tnum">${esc(it.qty)}</span>
            <button data-act="qty" data-id="${esc(it.id)}" data-d="1" aria-label="+">+</button>
          </div>
          <input class="note" id="note-${esc(it.id)}" data-change="note" data-id="${esc(it.id)}" value="${esc(it.note || '')}" placeholder="${esc(t('notePh'))}">`
          : `<span class="tnum muted">× ${esc(it.qty)}</span>${it.note ? `<span class="muted">${esc(it.note)}</span>` : ''}`}
        </div></li>`).join('')}</ul>`
      : `<p class="empty small">${esc(canEdit ? t('emptyMine') : t('cartClosedNote'))}</p>`;

    let doneBlock = '';
    if (canEdit && items.length) {
      doneBlock = m.done
        ? `<div class="done-box on"><p>${esc(forOther ? t('doneOther', { name: who }) : t('doneOn'))}</p><button class="secondary small" data-act="undoDone">${esc(t('undoDone'))}</button></div>`
        : `<button class="primary block big" data-act="done">✓ ${esc(forOther ? t('doneForOther', { name: who }) : t('doneBtn'))}</button>`;
    }

    const q = S.menuQuery.trim().toLowerCase();
    const groups = groupByCategory(c.menu || []);
    const menu = canEdit ? `<section class="menu">
        <div class="section-head"><h2>${esc(t('menuTitle'))}</h2><small class="muted">${esc(c.restaurant.name)}</small></div>
        <input type="search" id="menu-search" class="search" data-input="search" placeholder="${esc(t('search'))}" value="${esc(S.menuQuery)}">
        ${groups.map(g => `<div class="menu-group" data-group${q && !g.items.some(it => it.name.toLowerCase().includes(q)) ? ' hidden' : ''}>
          ${g.name ? `<h3 class="cat">${esc(g.name)}</h3>` : ''}
          <ul class="menu-items">${g.items.map(it => {
            const n = qtyById[it.id] || 0;
            return `<li class="menu-item" data-name="${esc(it.name.toLowerCase())}"${q && !it.name.toLowerCase().includes(q) ? ' hidden' : ''}>
              <button class="mi-add${n ? ' has' : ''}" data-act="addMenu" data-id="${esc(it.id)}">
                <span class="mi-label">${esc(it.name)}</span><span class="mi-price tnum">${esc(money(it.price))}</span>
                <span class="mi-plus" aria-hidden="true">${n ? `<b class="tnum">${n}</b>` : plusIcon()}</span>
              </button></li>`;
          }).join('')}</ul></div>`).join('')}
        <p class="empty small" id="no-match" hidden>${esc(t('noMatch'))}</p>
        <details class="panel custom">
          <summary>${esc(t('customItem'))}</summary>
          <form class="grid3 form" data-submit="customItem" novalidate>
            <label class="field"><span>${esc(t('itemName'))}</span><input id="ci-name" name="name" list="catalog" placeholder="${esc(t('customPh'))}"></label>
            <label class="field"><span>${esc(t('priceOpt'))}</span><input id="ci-price" name="price" inputmode="decimal" class="tnum"></label>
            <button class="secondary" type="submit">${esc(t('customAdd'))}</button>
          </form>
          <datalist id="catalog">${catalogNames(c).map(n => `<option value="${esc(n)}"></option>`).join('')}</datalist>
          <p class="muted small-text">${esc(t('customHint'))}</p>
        </details>
      </section>` : '';

    return `<section class="stack">
        ${picker}${attend}${estBox}${repeat}
        <div class="section-head"><h2>${esc(forOther ? t('itemsOf', { name: who }) : t('myItems'))}</h2></div>
        ${myList}${mySharedLines(c, key)}${doneBlock}
      </section>${host && st !== 'settled' ? sharedPanel(c) : ''}${menu}`;
  }

  /* ---------- shared items: one plate or bottle split between chosen people ---------- */
  // the safety net: what Talabat actually took vs what the bill adds up to
  function paidCheck(c, bill) {
    const actual = C.num(c.receiptTotal);
    const diff = actual > 0 ? C.round2(actual - bill.grand) : 0;
    const ok = actual > 0 && Math.abs(diff) < 0.05;
    return `<section class="panel paid-check ${actual > 0 ? (ok ? 'ok' : 'warn') : ''}">
      <label class="field inline-field"><span>${esc(t('paidActualLbl'))}</span><input id="paid-actual" class="tnum" inputmode="decimal" data-change="paidActual" value="${actual > 0 ? esc(C.fmtMoney(actual)) : ''}" placeholder="0"></label>
      ${actual > 0 ? (ok ? `<p class="small-text pc-ok">✓ ${esc(t('paidActualOk', { a: money(actual) }))}</p>`
        : `<p class="small-text pc-warn">⚠ ${esc(t('paidActualOff', { b: money(bill.grand), a: money(actual), d: (diff > 0 ? '+' : '−') + C.fmtMoney(Math.abs(diff)) }))}</p>
           <button class="primary block" data-act="adjustToPaid">${esc(t('adjustToPaid', { d: (diff > 0 ? '+' : '−') + C.fmtMoney(Math.abs(diff)) }))}</button>`)
        : `<p class="muted small-text">${esc(t('paidActualHint'))}</p>`}
    </section>`;
  }
  function mySharedLines(c, key) {
    const mine = (c.shared || []).filter(x => (x.keys || []).includes(key));
    if (!mine.length) return '';
    const exp = C.withShared(c).members[key] || { items: [] };
    return `<ul class="my-items shared-mine">${mine.map(x => {
      const part = (exp.items || []).find(i => i.shared === x.id);
      return `<li><div class="mi-top"><span class="mi-name">🤝 ${esc(x.name)} <small class="tag">${esc(t('sharedWith', { n: x.keys.length }))}</small></span><span class="mi-price tnum">${esc(money(part ? part.price : 0))}</span></div></li>`;
    }).join('')}</ul>`;
  }
  function sharedPanel(c) {
    const ppl = people(c);
    const keys = Object.keys(ppl).filter(k => personStatus(c, k) !== 'out');
    const anyIn = keys.some(k => (c.members || {})[k]);
    const inCart = k => !anyIn || !!(c.members || {})[k];   // default: the people already in this order
    const list = (c.shared || []).map(x => {
      const tot = C.round2(C.num(x.price) * (C.num(x.qty) || 1));
      return `<li><span><b>${esc((C.num(x.qty) > 1 ? x.qty + '× ' : '') + x.name)}</b> <span class="tnum">${esc(money(tot))}</span>
        <small class="muted">÷ ${x.keys.length} = <span class="tnum">${esc(C.fmtMoney(C.round2(tot / x.keys.length)))}</span> · ${esc(x.keys.map(k => (ppl[k] || {}).name || '?').join(comma()))}</small></span>
        <button class="icon-btn" data-act="delShared" data-id="${esc(x.id)}" aria-label="${esc(t('delete'))}">×</button></li>`;
    }).join('');
    const menuNames = (c.menu || []).map(i => `<option value="${esc(i.name)}"></option>`).join('');
    return `<details class="panel shared"${(c.shared || []).length || S.sharedOpen ? ' open' : ''}>
      <summary>🤝 ${esc(t('sharedTitle'))}${(c.shared || []).length ? ` <small class="muted">(${c.shared.length})</small>` : ''}</summary>
      <p class="muted small-text">${esc(t('sharedHint'))}</p>
      ${list ? `<ul class="shared-list">${list}</ul>` : ''}
      <form class="form" data-submit="sharedItem" novalidate>
        <div class="grid3">
          <label class="field"><span>${esc(t('itemName'))}</span><input id="sh-name" name="name" list="sh-menu" data-change="sharedName" placeholder="${esc(t('sharedPh'))}"></label>
          <label class="field"><span>${esc(t('price'))}</span><input id="sh-price" name="price" inputmode="decimal" class="tnum"></label>
          <label class="field"><span>${esc(t('qty'))}</span><input id="sh-qty" name="qty" inputmode="numeric" class="tnum" value="1"></label>
        </div>
        <datalist id="sh-menu">${menuNames}</datalist>
        <p class="label">${esc(t('sharedWho'))} <button type="button" class="link-btn" data-act="shAll">${esc(t('all'))}</button> <button type="button" class="link-btn" data-act="shNone">${esc(t('none'))}</button></p>
        <div class="sh-people">${keys.map(k => `<label class="chip-check"><input type="checkbox" name="who" value="${esc(k)}"${inCart(k) ? ' checked' : ''}><span>${esc(ppl[k].name)}</span></label>`).join('')}</div>
        <button class="secondary block" type="submit">${plusIcon()} ${esc(t('sharedAdd'))}</button>
      </form>
    </details>`;
  }


  /* names of items across all the group's restaurants, for typing items that aren't on today's menu */
  function catalogNames(c) {
    const own = new Set((c && c.menu || []).map(i => C.normName(i.name)));
    const seen = new Set(), out = [];
    for (const r of S.restaurants) for (const it of r.items || []) {
      const k = C.normName(it.name);
      if (own.has(k) || seen.has(k)) continue;
      seen.add(k); out.push(it.name);
    }
    for (const x of S.carts) for (const k of Object.keys(x.members || {})) for (const it of x.members[k].items || []) {
      const n = it.askedFor || (it.custom ? it.name : null);
      if (!n) continue;
      const kk = C.normName(n);
      if (own.has(kk) || seen.has(kk)) continue;
      seen.add(kk); out.push(n);
    }
    return out.slice(0, 300);
  }

  function groupByCategory(items) {
    const order = [], map = {};
    for (const it of items || []) {
      const cat = (it.category || '').trim();
      if (!(cat in map)) { map[cat] = []; order.push(cat); }
      map[cat].push(it);
    }
    return order.map(name => ({ name, items: map[name] }));
  }

  /* people */
  function tabPeople(c, st, host) {
    const ppl = people(c);
    const order = { none: 0, picking: 1, done: 2, out: 3 };
    const keys = Object.keys(ppl).sort((a, b) => order[personStatus(c, a)] - order[personStatus(c, b)] || ppl[a].name.localeCompare(ppl[b].name));
    const by = s => keys.filter(k => personStatus(c, k) === s);
    const open = st === 'ordering';
    const exp = C.withShared(c).members || {};
    const rows = keys.map(k => {
      const p = ppl[k], s = personStatus(c, k), m = (c.members || {})[k];
      const its = (exp[k] && exp[k].items) || [];
      const cnt = m ? (m.items || []).reduce((a, it) => a + C.num(it.qty), 0) : 0;
      let actions = '';
      if (host && open && k !== me() && (s === 'none' || s === 'picking') && p.phone) {
        actions += wa(waLink(p.phone, t(s === 'none' ? 'msgRemindNone' : 'msgRemindPicking', { name: p.name, rest: c.restaurant.name, time: fmtTime(c.closesAt), link: cartLink(c) })), t('remind'));
      }
      if (host && (open || st === 'closed') && k !== me()) actions += `<button class="ghost small" data-act="orderFor" data-key="${esc(k)}">${esc(t('orderForBtn'))}</button>`;
      return `<li class="person state-${s}">
        <span class="avatar sm${s === 'none' ? ' ghosted' : ''}">${esc(initial(p.name))}</span>
        <span class="p-main"><strong>${esc(p.name)}${k === me() ? ` <small class="muted">(${esc(t('you'))})</small>` : ''}${k === c.ownerId ? ` <small class="muted">· ${esc(t('host'))}</small>` : ''}${p.guest ? ` <small class="muted">· ${esc(t('guest'))}</small>` : ''}</strong>
          <small class="muted tnum">${cnt ? cnt + ' · ' + esc(money(C.memberSubtotal(exp[k] || m))) : '—'}</small>
</span>
        <span class="p-side">${personChip(s)}${actions}</span>
          ${its.length ? `<ul class="p-items">${its.map(it => `<li><span>${it.shared ? '🤝 ' : ''}${C.num(it.qty) > 1 || !it.shared ? `<b class="tnum">${esc(String(it.qty))}×</b> ` : ''}${esc(it.name)}${it.note ? ` <em>(${esc(it.note)})</em>` : ''}${it.shared ? ` <small class="muted">÷${it.sharedN}</small>` : ''}</span><span class="tnum">${it.price ? esc(C.fmtMoney(C.round2(C.num(it.price) * C.num(it.qty)))) : '?'}</span></li>`).join('')}</ul>` : ''}
      </li>`;
    }).join('');

    const late = [...by('none'), ...by('picking')].filter(k => k !== me());
    return `<section>
      <div class="counts tnum">
        <span class="chip chip-done">${esc(t('cntDone', { n: by('done').length }))}</span>
        <span class="chip chip-picking">${esc(t('cntPicking', { n: by('picking').length }))}</span>
        <span class="chip chip-none">${esc(t('cntNone', { n: by('none').length }))}</span>
        <span class="chip chip-out">${esc(t('cntOut', { n: by('out').length }))}</span>
      </div>
      <ul class="people">${rows}</ul>
      ${host && open && late.length ? wa(waLink('', t('msgRemindGroup', { rest: c.restaurant.name, time: fmtTime(c.closesAt), names: late.map(k => ppl[k].name).join(comma()), link: cartLink(c) })), t('remindGroup'), 'block') : ''}
      ${isLocal() && host ? `<p class="muted small-text">${esc(t('demoWaNote'))}</p>` : ''}
      ${host && st !== 'settled' ? `<form class="panel form add-person" data-submit="cartPerson" novalidate>
        <p class="label">➕ ${esc(t('addPersonTitle'))}</p>
        <p class="muted small-text">${esc(t('addPersonHint'))}</p>
        <div class="grid2">
          <label class="field"><span>${esc(t('personName'))}</span><input id="cp-name" name="name" autocomplete="off"></label>
          <label class="field"><span>${esc(t('personPhoneOpt'))}</span><input id="cp-phone" name="phone" type="tel" dir="ltr" autocomplete="off"></label>
        </div>
        <button class="secondary block" type="submit">${esc(t('addPersonBtn'))}</button>
      </form>` : ''}
      ${host ? `<section class="panel controls">
        <p class="label">${esc(t('ownerControls'))}</p>
        <div class="btn-row">
          ${st === 'ordering' ? `<button class="secondary" data-act="extend">${esc(t('extend'))}</button><button class="danger-ghost" data-act="closeCart">${esc(t('closeNow'))}</button>` : ''}
          ${st === 'closed' || st === 'ordered' ? `<button class="secondary" data-act="reopen">${esc(t('reopen'))}</button>` : ''}
        </div>
        <p class="muted small-text">${esc(t('orderForHint'))}</p>
      </section>` : ''}
    </section>`;
  }

  /* combined order */
  function orderText(c, agg) {
    const lines = [t('msgOrderHead', { rest: c.restaurant.name }), fmtDate(Date.now()) + ' ' + fmtTime(Date.now()), ''];
    for (const l of agg.lines) {
      lines.push(`${l.qty} × ${l.name} — ${C.fmtMoney(l.total)}`);
      if (l.note) lines.push(`   ${t('msgNote')}: ${l.note}`);
    }
    lines.push('—————', `${t('pieces')}: ${agg.pieces}`, `${t('foodTotal')}: ${money(agg.total)}`);
    return lines.join('\n');
  }
  // the order checklist: tick each line as it goes into the Talabat cart
  function lineId(l) { let h = 5381; const k = l.name + '|' + l.price + '|' + (l.note || '') + '|' + l.qty; for (let i = 0; i < k.length; i++) h = ((h * 33) ^ k.charCodeAt(i)) >>> 0; return 'l' + h.toString(36); }
  function checkProgress(c, agg) {
    const n = agg.lines.length, d = agg.lines.filter(l => (c.checked || {})[lineId(l)]).length;
    return `<div class="chk-prog${d === n ? ' all' : ''}"><span>${esc(d === n ? t('checkedAll') : t('checkedN', { d, n }))}</span><span class="bar"><i style="width:${Math.round(d / n * 100)}%"></i></span>${d ? `<button class="link-btn" data-act="clearChecks">${esc(t('clearChecks'))}</button>` : ''}</div>`;
  }
  function tabOrder(c, st, host) {
    const agg = C.aggregate(c);
    if (!agg.lines.length) return `<p class="empty">${esc(t('orderEmpty'))}</p>`;
    const text = orderText(c, agg);
    const r = c.restaurant;
    return `<section>
      ${st === 'ordering' ? `<p class="banner soft">${esc(t('stillOpenWarn'))}</p>` : ''}
      ${st === 'ordered' || st === 'settled' ? `<p class="banner ok">${esc(t('orderedNote'))}</p>` : ''}
      <div class="ticket">
        <div class="ticket-head"><strong>${esc(r.name)}</strong><span class="muted tnum">${esc(fmtTime(Date.now()))}</span></div>
        ${checkProgress(c, agg)}
        <ul class="agg">${agg.lines.map(l => { const id = lineId(l), on = !!(c.checked || {})[id]; return `<li class="${on ? 'done' : ''}">
          <label class="chk"><input type="checkbox" data-change="checkLine" data-id="${id}" ${on ? 'checked' : ''} ${host ? '' : 'disabled'} aria-label="${esc(t('markOrdered1'))}"></label>
          <span class="q tnum">${l.qty}×</span>
          <span class="n">${esc(l.name)}${l.custom ? ` <small class="tag">${esc(t('notOnMenu'))}</small>` : ''}${l.note ? `<em>${esc(l.note)}</em>` : ''}<small class="muted">${esc(t('forWho'))}: ${l.who.map(w => esc(w.name) + (w.qty > 1 ? ' ×' + w.qty : '')).join(comma())}</small></span>
          <span class="p tnum">${l.price ? esc(C.fmtMoney(l.total)) : '?'}</span>
        </li>`; }).join('')}</ul>
        ${agg.lines.some(l => l.custom) ? `<p class="muted small-text">${esc(t('customOrderHint'))}</p>` : ''}
        <div class="ticket-foot">
          <div><span>${esc(t('pieces'))}</span><strong class="tnum">${agg.pieces}</strong></div>
          <div><span>${esc(t('foodTotal'))}</span><strong class="tnum">${esc(money(agg.total))}</strong></div>
        </div>
      </div>
      <div class="btn-row">
        <button class="secondary" data-act="copy" data-text="${esc(text)}">${esc(t('copyOrder'))}</button>
        ${wa(waLink('', text), t('sendOrderWa'), '')}
        <button class="secondary" data-act="openTalabat">${esc(t('openTalabat'))}</button>
      </div>
      ${r.phone ? `<p class="phone-line"><span>${esc(t('callRest'))}:</span> <a href="tel:${esc(C.latinDigits(r.phone).replace(/[^\d+]/g, ''))}" class="tnum" dir="ltr">${esc(r.phone)}</a></p>` : ''}
      ${host && (st === 'ordering' || st === 'closed') ? `<button class="primary block big" data-act="markOrdered">✓ ${esc(t('markOrdered'))}</button><p class="muted small-text center">${esc(t('markOrderedHint'))}</p>` : ''}
    </section>`;
  }

  /* bill & payments */
  const KINDS = ['delivery', 'service', 'tax', 'tip', 'shortage', 'discount', 'other'];
  const METHODS = ['instapay', 'cash', 'wallet'];

  function billMessage(c, row) {
    const L = [t('msgBillHi', { name: row.name, rest: c.restaurant.name, date: fmtDate(c.createdAt) }), ''];
    for (const it of row.items) L.push(`• ${it.qty} × ${it.name} — ${C.fmtMoney(C.num(it.price) * C.num(it.qty))}`);
    L.push('', `${t('rowFood')}: ${C.fmtMoney(row.subtotal)}`);
    for (const l of row.lines) L.push(`${l.label}: ${l.value < 0 ? '-' : ''}${C.fmtMoney(Math.abs(l.value))}`);
    L.push(`${t('rowTotal')}: ${money(row.total)}`);
    if (row.prev > 0.009) L.push(`${t('prevCredit')}: -${C.fmtMoney(row.prev)}`);
    if (row.prev < -0.009) L.push(`${t('prevDebt')}: +${C.fmtMoney(-row.prev)}`);
    if (Math.abs(row.prev) > 0.009) L.push(t('msgNet', { total: money(row.net) }));
    const pi = c.payInfo || {};
    if (pi.instapay || pi.wallet || pi.instapayLink) {
      L.push('', t('msgPay'));
      if (pi.instapayLink) L.push(t('msgPayLink', { link: pi.instapayLink }));
      if (pi.instapay) L.push('InstaPay: ' + pi.instapay);
      if (pi.wallet) L.push(t('walletShort') + ': ' + pi.wallet);
    }
    L.push('', t('msgThanks'));
    return L.join('\n');
  }

  function chargesEditor(c) {
    const ppl = people(c);
    const eaters = C.eaters(c);
    const list = c.charges || [];
    return `<section class="panel form fees">
      <p class="label">${esc(t('chargesTitle'))}</p>
      <p class="muted small-text">${esc(t('chargesHint'))}</p>
      ${list.length ? `<ul class="charges">${list.map((ch, i) => `<li>
        <input id="ch-l-${esc(ch.id)}" class="ch-label" data-change="chLabel" data-i="${i}" value="${esc(ch.label)}" aria-label="${esc(t('chargeName'))}">
        <input id="ch-a-${esc(ch.id)}" class="ch-amt tnum" inputmode="decimal" data-change="chAmount" data-i="${i}" value="${ch.amount ? esc(ch.amount) : ''}" placeholder="0" aria-label="${esc(t('amount'))}">
        <select id="ch-s-${esc(ch.id)}" data-change="chSplit" data-i="${i}" aria-label="${esc(t('splitHow'))}">
          ${['equal', 'share', 'person'].map(s => `<option value="${s}"${(ch.split || C.DEFAULT_SPLIT[ch.kind]) === s ? ' selected' : ''}>${esc(t('split_' + s))}</option>`).join('')}
        </select>
        ${(ch.split === 'person') ? `<select id="ch-p-${esc(ch.id)}" data-change="chPerson" data-i="${i}" aria-label="${esc(t('splitPerson'))}">${eaters.map(k => `<option value="${esc(k)}"${ch.person === k ? ' selected' : ''}>${esc(ppl[k].name)}</option>`).join('')}</select>` : ''}
        <button type="button" class="icon-btn" data-act="delCharge" data-i="${i}" aria-label="${esc(t('delete'))}">×</button>
        ${ch.kind === 'discount' ? `<small class="ch-note">${esc(t('discountNote'))}</small>` : ''}
      </li>`).join('')}</ul>` : ''}
      <div class="quick-add">${KINDS.map(k => `<button type="button" class="chip-btn" data-act="addCharge" data-kind="${k}">+ ${esc(t('kind_' + k))}</button>`).join('')}</div>
      <label class="check"><input type="checkbox" id="round-up" data-change="roundUp" ${c.roundUp ? 'checked' : ''}><span>${esc(t('roundUp'))}</span></label>
      ${hostOptions(c)}
    </section>`;
  }

  function billCard(c, row, host, st) {
    const isMe = row.key === me();
    const lines = `<dl class="bill-lines tnum">
        <div><dt>${esc(t('rowFood'))}</dt><dd>${esc(C.fmtMoney(row.subtotal))}</dd></div>
        ${row.lines.map(l => `<div><dt>${esc(l.label)}</dt><dd>${l.value < 0 ? '−' : ''}${esc(C.fmtMoney(Math.abs(l.value)))}</dd></div>`).join('')}
        ${row.prev > 0.009 ? `<div class="ok"><dt>${esc(t('prevCredit'))}</dt><dd>−${esc(C.fmtMoney(row.prev))}</dd></div>` : ''}
        ${row.prev < -0.009 ? `<div class="warn"><dt>${esc(t('prevDebt'))}</dt><dd>+${esc(C.fmtMoney(-row.prev))}</dd></div>` : ''}
      </dl>`;
    const placed = st === 'ordered' || st === 'settled';
    const p = row.payment;
    const pm = p ? `${t('method_' + (p.method || 'cash'))} ${C.fmtMoney(p.amount)}` : '';
    let actions = '';
    if (row.isHost) actions = `<p class="muted small-text">${esc(t('hostShare'))}</p>`;
    else if (placed && host && !isMe) {
      const method = S.payMethod[row.key] || 'instapay';
      if (row.state === 'reported') {
        actions = `<div class="bill-actions"><span class="muted small-text">${esc(t('reportedSays', { m: pm }))}</span>
          <button class="primary small" data-act="confirmPay" data-key="${esc(row.key)}">✓ ${esc(t('confirm'))}</button>
          <button class="ghost small" data-act="rejectPay" data-key="${esc(row.key)}">${esc(t('notReceived'))}</button></div>`;
      } else if (row.state === 'paid') {
        actions = `<div class="bill-actions"><span class="muted small-text">✓ ${esc(pm)}</span><button class="ghost small" data-act="undoPay" data-key="${esc(row.key)}">${esc(t('undo'))}</button></div>`;
      } else {
        actions = `<div class="bill-actions col">
          <div class="pay-row">
            <div class="seg small">${METHODS.map(mt => `<button class="${method === mt ? 'on' : ''}" data-act="payMethod" data-key="${esc(row.key)}" data-m="${mt}">${esc(t('method_' + mt))}</button>`).join('')}</div>
            <input id="pay-${esc(row.key)}" class="pay-amt tnum" inputmode="decimal" value="${esc(C.fmtMoney(row.remaining))}" aria-label="${esc(t('amount'))}">
            <button class="primary small" data-act="recordPay" data-key="${esc(row.key)}">${esc(t('recordPay'))}</button>
          </div>
          <div class="btn-row tight">
            ${row.phone ? wa(waLink(row.phone, billMessage(c, row)), t('sendBill')) : `<button class="secondary small" data-act="copy" data-text="${esc(billMessage(c, row))}">${esc(t('copyBill'))}</button>`}
            ${row.phone && (p || st === 'settled') ? `<a class="ghost small as-btn" href="${esc(waLink(row.phone, t('msgPayRemind', { name: row.name, rest: c.restaurant.name, total: money(row.remaining) })))}" target="_blank" rel="noopener">${esc(t('payRemind'))}</a>` : ''}
          </div>
        </div>`;
      }
    } else if (placed && isMe) {
      if (row.state === 'unpaid' || row.state === 'partial') {
        const method = S.payMethod[row.key] || 'instapay';
        actions = `<div class="bill-actions col">
          <p class="label">${esc(t('iPaidQ'))}</p>
          <div class="pay-row">
            <div class="seg small">${METHODS.map(mt => `<button class="${method === mt ? 'on' : ''}" data-act="payMethod" data-key="${esc(row.key)}" data-m="${mt}">${esc(t('method_' + mt))}</button>`).join('')}</div>
            <input id="pay-${esc(row.key)}" class="pay-amt tnum" inputmode="decimal" value="${esc(C.fmtMoney(row.remaining))}" aria-label="${esc(t('amount'))}">
            <button class="primary small" data-act="reportPay">${esc(t('reportPay'))}</button>
          </div></div>`;
      } else if (row.state === 'reported') {
        actions = `<p class="muted small-text">${esc(t('waitingConfirm', { host: c.ownerName, m: pm }))}</p>`;
      }
    }
    return `<li class="bill-card state-${row.state}${isMe ? ' is-me' : ''}">
      <div class="bc-head">
        <strong>${esc(row.name)}${isMe ? ` <small class="muted">(${esc(t('you'))})</small>` : ''}${row.guest ? ` <small class="muted">· ${esc(t('guest'))}</small>` : ''}</strong>
        <span class="bc-total tnum">${esc(money(Math.abs(row.prev) > 0.009 ? row.net : row.total))}</span>
      </div>
      ${lines}
      ${placed ? `<div class="bc-state">${payChip(row, c)}</div>` : ''}
      ${actions}
    </li>`;
  }

  function tabBill(c, st, host) {
    const placed = st === 'ordered' || st === 'settled';
    const bill = C.computeBill(c, prevFor(c));
    const pi = c.payInfo || {};
    if (!bill.rows.length) return `<p class="empty">${esc(t('noBill'))}</p>`;
    const others = bill.rows.filter(r => !r.isHost);
    const settledAll = others.every(r => r.state === 'paid' || payChip(r, c).includes('chip-done'));
    const summary = `<section class="summary tnum">
        <div><span>${esc(t('foodTotal'))}</span><strong>${esc(money(bill.food))}</strong></div>
        <div><span>${esc(t('billTotal'))}</span><strong>${esc(money(bill.grand))}</strong><small class="muted">${esc(t('chargesN', { a: (bill.chargesTotal >= 0 ? '+' : '−') + C.fmtMoney(Math.abs(bill.chargesTotal)) }))}</small></div>
        <div><span>${esc(t('collected'))}</span><strong>${esc(money(bill.collected))}</strong>${bill.extra > 0 ? `<small class="muted">${esc(t('roundExtra'))} +${esc(C.fmtMoney(bill.extra))}</small>` : ''}</div>
        ${placed && host ? `<div class="paid-bar"><span>${esc(t('paidProgress', { a: C.fmtMoney(bill.paidSum), b: C.fmtMoney(bill.collected) }))}</span>
          <span class="bar"><i style="width:${bill.collected ? Math.min(100, Math.round(bill.paidSum / bill.collected * 100)) : 0}%"></i></span></div>` : ''}
      </section>
      ${host && (placed || st === 'closed') ? paidCheck(c, bill) : ''}`;
    const visible = host ? bill.rows : bill.rows.filter(r => r.key === me());
    const myRow = bill.rows.find(r => r.key === me());
    const payBox = (pi.instapay || pi.wallet || pi.instapayLink || host) ? `<section class="panel pay">
        <p class="label">${esc(host ? t('payInfoEdit') : t('payTo', { name: c.ownerName }))}</p>
        ${host ? `<div class="grid2">
          <label class="field"><span>${esc(t('instapayAny'))}</span><input id="pi-insta" dir="ltr" data-change="payInfoInsta" value="${esc(instaValue(pi))}" placeholder="name@instapay / https://ipn.eg/…"></label>
          <label class="field"><span>${esc(t('wallet'))}</span><input id="pi-wallet" dir="ltr" type="tel" data-change="payInfo" data-k="wallet" value="${esc(pi.wallet || '')}"></label>
        </div>${pi.instapayLink ? `<p class="muted small-text">✓ ${esc(t('instaLinkOk', { h: pi.instapay || '' }))}</p>` : ''}` : payButtons(pi, myRow && placed ? (myRow.remaining || myRow.net || 0) : 0)}
      </section>` : '';
    return `<section class="stack">
      ${!placed && !(host && st === 'closed') ? `<p class="banner soft">${esc(host ? t('billBeforeHost') : t('billBefore'))}</p>` : ''}
      ${host && (placed || st === 'closed') && others.length && !(S.sendQ && S.sendQ.cartId === c.id) ? `<button class="wa big block send-top" data-act="issueInvoices">${waIcon()} ${esc(t('sendInvoicesTop', { n: others.length }))}</button>
        <p class="muted small-text center">${esc(t('sendInvoicesTopHint'))}</p>` : ''}
      ${host && (placed || st === 'closed') ? receiptPanel(c) : ''}
      ${host ? chargesEditor(c) : ''}
      ${host ? summary : ''}
      ${host && (placed || st === 'closed') ? combinedInvoice(c, bill) : ''}
      ${!host && placed && c.invoices && c.invoices[me()] ? `<button class="secondary block" data-act="previewInvoice" data-key="${esc(me())}">${esc(t('viewMyInvoice'))}</button>` : ''}
      ${host && placed ? `<p class="muted small-text">${esc(t('sendAllHint'))}</p>` : ''}
      ${isLocal() && host ? `<p class="muted small-text">${esc(t('demoWaNote'))}</p>` : ''}
      <ul class="bills">${visible.map(r => billCard(c, r, host, st)).join('')}</ul>
      ${payBox}
      ${host && st === 'ordered' && settledAll ? `<button class="primary block" data-act="settle">✓ ${esc(t('settleBtn'))}</button>` : ''}
    </section>`;
  }

  /* ---------- money ---------- */
  function viewMoney() {
    const toMe = owedToMe();
    const credits = Object.values(pairs()[me()] || {}).filter(p => p.balance > 0.009);
    const { owe, credit } = myDebts();
    const pend = pendingForMe();
    const tot = list => C.round2(list.reduce((s, p) => s + Math.abs(p.balance), 0));
    const myPI = { instapay: S.profile.instapay, wallet: S.profile.wallet };
    return `<h1>${esc(t('navMoney'))}</h1>
      ${pend.length ? `<section class="stack">
        <div class="section-head"><h2>${esc(t('toConfirm'))}</h2><span class="chip chip-picking tnum">${pend.length}</span></div>
        <ul class="people">${pend.map(({ c, key, p }) => {
          const m = (c.members || {})[key] || {};
          return `<li class="person"><span class="avatar sm">${esc(initial(m.name))}</span>
            <span class="p-main"><strong>${esc(m.name)}</strong><small class="muted">${esc(t('method_' + (p.method || 'cash')))} · ${esc(money(p.amount))} · ${esc(c.restaurant.name)} (${esc(fmtAgo(c.createdAt))})</small></span>
            <span class="p-side"><button class="primary small" data-act="confirmPayIn" data-cart="${esc(c.id)}" data-key="${esc(key)}">✓ ${esc(t('confirm'))}</button><button class="ghost small" data-act="rejectPayIn" data-cart="${esc(c.id)}" data-key="${esc(key)}">${esc(t('notReceived'))}</button></span></li>`;
        }).join('')}</ul></section>` : ''}

      <section class="stack">
        <div class="section-head"><h2>${esc(t('owedToYou'))}</h2><b class="tnum">${esc(money(tot(toMe)))}</b></div>
        ${toMe.length ? `<ul class="people">${toMe.map(p => {
          const msg = t('msgDebt', { name: p.name, total: money(-p.balance), n: p.carts.filter(x => x.state !== 'paid').length }) + payLines(myPI);
          const method = S.payMethod['d_' + p.key] || 'cash';
          return `<li class="person debt">
            <span class="avatar sm">${esc(initial(p.name))}</span>
            <span class="p-main"><strong>${esc(p.name)}</strong><small class="muted">${esc(p.carts.filter(x => x.state !== 'paid').map(x => x.rest + ' (' + fmtAgo(x.at) + ')').slice(-3).join(comma()))}</small></span>
            <span class="p-side"><b class="tnum debt-amt">${esc(money(-p.balance))}</b></span>
            <div class="debt-actions">
              ${p.phone ? wa(waLink(p.phone, msg), t('remind')) : ''}
              <div class="seg small">${['cash', 'instapay'].map(mt => `<button class="${method === mt ? 'on' : ''}" data-act="payMethod" data-key="d_${esc(p.key)}" data-m="${mt}">${esc(t('method_' + mt))}</button>`).join('')}</div>
              <button class="secondary small" data-act="recordDebt" data-key="${esc(p.key)}">${esc(t('gotIt', { a: C.fmtMoney(-p.balance) }))}</button>
            </div></li>`;
        }).join('')}</ul>` : `<p class="empty small">${esc(t('nobodyOwes'))}</p>`}
        ${credits.length ? `<p class="muted small-text">${esc(t('creditsHeld'))}: ${esc(credits.map(p => p.name + ' ' + C.fmtMoney(p.balance)).join(comma()))}</p>` : ''}
      </section>

      <section class="stack">
        <div class="section-head"><h2>${esc(t('youOwe'))}</h2><b class="tnum">${esc(money(tot(owe)))}</b></div>
        ${owe.length ? owe.map(p => {
          const last = cartById(p.carts[p.carts.length - 1].id);
          const pi = (last && last.payInfo) || {};
          const method = S.payMethod['o_' + p.host] || 'instapay';
          const reported = last && last.payments && last.payments[me()] && last.payments[me()].status === 'reported';
          return `<div class="panel owe">
            <div class="bc-head"><strong>${esc(p.hostName)}</strong><b class="tnum bc-total">${esc(money(-p.balance))}</b></div>
            <small class="muted">${esc(p.carts.filter(x => x.state !== 'paid').map(x => x.rest + ' (' + fmtAgo(x.at) + ')').join(comma()))}</small>
            ${reported ? '' : payButtons(pi, -p.balance)}
            ${reported ? `<p class="muted small-text">${esc(t('waitingConfirm', { host: p.hostName, m: '' }))}</p>` : `<div class="pay-row">
              <div class="seg small">${METHODS.map(mt => `<button class="${method === mt ? 'on' : ''}" data-act="payMethod" data-key="o_${esc(p.host)}" data-m="${mt}">${esc(t('method_' + mt))}</button>`).join('')}</div>
              <button class="primary small" data-act="reportDebt" data-host="${esc(p.host)}">${esc(t('iPaidAll', { a: C.fmtMoney(-p.balance) }))}</button>
            </div>`}
          </div>`;
        }).join('') : `<p class="empty small">${esc(t('youOweNothing'))}</p>`}
        ${credit.length ? `<p class="muted small-text">${esc(t('yourCredit'))}: ${esc(credit.map(p => p.hostName + ' ' + C.fmtMoney(p.balance)).join(comma()))}</p>` : ''}
      </section>`;
  }
  /* InstaPay: accept the handle, the ipn.eg link, or the whole "send money to me" message pasted as is */
  function splitInsta(text) {
    const v = String(text || '').trim();
    const link = (v.match(/https?:\/\/(?:www\.)?ipn\.eg\/\S+/i) || [])[0] || '';
    let handle = (v.match(/[\w.\-]+@instapay/i) || [])[0] || '';
    if (!handle && link) { const m = link.match(/\/S\/([^/]+)\/instapay/i); if (m) handle = m[1] + '@instapay'; }
    if (!handle && !link) handle = v;
    return { instapay: handle, instapayLink: link };
  }
  const instaValue = pi => (pi && (pi.instapayLink || pi.instapay)) || '';
  // pay box: one tap to InstaPay with the amount shown, plus the handle and wallet to copy
  function payButtons(pi, amount) {
    pi = pi || {};
    const amt = C.fmtMoney(amount || 0);
    // InstaPay links can't carry an amount, so the tap copies it: in InstaPay it is one long-press → Paste
    return `${pi.instapayLink ? `<a class="insta-btn" href="${esc(pi.instapayLink)}" target="_blank" rel="noopener" data-act="payGo" data-keep="1" data-text="${esc(amt)}">💸 ${esc(t('payInsta', { a: money(amount || 0) }))}</a>
        <p class="muted small-text insta-note">${esc(t('payInstaNote2', { a: amt }))}</p>` : ''}
      ${pi.instapay ? `<p class="pay-line"><span>InstaPay</span><code dir="ltr">${esc(pi.instapay)}</code><button class="ghost small" data-act="copy" data-text="${esc(pi.instapay)}">${esc(t('copy'))}</button></p>` : ''}
      ${pi.wallet ? `<p class="pay-line"><span>${esc(t('walletShort'))}</span><code dir="ltr">${esc(pi.wallet)}</code><button class="ghost small" data-act="copy" data-text="${esc(pi.wallet)}">${esc(t('copy'))}</button></p>` : ''}`;
  }
  function payLines(pi) {
    const L = [];
    if (pi.instapayLink) L.push(t('msgPayLink', { link: pi.instapayLink }));
    if (pi.instapay) L.push('InstaPay: ' + pi.instapay);
    if (pi.wallet) L.push(t('walletShort') + ': ' + pi.wallet);
    return L.length ? '\n\n' + t('msgPay') + '\n' + L.join('\n') : '';
  }

  /* ---------- group ---------- */
  function viewGroup() {
    const g = S.group;
    const link = groupLink(S.gid);
    const ppl = people(null);
    const keys = Object.keys(ppl).sort((a, b) => (a === g.ownerId ? -1 : b === g.ownerId ? 1 : 0) || ppl[a].name.localeCompare(ppl[b].name));
    return `<h1>${esc(g.name)}</h1>
      <section class="share">
        <p class="label">${esc(t('inviteTitle'))}</p>
        <div class="share-row">
          <code class="link" dir="ltr">${esc(link)}</code>
          <button class="secondary small" data-act="copy" data-text="${esc(link)}">${esc(t('copyLink'))}</button>
          ${wa(waLink('', t('msgGroupInvite', { name: g.name, link })), t('shareWa'))}
        </div>
        <small class="muted">${esc(t('inviteHint'))}</small>
      </section>
      <section class="panel perms">
        <p class="label">🔐 ${esc(t('permsTitle'))}</p>
        <ul class="perm-list">
          <li><b>${esc(t('roleOwner'))} / ${esc(t('roleAdmin'))}</b><span>${esc(t('permsAdmin'))}</span></li>
          <li><b>${esc(t('roleMember'))}</b><span>${esc(t('permsMember'))}</span></li>
        </ul>
        <p class="muted small-text">${esc(isOwner() ? t('permsOwnerHint') : isAdmin() ? t('permsYouAdmin') : t('permsYouMember'))}</p>
      </section>
      <section>
        <div class="section-head"><h2>${esc(t('membersN', { n: keys.length }))}</h2></div>
        <ul class="people">${keys.map(k => `<li class="person">
          <span class="avatar sm${ppl[k].guest ? ' ghosted' : ''}">${esc(initial(ppl[k].name))}</span>
          <span class="p-main"><strong>${esc(ppl[k].name)}${k === me() ? ` <small class="muted">(${esc(t('you'))})</small>` : ''}</strong>${isAdmin() ? `<small class="muted tnum" dir="ltr">${esc(ppl[k].phone || '')}</small>` : ''}</span>
          <span class="p-side">${k === g.ownerId ? `<span class="chip chip-ordered">${esc(t('roleOwner'))}</span>` : (g.adminIds || []).includes(k) ? `<span class="chip chip-open">${esc(t('roleAdmin'))}</span>` : ''}${ppl[k].guest ? `<span class="chip chip-out">${esc(t('guest'))}</span>` : ''}
          ${isAdmin() && ppl[k].guest ? `<button class="icon-btn" data-act="delGuest" data-key="${esc(k)}" aria-label="${esc(t('delete'))}">×</button>` : ''}
          ${isOwner() && !ppl[k].guest && k !== g.ownerId && k !== me() ? `<button class="ghost small" data-act="toggleAdmin" data-key="${esc(k)}">${esc((g.adminIds || []).includes(k) ? t('removeAdmin') : t('makeAdmin'))}</button>` : ''}</span>
        </li>`).join('')}</ul>
      </section>
      ${isAdmin() ? `<form class="panel form" data-submit="addGuest" novalidate>
        <p class="label">${esc(t('addGuest'))}</p>
        <p class="muted small-text">${esc(t('addGuestHint'))}</p>
        <div class="grid2">
          <label class="field"><span>${esc(t('personName'))}</span><input id="gu-name" name="name"></label>
          <label class="field"><span>${esc(t('personPhoneOpt'))}</span><input id="gu-phone" name="phone" type="tel" dir="ltr"></label>
        </div>
        <button class="secondary" type="submit">${plusIcon()} ${esc(t('add'))}</button>
      </form>
      <form class="panel form" data-submit="renameGroup" novalidate>
        <label class="field"><span>${esc(t('groupName'))}</span><input id="g-rename" name="name" value="${esc(g.name)}"></label>
        <button class="secondary" type="submit">${esc(t('save'))}</button>
      </form>` : ''}
      ${S.groups.length > 1 ? `<section class="panel"><p class="label">${esc(t('myGroups'))}</p>${S.groups.map(x => `<button class="row-link${x.id === S.gid ? ' on' : ''}" data-act="switchGroup" data-id="${esc(x.id)}"><span><strong>${esc(x.name)}</strong></span><span class="chev">›</span></button>`).join('')}</section>` : ''}
      ${!isLocal() ? `<details class="panel"><summary>${esc(t('newGroup'))}</summary>
        <form class="form" data-submit="createGroup" novalidate>
          <label class="field"><span>${esc(t('groupName'))}</span><input id="g-new" name="name"></label>
          <button class="secondary" type="submit">${esc(t('createGroup'))}</button>
        </form></details>` : ''}`;
  }

  /* ---------- restaurants ---------- */
  function viewRestaurants() {
    const q = S.restQuery.trim().toLowerCase();
    const list = S.restaurants.slice().sort((a, b) => (b.lastOrderedAt || 0) - (a.lastOrderedAt || 0) || a.name.localeCompare(b.name));
    return `<div class="section-head"><h1>${esc(t('navRestaurants'))}</h1><button class="primary small" data-act="newRestaurant">${plusIcon()} ${esc(t('addRestaurant'))}</button></div>
      <p class="muted small-text">${esc(t('restLibHint'))}</p>
      ${list.length > 5 ? `<input type="search" id="rest-search2" data-input="restSearch" placeholder="${esc(t('searchRest'))}" value="${esc(S.restQuery)}">` : ''}
      ${list.length ? `<ul class="rest-list">${list.map(r => `<li class="pick-wrap" data-name="${esc(r.name.toLowerCase())}"${q && !r.name.toLowerCase().includes(q) ? ' hidden' : ''}><button class="row-link" data-act="editRestaurant" data-id="${esc(r.id)}">
        <span><strong>${esc(r.name)}</strong><small class="muted">${esc(t('itemsCount', { n: (r.items || []).length }))} · ${esc(t('lastOrdered'))}: ${esc(fmtAgo(r.lastOrderedAt))}</small></span><span class="chev" aria-hidden="true">›</span></button></li>`).join('')}</ul>`
        : `<p class="empty">${esc(t('noRestaurants'))}</p>`}`;
  }

  function viewRestaurantEdit() {
    const d = S.draft;
    if (!d) return viewRestaurants();
    const cats = groupByCategory(d.items);
    const f = d.fees || {};
    return `${back(S.route.from || 'restaurants')}
      <h1>${esc(d.id ? d.name || t('navRestaurants') : t('newRestaurant'))}</h1>
      <section class="panel form">
        <label class="field"><span>${esc(t('restName'))}</span><input id="r-name" data-draft="name" value="${esc(d.name)}"></label>
        <div class="grid2">
          <label class="field"><span>${esc(t('restPhone'))}</span><input id="r-phone" data-draft="phone" type="tel" dir="ltr" value="${esc(d.phone)}"></label>
        </div>
      </section>
      <section class="panel form">
        <p class="label">${esc(t('typicalCharges'))}</p>
        <p class="muted small-text">${esc(t('typicalChargesHint'))}</p>
        <div class="grid4">
          <label class="field"><span>${esc(t('delivery'))}</span><input id="rf-del" class="tnum" inputmode="decimal" data-fee="delivery" value="${f.delivery ? esc(f.delivery) : ''}" placeholder="0"></label>
          <label class="field"><span>${esc(t('servicePctLbl'))}</span><input id="rf-svcp" class="tnum" inputmode="decimal" data-fee="servicePct" value="${f.servicePct ? esc(f.servicePct) : ''}" placeholder="0"></label>
          <label class="field"><span>${esc(t('taxPct'))}</span><input id="rf-tax" class="tnum" inputmode="decimal" data-fee="taxPct" value="${f.taxPct ? esc(f.taxPct) : ''}" placeholder="0"></label>
          <label class="field"><span>${esc(t('tipUsual'))}</span><input id="rf-tip" class="tnum" inputmode="decimal" data-fee="tip" value="${f.tip ? esc(f.tip) : ''}" placeholder="0"></label>
        </div>
      </section>

      ${!d.items.length ? `<section class="panel setup">
        <p class="label">${esc(t('setupTitle'))}</p>
        <ol class="steps-mini"><li>${esc(t('setupStep1'))}</li><li>${esc(t('setupStep2'))}</li><li>${esc(t('setupStep3'))}</li><li>${esc(t('setupStep4'))}</li></ol>
      </section>` : ''}
      <section class="panel shots">
        <p class="label">${esc(d.items.length ? t('updateTitle') : t('shotsTitle'))}</p>
        <p class="muted small-text">${esc(d.items.length ? t('updateHint') : t('menuShotsHint'))}</p>
        <label class="primary block file-btn${S.ocr && S.ocr.busy ? ' busy' : ''}">
          <input type="file" id="shots" accept="image/*" multiple data-change="shots">
          ${esc(S.ocr && S.ocr.busy ? t('shotsBusy') : d.items.length ? t('shotsPick') : '📷 ' + t('pickMenuShots'))}
        </label>
        ${!d.items.length ? `<button class="secondary block" data-act="manualMenu">✍️ ${esc(t('manualMenu'))}</button>` : ''}
        <p class="ocr-status small-text${S.ocr && S.ocr.error ? ' err' : ''}" id="ocr-status"${S.ocr && S.ocr.msg ? '' : ' hidden'}>${esc(S.ocr ? S.ocr.msg : '')}</p>
        ${savedReceipts(d.name)}
      </section>
      ${priceCompare(d)}

      ${S.restaurants.filter(r => r.id !== d.id && (r.items || []).length).length ? `<section class="panel copy-items">
        <p class="label">${esc(t('copyItemsTitle'))}</p>
        <p class="muted small-text">${esc(t('copyItemsHint'))}</p>
        <div class="pay-row"><select id="copy-from" data-change="copyFrom">${S.restaurants.filter(r => r.id !== d.id && (r.items || []).length).map(r => `<option value="${esc(r.id)}"${S.copyFrom === r.id ? ' selected' : ''}>${esc(r.name)} (${(r.items || []).length})</option>`).join('')}</select>
        <button class="secondary small" data-act="copyItems">${esc(t('copyItemsBtn'))}</button></div>
      </section>` : ''}

      <details class="panel paste">
        <summary>${esc(t('pasteMenu'))}</summary>
        <ol class="steps-mini">
          <li>${esc(t('pasteStep1'))}</li><li>${esc(t('pasteStep2'))}</li><li>${esc(t('pasteStep3'))}</li>
        </ol>
        <p class="muted small-text">${esc(t('pasteHint'))}</p>
        <textarea id="paste-menu" rows="7" placeholder="${esc(t('pastePh'))}"></textarea>
        <button class="secondary" data-act="parseMenu">${esc(t('parseBtn'))}</button>
        <p class="muted small-text" id="parse-result" hidden></p>
      </details>

      <section>
        <div class="section-head"><h2>${esc(t('menu'))} <small class="muted">${esc(t('itemsCount', { n: d.items.length }))}</small></h2>
          ${d.items.length && S.history[d.name] ? movesSummary(d) : ''}
          ${d.items.length ? `<button class="ghost small" data-act="clearMenu">${esc(S.confirmKey === 'clearMenu' ? t('confirmAgain') : t('clearMenu'))}</button>` : ''}</div>
        ${d.items.length ? cats.map(g => `<div class="menu-group">
            ${g.name ? `<h3 class="cat">${esc(g.name)}</h3>` : ''}
            <ul class="edit-items">${g.items.map(it => `<li${it.fresh ? ' class="fresh"' : ''}>
              <input class="ei-name" id="ei-n-${esc(it.id)}" data-change="itemName" data-id="${esc(it.id)}" value="${esc(it.name)}" aria-label="${esc(t('itemName'))}">
              <input class="ei-price tnum" id="ei-p-${esc(it.id)}" data-change="itemPrice" data-id="${esc(it.id)}" inputmode="decimal" value="${esc(it.price)}" aria-label="${esc(t('price'))}">
              <button class="icon-btn" data-act="draftDelItem" data-id="${esc(it.id)}" aria-label="${esc(t('delete'))}">×</button>
              ${it.oldPrice && it.oldPrice !== it.price ? `<small class="was tnum">${esc(t('wasPrice', { p: C.fmtMoney(it.oldPrice) }))}</small>` : moveTag(d.name, it.name, C.num(it.price), true)}
            </li>`).join('')}</ul></div>`).join('') : `<p class="empty">${esc(t('menuEmpty'))}</p>`}
        <form class="panel form add-item" data-submit="draftAddItem" novalidate>
          <div class="grid3">
            <label class="field"><span>${esc(t('itemName'))}</span><input id="ai-name" name="name"></label>
            <label class="field"><span>${esc(t('price'))}</span><input id="ai-price" name="price" inputmode="decimal" class="tnum"></label>
            <label class="field"><span>${esc(t('categoryOpt'))}</span><input id="ai-cat" name="category" list="cat-list" value="${esc(S._lastCat || '')}"></label>
          </div>
          <datalist id="cat-list">${cats.filter(g => g.name).map(g => `<option value="${esc(g.name)}"></option>`).join('')}</datalist>
          <button class="secondary" type="submit">${plusIcon()} ${esc(t('addItem'))}</button>
        </form>
      </section>

      <div class="sticky-actions">
        <button class="primary block" data-act="saveRestaurant">${esc(t('save'))}</button>
        ${d.id ? `<button class="danger-ghost" data-act="deleteRestaurant">${esc(S.confirmKey === 'delRest' ? t('confirmAgain') : t('deleteRest'))}</button>` : ''}
      </div>`;
  }

  /* ---------- profile ---------- */
  function viewProfile() {
    const p = S.profile;
    return `<h1>${esc(t('profile'))}</h1>
      <form class="panel form" data-submit="profile" novalidate>
        <label class="field"><span>${esc(t('yourName'))}</span><input id="p-name" name="name" value="${esc(p.name)}"></label>
        <label class="field"><span>${esc(t('yourPhone'))}</span><input id="p-phone" name="phone" type="tel" dir="ltr" value="${esc(p.phone)}"></label>
        <div class="grid2">
          <label class="field"><span>${esc(t('instapayAny'))}</span><input id="p-insta" name="instapay" dir="ltr" value="${esc(instaValue(p))}" placeholder="name@instapay / https://ipn.eg/…"></label>
          <label class="field"><span>${esc(t('wallet'))}</span><input id="p-wallet" name="wallet" type="tel" dir="ltr" value="${esc(p.wallet || '')}"></label>
        </div>
        <p class="form-error" id="p-err" hidden></p>
        <button class="primary block" type="submit">${esc(t('save'))}</button>
      </form>
      <section class="panel form">
        <p class="label">👤 ${esc(t('hostOptsProfile'))}</p>
        <p class="muted small-text">${esc(t('hostOptsProfileHint'))}</p>
        <label class="check"><input type="checkbox" id="ph-exempt" data-change="profHostExempt" ${p.hostExempt ? 'checked' : ''}><span>${esc(t('hostExemptLbl'))}</span></label>
        <label class="field inline-field"><span>${esc(t('hostFeeLbl'))}</span><input id="ph-fee" class="tnum" inputmode="decimal" data-change="profHostFee" value="${C.num(p.hostFee) ? esc(p.hostFee) : ''}" placeholder="0"></label>
      </section>
      <section class="panel">
        <p class="label">${esc(t('language'))}</p>
        <div class="btn-row"><button class="${S.lang === 'ar' ? 'primary' : 'secondary'}" data-act="setLang" data-lang="ar">العربية</button><button class="${S.lang === 'en' ? 'primary' : 'secondary'}" data-act="setLang" data-lang="en">English</button></div>
      </section>
      ${isLocal() ? `<button class="danger-ghost" data-act="resetDemo">${esc(S.confirmKey === 'reset' ? t('confirmAgain') : t('resetDemo'))}</button>` : `<p class="muted small-text">${esc(t('deviceNote'))}</p>`}`;
  }

  /* ---------- countdown ---------- */
  let lastStates = '';
  function tick() {
    document.querySelectorAll('[data-countdown]').forEach(el => {
      el.textContent = t('closesIn', { t: fmtLeft(+el.dataset.countdown - Date.now()) });
    });
    const states = S.carts.map(stageOf).join(',');
    if (lastStates && states !== lastStates) scheduleRender();
    lastStates = states;
  }
  setInterval(tick, 1000);

  /* ---------- actions ---------- */
  const curCart = () => cartById(S.route.id);
  function memberFor(c, key) {
    const m = (c.members || {})[key];
    if (m) return clone(m);
    const p = people(c)[key] || {};
    return { name: p.name || S.profile.name, phone: p.phone || '', status: 'in', items: [], done: false, guest: !!p.guest, at: Date.now() };
  }
  function actKey(c) { const ppl = people(c); return (isHost(c) && S.actFor && ppl[S.actFor]) ? S.actFor : me(); }
  async function saveMember(c, key, m) {
    if (key === me()) { m.name = S.profile.name; m.phone = S.profile.phone; }
    m.at = Date.now();
    await guard(S.store.setMember(S.gid, c.id, key, m));
  }
  const patch = (c, p) => guard(S.store.patchCart(S.gid, c.id, p));

  function snapshotOf(r) {
    return {
      restaurantId: r.id,
      restaurant: { name: r.name, phone: r.phone || '', talabatUrl: r.talabatUrl || '' },
      menu: (r.items || []).map(i => ({ id: i.id, name: i.name, price: i.price, category: i.category || '' })),
      estimate: Object.assign({ delivery: 0, service: 0, taxPct: 0, tip: 0 }, r.fees || {})
    };
  }
  function chargesFromEstimate(c) {
    const e = c.estimate || {};
    const food = C.aggregate(c).total;
    const out = [];
    const add = (kind, amount) => { if (C.num(amount) > 0) out.push({ id: rid(6), kind, label: t('kind_' + kind), amount: C.round2(C.num(amount)), split: C.DEFAULT_SPLIT[kind] }); };
    add('delivery', e.delivery); add('service', C.num(e.service) + food * C.num(e.servicePct) / 100); add('tax', food * C.num(e.taxPct) / 100); add('tip', e.tip);
    return out;
  }

  const actions = {
    nav: el => {
      const to = el.dataset.to;
      if (to === 'newOrder') S.sel = [];
      go(to);
    },
    lang: () => setLang(S.lang === 'ar' ? 'en' : 'ar'),
    setLang: el => setLang(el.dataset.lang),
    openCart: el => go('cart', { id: el.dataset.id, tab: el.dataset.tab || 'mine' }),
    tab: el => { S.route.tab = el.dataset.tab; render(true); },
    copy: el => copyText(el.dataset.text),
    payGo: el => { try { navigator.clipboard.writeText(el.dataset.text).catch(() => { }); } catch (e) { } toast(t('amountCopied', { a: el.dataset.text })); },
    switchGroup: el => setGroup(el.dataset.id),
    joinGroup: () => joinPending(),

    /* restaurants */
    newRestaurant: () => { const from = S.route.name; syncNewOrder(); S.draft = { name: '', phone: '', talabatUrl: '', fees: {}, items: [] }; S.ocr = null; S.pendingMenu = null; go('restaurant', { from: from === 'newOrder' ? 'newOrder' : 'restaurants' }); },
    editRestaurant: el => {
      const r = S.restaurants.find(x => x.id === el.dataset.id); if (!r) return;
      S.draft = clone(r); S.draft.items = S.draft.items || []; S.draft.fees = S.draft.fees || {}; S.ocr = null;
      loadHistory(r.name, true); loadReceipts(r.name);
      go('restaurant', { from: 'restaurants' });
    },
    draftDelItem: el => { syncDraft(); S.draft.items = S.draft.items.filter(i => i.id !== el.dataset.id); render(true); },
    clearMenu: () => { if (S.confirmKey !== 'clearMenu') { syncDraft(); S.confirmKey = 'clearMenu'; return render(true); } syncDraft(); S.draft.items = []; S.confirmKey = null; render(true); },
    parseMenu: () => {
      syncDraft();
      const ta = $('#paste-menu');
      const res = C.parseMenu(ta.value);
      const have = new Set(S.draft.items.map(i => i.name + '|' + i.price));
      let added = 0;
      for (const it of res.items) { if (have.has(it.name + '|' + it.price)) continue; S.draft.items.push({ id: rid(8), name: it.name, price: it.price, category: it.category }); added++; }
      render(true);
      const out = $('#parse-result');
      if (out) {
        out.hidden = false;
        out.textContent = t('parsed', { n: added }) + (res.skipped.length ? ' — ' + t('skippedLines', { s: res.skipped.slice(0, 8).join(' / ') }) : '');
        const det = out.closest('details'); if (det) det.open = true;
      }
    },
    saveRestaurant: async () => {
      syncDraft();
      const d = S.draft;
      if (!d.name.trim()) return toast(t('errRestName'), 'warn');
      if (!d.items.length) return toast(t('errNoItems'), 'warn');
      d.items = d.items.map(({ fresh, oldPrice, ...it }) => it);
      delete d.priceSource;
      const id = await guard(S.store.saveRestaurant(S.gid, d));
      S.ocr = null;
      if (id && S.pendingMenu && S.store.saveReceipt) { const pm = S.pendingMenu; S.pendingMenu = null; S.store.saveReceipt(S.gid, Object.assign({ restName: d.name }, pm)).catch(e => console.warn(e)); }
      if (!id) return;
      toast(t('saved'));
      if (S.route.from === 'newOrder') { if (!S.sel.includes(id)) S.sel.push(id); go('newOrder'); }
      else go('restaurants');
    },
    deleteRestaurant: async () => {
      if (S.confirmKey !== 'delRest') { syncDraft(); S.confirmKey = 'delRest'; return render(true); }
      await guard(S.store.deleteRestaurant(S.gid, S.draft.id));
      go('restaurants');
    },

    /* voting */
    vote: el => guard(S.store.setVote(S.gid, curCart().id, el.dataset.id)),
    lockRest: async el => {
      const c = curCart();
      const r = S.restaurants.find(x => x.id === el.dataset.id);
      if (!r) return toast(t('errLoad'), 'warn');
      await patch(c, Object.assign(snapshotOf(r), { stage: 'ordering', closesAt: Math.max(c.closesAt, Date.now() + 20 * 60000) }));
      S.route.tab = 'mine';
    },

    /* ordering */
    orderFor: el => { S.actFor = el.dataset.key; S.route.tab = 'mine'; S.menuQuery = ''; render(true); window.scrollTo(0, 0); },
    attend: el => {
      const c = curCart(), key = actKey(c), m = memberFor(c, key);
      m.status = el.dataset.v;
      if (m.status === 'out') { m.items = []; m.done = true; } else { m.done = false; }
      saveMember(c, key, m);
    },
    repeatLast: el => {
      const c = curCart(), key = actKey(c), last = cartById(el.dataset.id);
      if (!last) return;
      const m = memberFor(c, key);
      const menuByName = {};
      for (const mi of c.menu || []) menuByName[mi.name] = mi;
      m.items = (last.members[key].items || []).map(it => {
        const mi = menuByName[it.name];
        return { id: rid(8), menuId: mi ? mi.id : it.menuId, name: it.name, price: mi ? mi.price : it.price, qty: it.qty, note: it.note || '' };
      });
      m.status = 'in'; m.done = false;
      saveMember(c, key, m);
    },
    addMenu: el => {
      const c = curCart(), key = actKey(c);
      const mi = (c.menu || []).find(x => x.id === el.dataset.id); if (!mi) return;
      const m = memberFor(c, key);
      const ex = m.items.find(i => i.menuId === mi.id && !i.note);
      if (ex) ex.qty = C.num(ex.qty) + 1;
      else m.items.push({ id: rid(8), menuId: mi.id, name: mi.name, price: mi.price, qty: 1, note: '' });
      m.status = 'in'; m.done = false;
      saveMember(c, key, m);
    },
    qty: el => {
      const c = curCart(), key = actKey(c), m = memberFor(c, key);
      const it = m.items.find(i => i.id === el.dataset.id); if (!it) return;
      it.qty = C.num(it.qty) + (+el.dataset.d);
      if (it.qty <= 0) m.items = m.items.filter(i => i.id !== it.id);
      m.done = false;
      saveMember(c, key, m);
    },
    done: () => { const c = curCart(), key = actKey(c), m = memberFor(c, key); m.done = true; m.status = 'in'; saveMember(c, key, m); },
    undoDone: () => { const c = curCart(), key = actKey(c), m = memberFor(c, key); m.done = false; saveMember(c, key, m); },

    extend: () => { const c = curCart(); patch(c, { closesAt: Math.max(Date.now(), c.closesAt) + 10 * 60000, stage: 'ordering' }); },
    closeCart: () => { const c = curCart(); patch(c, { closesAt: Math.min(c.closesAt, Date.now()) }); },
    reopen: () => { const c = curCart(); patch(c, { stage: 'ordering', closesAt: Math.max(Date.now() + 15 * 60000, c.closesAt) }); toast(t('reopened')); },
    markOrdered: async () => {
      const c = curCart();
      const p = { stage: 'ordered', closesAt: Math.min(c.closesAt, Date.now()) };
      if (!(c.charges || []).length) p.charges = chargesFromEstimate(c);
      await patch(c, p);
      if (c.restaurantId && S.restaurants.some(r => r.id === c.restaurantId)) guard(S.store.patchRestaurant(S.gid, c.restaurantId, { lastOrderedAt: Date.now() }));
      S.route.tab = 'bill'; render(true);
    },

    /* charges */
    addCharge: el => {
      const c = curCart(), kind = el.dataset.kind;
      const list = clone(c.charges || []);
      let amount = 0;
      if (kind === 'tax') amount = C.round2(C.aggregate(c).total * C.num((c.estimate || {}).taxPct) / 100);
      else if (kind === 'service') amount = C.round2(C.num((c.estimate || {}).service) + C.aggregate(c).total * C.num((c.estimate || {}).servicePct) / 100);
      else if (kind === 'delivery' || kind === 'tip') amount = C.num((c.estimate || {})[kind]);
      list.push({ id: rid(6), kind, label: t('kind_' + kind), amount, split: C.DEFAULT_SPLIT[kind], person: kind === 'shortage' ? c.ownerId : undefined });
      patch(c, { charges: list.map(x => JSON.parse(JSON.stringify(x))) });
      setTimeout(() => { const inp = document.getElementById('ch-a-' + list[list.length - 1].id); if (inp) inp.focus(); }, 120);
    },
    delCharge: el => { const c = curCart(); const list = clone(c.charges || []); list.splice(+el.dataset.i, 1); patch(c, { charges: list }); },

    /* payments */
    payMethod: el => { S.payMethod[el.dataset.key] = el.dataset.m; render(true); },
    recordPay: el => {
      const c = curCart(), key = el.dataset.key;
      const inp = document.getElementById('pay-' + key);
      const amount = C.round2(C.num(inp && inp.value));
      if (amount <= 0) return toast(t('errAmount'), 'warn');
      const prev = (c.payments || {})[key];
      const before = prev && prev.status === 'confirmed' ? C.num(prev.amount) : 0;
      patch(c, { ['payments.' + key]: { amount: C.round2(before + amount), method: S.payMethod[key] || 'instapay', status: 'confirmed', at: Date.now(), by: me() } });
    },
    reportPay: () => {
      const c = curCart(), key = me();
      const inp = document.getElementById('pay-' + key);
      const amount = C.round2(C.num(inp && inp.value));
      if (amount <= 0) return toast(t('errAmount'), 'warn');
      const prev = (c.payments || {})[key];
      const before = prev && prev.status === 'confirmed' ? C.num(prev.amount) : 0;
      guard(S.store.reportPayment(S.gid, c.id, { amount: C.round2(before + amount), method: S.payMethod[key] || 'instapay', status: 'reported', at: Date.now() }));
      toast(t('reportedToast', { host: c.ownerName }));
    },
    confirmPay: el => { const c = curCart(); const p = clone(c.payments[el.dataset.key]); p.status = 'confirmed'; p.by = me(); patch(c, { ['payments.' + el.dataset.key]: p }); },
    rejectPay: el => { const c = curCart(); patch(c, { ['payments.' + el.dataset.key]: undefined }); },
    undoPay: el => { const c = curCart(); patch(c, { ['payments.' + el.dataset.key]: undefined }); },
    confirmPayIn: el => { const c = cartById(el.dataset.cart); const p = clone(c.payments[el.dataset.key]); p.status = 'confirmed'; p.by = me(); patch(c, { ['payments.' + el.dataset.key]: p }); },
    rejectPayIn: el => { const c = cartById(el.dataset.cart); patch(c, { ['payments.' + el.dataset.key]: undefined }); },
    settle: () => patch(curCart(), { stage: 'settled' }),
    applyReceipt: () => applyReceipt(),
    issueInvoices: async () => {
      const c = curCart();
      if (!C.computeBill(c, {}).rows.some(r => r.key !== c.ownerId)) return toast(t('noOneElse'), 'warn');
      if (c.stage !== 'ordered' && c.stage !== 'settled') {   // sending the bills means it was ordered
        const p = { stage: 'ordered', closesAt: Math.min(c.closesAt, Date.now()) };
        if (!(c.charges || []).length) p.charges = chargesFromEstimate(c);
        Object.assign(c, p); await patch(c, p);
      }
      const keys = await issueInvoices(c);
      if (!keys || !keys.length) return toast(t('noOneElse'), 'warn');
      startSending(c, keys);
      setTimeout(() => { const el = document.querySelector('.sender'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 60);
    },
    remindUnpaid: el => {
      const c = el.dataset.cart ? cartById(el.dataset.cart) : curCart(); if (!c) return;
      const keys = unpaidRows(c).map(r => r.key);
      if (!keys.length) return toast(t('allPaidNow'));
      if (curCart() !== c || S.route.tab !== 'bill') go('cart', { id: c.id, tab: 'bill' });
      S.sendQ = { cartId: c.id, keys, i: 0, mode: 'remind' };
      render(true);
      setTimeout(() => { const el2 = document.querySelector('.sender'); if (el2) el2.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 60);
    },
    sendNext: el => {
      const q = S.sendQ; if (!q) return;
      const c = cartById(q.cartId);
      if (c && el.dataset.key) patch(c, q.mode === 'remind' ? { ['reminded.' + el.dataset.key]: Date.now() } : { ['invoices.' + el.dataset.key + '.sentAt']: Date.now() });
      q.i++; if (q.i >= q.keys.length) { toast(t('allSent')); S.sendQ = null; }
      render(true);
    },
    skipSend: () => { const q = S.sendQ; if (!q) return; q.i++; if (q.i >= q.keys.length) S.sendQ = null; render(true); },
    stopSend: () => { S.sendQ = null; render(true); },
    previewInvoice: el => {
      const c = curCart(); const inv = (c.invoices || {})[el.dataset.key];
      if (!inv) return;
      S.invoiceView = { preview: true, back: { name: 'cart', id: c.id, tab: 'bill' }, data: invoiceData(c, el.dataset.key) };
      render(true); window.scrollTo(0, 0);
    },
    closeInvoice: () => { const b = S.invoiceView && S.invoiceView.back; S.invoiceView = null; if (b) go(b.name, b); else render(true); },
    copyInvoiceLink: el => copyText(el.dataset.text),
    openTalabat: () => openTalabatApp(),
    viewReceipt: el => openReceipt(el.dataset.id),
    adjustToPaid: () => {
      const c = curCart(); const actual = C.num(c.receiptTotal); if (!(actual > 0)) return;
      const charges = (c.charges || []).filter(ch => !ch.adjust);
      const grand = C.computeBill(Object.assign({}, c, { charges }), {}).grand;
      const gap = C.round2(actual - grand);
      if (Math.abs(gap) >= 0.05) charges.push({ id: rid(6), kind: gap < 0 ? 'discount' : 'other', label: t('receiptAdjust'), amount: Math.abs(gap), split: 'share', adjust: true });
      patch(c, { charges }); toast(t('adjustedToPaid'));
    },
    issueOnly: async () => { const c = curCart(); await issueInvoices(c); render(true); toast(t('invoicesReady')); },
    markSent: el => { const c = curCart(); const k = el.dataset.key; if (c.invoices && c.invoices[k]) c.invoices[k].sentAt = Date.now(); patch(c, { ['invoices.' + k + '.sentAt']: Date.now() }); setTimeout(() => render(true), 300); },
    clearChecks: () => { const c = curCart(); c.checked = {}; render(true); patch(c, { checked: {} }); },
    delShared: el => { const c = curCart(); patch(c, { shared: (c.shared || []).filter(x => x.id !== el.dataset.id) }); },
    shAll: () => document.querySelectorAll('.sh-people input').forEach(i => { i.checked = true; }),
    shNone: () => document.querySelectorAll('.sh-people input').forEach(i => { i.checked = false; }),
    manualMenu: () => { const n = $('#ai-name'); if (n) { n.scrollIntoView({ behavior: 'smooth', block: 'center' }); n.focus(); } },
    closeReceipt: () => { S.rview = null; render(true); },
    copyItems: () => {
      syncDraft();
      const src = S.restaurants.find(r => r.id === (S.copyFrom || ($('#copy-from') || {}).value));
      if (!src) return;
      const have = new Set(S.draft.items.map(i => C.normName(i.name)));
      let n = 0;
      for (const it of src.items || []) { if (have.has(C.normName(it.name))) continue; S.draft.items.push({ id: rid(8), name: it.name, price: it.price, category: it.category || '', fresh: true }); n++; }
      render(true); toast(t('copiedItems', { n }));
    },
    recordDebt: el => {
      // someone pays everything they owe me: record it on their latest order with me
      const key = el.dataset.key;
      const p = (pairs()[me()] || {})[key]; if (!p) return;
      const c = cartById(p.carts[p.carts.length - 1].id); if (!c) return;
      const prev = (c.payments || {})[key];
      const before = prev && prev.status === 'confirmed' ? C.num(prev.amount) : 0;
      patch(c, { ['payments.' + key]: { amount: C.round2(before - p.balance), method: S.payMethod['d_' + key] || 'cash', status: 'confirmed', at: Date.now(), by: me() } });
      toast(t('saved'));
    },
    reportDebt: el => {
      const host = el.dataset.host;
      const p = (pairs()[host] || {})[me()]; if (!p) return;
      const c = cartById(p.carts[p.carts.length - 1].id); if (!c) return;
      const prev = (c.payments || {})[me()];
      const before = prev && prev.status === 'confirmed' ? C.num(prev.amount) : 0;
      guard(S.store.reportPayment(S.gid, c.id, { amount: C.round2(before - p.balance), method: S.payMethod['o_' + host] || 'instapay', status: 'reported', at: Date.now() }));
      toast(t('reportedToast', { host: p.hostName }));
    },

    /* group */
    delGuest: el => guard(S.store.patchGroup(S.gid, { ['roster.' + el.dataset.key]: undefined })),
    toggleAdmin: el => {
      const ids = new Set(S.group.adminIds || []);
      if (ids.has(el.dataset.key)) ids.delete(el.dataset.key); else ids.add(el.dataset.key);
      guard(S.store.patchGroup(S.gid, { adminIds: Array.from(ids) }));
    },

    resetDemo: () => {
      if (S.confirmKey !== 'reset') { S.confirmKey = 'reset'; return render(true); }
      S.store.seed(S.lang); S.profile = S.store.profile(); setGroup('demo-g1', true);
      go('cart', { id: 'demo-c1', tab: 'mine' });
    }
  };

  /* ---------- menu from screenshots (on-device text recognition, free) ---------- */
  function loadScript(src) {
    return new Promise((res, rej) => {
      if (window.Tesseract) return res();
      const sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = () => rej(new Error('load ' + src));
      document.head.appendChild(sc);
    });
  }
  // keep dark text, drop photos and coloured badges, so the reader sees clean black-on-white text
  async function cleanImage(file) {
    const url = URL.createObjectURL(file);
    const img = new Image(); img.src = url; await img.decode();
    let w = img.naturalWidth, h = img.naturalHeight;
    const scale = w < 900 ? 2 : (w > 1600 ? 1600 / w : 1);
    w = Math.round(w * scale); h = Math.round(h * scale);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h), a = d.data;
    // dark-mode screenshots: invert first so text is dark
    let sum = 0; for (let i = 0; i < a.length; i += 400) sum += a[i] + a[i + 1] + a[i + 2];
    const dark = sum / (a.length / 400) / 3 < 110;
    for (let i = 0; i < a.length; i += 4) {
      let r = a[i], g = a[i + 1], b = a[i + 2];
      if (dark) { r = 255 - r; g = 255 - g; b = 255 - b; }
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const lum = (r + g + b) / 3;
      // coloured areas (photos, badges, highlighter): keep only really dark strokes, so text on a coloured background survives
      const v = (mx - mn > 38) ? (lum < 100 ? 0 : 255) : (lum < 170 ? 0 : 255);
      a[i] = a[i + 1] = a[i + 2] = v;
    }
    x.putImageData(d, 0, 0);
    return { canvas: c, url };
  }
  async function ocrWorkers(status) {
    const base = CFG.ocrPath || 'ocr/';
    if (!S.ocrAr) {
      status(t('shotsLoading'));
      await loadScript(base + 'tesseract.min.js');
      const opts = { workerPath: base + 'worker.min.js', corePath: base, langPath: base, gzip: false, workerBlobURL: false };
      S.ocrAr = await window.Tesseract.createWorker(['ara'], 1, opts);
      S.ocrEn = await window.Tesseract.createWorker(['eng'], 1, opts);
    }
  }
  function lineList(data) {
    const out = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
      out.push({ text: (l.text || '').trim(), conf: l.confidence || 0, y0: l.bbox.y0, y1: l.bbox.y1 });
    }
    return out;
  }
  /* read screenshots → lines {ar, en}: names from whichever model was surer, digits from English */
  async function ocrRead(files, status) {
    await ocrWorkers(status);
    const lines = [], thumbs = [];
    for (let i = 0; i < files.length; i++) {
      status(t('shotsReading', { i: i + 1, n: files.length }));
      const { canvas, url } = await cleanImage(files[i]);
      thumbs.push(url);
      const [ra, re] = await Promise.all([S.ocrAr.recognize(canvas, {}, { blocks: true }), S.ocrEn.recognize(canvas, {}, { blocks: true })]);
      const A = lineList(ra.data), E = lineList(re.data);
      for (const a of A) {
        let best = null, bestOv = 0;
        for (const e of E) {
          const ov = Math.min(a.y1, e.y1) - Math.max(a.y0, e.y0);
          if (ov > bestOv) { bestOv = ov; best = e; }
        }
        const en = best ? best.text : '';
        const arabic = (a.text.match(/[\u0600-\u06FF]/g) || []).length;
        const useAr = arabic >= 3 ? !(best && best.conf >= 85 && a.conf < 55) : (arabic > 0 && (!best || a.conf + 8 >= best.conf));
        lines.push({ ar: useAr ? a.text : en, en });
      }
      lines.push({ sep: true, ar: '', en: '' });
    }
    return { lines, thumbs };
  }
  /* one readable line for the menu parser: the name as read, the price as the English model read it */
  function lineText(l) {
    const price = (C.latinDigits(l.en).match(/\d{1,5}[.,]\d{2}(?!\d)/g) || []).pop();
    if (!/[؀-ۿ]/.test(l.ar)) return l.ar || l.en;
    if (!price) return l.ar;
    const name = C.latinDigits(l.ar).replace(/\d+(?:[.,]\d+)?/g, '').replace(/(ج\.?\s?م\.?|جم|حم|جنيه|egp)/gi, '').replace(/[\s.،,]+$/, '').trim();
    return (name ? name + ' ' : '') + price + ' ج.م';
  }

  async function readScreenshots(files) {
    if (!files.length || (S.ocr && S.ocr.busy)) return;
    syncDraft();
    const status = msg => { S.ocr.msg = msg; const el = $('#ocr-status'); if (el) { el.hidden = false; el.textContent = msg; } };
    S.ocr = { busy: true, msg: '', thumbs: (S.ocr && S.ocr.thumbs) || [] };
    render(true);
    try {
      const { lines } = await ocrRead(files, status);
      // each screenshot may be a different order: read them one by one (one part per file)
      const parts = [{ fi: 0, lines: [] }];
      for (const l of lines) { if (l.sep) parts.push({ fi: parts.length, lines: [] }); else parts[parts.length - 1].lines.push(l); }
      const receipts = parts.filter(p => p.lines.length).map(p => Object.assign(C.parseReceipt(p.lines), { fi: p.fi })).filter(r => r.items.length);
      if (receipts.length) {
        const seenOrders = new Set();
        let updated = 0, added = 0, dup = 0, orders = 0, unsure = 0, older = 0, saved = 0, savedDup = 0;
        const other = [];
        if (!S.draft.name) {   // name the restaurant after the name most of these receipts show
          const counts = {};
          for (const rc of receipts) if (rc.restaurant) counts[rc.restaurant] = (counts[rc.restaurant] || 0) + 1;
          const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
          if (top) S.draft.name = top;
        }
        const name = S.draft.name;
        if (name) await loadHistory(name, true);
        receipts.sort((a, b) => rcAt(a) - rcAt(b));   // oldest first: the newest receipt has the last word
        let newest = null;
        for (const rc of receipts) {
          if (rc.orderNo) { if (seenOrders.has(rc.orderNo)) { dup++; continue; } seenOrders.add(rc.orderNo); }
          if (rc.restaurant && name && C.similarity(rc.restaurant, name) < 0.34) { other.push(rc.restaurant); continue; }
          orders++;
          C.inferQty(rc, S.draft.items);
          if (name && S.store.saveReceipt) {
            status(t('rcSaving'));
            try {
              const sv = await S.store.saveReceipt(S.gid, { restName: name, orderNo: rc.orderNo, at: rcAt(rc), parsed: stripRc(rc), image: await shrinkImages([files[rc.fi]]) });
              if (sv && sv.dup) savedDup++; else saved++;
            } catch (e) { console.warn(e); }
          }
          const res = takeNewest(S.draft.items, rc, name, '');
          updated += res.updated; added += res.added; older += res.older; unsure += res.unsure;
          if (!newest || rcAt(rc) >= rcAt(newest)) newest = rc;
        }
        if (newest && rcAt(newest) >= (S.draft.feesAt || 0)) {
          for (const f of newest.fees) if (f.kind === 'delivery') S.draft.fees.delivery = f.amount;
          if (newest.servicePct) { S.draft.fees.servicePct = newest.servicePct; S.draft.fees.service = 0; }
          S.draft.feesAt = rcAt(newest);
        }
        // keep it: the restaurant is saved right away, so a refresh loses nothing
        if (name && S.draft.items.length) {
          const keep = clone(S.draft); keep.items = keep.items.map(({ fresh, oldPrice, ...it }) => it); delete keep.priceSource;
          const id = await guard(S.store.saveRestaurant(S.gid, keep));
          if (id) S.draft.id = id;
          loadHistory(name, true); loadReceipts(name);
        }
        S.ocr.busy = false; S.ocr.error = false;
        S.ocr.msg = t('receiptToMenu2', { o: orders, u: updated, a: added })
          + (saved ? ' ' + t('rcSavedN', { n: saved }) : '') + (savedDup ? ' ' + t('rcDupN', { n: savedDup }) : '')
          + (older ? ' ' + t('rcOlderN', { n: older }) : '')
          + (dup ? ' ' + t('receiptDup', { n: dup }) : '') + (unsure ? ' ' + t('receiptUnsure', { n: unsure }) : '') + (other.length ? ' ' + t('receiptOtherSkipped', { s: Array.from(new Set(other)).join(comma()) }) : '');
      } else {
        const res = C.parseMenu(lines.map(lineText).join('\n'), { ocr: true });
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const at = today.getTime();   // a menu price counts from the start of the day: that day's receipt still wins
        const have = new Set(S.draft.items.map(i => C.normName(i.name) + '|' + i.price));
        let added = 0;
        for (const it of res.items) {
          const k = C.normName(it.name) + '|' + it.price;
          if (have.has(k)) continue;
          have.add(k);
          const ex = findItem(S.draft.items, it.name);
          if (ex) { if (C.num(ex.price) !== it.price && at >= priceAt(S.draft.name, ex)) { ex.oldPrice = ex.oldPrice || ex.price; ex.price = it.price; ex.at = at; ex.fresh = true; added++; } continue; }
          S.draft.items.push({ id: rid(8), name: it.name, price: it.price, category: it.category, fresh: true, at });
          added++;
        }
        const name = S.draft.name;
        if (added && res.items.length) {
          const menuRec = { kind: 'menu', items: res.items.map(i => ({ name: i.name, unit: i.price, qty: 1 })) };
          if (name && S.store.saveReceipt) {
            status(t('rcSaving'));
            try { await S.store.saveReceipt(S.gid, { restName: name, at, parsed: menuRec, image: await shrinkImages(files) }); } catch (e) { console.warn(e); }
            const keep = clone(S.draft); keep.items = keep.items.map(({ fresh, oldPrice, ...it }) => it); delete keep.priceSource;
            const id = await guard(S.store.saveRestaurant(S.gid, keep));
            if (id) S.draft.id = id;
            loadHistory(name, true); loadReceipts(name);
          } else S.pendingMenu = { at, parsed: menuRec, image: await shrinkImages(files) };
        }
        S.ocr.busy = false; S.ocr.error = !added;
        S.ocr.msg = added ? t('shotsDone', { n: added, m: files.length }) + (res.skipped.length ? ' ' + t('skippedLines', { s: res.skipped.slice(0, 6).join(' / ') }) : '') : t('shotsNone');
      }
    } catch (e) {
      console.warn(e);
      S.ocr.busy = false; S.ocr.error = true; S.ocr.msg = t('shotsFail');
    }
    render(true);
  }

  /* ---------- receipt for an order: real names and prices, real charges ---------- */
  function lineKey(it) { return it.name.trim() + '|' + C.num(it.price) + '|' + (it.note || '').trim(); }
  // match our order lines to receipt lines. A receipt line can cover several of our lines up to its quantity
  // (e.g. "4× فول جاد" covers 2× فول جاد + 2× فول بالحمص when the host ordered the nearest thing).
  function autoMatch(c, rc) {
    const agg = C.aggregate(c).lines;
    const map = {};
    const cap = rc.items.map(it => Math.max(1, C.num(it.qty) || 1));
    const key = l => l.name.trim() + '|' + C.num(l.price) + '|' + l.note;
    const score = (l, it) => {
      let sc = C.similarity(l.name, it.name);
      if (sameName(l.name, it.name)) sc += 0.3;
      if (it.unit != null && Math.abs(C.num(l.price) - it.unit) < 0.01) sc += 0.15;
      if (l.qty === it.qty) sc += 0.1;
      return sc;
    };
    const pairs = [];
    agg.forEach(l => rc.items.forEach((it, j) => pairs.push({ l, k: key(l), j, sc: score(l, it) })));
    pairs.sort((a, b) => b.sc - a.sc);
    // 1) clear name matches, while the receipt line still has quantity left
    for (const p of pairs) {
      if (p.sc < 0.4 || p.k in map || cap[p.j] < p.l.qty) continue;
      map[p.k] = p.j; cap[p.j] -= p.l.qty;
    }
    // 2) what is left: the closest receipt line that still has room for it
    for (const p of pairs) {
      if (p.k in map || cap[p.j] < p.l.qty) continue;
      map[p.k] = p.j; cap[p.j] -= p.l.qty;
    }
    return map;
  }
  // how much of the receipt our matched lines use, and what the food comes to after matching
  function matchState(c, rc, map) {
    const agg = C.aggregate(c).lines;
    const used = rc.items.map(() => 0);
    let after = 0;
    for (const l of agg) {
      const j = map[l.name.trim() + '|' + C.num(l.price) + '|' + l.note];
      const ok = j != null && j >= 0 && rc.items[j] && rc.items[j].unit != null;
      if (ok) used[j] += l.qty;
      after += l.qty * (ok ? rc.items[j].unit : C.num(l.price));
    }
    const sub = rc.subtotal != null ? rc.subtotal : rc.itemsSum;
    return { used, after: C.round2(after), sub, diff: C.round2(sub - after) };
  }
  async function readReceipt(files) {
    const c = curCart();
    if (!files.length || !c || (S.rcpt && S.rcpt.busy)) return;
    const status = msg => { S.rcpt.msg = msg; const el = $('#rcpt-status'); if (el) { el.hidden = false; el.textContent = msg; } };
    S.rcpt = { cartId: c.id, busy: true, msg: '' };
    render(true);
    try {
      const { lines } = await ocrRead(files, status);
      const rc = C.parseReceipt(lines);
      C.inferQty(rc, c.menu || []);
      S.rcpt = { cartId: c.id, busy: false, data: rc, map: autoMatch(c, rc), fees: rc.fees.map(() => true), msg: rc.items.length ? '' : t('receiptNone'), error: !rc.items.length };
      if (rc.items.length && S.store.saveReceipt) {
        status(t('rcSaving'));
        try {
          const sv = await S.store.saveReceipt(S.gid, { cartId: c.id, restName: c.restaurant.name, orderNo: rc.orderNo, at: rcAt(rc), parsed: stripRc(rc), image: await shrinkImages(files) });
          S.rcpt.id = sv && sv.id;
          await patch(c, { receipt: { id: (sv && sv.id) || '', data: stripRc(rc), savedAt: Date.now() } });
          S.rcpt.msg = t('rcKept');
        } catch (e) { console.warn(e); }
      }
    } catch (e) {
      console.warn(e);
      S.rcpt = { cartId: c.id, busy: false, error: true, msg: t('shotsFail') };
    }
    render(true);
  }
  function receiptPanel(c) {
    if ((!S.rcpt || S.rcpt.cartId !== c.id) && c.receipt && c.receipt.data && !(c.receiptAt >= c.receipt.savedAt)) {
      const rd = c.receipt.data;   // read before, not applied yet: pick up where it stopped
      S.rcpt = { cartId: c.id, busy: false, id: c.receipt.id, data: rd, map: autoMatch(c, rd), fees: (rd.fees || []).map(() => true), msg: t('rcKept') };
    }
    const R = S.rcpt && S.rcpt.cartId === c.id ? S.rcpt : null;
    const rid0 = (R && R.id) || (c.receipt && c.receipt.id);
    const head = `<section class="panel receipt">
      <p class="label">${esc(t('receiptTitle'))}</p>
      <p class="muted small-text">${esc(c.receiptAt ? t('receiptApplied', { when: fmtAgo(c.receiptAt) }) : t('receiptHint'))}</p>
      <label class="${R && R.data ? 'secondary' : 'primary'} block file-btn${R && R.busy ? ' busy' : ''}">
        <input type="file" id="rcpt-file" accept="image/*" multiple data-change="receipt">
        ${esc(R && R.busy ? t('shotsBusy') : t('receiptPick'))}
      </label>
      <p class="ocr-status small-text${R && R.error ? ' err' : ''}" id="rcpt-status"${R && R.msg ? '' : ' hidden'}>${esc(R ? R.msg : '')}</p>
      ${rid0 ? `<button class="ghost small" data-act="viewReceipt" data-id="${esc(rid0)}">🧾 ${esc(t('viewReceipt'))}</button>` : ''}`;
    if (!R || !R.data || !R.data.items.length) return head + `</section>`;
    const rc = R.data;
    const agg = C.aggregate(c).lines;
    const opts = sel => `<option value="-1"${sel === -1 ? ' selected' : ''}>${esc(t('receiptNoMatch'))}</option>` +
      rc.items.map((it, j) => `<option value="${j}"${sel === j ? ' selected' : ''}>${esc((it.unsure ? '⚠ ' : '') + it.qty + '× ' + it.name + ' — ' + (it.unit == null ? '?' : C.fmtMoney(it.unit)))}</option>`).join('');
    const ms = matchState(c, rc, R.map);
    const after = ms.after, sub = ms.sub;
    const okSum = Math.abs(ms.diff) < 0.06;
    const leftover = rc.items.map((it, j) => ({ it, n: Math.max(0, (C.num(it.qty) || 1) - ms.used[j]) })).filter(x => x.n > 0);
    const over = rc.items.map((it, j) => ({ it, n: ms.used[j] - (C.num(it.qty) || 1) })).filter(x => x.n > 0);
    const nameOff = rc.restaurant && C.similarity(rc.restaurant, c.restaurant.name) < 0.34;
    return head + `
      ${rc.restaurant || rc.date ? `<p class="small-text${nameOff ? ' rc-warn' : ' muted'}">${esc(t('receiptFrom', { r: rc.restaurant || '—', d: rc.date || '—' }))}${nameOff ? ' ' + esc(t('receiptOtherRest')) : ''}</p>` : ''}
      <div class="rc-sum tnum">
        <span>${esc(t('receiptItems', { n: rc.items.length }))}</span>
        <span>${esc(t('receiptSubtotal'))}: <b>${esc(money(sub))}</b> ${rc.checks.subtotal === false ? '<em class="warn">' + esc(t('receiptCheckItems', { a: C.fmtMoney(rc.itemsSum) })) + '</em>' : ''}</span>
        ${rc.total != null ? `<span>${esc(t('receiptTotal'))}: <b>${esc(money(rc.total))}</b></span>` : ''}
      </div>
      <p class="label">${esc(t('receiptMatchTitle'))}</p>
      <ul class="rc-map">${agg.map(l => {
        const k = l.name.trim() + '|' + C.num(l.price) + '|' + l.note;
        const j = k in R.map ? R.map[k] : -1;
        return `<li class="${j >= 0 ? '' : 'unmatched'}">
          <span class="rc-ours"><b class="tnum">${l.qty}×</b> ${esc(l.name)}${l.note ? ` <em>${esc(l.note)}</em>` : ''} <small class="muted tnum">${C.num(l.price) ? esc(C.fmtMoney(l.price)) : '?'}</small></span>
          <select data-change="rcMap" data-k="${esc(k)}" aria-label="${esc(t('receiptMatchTitle'))}">${opts(j)}</select>
        </li>`;
      }).join('')}</ul>
      ${rc.items.some(i => i.unsure) ? `<p class="small-text rc-warn">${esc(t('receiptUnsureLines', { s: rc.items.filter(i => i.unsure).map(i => i.name).join(comma()) }))}</p>` : ''}
      ${leftover.length ? `<p class="small-text rc-warn">${esc(t('receiptExtra'))}: ${esc(leftover.map(x => x.n + '× ' + x.it.name).join(comma()))}</p>` : ''}
      ${over.length ? `<p class="small-text rc-warn">${esc(t('receiptOver'))}: ${esc(over.map(x => x.it.name + ' +' + x.n).join(comma()))}</p>` : ''}
      ${rc.fees.length ? `<p class="label">${esc(t('receiptFees'))}</p><div class="rc-fees">${rc.fees.map((f, i) => `<label class="check"><input type="checkbox" data-change="rcFee" data-i="${i}" ${R.fees[i] ? 'checked' : ''}><span>${esc(f.label || t('kind_' + f.kind))}: <b class="tnum">${f.kind === 'discount' ? '−' : ''}${esc(money(f.amount))}</b></span></label>`).join('')}</div>` : ''}
      <p class="rc-check ${okSum ? 'ok' : 'warn'} tnum">${esc(okSum ? t('receiptMatchesOk', { a: money(after) }) : t('receiptMatchesOff', { a: money(after), b: money(sub) }))}</p>
      ${okSum ? '' : `<p class="small-text rc-warn">${esc(t('receiptAdjustNote', { d: (ms.diff > 0 ? '+' : '−') + C.fmtMoney(Math.abs(ms.diff)) }))}</p>`}
      <button class="primary block" data-act="applyReceipt">${esc(t('receiptApply'))}</button>
      <p class="muted small-text">${esc(t('receiptApplyHint'))}</p>
    </section>`;
  }
  async function applyReceipt() {
    const c = curCart(), R = S.rcpt;
    if (!c || !R || !R.data) return;
    const rc = R.data;
    const members = clone(c.members || {});
    const pairs = [];   // [name people see, receipt line] for every confirmed match
    for (const k of Object.keys(members)) {
      for (const it of members[k].items || []) {
        const j = R.map[lineKey(it)];
        if (j == null || j < 0) continue;
        const r = rc.items[j];
        if (r.unit == null) continue;
        // the name people chose stays; only the price follows the receipt. The receipt's wording is kept internally.
        it.price = r.unit; it.noPrice = false;
        if (C.normName(r.name) !== C.normName(it.name)) it.receiptName = r.name;
        pairs.push([it.name, r]);
      }
    }
    const shared = clone(c.shared || []);
    for (const x of shared) {
      const j = R.map[x.name.trim() + '|' + C.num(x.price) + '|'];
      if (j == null || j < 0 || rc.items[j].unit == null) continue;
      x.price = rc.items[j].unit;
      if (C.normName(rc.items[j].name) !== C.normName(x.name)) x.receiptName = rc.items[j].name;
      pairs.push([x.name, rc.items[j]]);
    }
    const kinds = new Set(rc.fees.filter((f, i) => R.fees[i]).map(f => f.kind));
    const kept = (c.charges || []).filter(ch => !ch.adjust && (!kinds.has(ch.kind) || ch.kind === 'tip' || ch.kind === 'shortage'));
    const fromReceipt = rc.fees.filter((f, i) => R.fees[i] && f.amount > 0).map(f => ({ id: rid(6), kind: f.kind, label: f.label || t('kind_' + f.kind), amount: f.amount, split: C.DEFAULT_SPLIT[f.kind] || 'equal' }));
    // the money must add up to what was actually paid: any gap left after matching is shared by food share
    const food = C.round2(C.aggregate(Object.assign({}, c, { members, shared })).lines.reduce((a, l) => a + l.qty * C.num(l.price), 0));
    const sub = rc.subtotal != null ? rc.subtotal : rc.itemsSum;
    const gap = sub != null ? C.round2(sub - food) : 0;
    if (Math.abs(gap) >= 0.05) fromReceipt.push({ id: rid(6), kind: gap < 0 ? 'discount' : 'other', label: t('receiptAdjust'), amount: Math.abs(gap), split: 'share', adjust: true });
    await patch(c, { stage: c.stage === 'settled' ? 'settled' : 'ordered', closesAt: Math.min(c.closesAt, Date.now()), members, shared, charges: [...fromReceipt, ...kept], receiptAt: Date.now(), receiptNo: rc.orderNo || '', receiptDate: rc.date || '', receiptTotal: rc.total != null ? rc.total : null });
    // teach the restaurant: real prices, new items, usual charges
    const r = S.restaurants.find(x => x.id === c.restaurantId);
    const wrongRest = r && rc.restaurant && C.similarity(rc.restaurant, r.name) < 0.34;
    if (r && !wrongRest) {
      await loadHistory(r.name, true);
      const items = clone(r.items || []);
      const res = learnFromReceipt(items, rc, pairs, r.name);
      items.forEach(i => { delete i.fresh; delete i.oldPrice; });
      const fees = Object.assign({}, r.fees || {});
      const p = { items, lastOrderedAt: Date.now(), priceSource: null };
      if (rcAt(rc) >= (r.feesAt || 0)) {
        for (const f of rc.fees) if (f.kind === 'delivery') fees.delivery = f.amount;
        if (rc.servicePct) { fees.servicePct = rc.servicePct; fees.service = 0; }
        p.fees = fees; p.feesAt = rcAt(rc);
      }
      await guard(S.store.patchRestaurant(S.gid, r.id, p));
      loadHistory(r.name, true); loadReceipts(r.name);
      if (res.older) toast(t('rcOlderN', { n: res.older }));
      if (res.unknown) toast(t('rcUnknownN', { n: res.unknown }));
    }
    S.rcpt = null;
    toast(wrongRest ? t('rcWrongRestApplied', { r: rc.restaurant }) : t('receiptDone'));
  }

  /* ---------- collecting the money: who still owes on my orders ---------- */
  function unpaidRows(c) {
    return C.computeBill(c, prevFor(c)).rows.filter(r => !r.isHost && (r.state === 'unpaid' || r.state === 'partial') && r.remaining > 0.009);
  }
  function remindMessage(c, row) {
    const link = c.invoices && c.invoices[row.key] && c.invoiceKey ? invoiceLink(c, row.key) : '';
    return t('msgPayRemind2', { name: row.name, rest: c.restaurant.name, when: fmtAgo(c.createdAt), total: money(row.remaining) }) + (link ? '\n' + t('msgInvoiceLink', { link }) : '') + payLines(c.payInfo || {});
  }
  // the banner on the home page: money not collected yet, payments waiting for my OK
  function collectNag() {
    const mine = S.carts.filter(c => c.ownerId === me() && c.stage === 'ordered').sort((a, b) => b.createdAt - a.createdAt);
    const out = [];
    for (const c of mine) {
      const bill = C.computeBill(c, prevFor(c));
      const un = bill.rows.filter(r => !r.isHost && (r.state === 'unpaid' || r.state === 'partial') && r.remaining > 0.009);
      const rep = bill.rows.filter(r => r.state === 'reported');
      if (!un.length && !rep.length) continue;
      const sum = C.round2(un.reduce((a, r) => a + r.remaining, 0));
      const noInv = !c.invoices || !Object.keys(c.invoices).length;
      out.push(`<div class="nag">
        <p class="nag-title">💸 ${esc(t('nagTitle', { rest: c.restaurant.name, when: fmtAgo(c.createdAt) }))}</p>
        ${un.length ? `<p>${esc(t('nagUnpaid', { n: un.length, a: money(sum) }))}: <b>${esc(un.map(r => r.name).join(comma()))}</b></p>` : ''}
        ${rep.length ? `<p>${esc(t('nagReported', { s: rep.map(r => r.name).join(comma()) }))}</p>` : ''}
        ${noInv ? `<p class="muted small-text">${esc(t('nagNoInvoices'))}</p>` : ''}
        <div class="btn-row tight">
          ${un.length ? `<button class="primary small" data-act="remindUnpaid" data-cart="${esc(c.id)}">🔔 ${esc(t('nagRemind'))}</button>` : ''}
          <button class="secondary small" data-act="openCart" data-id="${esc(c.id)}" data-tab="bill">${esc(rep.length ? t('nagConfirm') : t('nagOpen'))}</button>
        </div></div>`);
    }
    return out.length ? `<section class="stack nags">${out.join('')}</section>` : '';
  }
  function saveHostDefaults(o) {
    Object.assign(S.profile, o);
    if (isLocal()) S.store.saveProfile(S.profile); else LS.set('tarweeqa.profile', S.profile);
    if (S.store.saveProfileRemote) guard(S.store.saveProfileRemote(S.profile.name, { instapay: S.profile.instapay, instapayLink: S.profile.instapayLink || '', wallet: S.profile.wallet, hostExempt: !!S.profile.hostExempt, hostFee: C.num(S.profile.hostFee), hostAuto: !!S.profile.hostAuto }));
  }
  function hostOptions(c) {
    const bill = C.computeBill(c, {});
    const items = bill.rows.filter(r => r.key !== c.ownerId).reduce((a, r) => a + r.items.reduce((x, it) => x + C.num(it.qty), 0), 0);
    return `<div class="host-opts">
      <p class="label">👤 ${esc(t('hostOptsTitle'))}</p>
      <label class="check"><input type="checkbox" id="host-exempt" data-change="hostExempt" ${c.hostExempt ? 'checked' : ''}><span>${esc(t('hostExemptLbl'))}</span></label>
      <label class="field inline-field"><span>${esc(t('hostFeeLbl'))}</span><input id="host-fee" class="tnum" inputmode="decimal" data-change="hostFee" value="${C.num(c.hostFee) ? esc(c.hostFee) : ''}" placeholder="0"></label>
      ${C.num(c.hostFee) > 0 ? `<p class="muted small-text tnum">${esc(t('hostFeeSum', { n: items, a: money(bill.hostFees || 0) }))}</p>` : ''}
      <label class="check"><input type="checkbox" id="host-auto" data-change="hostAuto" ${S.profile.hostAuto ? 'checked' : ''}><span>${esc(t('hostAutoLbl'))}</span></label>
    </div>`;
  }

  /* ---------- saved receipts: kept with their picture; the newest receipt sets the price ---------- */
  function rcAt(rc) { const v = rc && rc.date ? Date.parse(rc.date + 'T09:00:00') : NaN; return isNaN(v) ? Date.now() : v; }
  function stripRc(rc) { const { fi, ...o } = rc; return clone(o); }
  function rcUsable(it) { return !(it.unit == null || it.nameUnsure || (it.unsure && !it.qtyInferred)); }
  // the date the item's current price comes from
  function priceAt(restName, it) {
    let at = it.at || 0;
    for (const r of S.history[restName] || []) if (r.at && r.at > at && namesOf(it).some(n => C.sameItem(r.item, n)) && Math.abs(C.num(r.price) - C.num(it.price)) < 0.005) at = r.at;
    return at;
  }
  // item names: the menu name people see, plus the receipt wordings learned for it (aliases)
  const loose = n => C.normName(n).replace(/^(سندو?تش|ساندو?يتش|سندويتش|ساندوتش)\s*/, '').replace(/\s+/g, '').replace(/^ال/, '').replace(/بال/g, 'ب').replace(/أ|إ|آ/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/و?اوم?ليت|امليت|اومليت/g, 'امليت');
  const sameName = (a, b) => C.sameItem(a, b) || loose(a) === loose(b) || C.similarity(loose(a), loose(b)) >= 0.86;
  const namesOf = it => [it.name, ...(it.aliases || [])];
  const itemIs = (it, name) => namesOf(it).some(n => sameName(n, name));
  function findItem(items, name) { return items.find(x => itemIs(x, name)); }
  function addAlias(it, name) {
    if (!name || C.normName(name) === C.normName(it.name)) return;
    it.aliases = Array.from(new Set([...(it.aliases || []), name])).slice(-8);
  }
  // all the names an item went by in this restaurant (for its price history)
  function aliasesOf(restName, name) {
    const lists = [S.draft && S.draft.name === restName ? S.draft.items : null, (S.restaurants.find(r => r.name === restName) || {}).items].filter(Boolean);
    for (const items of lists) { const it = items.find(x => C.sameItem(x.name, name)); if (it) return namesOf(it); }
    return [name];
  }
  const histIs = (restName, rowItem, name) => aliasesOf(restName, name).some(n => C.sameItem(rowItem, n));
  // the order's receipt teaches the menu: confirmed matches update the matched menu item's price (name unchanged);
  // receipt lines that match nothing on the menu are NOT added — they stay in the price history only
  function learnFromReceipt(items, rc, pairs, restName) {
    const at = rcAt(rc);
    let updated = 0, older = 0, unknown = 0;
    const done = new Set();
    const touch = (ex, line) => {
      if (done.has(ex)) return;
      done.add(ex); addAlias(ex, line.name);
      if (at >= priceAt(restName, ex)) { if (C.num(ex.price) !== line.unit) { ex.price = line.unit; updated++; } ex.at = at; } else older++;
    };
    for (const [shown, line] of pairs) { const ex = findItem(items, shown) || findItem(items, line.name); if (ex && rcUsable(line)) touch(ex, line); }
    for (const line of rc.items) {
      if (!rcUsable(line) || pairs.some(p => p[1] === line)) continue;
      const ex = findItem(items, line.name);
      if (ex) touch(ex, line); else unknown++;
    }
    return { updated, older, unknown };
  }
  // apply one receipt to a menu: newer-or-same date replaces the price, an older one only goes to the history
  function takeNewest(items, rc, restName, category) {
    const at = rcAt(rc);
    let updated = 0, added = 0, older = 0, unsure = 0;
    for (const it of rc.items) {
      if (!rcUsable(it)) { unsure++; continue; }
      const ex = findItem(items, it.name);
      if (ex) addAlias(ex, it.name);
      if (!ex) { items.push({ id: rid(8), name: it.name, price: it.unit, category: category || '', fresh: true, at }); added++; continue; }
      if (at >= priceAt(restName, ex)) {
        if (C.num(ex.price) !== it.unit) { ex.oldPrice = ex.oldPrice || ex.price; ex.price = it.unit; ex.fresh = true; updated++; }
        ex.at = at;
      } else older++;
    }
    return { updated, added, older, unsure };
  }
  // one light JPEG of the screenshot(s), stacked, to keep with the receipt
  async function shrinkImages(files, maxW = 720, q = 0.62) {
    const imgs = [];
    for (const f of files) {
      if (!f) continue;
      const url = URL.createObjectURL(f);
      try { imgs.push(await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; })); } catch (e) { }
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    if (!imgs.length) return null;
    const w = Math.min(maxW, Math.max(...imgs.map(i => i.naturalWidth)));
    const hs = imgs.map(i => Math.round(i.naturalHeight * w / i.naturalWidth));
    const c = document.createElement('canvas'); c.width = w; c.height = Math.min(14000, hs.reduce((a, b) => a + b, 0));
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    let y = 0; imgs.forEach((i, k) => { x.drawImage(i, 0, y, w, hs[k]); y += hs[k]; });
    return c.toDataURL('image/jpeg', q);
  }
  async function loadReceipts(restName) {
    if (!restName || !S.store.receipts) return;
    try { S.rlist[restName] = (await S.store.receipts(S.gid, restName)) || []; } catch (e) { console.warn(e); }
    scheduleRender();
  }
  const dayFmt = ms => new Date(ms).toLocaleDateString(S.lang === 'ar' ? 'ar-EG' : 'en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
  function savedReceipts(restName) {
    const list = S.rlist[restName] || [];
    if (!list.length) return '';
    return `<p class="label rl-head">${esc(t('receiptsSaved'))} <small class="muted">(${list.length})</small></p>
      <ul class="rlist">${list.map(r => `<li><button class="row-link" data-act="viewReceipt" data-id="${esc(r.id)}">
        <span>🧾 <b>${esc(r.at ? dayFmt(r.at) : '—')}</b>${r.orderNo ? ` <small class="muted" dir="ltr">#${esc(r.orderNo)}</small>` : ''}</span>
        <small class="muted tnum">${esc(t('itemsCount', { n: r.items }))}${r.total != null ? ' · ' + esc(money(r.total)) : ''}</small></button></li>`).join('')}</ul>`;
  }
  async function openReceipt(id) {
    S.rview = { id, busy: true }; render(true);
    try { const r = await S.store.receipt(S.gid, id); S.rview = r ? Object.assign({ busy: false }, r) : null; if (!r) toast(t('invoiceMissing'), 'warn'); }
    catch (e) { console.warn(e); S.rview = null; toast(t('shotsFail'), 'warn'); }
    render(true);
  }
  function receiptModal() {
    const R = S.rview; if (!R) return '';
    const p = R.parsed || {};
    return `<div class="rmodal" role="dialog" aria-modal="true"><div class="rmodal-box">
      <div class="rmodal-head"><b>🧾 ${esc(R.restName || '')} ${R.at ? '· ' + esc(dayFmt(R.at)) : ''}</b>${R.orderNo ? ` <small class="muted" dir="ltr">#${esc(R.orderNo)}</small>` : ''}
        <button class="icon-btn" data-act="closeReceipt" aria-label="${esc(t('close'))}">×</button></div>
      ${R.busy ? `<p class="muted center">${esc(t('loading'))}</p>` : R.image ? `<img src="${esc(R.image)}" alt="">` : `<ul class="rm-items">${(p.items || []).map(i => `<li><span>${esc(i.qty + '× ' + i.name)}</span><b class="tnum">${i.unit == null ? '?' : esc(C.fmtMoney(i.unit))}</b></li>`).join('')}</ul>`}
    </div></div>`;
  }
  // every receipt side by side: what each item cost on each date
  function priceCompare(d) {
    const rows = (S.history[d.name] || []).filter(r => r.at);
    const day = ms => { const x = new Date(ms); x.setHours(0, 0, 0, 0); return x.getTime(); };
    const dates = Array.from(new Set(rows.map(r => day(r.at)))).sort((a, b) => b - a).slice(0, 5);
    if (dates.length < 2) return '';
    const items = d.items.filter(it => rows.some(r => namesOf(it).some(n => C.sameItem(r.item, n))));
    if (!items.length) return '';
    // one column per day; several receipts on one day → the last one counts
    const cell = (it, dd) => { let best = null; for (const x of rows) if (day(x.at) === dd && namesOf(it).some(n => C.sameItem(x.item, n)) && (!best || x.at >= best.at)) best = x; return best ? C.num(best.price) : null; };
    return `<details class="panel cmp"><summary>${esc(t('priceCompare'))} <small class="muted">${esc(t('priceCompareSub', { n: dates.length }))}</small></summary>
      <div class="cmp-wrap"><table class="cmp-table tnum"><thead><tr><th>${esc(t('itemName'))}</th>${dates.map(a => `<th>${esc(dayFmt(a))}</th>`).join('')}</tr></thead>
      <tbody>${items.map(it => {
        const vals = dates.map(a => cell(it, a));
        return `<tr><td>${esc(it.name)}</td>${vals.map((v, i) => {
          if (v == null) return '<td class="muted">—</td>';
          const prev = vals.slice(i + 1).find(x => x != null);
          const cls = prev == null || prev === v ? '' : v > prev ? ' up' : ' down';
          return `<td class="${cls.trim()}">${esc(C.fmtMoney(v))}${cls ? (cls === ' up' ? ' ▲' : ' ▼') : ''}</td>`;
        }).join('')}</tr>`;
      }).join('')}</tbody></table></div>
      <p class="muted small-text">${esc(t('priceCompareHint'))}</p></details>`;
  }

  /* ---------- price history ---------- */
  async function loadHistory(restName, force) {
    if (!restName || !S.store.priceHistory) return [];
    if (S.history[restName] && !force) return S.history[restName];
    try { S.history[restName] = (await S.store.priceHistory(S.gid, restName)) || []; }
    catch (e) { console.warn(e); S.history[restName] = S.history[restName] || []; }
    scheduleRender();
    return S.history[restName];
  }
  // the price before the current one, from the restaurant's history
  function priceMove(restName, itemName, price) {
    const rows = (S.history[restName] || []).filter(r => histIs(restName, r.item, itemName));
    if (!rows.length) return null;
    const same = r => Math.abs(C.num(r.price) - price) < 0.005;
    let idx = -1;
    for (let i = rows.length - 1; i >= 0; i--) if (same(rows[i])) { idx = i; break; }
    let before = null;
    if (idx === -1) before = rows[rows.length - 1];
    else { let i = idx; while (i > 0 && same(rows[i - 1])) i--; before = i > 0 ? rows[i - 1] : null; }
    if (!before || Math.abs(C.num(before.price) - price) < 0.005) return null;
    return { prev: C.num(before.price), diff: C.round2(price - C.num(before.price)), at: before.at };
  }
  function moveBadge(prev, price) {
    if (prev == null) return '';
    const diff = C.round2(price - prev);
    if (!diff) return '';
    const up = diff > 0;
    return `<span class="move ${up ? 'up' : 'down'} tnum" title="${esc(t('wasPrice', { p: C.fmtMoney(prev) }))}">${up ? '▲' : '▼'} ${esc(C.fmtMoney(Math.abs(diff)))}<small>${esc(t('wasPrice', { p: C.fmtMoney(prev) }))}</small></span>`;
  }
  function moveTag(restName, itemName, price) {
    const mv = priceMove(restName, itemName, price);
    return mv ? `<small class="hist">${moveBadge(mv.prev, price)}</small>` : '';
  }
  function movesSummary(d) {
    let up = 0, down = 0;
    for (const it of d.items) { const mv = priceMove(d.name, it.name, C.num(it.price)); if (mv) { if (mv.diff > 0) up++; else down++; } }
    if (!up && !down) return `<small class="muted">${esc(t('pricesStable'))}</small>`;
    return `<small class="moves">${up ? `<span class="move up">▲ ${esc(t('nUp', { n: up }))}</span>` : ''}${down ? `<span class="move down">▼ ${esc(t('nDown', { n: down }))}</span>` : ''}</small>`;
  }

  /* ---------- invoices ---------- */
  const ymd = ms => { const d = new Date(ms); return String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); };
  // Opens the Talabat app itself (no deep link to a restaurant: Talabat has no public integration).
  function openTalabatApp() {
    const ua = navigator.userAgent || '';
    const web = 'https://www.talabat.com/egypt';
    if (/android/i.test(ua)) {
      location.href = 'intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=com.talabat;S.browser_fallback_url=' + encodeURIComponent('https://play.google.com/store/apps/details?id=com.talabat') + ';end';
    } else if (/iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
      const t0 = Date.now();
      location.href = 'talabat://';
      setTimeout(() => { if (!document.hidden && Date.now() - t0 < 2500) location.href = web; }, 1500);
    } else {
      window.open(web, '_blank', 'noopener');
    }
  }

  function invoiceLink(c, key) {
    return baseUrl() + '?inv=1&g=' + encodeURIComponent(c.groupId || S.gid) + '&c=' + encodeURIComponent(c.id) + '&p=' + encodeURIComponent(key) + '&k=' + encodeURIComponent(c.invoiceKey || '');
  }
  async function issueInvoices(c) {
    await loadHistory(c.restaurant.name, true);
    const bill = C.computeBill(c, prevFor(c));
    const secret = c.invoiceKey || rid(18);
    const base = 'TQ-' + ymd(c.createdAt) + '-' + c.id.replace(/[^a-z0-9]/gi, '').slice(-4).toUpperCase();
    const p = { invoiceKey: secret, invoicesAt: Date.now() };
    bill.rows.forEach((r, i) => {
      p['invoices.' + r.key] = {
        no: base + '-' + String(i + 1).padStart(2, '0'), issuedAt: Date.now(), name: r.name, phone: r.phone || '',
        items: r.items.map(it => {
          const unit = C.num(it.price), qty = C.num(it.qty);
          const mv = priceMove(c.restaurant.name, it.name, unit);
          return { name: it.name, qty, unit, total: C.round2(unit * qty), note: it.note || '', askedFor: it.askedFor || '', prev: mv ? mv.prev : null };
        }),
        subtotal: r.subtotal, lines: r.lines.map(l => ({ label: l.label, value: l.value, kind: l.kind })),
        exact: r.exact, total: r.total, prev: r.isHost ? 0 : r.prev, net: r.isHost ? r.total : r.net, self: !!r.isHost,
        receiptNo: c.receiptNo || '', receiptDate: c.receiptDate || '', people: bill.people, orderFood: bill.food, orderGrand: bill.grand,
        splitNote: (c.charges || []).filter(ch => C.num(ch.amount)).map(ch => ch.label + ': ' + t('split_' + (ch.split || C.DEFAULT_SPLIT[ch.kind] || 'equal'))).join(' · ')
      };
    });
    await patch(c, p);
    // show the new invoices right away, without waiting for the next refresh
    c.invoiceKey = secret; c.invoicesAt = p.invoicesAt; c.invoices = Object.assign({}, c.invoices || {});
    for (const k of Object.keys(p)) if (k.startsWith('invoices.')) c.invoices[k.slice(9)] = p[k];
    return Object.keys(p).filter(k => k.startsWith('invoices.')).map(k => k.slice(9));
  }
  function startSending(c, keys) {
    keys = (keys || Object.keys(c.invoices || {})).filter(k => k !== c.ownerId);
    S.sendQ = keys.length ? { cartId: c.id, keys, i: 0 } : null;
    render(true);
  }
  function invoiceMessage(c, key) {
    const inv = c.invoices[key];
    return t('msgInvoice', { name: inv.name, rest: c.restaurant.name, total: money(inv.net), no: inv.no, link: invoiceLink(c, key) }) + payLines(c.payInfo || {});
  }
  function combinedInvoice(c, bill) {
    const inv = c.invoices || {};
    const issued = Object.keys(inv).length;
    const stale = issued && bill.rows.some(r => !r.isHost && (!inv[r.key] || Math.abs(inv[r.key].net - r.net) > 0.009));
    const q = S.sendQ && S.sendQ.cartId === c.id ? S.sendQ : null;
    const rest = c.restaurant.name;
    const rows = bill.rows.map(r => `<tr class="${r.isHost ? 'is-host' : ''}">
        <td class="who"><b>${esc(r.name)}</b>${r.isHost ? `<small>${esc(t('host'))}</small>` : ''}</td>
        <td class="what">${r.items.map(it => `<span class="ci">${esc(it.qty)}× ${esc(it.name)} <em class="tnum">${esc(C.fmtMoney(it.price))}</em>${(() => { const mv = priceMove(rest, it.name, C.num(it.price)); return mv ? moveBadge(mv.prev, C.num(it.price)) : ''; })()}</span>`).join('')}</td>
        <td class="num tnum">${esc(C.fmtMoney(r.subtotal))}</td>
        <td class="num tnum">${esc(C.fmtMoney(C.round2(r.exact - r.subtotal)))}</td>
        <td class="num tnum"><b>${esc(C.fmtMoney(r.isHost ? r.total : r.net))}</b></td>
        <td>${payChip(r, c)}${inv[r.key] ? `<button class="link-btn" data-act="previewInvoice" data-key="${esc(r.key)}">${esc(t('viewInvoice'))}</button>` : ''}</td>
      </tr>`).join('');
    let sender = '';
    if (q && q.mode === 'remind') {
      const key = q.keys[q.i], row = bill.rows.find(r => r.key === key);
      if (row) {
        const msg = remindMessage(c, row);
        sender = `<div class="sender remind">
          <div class="sender-top"><span class="tnum">🔔 ${esc(t('remindingN', { i: q.i + 1, n: q.keys.length }))}</span><button class="ghost small" data-act="stopSend">${esc(t('stop'))}</button></div>
          <p><b>${esc(row.name)}</b> · <span class="tnum">${esc(money(row.remaining))}</span>${c.reminded && c.reminded[key] ? ` · <span class="muted">${esc(t('lastReminded', { t: fmtAgo(c.reminded[key]) }))}</span>` : ''}</p>
          <div class="btn-row">
            ${row.phone ? `<a class="wa big" data-act="sendNext" data-keep="1" data-key="${esc(key)}" href="${esc(waLink(row.phone, msg))}" target="_blank" rel="noopener">${waIcon()} ${esc(t('remindTo', { name: row.name }))}</a>`
              : `<button class="secondary" data-act="copyInvoiceLink" data-text="${esc(msg)}">${esc(t('copyInvoiceMsg'))}</button><button class="primary" data-act="sendNext" data-key="${esc(key)}">${esc(t('next'))}</button>`}
            <button class="ghost small" data-act="skipSend">${esc(t('skip'))}</button>
          </div>
        </div>`;
      }
    } else if (q) {
      const key = q.keys[q.i], one = (c.invoices || {})[key];
      if (one) {
        const phone = one.phone || ((c.members || {})[key] || {}).phone;
        sender = `<div class="sender">
          <div class="sender-top"><span class="tnum">${esc(t('sendingN', { i: q.i + 1, n: q.keys.length }))}</span><button class="ghost small" data-act="stopSend">${esc(t('stop'))}</button></div>
          <p><b>${esc(one.name)}</b> · <span class="tnum">${esc(money(one.net))}</span> · <span class="muted">${esc(one.no)}</span></p>
          <div class="btn-row">
            ${phone ? `<a class="wa big" data-act="sendNext" data-keep="1" data-key="${esc(key)}" href="${esc(waLink(phone, invoiceMessage(c, key)))}" target="_blank" rel="noopener">${waIcon()} ${esc(t('sendTo', { name: one.name }))}</a>`
              : `<button class="secondary" data-act="copyInvoiceLink" data-text="${esc(invoiceMessage(c, key))}">${esc(t('copyInvoiceMsg'))}</button><button class="primary" data-act="sendNext" data-key="${esc(key)}">${esc(t('next'))}</button>`}
            <button class="ghost small" data-act="skipSend">${esc(t('skip'))}</button>
          </div>
        </div>`;
      }
    }
    return `<section class="panel combined">
      <div class="section-head"><p class="label">${esc(t('combinedTitle'))}</p><small class="muted tnum">${esc(t('combinedSub', { n: bill.people, a: money(bill.grand) }))}</small></div>
      <div class="scroll"><table class="ctable">
        <thead><tr><th>${esc(t('colName'))}</th><th>${esc(t('colItems'))}</th><th>${esc(t('rowFood'))}</th><th>${esc(t('colCharges'))}</th><th>${esc(t('rowTotal'))}</th><th>${esc(t('colStatus'))}</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="2">${esc(t('colTotal'))}</td><td class="num tnum">${esc(C.fmtMoney(bill.food))}</td><td class="num tnum">${esc(C.fmtMoney(bill.chargesTotal))}</td><td class="num tnum"><b>${esc(C.fmtMoney(bill.collected))}</b></td><td></td></tr></tfoot>
      </table></div>
      ${collectSheet(c, bill)}
      ${!bill.rows.some(r => !r.isHost) ? `<p class="banner soft">${esc(t('noOneElse'))}</p>` : sender || `<p class="muted small-text send-to">${esc(t('willSendTo', { s: bill.rows.filter(r => !r.isHost).map(r => r.name + (r.phone ? '' : ' ' + t('noPhoneTag'))).join(comma()) }))}</p><button class="primary block big" data-act="issueInvoices">${esc(issued ? (stale ? t('reissueSend') : t('sendAgain')) : t('issueSend'))}</button>
        ${issued ? `<p class="muted small-text">${esc(t('issuedAt', { n: issued, t: fmtTime(c.invoicesAt || Date.now()) }))}${stale ? ' ' + esc(t('staleNote')) : ''}</p>` : `<p class="muted small-text">${esc(t('issueHint'))}</p>`}
        ${(() => { const un = bill.rows.filter(r => !r.isHost && (r.state === 'unpaid' || r.state === 'partial')); return un.length ? `<button class="secondary block remind-btn" data-act="remindUnpaid">🔔 ${esc(t('remindUnpaid', { n: un.length }))}</button>
          <p class="muted small-text">${esc(t('remindUnpaidHint', { s: un.map(r => r.name).join(comma()) }))}</p>` : ''; })()}`}
    </section>`;
  }
  /* ---------- the collection sheet: sent? paid? how much came in? ---------- */
  function collectSheet(c, bill) {
    const inv = c.invoices || {};
    const pays = c.payments || {};
    const others = bill.rows.filter(r => !r.isHost);
    if (!others.length) return '';
    const host = bill.rows.find(r => r.isHost);
    let due = 0, got = 0;
    const row = r => {
      const one = inv[r.key];
      const stale = one && Math.abs(C.num(one.net) - C.num(r.net)) > 0.009;
      const P = pays[r.key];
      const recv = P && P.status === 'confirmed' ? C.num(P.amount) : 0;
      const reported = P && P.status === 'reported';
      const need = Math.max(0, C.num(r.net));
      due += need; got += recv;
      const diff = C.round2(recv - need);
      const phone = (one && one.phone) || r.phone;
      let send;
      if (!one || stale) send = `<button class="secondary small" data-act="issueOnly">${esc(one ? t('updateInvoice') : t('makeInvoice'))}</button>`;
      else if (phone) send = `<a class="wa small" data-act="markSent" data-keep="1" data-key="${esc(r.key)}" href="${esc(waLink(phone, invoiceMessage(c, r.key)))}" target="_blank" rel="noopener">${waIcon()} ${esc(one.sentAt ? t('sendAgainOne') : t('sendOne'))}</a>`;
      else send = `<button class="secondary small" data-act="copyInvoiceLink" data-text="${esc(invoiceMessage(c, r.key))}">${esc(t('copyInvoiceMsg'))}</button>`;
      return `<li class="cs-row${recv >= need - 0.009 && need > 0 ? ' paid' : ''}">
        <div class="cs-top"><b>${esc(r.name)}</b><span class="tnum cs-due">${esc(money(need))}</span></div>
        <div class="cs-sent">${one && one.sentAt ? `<span class="sent-ok">✓ ${esc(t('sentAt', { t: fmtTime(one.sentAt) }))}</span>` : `<span class="muted">${esc(t('notSent'))}</span>`}
          ${one ? `<button class="link-btn" data-act="previewInvoice" data-key="${esc(r.key)}">${esc(t('viewInvoice'))}</button>` : ''}${send}</div>
        <div class="cs-pay">
          <label class="chip-check"><input type="checkbox" data-change="paidToggle" data-key="${esc(r.key)}" ${recv > 0 && recv >= need - 0.009 ? 'checked' : ''}><span>${esc(t('paidCheck'))}</span></label>
          <label class="cs-amt"><span>${esc(t('received'))}</span><input class="tnum" inputmode="decimal" data-change="paidAmount" data-key="${esc(r.key)}" value="${recv ? esc(C.fmtMoney(recv)) : ''}" placeholder="0"></label>
          <span class="cs-diff tnum ${!recv ? 'muted' : diff < -0.009 ? 'short' : diff > 0.009 ? 'over' : 'even'}">${!recv ? (reported ? esc(t('payReported')) : '—') : diff < -0.009 ? esc(t('shortBy', { a: C.fmtMoney(-diff) })) : diff > 0.009 ? esc(t('overBy', { a: C.fmtMoney(diff) })) : '✓'}</span>
        </div>
        ${reported ? `<p class="small-text muted">${esc(t('reportedSays', { m: t('method_' + (P.method || 'instapay')) + ' ' + C.fmtMoney(P.amount) }))} <button class="link-btn" data-act="confirmPay" data-key="${esc(r.key)}">✓ ${esc(t('confirm'))}</button></p>` : ''}
      </li>`;
    };
    const list = others.map(row).join('');
    const gap = C.round2(got - due);
    const myInv = host && inv[host.key];
    const myPhone = S.profile && S.profile.phone;
    const paidTalabat = C.num(c.receiptTotal) || bill.grand;
    const shouldCollect = C.round2(paidTalabat - (host ? host.total : 0));
    return `<div class="collect">
      <p class="label">💰 ${esc(t('collectTitle'))}</p>
      <ul class="cs-list">${list}</ul>
      <div class="cs-sum tnum">
        <div><span>${esc(t('csDue'))}</span><b>${esc(money(due))}</b></div>
        <div><span>${esc(t('csGot'))}</span><b>${esc(money(got))}</b></div>
        <div class="${gap < -0.009 ? 'short' : gap > 0.009 ? 'over' : 'even'}"><span>${esc(gap < -0.009 ? t('csShort') : gap > 0.009 ? t('csOver') : t('csEven'))}</span><b>${esc(gap ? money(Math.abs(gap)) : '✓')}</b></div>
      </div>
      <p class="muted small-text tnum">${esc(t('csCheck', { p: money(paidTalabat), m: money(host ? host.total : 0), c: money(shouldCollect) }))}${(() => {
        const thisOrder = C.round2(others.reduce((a, r) => a + C.num(r.total), 0));
        const old = C.round2(due - thisOrder), round = C.round2(thisOrder - shouldCollect);
        return (Math.abs(round) > 0.009 ? ' ' + esc(t('csRound', { a: (round > 0 ? '+' : '−') + C.fmtMoney(Math.abs(round)) })) : '') + (Math.abs(old) > 0.009 ? ' ' + esc(t('csOld', { a: (old > 0 ? '+' : '−') + C.fmtMoney(Math.abs(old)) })) : '');
      })()}</p>
      ${host ? `<div class="cs-me"><b>${esc(t('myInvoice'))}</b> <span class="tnum">${esc(money(host.total))}</span>
        ${myInv ? `<button class="secondary small" data-act="previewInvoice" data-key="${esc(host.key)}">${esc(t('viewInvoice'))}</button>
          ${myPhone ? `<a class="wa small" href="${esc(waLink(myPhone, invoiceMessage(c, host.key)))}" target="_blank" rel="noopener">${waIcon()} ${esc(t('sendToMe'))}</a>` : ''}`
          : `<button class="secondary small" data-act="issueOnly">${esc(t('makeInvoice'))}</button>`}
        <p class="muted small-text">${esc(t('myInvoiceHint'))}</p></div>` : ''}
    </div>`;
  }

  function invoiceData(c, key) {
    return { invoice: c.invoices[key], payment: (c.payments || {})[key], restaurant: c.restaurant, title: c.title, createdAt: c.createdAt,
      ownerName: c.ownerName, ownerPhone: c.ownerPhone, payInfo: c.payInfo, groupName: S.group && S.group.name, link: invoiceLink(c, key) };
  }
  async function openInvoice(inv) {
    S.invoiceView = { loading: true };
    render(true);
    try {
      const data = await S.store.invoice(inv.gid, inv.cid, inv.key, inv.secret);
      S.invoiceView = { data: Object.assign(data, { link: location.href }) };
    } catch (e) { console.warn(e); S.invoiceView = { error: true }; }
    render(true);
  }
  function viewInvoice() {
    const V = S.invoiceView;
    if (V.loading) return `<main class="inv-page"><div class="loading" aria-busy="true"></div></main>`;
    if (V.error || !V.data || !V.data.invoice) return `<main class="inv-page"><p class="empty">${esc(t('invoiceMissing'))}</p></main>`;
    const D = V.data, I = D.invoice, P = D.payment;
    const paid = P && P.status === 'confirmed' ? C.num(P.amount) : 0;
    const state = P && P.status === 'reported' ? 'pending' : (paid + 0.009 >= I.net ? 'paid' : (paid > 0 ? 'partial' : 'unpaid'));
    const stamp = { paid: t('invPaid'), pending: t('invPending'), partial: t('invPartial', { a: C.fmtMoney(paid) }), unpaid: t('invUnpaid') }[state];
    const pi = D.payInfo || {};
    const when = new Date(I.issuedAt || D.createdAt);
    const changed = I.items.filter(i => i.prev != null && i.prev !== i.unit);
    return `<main class="inv-page">
      ${V.preview ? `<div class="inv-tools"><button class="ghost small" data-act="closeInvoice">‹ ${esc(t('back'))}</button>
        ${D.link ? `<button class="secondary small" data-act="copyInvoiceLink" data-text="${esc(D.link)}">${esc(t('copyInvoiceLink'))}</button>` : ''}</div>` : ''}
      <article class="invoice">
        <header class="inv-head">
          <div class="inv-brand">${logoSvg()}<div><b>${esc(t('appName'))}</b><small>${esc(D.groupName || '')}</small></div></div>
          <div class="inv-title"><h1>${esc(t('invoice'))}</h1><span class="tnum" dir="ltr">${esc(I.no)}</span></div>
        </header>
        <dl class="inv-meta tnum">
          <div><dt>${esc(t('invDate'))}</dt><dd>${esc(when.toLocaleDateString(loc(), { day: 'numeric', month: 'long', year: 'numeric' }))} · ${esc(fmtTime(when.getTime()))}</dd></div>
          <div><dt>${esc(t('invTo'))}</dt><dd><b>${esc(I.name)}</b>${I.phone ? ` <span dir="ltr">${esc(I.phone)}</span>` : ''}</dd></div>
          <div><dt>${esc(t('invFrom'))}</dt><dd>${esc(D.ownerName || '')}</dd></div>
          <div><dt>${esc(t('invRest'))}</dt><dd>${esc((D.restaurant || {}).name || '')}${D.title ? ' · ' + esc(D.title) : ''}</dd></div>
          ${I.receiptNo ? `<div><dt>${esc(t('invTalabatNo'))}</dt><dd dir="ltr">${esc(I.receiptNo)}</dd></div>` : ''}
        </dl>
        <table class="inv-items">
          <thead><tr><th>${esc(t('itemName'))}</th><th class="num">${esc(t('qty'))}</th><th class="num">${esc(t('unitPrice'))}</th><th class="num">${esc(t('lineTotal'))}</th></tr></thead>
          <tbody>${I.items.map(it => `<tr>
            <td><b>${esc(it.name)}</b>${it.note ? `<small>${esc(it.note)}</small>` : ''}${it.askedFor && it.askedFor !== it.name ? `<small>${esc(t('youAsked', { s: it.askedFor }))}</small>` : ''}</td>
            <td class="num tnum">${esc(it.qty)}</td>
            <td class="num tnum">${esc(C.fmtMoney(it.unit))}${moveBadge(it.prev, it.unit)}</td>
            <td class="num tnum">${esc(C.fmtMoney(it.total))}</td></tr>`).join('')}</tbody>
        </table>
        <dl class="inv-totals tnum">
          <div><dt>${esc(t('rowFood'))}</dt><dd>${esc(C.fmtMoney(I.subtotal))}</dd></div>
          ${(I.lines || []).map(l => `<div><dt>${esc(l.label)}</dt><dd>${l.value < 0 ? '−' : ''}${esc(C.fmtMoney(Math.abs(l.value)))}</dd></div>`).join('')}
          ${Math.abs(I.total - I.exact) > 0.009 ? `<div><dt>${esc(t('invRounding'))}</dt><dd>+${esc(C.fmtMoney(C.round2(I.total - I.exact)))}</dd></div>` : ''}
          ${Math.abs(I.prev) > 0.009 ? `<div class="sub"><dt>${esc(t('rowTotal'))}</dt><dd>${esc(C.fmtMoney(I.total))}</dd></div><div class="${I.prev > 0 ? 'ok' : 'warn'}"><dt>${esc(I.prev > 0 ? t('prevCredit') : t('prevDebt'))}</dt><dd>${I.prev > 0 ? '−' : '+'}${esc(C.fmtMoney(Math.abs(I.prev)))}</dd></div>` : ''}
          <div class="grand"><dt>${esc(t('invDue'))}</dt><dd>${esc(money(I.net))}</dd></div>
        </dl>
        <div class="inv-stamp ${state}">${esc(stamp)}${P && P.method ? ` · ${esc(t('method_' + P.method))}` : ''}</div>
        ${(pi.instapay || pi.wallet || pi.instapayLink) && state !== 'paid' ? `<section class="inv-pay">
          <p class="label">${esc(t('payTo', { name: D.ownerName || '' }))}</p>
          ${payButtons(pi, C.round2(Math.max(0, I.net - paid)))}
          ${D.ownerPhone ? wa(waLink(D.ownerPhone, t('msgPaidInvoice', { no: I.no, total: money(I.net) })), t('tellPaid'), 'block') : ''}
        </section>` : ''}
        <footer class="inv-foot">
          ${changed.length ? `<p>${esc(t('invPriceNote', { n: changed.length }))}</p>` : ''}
          ${I.splitNote ? `<p>${esc(t('invSplit'))}: ${esc(I.splitNote)}</p>` : ''}
          <p>${esc(t('invOrderNote', { n: I.people || 1, a: money(I.orderGrand || 0) }))}</p>
          <p class="inv-by">${esc(t('invBy'))}</p>
        </footer>
      </article>
    </main>`;
  }

  function syncDraft() {
    if (!S.draft) return;
    document.querySelectorAll('[data-draft]').forEach(inp => { S.draft[inp.dataset.draft] = inp.value.trim(); });
    document.querySelectorAll('[data-fee]').forEach(inp => { S.draft.fees[inp.dataset.fee] = C.round2(C.num(inp.value)); });
    document.querySelectorAll('[data-change="itemName"]').forEach(inp => { const it = S.draft.items.find(i => i.id === inp.dataset.id); if (it && inp.value.trim()) it.name = inp.value.trim(); });
    document.querySelectorAll('[data-change="itemPrice"]').forEach(inp => { const it = S.draft.items.find(i => i.id === inp.dataset.id); if (it && C.num(inp.value) > 0 && C.round2(C.num(inp.value)) !== C.num(it.price)) { it.price = C.round2(C.num(inp.value)); it.at = Date.now(); } });
  }
  function syncNewOrder() { /* selections live in S.sel; nothing else to keep */ }

  function setLang(l) { S.lang = l === 'en' ? 'en' : 'ar'; LS.set('tarweeqa.lang', S.lang); render(true); }

  const changes = {
    acting: el => {
      S.store.setActing(el.value);
      S.profile = S.store.profile();
      S.actFor = null; S.payMethod = {};
      render(true);
    },
    actFor: el => { S.actFor = el.value; S.menuQuery = ''; render(true); },
    pickRest: el => {
      const id = el.value;
      if (el.checked) { if (!S.sel.includes(id)) S.sel.push(id); } else S.sel = S.sel.filter(x => x !== id);
      if (S.sel.length > 4) { S.sel = S.sel.slice(0, 4); toast(t('maxFour'), 'warn'); }
      render(true);
    },
    note: el => {
      const c = curCart(), key = actKey(c), m = memberFor(c, key);
      const it = m.items.find(i => i.id === el.dataset.id);
      if (!it || (it.note || '') === el.value.trim()) return;
      it.note = el.value.trim(); saveMember(c, key, m);
    },
    chLabel: el => { const c = curCart(); const list = clone(c.charges); list[+el.dataset.i].label = el.value.trim() || list[+el.dataset.i].label; patch(c, { charges: list }); },
    chAmount: el => { const c = curCart(); const list = clone(c.charges); list[+el.dataset.i].amount = C.round2(Math.abs(C.num(el.value))); patch(c, { charges: list }); },
    chSplit: el => {
      const c = curCart(); const list = clone(c.charges); const ch = list[+el.dataset.i];
      ch.split = el.value; if (ch.split === 'person' && !ch.person) ch.person = C.eaters(c)[0];
      patch(c, { charges: list });
    },
    chPerson: el => { const c = curCart(); const list = clone(c.charges); list[+el.dataset.i].person = el.value; patch(c, { charges: list }); },
    roundUp: el => patch(curCart(), { roundUp: el.checked }),
    paidToggle: el => {
      const c = curCart(), k = el.dataset.key;
      const r = C.computeBill(c, prevFor(c)).rows.find(x => x.key === k); if (!r) return;
      const old = (c.payments || {})[k];
      const v = el.checked ? { amount: C.round2(Math.max(0, r.net)), method: (old && old.method) || 'instapay', status: 'confirmed', at: Date.now(), by: me() } : null;
      c.payments = Object.assign({}, c.payments, { [k]: v || undefined }); render(true);
      patch(c, { ['payments.' + k]: v || undefined });
    },
    paidAmount: el => {
      const c = curCart(), k = el.dataset.key, a = C.round2(C.num(el.value));
      const old = (c.payments || {})[k];
      const v = a > 0 ? { amount: a, method: (old && old.method) || 'instapay', status: 'confirmed', at: Date.now(), by: me() } : null;
      c.payments = Object.assign({}, c.payments, { [k]: v || undefined }); render(true);
      patch(c, { ['payments.' + k]: v || undefined });
    },
    paidActual: el => { const v = C.round2(C.num(el.value)); patch(curCart(), { receiptTotal: v > 0 ? v : null }); },
    checkLine: el => { const c = curCart(); c.checked = Object.assign({}, c.checked, { [el.dataset.id]: el.checked || undefined }); render(true); patch(c, { ['checked.' + el.dataset.id]: el.checked ? true : null }); },
    sharedName: el => { const c = curCart(); const it = (c.menu || []).find(i => C.sameItem(i.name, el.value)); const pr = $('#sh-price'); if (it && pr && !pr.value) pr.value = it.price; },
    hostExempt: el => { patch(curCart(), { hostExempt: el.checked }); if (S.profile.hostAuto) saveHostDefaults({ hostExempt: el.checked }); },
    hostFee: el => { const v = Math.max(0, C.round2(C.num(el.value))); patch(curCart(), { hostFee: v, hostFeeLabel: t('hostFeeLabel') }); if (S.profile.hostAuto) saveHostDefaults({ hostFee: v }); },
    hostAuto: el => { const c = curCart(); saveHostDefaults(el.checked ? { hostAuto: true, hostExempt: !!c.hostExempt, hostFee: C.num(c.hostFee) } : { hostAuto: false, hostExempt: false, hostFee: 0 }); toast(el.checked ? t('hostAutoOn') : t('hostAutoOff')); },
    profHostExempt: el => saveHostDefaults({ hostExempt: el.checked, hostAuto: el.checked || C.num(S.profile.hostFee) > 0 }),
    profHostFee: el => { const v = Math.max(0, C.round2(C.num(el.value))); saveHostDefaults({ hostFee: v, hostAuto: v > 0 || !!S.profile.hostExempt }); },
    payInfo: el => patch(curCart(), { ['payInfo.' + el.dataset.k]: el.value.trim() }),
    payInfoInsta: el => { const v = splitInsta(el.value); patch(curCart(), { 'payInfo.instapay': v.instapay, 'payInfo.instapayLink': v.instapayLink }); },
    shots: el => readScreenshots(Array.from(el.files || [])),
    receipt: el => readReceipt(Array.from(el.files || [])),
    rcMap: el => { S.rcpt.map[el.dataset.k] = +el.value; render(true); },
    rcFee: el => { S.rcpt.fees[+el.dataset.i] = el.checked; render(true); },
    copyFrom: el => { S.copyFrom = el.value; },
    itemName: () => syncDraft(),
    itemPrice: () => syncDraft()
  };

  const submits = {
    welcome: async form => {
      const name = form.name.value.trim(), phone = form.phone.value.trim();
      const err = $('#w-err');
      if (!C.isValidPhone(phone)) { err.textContent = t('errPhone'); err.hidden = false; return; }
      const btn = form.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
      let r = null;
      try { r = await S.store.register(phone, name, {}); }
      catch (e) { console.warn(e); if (btn) btn.disabled = false; err.textContent = t('errWrite'); err.hidden = false; return; }
      const p = (r && r.person) || {};
      if (!name && !p.name) { if (btn) btn.disabled = false; err.textContent = t('errName'); err.hidden = false; return; }
      S.profile = Object.assign({ instapay: '', wallet: '' }, p.data || {}, { name: p.name || name, phone });
      LS.set('tarweeqa.profile', S.profile);
      if (r && r.existing) toast(t('welcomeBack', { name: S.profile.name }));
      if (S.pending && S.pending.gid) return loadPending();
      const saved = LS.get('tarweeqa.gid');
      const mine = (S.store.myGroups || []);
      if (mine.length) S.groups = mine;
      const pick = (saved && mine.some(g => g.id === saved)) ? saved : (mine[0] && mine[0].id) || saved;
      if (pick) { setGroup(pick, true); return go('home'); }
      render(true);
    },
    profile: form => {
      const p = Object.assign({ name: form.name.value.trim(), phone: form.phone.value.trim(), wallet: form.wallet.value.trim() }, splitInsta(form.instapay.value));
      const err = $('#p-err');
      if (!p.name) { err.textContent = t('errName'); err.hidden = false; return; }
      if (!C.isValidPhone(p.phone)) { err.textContent = t('errPhone'); err.hidden = false; return; }
      S.profile = Object.assign({}, S.profile, p);
      if (isLocal()) S.store.saveProfile(S.profile); else LS.set('tarweeqa.profile', S.profile);
      if (S.store.saveProfileRemote) guard(S.store.saveProfileRemote(p.name, { instapay: p.instapay, instapayLink: p.instapayLink, wallet: p.wallet }));
      if (S.group && S.group.roster && S.group.roster[me()]) guard(S.store.joinGroup(S.gid, Object.assign({}, S.group.roster[me()], { name: p.name, phone: p.phone })));
      toast(t('saved')); go('home');
    },
    createGroup: async form => {
      const name = form.name.value.trim();
      if (!name) return toast(t('errGroupName'), 'warn');
      const uid = me();
      const gid = await guard(S.store.createGroup({ name, ownerId: uid, adminIds: [uid], memberUids: [uid], roster: { [uid]: { name: S.profile.name, phone: S.profile.phone, joinedAt: Date.now() } }, createdAt: Date.now() }));
      if (gid) { setGroup(gid); go('group'); }
    },
    renameGroup: form => { const n = form.name.value.trim(); if (n) guard(S.store.patchGroup(S.gid, { name: n })).then(() => toast(t('saved'))); },
    cartPerson: form => {
      const c = curCart(); if (!c) return;
      const name = form.name.value.trim(), phone = form.phone.value.trim();
      if (!name) return toast(t('errName'), 'warn');
      if (phone && !C.isValidPhone(phone)) return toast(t('errPhone'), 'warn');
      const ppl = people(c);
      const ex = Object.keys(ppl).find(k => (phone && ppl[k].phone && C.waPhone(ppl[k].phone) === C.waPhone(phone)) || C.normName(ppl[k].name) === C.normName(name));
      const k = ex || 'g_' + rid(8);
      const m = (c.members || {})[k];
      if (!m || m.status === 'out') patch(c, { ['members.' + k]: Object.assign({ items: [] }, m || {}, { name: (ppl[k] || {}).name || name, phone: phone || (ppl[k] || {}).phone || '', status: 'in', guest: ex ? !!ppl[k].guest : true, at: Date.now() }) });
      if (!ex) S.store.patchGroup(S.gid, { ['roster.' + k]: { name, phone, guest: true, joinedAt: Date.now() } }).catch(() => { });   // remembered for next time
      form.reset();
      S.actFor = k; S.route.tab = 'mine'; render(true); window.scrollTo(0, 0);
      toast(t('personAdded', { name }));
    },
    addGuest: form => {
      const name = form.name.value.trim(), phone = form.phone.value.trim();
      if (!name) return toast(t('errName'), 'warn');
      if (phone && !C.isValidPhone(phone)) return toast(t('errPhone'), 'warn');
      guard(S.store.patchGroup(S.gid, { ['roster.g_' + rid(8)]: { name, phone, guest: true, joinedAt: Date.now() } }));
      form.reset(); toast(t('saved'));
    },
    draftAddItem: form => {
      syncDraft();
      const name = form.name.value.trim(), price = C.num(form.price.value), category = form.category.value.trim();
      if (!name || price <= 0) return toast(t('errItem'), 'warn');
      S.draft.items.push({ id: rid(8), name, price: C.round2(price), category });
      S._lastCat = category; render(true);
      const n = $('#ai-name'); if (n) n.focus();
    },
    sharedItem: form => {
      const c = curCart(); if (!c) return;
      const name = form.name.value.trim(), price = C.round2(C.num(form.price.value)), qty = Math.max(1, Math.round(C.num(form.qty.value) || 1));
      const keys = Array.from(form.querySelectorAll('input[name=who]:checked')).map(i => i.value);
      if (!name) return toast(t('errItemName'), 'warn');
      if (!(price > 0)) return toast(t('sharedNeedPrice'), 'warn');
      if (keys.length < 1) return toast(t('sharedNeedPeople'), 'warn');
      const members = {};   // sharers who never opened the order still count as in
      for (const k of keys) if (!(c.members || {})[k]) { const p = people(c)[k] || {}; members['members.' + k] = { name: p.name || k, phone: p.phone || '', status: 'in', items: [], done: true, guest: !!p.guest, at: Date.now() }; }
      S.sharedOpen = true;
      patch(c, Object.assign(members, { shared: [...(c.shared || []), { id: rid(6), name, price, qty, keys }] }));
      toast(t('sharedAdded', { n: keys.length, a: money(C.round2(price * qty / keys.length)) }));
    },
    customItem: form => {
      const name = form.name.value.trim(), price = C.num(form.price.value);
      if (!name) return toast(t('errItemName'), 'warn');
      const c = curCart(), key = actKey(c), m = memberFor(c, key);
      m.items.push({ id: rid(8), name, price: C.round2(Math.max(0, price)), qty: 1, note: '', custom: true, noPrice: !(price > 0) });
      m.status = 'in'; m.done = false;
      if (document.activeElement) document.activeElement.blur();
      saveMember(c, key, m);
    },
    createCart: async form => {
      if (!S.sel.length) return toast(t('needRest'), 'warn');
      const [h, mi] = (form.time.value || '').split(':').map(Number);
      const close = new Date(); close.setHours(h || 0, mi || 0, 0, 0);
      if (close.getTime() <= Date.now() + 60000) close.setDate(close.getDate() + 1);
      const { instapay, instapayLink } = splitInsta(form.instapay.value), wallet = form.wallet.value.trim();
      if (instapay !== (S.profile.instapay || '') || instapayLink !== (S.profile.instapayLink || '') || wallet !== (S.profile.wallet || '')) {
        S.profile = Object.assign({}, S.profile, { instapay, instapayLink, wallet });
        if (isLocal()) S.store.saveProfile(S.profile); else LS.set('tarweeqa.profile', S.profile);
        if (S.store.saveProfileRemote) guard(S.store.saveProfileRemote(S.profile.name, { instapay, instapayLink, wallet }));
      }
      const uid = me();
      const cart = {
        title: form.title.value.trim(), ownerId: uid, ownerName: S.profile.name, ownerPhone: S.profile.phone,
        createdAt: Date.now(), closesAt: close.getTime(),
        candidates: [], candidateInfo: {}, votes: {}, members: {}, payments: {}, charges: [], roundUp: true,
        payInfo: { instapay, instapayLink, wallet },
        hostExempt: !!S.profile.hostExempt, hostFee: C.num(S.profile.hostFee) || 0, hostFeeLabel: t('hostFeeLabel')
      };
      const chosen = S.sel.map(id => S.restaurants.find(r => r.id === id)).filter(Boolean);
      if (chosen.length === 1) Object.assign(cart, snapshotOf(chosen[0]), { stage: 'ordering' });
      else {
        cart.stage = 'voting';
        cart.candidates = chosen.map(r => r.id);
        for (const r of chosen) cart.candidateInfo[r.id] = { name: r.name, items: (r.items || []).length, delivery: (r.fees || {}).delivery || 0 };
      }
      const id = await guard(S.store.createCart(S.gid, cart));
      if (id) { S.sel = []; go('cart', { id, tab: 'mine' }); }
    }
  };

  /* ---------- events ---------- */
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || !$('#app').contains(el) || el.disabled) return;
    const fn = actions[el.dataset.act];
    if (!fn) return;
    if (el.tagName === 'A' && el.dataset.keep) { setTimeout(() => fn(el), 0); return; }   // open the link and also act
    e.preventDefault(); fn(el);
  });
  document.addEventListener('change', e => {
    const el = e.target.closest('[data-change]');
    if (!el) return;
    const fn = changes[el.dataset.change];
    if (fn) fn(el);
  });
  document.addEventListener('input', e => {
    const el = e.target;
    if (!el.dataset) return;
    if (el.dataset.input === 'search') {
      S.menuQuery = el.value;
      const q = el.value.trim().toLowerCase();
      let any = false;
      document.querySelectorAll('.menu-item').forEach(li => { const show = !q || li.dataset.name.includes(q); li.hidden = !show; if (show) any = true; });
      document.querySelectorAll('[data-group]').forEach(g => { g.hidden = !g.querySelector('.menu-item:not([hidden])'); });
      const nm = $('#no-match'); if (nm) nm.hidden = any;
    } else if (el.dataset.input === 'restSearch') {
      S.restQuery = el.value;
      const q = el.value.trim().toLowerCase();
      document.querySelectorAll('.pick, .pick-wrap').forEach(p => { p.hidden = !!q && !p.dataset.name.includes(q); });
    }
  });
  document.addEventListener('submit', e => {
    const form = e.target.closest('form[data-submit]');
    if (!form) return;
    e.preventDefault();
    const fn = submits[form.dataset.submit];
    if (fn) fn(form);
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      const ae = document.activeElement;
      const typing = ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && !['checkbox', 'radio', 'button'].includes(ae.type);
      if (S.dirty && !typing) render();
    }, 120);
  });

  /* ---------- data subscriptions ---------- */
  let groupUnsubs = [];
  function setGroup(gid, silent) {
    groupUnsubs.forEach(u => u && u()); groupUnsubs = [];
    S.gid = gid; S.group = null; S.restaurants = []; S.carts = [];
    LS.set('tarweeqa.gid', gid);
    const err = e => console.warn(e);
    groupUnsubs.push(S.store.onGroup(gid, g => { S.group = g; if (!g) { S.gid = null; LS.del('tarweeqa.gid'); } scheduleRender(); }, err));
    groupUnsubs.push(S.store.onRestaurants(gid, list => { S.restaurants = list; scheduleRender(); }, err));
    groupUnsubs.push(S.store.onGroupCarts(gid, list => { S.carts = list; scheduleRender(); }, err));
    if (!silent) go('home');
  }

  async function loadPending() {
    // opened from an invite link: show the group name, then let the person join
    const gid = S.pending.gid;
    const un = S.store.onGroup(gid, g => {
      un && un();
      if (!g) { S.pending.missing = true; return render(true); }
      if ((g.memberUids || []).includes(me())) { const cid = S.pending.cid; S.pending = null; setGroup(gid, true); if (cid) go('cart', { id: cid, tab: 'mine' }); else go('home'); return; }
      S.pending.group = g;
      if (S.profile && S.profile.name && !S.pending.joining) { S.pending.joining = true; joinPending(); }   // the link is the invitation: no extra step
      render(true);
    }, () => { S.pending.missing = true; render(true); });
    render(true);
  }
  async function joinPending() {
    const { gid, cid } = S.pending;
    const ok = await guard(S.store.joinGroup(gid, { name: S.profile.name, phone: S.profile.phone, joinedAt: Date.now() }));
    if (ok === null) { if (S.pending) S.pending.joining = false; render(true); return; }
    S.pending = null;
    setGroup(gid, true);
    if (cid) go('cart', { id: cid, tab: 'mine' }); else go('home');
  }

  async function boot() {
    render(true);
    try {
      if (CFG.supabase && CFG.supabase.url) {
        S.store = new SupaStore(CFG);
        await S.store.init();
        S.profile = LS.get('tarweeqa.profile');
        const sp = S.store.person;
        if (sp && sp.name) { S.profile = Object.assign({ instapay: '', wallet: '' }, S.profile || {}, sp.data || {}, { name: sp.name, phone: (S.profile && S.profile.phone) || ('0' + String(sp.phone || '').replace(/^20/, '')) }); LS.set('tarweeqa.profile', S.profile); }
        else if (S.profile && S.profile.name && C.isValidPhone(S.profile.phone || '')) {
          // signed in on this device before the phone registry existed: register the number now, so other devices find this person
          try { await S.store.register(S.profile.phone, S.profile.name, { instapay: S.profile.instapay || '', instapayLink: S.profile.instapayLink || '', wallet: S.profile.wallet || '' }); } catch (e) { console.warn(e); }
        }
      } else if (CFG.firebase) {
        S.store = new CloudStore(CFG);
        await S.store.init();
        S.profile = LS.get('tarweeqa.profile');
      } else {
        S.store = new LocalStore();
        await S.store.init();
        if (!S.store.hasData()) S.store.seed(S.lang);
        S.profile = S.store.profile();
      }
    } catch (e) {
      console.error(e);
      S.fatal = String((e && e.message) || e); S.booted = true; return render(true);
    }
    S.booted = true;
    S.store.onMyGroups(list => { S.groups = list; scheduleRender(); }, e => console.warn(e));

    if (isLocal()) { setGroup('demo-g1', true); return go('cart', { id: 'demo-c1', tab: 'mine' }); }

    let gid = null, cid = null, inv = null;
    try { const q = new URLSearchParams(location.search); gid = q.get('g'); cid = q.get('c'); if (q.get('inv')) inv = { gid, cid, key: q.get('p'), secret: q.get('k') }; } catch (e) { }
    if (inv) return openInvoice(inv);
    if (gid) { S.pending = { gid, cid }; if (S.profile && S.profile.name) loadPending(); else render(true); return; }
    const saved = LS.get('tarweeqa.gid');
    if (saved && S.profile && S.profile.name) { setGroup(saved, true); return go('home'); }
    render(true);
  }

  try {
    if ('serviceWorker' in navigator && location.protocol === 'https:' && window.top === window.self && (CFG.firebase || CFG.supabase)) {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => { reg.update().catch(() => { }); }).catch(() => { });
      // a new version took over: reload once so the screen runs the new code
      const hadController = !!navigator.serviceWorker.controller;   // first visit: no reload needed
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloaded || !hadController) return; reloaded = true; location.reload(); });
    }
  } catch (e) { }

  boot();
})();
