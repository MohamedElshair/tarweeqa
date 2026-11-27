/* ترويقة — التخزين (Storage, v2)
   LocalStore  : demo mode, everything in this browser
   CloudStore  : Firebase (anonymous sign-in + Firestore), shared by the whole group
   Both expose the same methods, so the screens don't care which one runs.

   Data:
     groups/{gid}       { name, ownerId, adminIds[], memberUids[], roster{ key:{name,phone,guest?} }, createdAt }
     groups/{gid}/restaurants/{rid}  { groupId, name, phone, talabatUrl, fees{delivery,service,taxPct,tip}, items[], updatedAt, lastOrderedAt }
     groups/{gid}/carts/{cid}        { groupId, ownerId, ownerName, ownerPhone, stage, closesAt, createdAt, title,
                          candidates[], candidateInfo{}, votes{},               ← voting
                          restaurantId, restaurant{}, menu[], estimate{},      ← chosen restaurant
                          members{ key:{name,phone,status,items[],done,guest?} },
                          charges[], roundUp, payInfo{instapay,wallet}, payments{ key:{amount,method,status,at} } }
*/
(function () {
  'use strict';

  function rid(len) {
    const a = 'abcdefghijkmnpqrstuvwxyz23456789';
    let s = '';
    const n = len || 12;
    const buf = (window.crypto && crypto.getRandomValues) ? crypto.getRandomValues(new Uint8Array(n)) : null;
    for (let i = 0; i < n; i++) s += a[(buf ? buf[i] : Math.floor(Math.random() * 256)) % a.length];
    return s;
  }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function setPath(obj, path, val) {
    const parts = path.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) { if (typeof o[parts[i]] !== 'object' || o[parts[i]] === null) o[parts[i]] = {}; o = o[parts[i]]; }
    if (val === undefined) delete o[parts[parts.length - 1]]; else o[parts[parts.length - 1]] = clone(val);
  }

  const LS = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { } }
  };

  /* ---------------- Demo / local store ---------------- */
  class LocalStore {
    constructor() {
      this.mode = 'local';
      this.key = 'tarweeqa.demo.v4';
      this.data = LS.get(this.key);
      this.subs = new Set();
      try {
        window.addEventListener('storage', e => { if (e.key === this.key) { this.data = LS.get(this.key) || this.data; this.emit(); } });
      } catch (e) { }
    }
    async init() { }
    hasData() { return !!this.data; }
    seed(lang) { this.data = demoSeed(lang); this.persist(); }
    uid() { return this.data ? this.data.actingUid : 'me'; }
    people() { return clone(this.data.people); }
    setActing(uid) { this.data.actingUid = uid; this.persist(); }
    profile() { return clone(this.data.people[this.uid()]); }
    saveProfile(p) { this.data.people[this.uid()] = Object.assign({}, this.data.people[this.uid()], p); this.persist(); }
    persist() { LS.set(this.key, this.data); this.emit(); }
    emit() { for (const f of Array.from(this.subs)) { try { f(); } catch (e) { console.error(e); } } }
    sub(f) { this.subs.add(f); setTimeout(f, 0); return () => this.subs.delete(f); }

    onMyGroups(cb) { return this.sub(() => cb(Object.values(this.data.groups).filter(g => g.memberUids.includes(this.uid()) && !g.deletedAt).map(clone))); }
    async deleteGroup(gid) { const g = this.data.groups[gid]; if (!g) return; g.deletedAt = Date.now(); if (g.schedule) g.schedule.on = false; this.persist(); }
    async restoreGroup(gid) { const g = this.data.groups[gid]; if (g) { delete g.deletedAt; this.persist(); } }
    onGroup(gid, cb) { return this.sub(() => cb(this.data.groups[gid] && !this.data.groups[gid].deletedAt ? clone(this.data.groups[gid]) : null)); }
    async createGroup(g) { const id = rid(); this.data.groups[id] = Object.assign(clone(g), { id }); this.persist(); return id; }
    async joinGroup(gid, entry) {
      const g = this.data.groups[gid]; const me = this.uid();
      g.roster[me] = clone(entry); if (!g.memberUids.includes(me)) g.memberUids.push(me); this.persist();
    }
    async patchGroup(gid, patch) { const g = this.data.groups[gid]; for (const k of Object.keys(patch)) setPath(g, k, patch[k]); this.persist(); }

    onRestaurants(gid, cb) { return this.sub(() => cb(Object.values(this.data.restaurants).filter(r => r.groupId === gid).map(clone))); }
    async saveRestaurant(gid, r) {
      const id = r.id || rid();
      this.data.restaurants[id] = Object.assign({}, this.data.restaurants[id] || {}, clone(r), { id, groupId: gid, updatedAt: Date.now() });
      this.persist(); return id;
    }
    async patchRestaurant(gid, id, patch) { const r = this.data.restaurants[id]; if (!r) return; for (const k of Object.keys(patch)) setPath(r, k, patch[k]); this.persist(); }
    async deleteRestaurant(gid, id) { delete this.data.restaurants[id]; this.persist(); }

    onGroupCarts(gid, cb) { return this.sub(() => cb(Object.values(this.data.carts).filter(c => c.groupId === gid).map(clone))); }
    onCart(gid, id, cb) { return this.sub(() => cb(this.data.carts[id] ? clone(this.data.carts[id]) : null)); }
    async createCart(gid, c) { const id = rid(); this.data.carts[id] = Object.assign(clone(c), { id, groupId: gid }); this.persist(); return id; }
    async setMember(gid, cartId, key, m) { setPath(this.data.carts[cartId], 'members.' + key, m); this.persist(); }
    async setVote(gid, cartId, restId) { setPath(this.data.carts[cartId], 'votes.' + this.uid(), restId); this.persist(); }
    async reportPayment(gid, cartId, p) { setPath(this.data.carts[cartId], 'payments.' + this.uid(), p); this.persist(); }
    async patchCart(gid, cartId, patch) { const c = this.data.carts[cartId]; for (const k of Object.keys(patch)) setPath(c, k, patch[k]); this.persist(); }
    async register(phone, name, data) { this.saveProfile(Object.assign({ name, phone }, data || {})); return { uid: this.uid(), existing: false, person: { name, phone, data } }; }
    async saveProfileRemote() { }
    async priceHistory(gid, restName) { return clone((this.data.prices || {})[restName] || []); }
    async saveReceipt(gid, r) {
      const list = (this.data.receipts = this.data.receipts || []);
      const ex = r.orderNo && list.find(x => x.restName === r.restName && x.orderNo === r.orderNo);
      if (ex) return { id: ex.id, dup: true };
      const sig = x => JSON.stringify([(x.parsed || {}).items, (x.parsed || {}).total]);
      const same = !r.orderNo && list.find(x => x.restName === r.restName && !x.orderNo && sig(x) === sig(r));
      if (same) return { id: same.id, dup: true };
      const id = rid();
      list.push({ id, gid, restName: r.restName, cartId: r.cartId || null, orderNo: r.orderNo || null, at: r.at, parsed: r.parsed, image: !!r.image, ms: Date.now() });
      if (r.image) { try { localStorage.setItem('tarweeqa.rimg.' + id, r.image); } catch (e) { list[list.length - 1].image = false; } }
      const P = (this.data.prices = this.data.prices || {}); const rows = (P[r.restName] = P[r.restName] || []);
      for (const it of (r.parsed && r.parsed.items) || []) {
        if (it.unit == null || it.nameUnsure || (it.unsure && !it.qtyInferred)) continue;
        const i = rows.findIndex(x => x.item === it.name && x.at === r.at); if (i >= 0) rows.splice(i, 1);
        rows.push({ item: it.name, price: it.unit, at: r.at, source: (r.parsed && r.parsed.kind) || 'receipt' });
      }
      rows.sort((a, b) => (a.at || 0) - (b.at || 0));
      this.persist();
      return { id, dup: false };
    }
    async receipts(gid, restName) {
      return (this.data.receipts || []).filter(x => x.gid === gid && x.restName === restName).sort((a, b) => b.at - a.at || b.ms - a.ms)
        .map(x => ({ id: x.id, at: x.at, orderNo: x.orderNo, cartId: x.cartId, ms: x.ms, items: ((x.parsed || {}).items || []).length, total: (x.parsed || {}).total, hasImage: !!x.image, kind: (x.parsed || {}).kind || 'receipt' }));
    }
    async deleteReceipt(gid, id) {
      const list = this.data.receipts || []; const i = list.findIndex(r => r.id === id); if (i < 0) return;
      try { localStorage.removeItem('tarweeqa.rimg.' + id); } catch (e) { }
      list.splice(i, 1); this.persist();
    }
    async receipt(gid, id) { const x = (this.data.receipts || []).find(r => r.id === id); return x ? clone({ id: x.id, at: x.at, orderNo: x.orderNo, cartId: x.cartId, restName: x.restName, parsed: x.parsed, image: x.image ? localStorage.getItem('tarweeqa.rimg.' + x.id) : null }) : null; }
    async invoice(gid, cid, key, secret) {
      const c = this.data.carts[cid];
      if (!c || c.invoiceKey !== secret || !(c.invoices || {})[key]) throw new Error('invoice not found');
      return clone({ invoice: c.invoices[key], payment: (c.payments || {})[key], restaurant: c.restaurant, title: c.title, createdAt: c.createdAt,
        ownerName: c.ownerName, ownerPhone: c.ownerPhone, payInfo: c.payInfo, groupName: this.data.groups[gid] && this.data.groups[gid].name });
    }
  }

  /* ---------------- Firebase store ---------------- */
  class CloudStore {
    constructor(cfg) { this.mode = 'cloud'; this.cfg = cfg; this._uid = null; }
    async init() {
      const v = this.cfg.firebaseSdkVersion || '12.19.0';
      const base = 'https://www.gstatic.com/firebasejs/' + v + '/';
      const [appMod, authMod, fs] = await Promise.all([
        import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-firestore.js')
      ]);
      this.fs = fs;
      this.app = appMod.initializeApp(this.cfg.firebase);
      this.auth = authMod.getAuth(this.app);
      this.db = fs.getFirestore(this.app);
      if (this.auth.authStateReady) await this.auth.authStateReady();
      if (!this.auth.currentUser) await authMod.signInAnonymously(this.auth);
      this._uid = this.auth.currentUser.uid;
    }
    hasData() { return true; }
    uid() { return this._uid; }
    // col is a path: 'groups' or 'groups/<gid>/carts'
    ref(col, id) { return this.fs.doc(this.db, col + '/' + id); }
    coll(col) { return this.fs.collection(this.db, col); }
    list(q, cb, err) { return this.fs.onSnapshot(q, s => cb(s.docs.map(d => Object.assign({ id: d.id }, d.data()))), err); }
    one(col, id, cb, err) { return this.fs.onSnapshot(this.ref(col, id), s => cb(s.exists() ? Object.assign({ id: s.id }, s.data()) : null), err); }
    async add(col, data) { const d = clone(data); delete d.id; const r = await this.fs.addDoc(this.coll(col), d); return r.id; }
    async upd(col, id, patch) {
      const p = {};
      for (const k of Object.keys(patch)) p[k] = patch[k] === undefined ? this.fs.deleteField() : clone(patch[k]);
      await this.fs.updateDoc(this.ref(col, id), p);
    }

    onMyGroups(cb, err) { const { query, where } = this.fs; return this.list(query(this.coll('groups'), where('memberUids', 'array-contains', this._uid)), cb, err); }
    onGroup(gid, cb, err) { return this.one('groups', gid, cb, err); }
    createGroup(g) { return this.add('groups', g); }
    async joinGroup(gid, entry) {
      await this.fs.updateDoc(this.ref('groups', gid), { ['roster.' + this._uid]: clone(entry), memberUids: this.fs.arrayUnion(this._uid) });
    }
    patchGroup(gid, patch) { return this.upd('groups', gid, patch); }

    onRestaurants(gid, cb, err) { return this.list(this.coll('groups/' + gid + '/restaurants'), cb, err); }
    async saveRestaurant(gid, r) {
      const col = 'groups/' + gid + '/restaurants';
      const data = clone(r); delete data.id; data.groupId = gid; data.updatedAt = Date.now();
      if (r.id) { await this.fs.setDoc(this.ref(col, r.id), data); return r.id; }
      return this.add(col, data);
    }
    patchRestaurant(gid, id, patch) { return this.upd('groups/' + gid + '/restaurants', id, patch); }
    deleteRestaurant(gid, id) { return this.fs.deleteDoc(this.ref('groups/' + gid + '/restaurants', id)); }

    onGroupCarts(gid, cb, err) { return this.list(this.coll('groups/' + gid + '/carts'), cb, err); }
    onCart(gid, id, cb, err) { return this.one('groups/' + gid + '/carts', id, cb, err); }
    createCart(gid, c) { return this.add('groups/' + gid + '/carts', Object.assign({}, c, { groupId: gid })); }
    setMember(gid, cartId, key, m) { return this.upd('groups/' + gid + '/carts', cartId, { ['members.' + key]: m }); }
    setVote(gid, cartId, restId) { return this.upd('groups/' + gid + '/carts', cartId, { ['votes.' + this._uid]: restId }); }
    reportPayment(gid, cartId, p) { return this.upd('groups/' + gid + '/carts', cartId, { ['payments.' + this._uid]: p }); }
    patchCart(gid, cartId, patch) { return this.upd('groups/' + gid + '/carts', cartId, patch); }
  }


  /* ---------------- Supabase store (what the live site uses) ----------------
     Each browser keeps a secret device token. Signing in (phone + PIN, tq_login) links that token to the
     person; the database functions (supabase/schema.sql + supabase/migrations) check every read and write against it. Changes arrive by asking the
     database every few seconds for what changed since the last time. */
  class SupaStore {
    constructor(cfg) {
      this.mode = 'cloud';
      this.url = cfg.supabase.url.replace(/\/$/, '');
      this.key = cfg.supabase.anonKey;
      this.token = LS.get('tarweeqa.token');
      if (!this.token) { this.token = rid(40); LS.set('tarweeqa.token', this.token); }
      this.g = new Map();          // gid → cache
      this.groupSubs = new Set();
      this.myGroups = [];
      try {
        document.addEventListener('visibilitychange', () => { if (!document.hidden) for (const gid of this.g.keys()) this.poll(gid); });
      } catch (e) { }
    }
    async rpc(fn, args, noToken) {
      const res = await fetch(this.url + '/rest/v1/rpc/' + fn, {
        method: 'POST',
        headers: { apikey: this.key, Authorization: 'Bearer ' + this.key, 'Content-Type': 'application/json' },
        body: JSON.stringify(noToken ? (args || {}) : Object.assign({ p_token: this.token }, args || {}))
      });
      const text = await res.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
      if (!res.ok) throw new Error((data && data.message) || ('HTTP ' + res.status));
      return data;
    }
    async init() { const r = await this.rpc('tq_hello'); this._uid = r.uid; this.person = r.person || null; }
    hasData() { return true; }
    uid() { return this._uid; }
    /* accounts: phone + PIN. A new number makes an account; a number seen before needs its PIN (tq_login). */
    becomes(uid) { if (uid !== this._uid) { this._uid = uid; this.g.forEach(c => { c.since = 0; c.member = false; }); } }
    async register(phone, name, data, pin) {
      const args = { p_phone: phone, p_name: name, p_data: data || {} };
      if (pin) args.p_pin = pin;
      const r = await this.rpc('tq_register', args);
      this.becomes(r.uid);
      this.person = r.person; await this.refreshGroups();
      return r;
    }
    checkPhone(phone) { return this.rpc('tq_check_phone', { p_phone: phone }); }
    /* returns {error: 'no_account' | 'wrong_pin' | 'locked' | 'no_pin', left?, until?} or the person */
    async login(phone, pin) {
      const r = await this.rpc('tq_login', { p_phone: phone, p_pin: pin });
      if (!r || r.error) return r || { error: 'unknown' };
      this.becomes(r.uid);
      this.person = r.person; await this.refreshGroups();
      return r;
    }
    async setPin(pin, old) {
      const r = await this.rpc('tq_set_pin', { p_pin: pin, p_old: old || null });
      if (r && r.person) this.person = r.person;
      return r;
    }
    /* sign out this device: the old device key is forgotten and a fresh one starts as nobody */
    async logout() {
      try { await this.rpc('tq_logout'); } catch (e) { console.warn(e); }
      this.token = rid(40); LS.set('tarweeqa.token', this.token);
    }
    history() { return this.rpc('tq_my_history'); }
    adminOverview() { return this.rpc('tq_admin_overview'); }
    adminLedger() { return this.rpc('tq_admin_ledger'); }
    adminResetPin(uid) { return this.rpc('tq_admin_reset_pin', { p_uid: uid }); }
    adminSignout(uid) { return this.rpc('tq_admin_signout', { p_uid: uid }); }
    async adminRemoveMember(gid, uid) { await this.after(gid, this.rpc('tq_admin_remove_member', { p_gid: gid, p_uid: uid })); }
    adminRenamePerson(uid, name) { return this.rpc('tq_admin_rename_person', { p_uid: uid, p_name: name }); }
    // a deleted group order is hidden from everyone, but its orders, invoices and money stay (the admin can bring it back)
    async deleteGroup(gid) { await this.rpc('tq_admin_delete_group', { p_gid: gid }); await this.refreshGroups(); }
    async restoreGroup(gid) { await this.rpc('tq_admin_restore_group', { p_gid: gid }); await this.refreshGroups(); }
    saveProfileRemote(name, data) { return this.rpc('tq_save_profile', { p_name: name, p_data: data || {} }); }
    priceHistory(gid, restName) { return this.rpc('tq_price_history', { p_gid: gid, p_rest_name: restName }); }
    saveReceipt(gid, r) { return this.rpc('tq_save_receipt', { p_gid: gid, p_cart_id: r.cartId || null, p_rest_name: r.restName, p_order_no: r.orderNo || '', p_at: r.at, p_parsed: r.parsed, p_image: r.image || null }); }
    receipts(gid, restName) { return this.rpc('tq_receipts_list', { p_gid: gid, p_rest_name: restName }); }
    receipt(gid, id) { return this.rpc('tq_receipt_get', { p_gid: gid, p_id: id }); }
    deleteReceipt(gid, id) { return this.rpc('tq_delete_receipt', { p_gid: gid, p_id: id }); }
    invoice(gid, cid, key, secret) { return this.rpc('tq_invoice', { p_gid: gid, p_cid: cid, p_key: key, p_secret: secret }, true); }
    static nulls(patch) { const o = {}; for (const k of Object.keys(patch)) o[k] = patch[k] === undefined ? null : patch[k]; return o; }

    /* my groups */
    async refreshGroups() {
      try { this.myGroups = await this.rpc('tq_my_groups'); } catch (e) { console.warn(e); }
      for (const f of Array.from(this.groupSubs)) f(clone(this.myGroups));
    }
    onMyGroups(cb) {
      this.groupSubs.add(cb);
      this.refreshGroups();
      const t = setInterval(() => this.refreshGroups(), 60000);
      return () => { this.groupSubs.delete(cb); clearInterval(t); };
    }

    /* one cache + poller per group */
    cache(gid) {
      if (!this.g.has(gid)) this.g.set(gid, { group: undefined, member: false, rest: new Map(), carts: new Map(), since: 0, subs: new Set(), timer: null, busy: false, again: false });
      return this.g.get(gid);
    }
    sub(gid, fn) {
      const c = this.cache(gid);
      c.subs.add(fn);
      if (c.group !== undefined) setTimeout(() => fn(c), 0);
      if (!c.timer) this.loop(gid);
      return () => { c.subs.delete(fn); if (!c.subs.size) { clearTimeout(c.timer); c.timer = null; } };
    }
    loop(gid) {
      const c = this.cache(gid);
      clearTimeout(c.timer);
      this.poll(gid).finally(() => {
        if (!c.subs.size) { c.timer = null; return; }
        let hidden = false; try { hidden = document.hidden; } catch (e) { }
        c.timer = setTimeout(() => this.loop(gid), hidden ? 20000 : 3500);
      });
    }
    async poll(gid) {
      const c = this.cache(gid);
      if (c.busy) { c.again = true; return; }
      c.busy = true;
      try {
        const b = await this.rpc('tq_bundle', { p_gid: gid, p_since: c.since });
        if (b.member && !c.member) c.since = 0;
        const wasMember = c.member;
        c.group = b.group; c.member = !!b.member;
        if (b.member) {
          for (const r of b.restaurants || []) c.rest.set(r.id, spell(r));
          for (const x of b.carts || []) c.carts.set(x.id, spell(x));
          const rIds = new Set(b.restaurantIds || []), cIds = new Set(b.cartIds || []);
          for (const id of Array.from(c.rest.keys())) if (!rIds.has(id)) c.rest.delete(id);
          for (const id of Array.from(c.carts.keys())) if (!cIds.has(id)) c.carts.delete(id);
          const missing = [...rIds].some(id => !c.rest.has(id)) || [...cIds].some(id => !c.carts.has(id));
          const askedAll = c.since === 0;
          c.since = missing ? 0 : Math.max(0, b.now - 3000);
          if (missing && !askedAll) c.again = true;   // something we never saw: fetch everything once
        }
        for (const f of Array.from(c.subs)) { try { f(c); } catch (e) { console.error(e); } }
      } catch (e) {
        console.warn(e);
        for (const f of Array.from(c.subs)) { try { f(c, e); } catch (e2) { } }
      } finally {
        c.busy = false;
        if (c.again) { c.again = false; this.poll(gid); }
      }
    }
    onGroup(gid, cb, err) { return this.sub(gid, (c, e) => { if (e) { if (c.group === undefined && err) err(e); return; } cb(c.group ? clone(c.group) : null); }); }
    onRestaurants(gid, cb) { return this.sub(gid, (c, e) => { if (!e) cb(Array.from(c.rest.values()).map(clone)); }); }
    onGroupCarts(gid, cb) { return this.sub(gid, (c, e) => { if (!e) cb(Array.from(c.carts.values()).map(clone)); }); }
    onCart(gid, id, cb) { return this.sub(gid, (c, e) => { if (!e) cb(c.carts.has(id) ? clone(c.carts.get(id)) : null); }); }
    async after(gid, p) { const r = await p; this.poll(gid); return r; }

    async createGroup(g) { const id = await this.rpc('tq_create_group', { p_data: g }); this.refreshGroups(); return id; }
    async joinGroup(gid, entry) { await this.after(gid, this.rpc('tq_join_group', { p_gid: gid, p_entry: entry })); this.refreshGroups(); }
    patchGroup(gid, patch) { return this.after(gid, this.rpc('tq_patch_group', { p_gid: gid, p_patch: SupaStore.nulls(patch) })); }

    saveRestaurant(gid, r) { return this.after(gid, this.rpc('tq_save_restaurant', { p_gid: gid, p_id: r.id || null, p_data: Object.assign({}, r, { updatedAt: Date.now() }) })); }
    patchRestaurant(gid, id, patch) { return this.after(gid, this.rpc('tq_patch_restaurant', { p_gid: gid, p_id: id, p_patch: SupaStore.nulls(patch) })); }
    deleteRestaurant(gid, id) { return this.after(gid, this.rpc('tq_delete_restaurant', { p_gid: gid, p_id: id })); }

    createCart(gid, c) { return this.after(gid, this.rpc('tq_create_cart', { p_gid: gid, p_data: c })); }
    setMember(gid, cartId, key, m) { return this.after(gid, this.rpc('tq_set_member', { p_gid: gid, p_cid: cartId, p_key: key, p_member: m })); }
    setVote(gid, cartId, restId) { return this.after(gid, this.rpc('tq_vote', { p_gid: gid, p_cid: cartId, p_rid: restId })); }
    reportPayment(gid, cartId, p) { return this.after(gid, this.rpc('tq_report_payment', { p_gid: gid, p_cid: cartId, p_payment: p })); }
    patchCart(gid, cartId, patch) { return this.after(gid, this.rpc('tq_patch_cart', { p_gid: gid, p_cid: cartId, p_patch: SupaStore.nulls(patch) })); }
  }

  /* ---------------- Demo data (fictional places and people) ---------------- */
  function demoSeed(lang) {
    const now = Date.now();
    const ar = lang !== 'en';
    const day = 86400000;
    const N = (a, e) => ar ? a : e;
    const people = {
      me: { name: N('أنت', 'You'), phone: '01000000000', instapay: 'tarweeqa@instapay', wallet: '01000000000' },
      karim: { name: N('كريم', 'Karim'), phone: '01100000001', instapay: 'karim@instapay' },
      mariam: { name: N('مريم', 'Mariam'), phone: '01200000002' },
      youssef: { name: N('يوسف', 'Youssef'), phone: '01500000003' },
      nour: { name: N('نور', 'Nour'), phone: '01300000004' }
    };
    const gid = 'demo-g1';
    const roster = {};
    for (const k of Object.keys(people)) roster[k] = { name: people[k].name, phone: people[k].phone, joinedAt: now - 30 * day };
    roster.g_hany = { name: N('عم هاني (من غير موبايل)', 'Hany (no phone)'), phone: '', guest: true, joinedAt: now - 20 * day };
    const group = { id: gid, name: N('فطار المكتب', 'Office breakfast'), ownerId: 'me', adminIds: ['me'], memberUids: Object.keys(people), roster, createdAt: now - 30 * day };

    const mk = (id, name, fees, list, lastAt) => ({
      id, groupId: gid, name, phone: '', talabatUrl: '', fees, lastOrderedAt: lastAt, updatedAt: now,
      items: list.map((x, i) => ({ id: id + '-' + i, name: x[0], price: x[1], category: x[2] }))
    });
    // real menus read from the group's Talabat receipts (Nov 2026)
    const r1 = mk('demo-r1', N('جاد', 'Gad'), { delivery: 0, servicePct: 5, taxPct: 0, tip: 0 }, [
      ['سندوتش فول اسكندراني', 27, 'فول'], ['سندوتش فول زيت حار', 27, 'فول'], ['سندتش فول ليمون معصر', 27, 'فول'],
      ['سندوتش فول بالحمص', 28, 'فول'], ['سندوتش فول جاد', 18, 'فول'],
      ['سندوتش فلافل سلطه و طحينه', 18, 'فلافل'], ['سندوتش فلافل محشيه', 21, 'فلافل'], ['سندوتش فلافل جبنه كيري', 34, 'فلافل'], ['فلافل حمص', 27, 'فلافل'],
      ['سندوتش بطاطس سلطه و طحينه', 33, 'بطاطس'], ['سندوتش بطاطس كاتشب و مايونيز', 35, 'بطاطس'], ['سندوتش بطاطس بوريه', 25, 'بطاطس'],
      ['سندوتش امليت بالبسطرمه', 56, 'بيض وجبن'], ['جبنة بالطماطم', 24, 'بيض وجبن'], ['سندوتش ديناميت', 47, 'بيض وجبن']], now - 2 * day);
    const r2 = mk('demo-r2', N('مطعم الراعي', 'El Raai'), { delivery: 0, servicePct: 5, taxPct: 0, tip: 0 }, [
      ['سندوتش فول محوج', 19, ''], ['سندوتش طعميه اصلي', 19, ''], ['سندوتش بطاطس صوابع', 39, ''],
      ['سندوتش اومليت بالبسطرمه', 51, ''], ['سندوتش اومليت بالجبنه الرومي', 41, '']], now - 1 * day);
    const r3 = mk('demo-r3', N('الجعان', 'El Gaan'), { delivery: 0, servicePct: 8.3, taxPct: 0, tip: 0 }, [
      ['بطاطس مقلية صوابع مع سلطة وطحينة', 30, ''], ['شيبسي سلطة وطحينة', 24, ''], ['أومليت بسطرمة', 40, ''], ['جبنة بالطماطم', 25.99, '']], now - 4 * day);

    let n = 0;
    const it = (r, idx, qty, note) => ({ id: 'it' + (n++), menuId: r.items[idx].id, name: r.items[idx].name, price: r.items[idx].price, qty, note: note || '' });
    const mem = (k, status, items, done) => ({ name: roster[k].name, phone: roster[k].phone, status, items: items || [], done: !!done, guest: !!roster[k].guest, at: now });
    const snap = r => ({ restaurantId: r.id, restaurant: { name: r.name, phone: r.phone, talabatUrl: r.talabatUrl }, menu: r.items, estimate: r.fees });
    const host = k => ({ ownerId: k, ownerName: people[k].name, ownerPhone: people[k].phone, payInfo: { instapay: people[k].instapay || '', wallet: people[k].wallet || '' } });

    const today = Object.assign({
      id: 'demo-c1', groupId: gid, title: N('فطار النهارده', "Today's breakfast"), stage: 'ordering',
      createdAt: now - 12 * 60000, closesAt: now + 21 * 60000, candidates: [], candidateInfo: {}, votes: {},
      members: {
        me: mem('me', 'in', [it(r1, 0, 1), it(r1, 13, 1)], false),
        karim: mem('karim', 'in', [it(r1, 5, 2, N('عيش شامي', 'shami bread')), it(r1, 10, 1)], true),
        mariam: mem('mariam', 'in', [it(r1, 12, 1, N('شامي', 'shami'))], false),
        youssef: mem('youssef', 'in', [it(r1, 3, 2), { id: 'itc1', name: N('فول بالبيض المسلوق', 'Foul with boiled egg'), price: 0, qty: 1, note: '', custom: true, noPrice: true }], true),
        nour: mem('nour', 'out', [], false)
      },
      charges: [], roundUp: true, payments: {}
    }, snap(r1), host('me'));

    const raai = Object.assign({
      id: 'demo-c0', groupId: gid, title: N('فطار الاتنين', 'Monday breakfast'), stage: 'ordered', receiptAt: now - day + 3600000,
      createdAt: now - 1 * day, closesAt: now - 1 * day + 30 * 60000, candidates: [], candidateInfo: {}, votes: {},
      members: {
        me: mem('me', 'in', [it(r2, 3, 1)], true),
        karim: mem('karim', 'in', [it(r2, 0, 2), it(r2, 1, 1)], true),
        mariam: mem('mariam', 'in', [it(r2, 2, 1, N('كاتشب, مايونيز', 'ketchup, mayo')), it(r2, 0, 1)], true),
        youssef: mem('youssef', 'in', [it(r2, 4, 1), it(r2, 0, 1)], true),
        g_hany: mem('g_hany', 'in', [it(r2, 2, 1, N('كاتشب, مايونيز', 'ketchup, mayo'))], true)
      },
      charges: [
        { id: 'ch1', kind: 'discount', label: N('خصم الكوبون', 'Coupon'), amount: 39.75, split: 'share' },
        { id: 'ch2', kind: 'delivery', label: N('رسوم التوصيل', 'Delivery'), amount: 0, split: 'equal' },
        { id: 'ch3', kind: 'service', label: N('رسوم الخدمة', 'Service fee'), amount: 13.25, split: 'share' }
      ],
      roundUp: true,
      payments: {
        karim: { amount: 55, method: 'instapay', status: 'confirmed', at: now - day + 7200000 },
        mariam: { amount: 50, method: 'cash', status: 'confirmed', at: now - day + 7200000 },
        youssef: { amount: 54, method: 'instapay', status: 'reported', at: now - 3600000 }
      }
    }, snap(r2), host('me'));

    const karimHost = Object.assign({
      id: 'demo-c2', groupId: gid, title: N('فطار الخميس', 'Thursday breakfast'), stage: 'ordered', receiptAt: now - 4 * day,
      createdAt: now - 4 * day, closesAt: now - 4 * day + 30 * 60000, candidates: [], candidateInfo: {}, votes: {},
      members: {
        karim: mem('karim', 'in', [it(r3, 1, 2)], true),
        me: mem('me', 'in', [it(r3, 2, 1), it(r3, 1, 2), it(r3, 3, 1)], true),
        nour: mem('nour', 'in', [it(r3, 0, 1)], true)
      },
      charges: [{ id: 'ch5', kind: 'service', label: N('رسوم الخدمة', 'Service fee'), amount: 16, split: 'share' }],
      roundUp: true,
      payments: { nour: { amount: 33, method: 'cash', status: 'confirmed', at: now - 4 * day } }
    }, snap(r3), host('karim'));

    const old = Object.assign({
      id: 'demo-c3', groupId: gid, title: N('فطار الأحد', 'Sunday breakfast'), stage: 'settled', receiptAt: now - 6 * day,
      createdAt: now - 6 * day, closesAt: now - 6 * day + 30 * 60000, candidates: [], candidateInfo: {}, votes: {},
      members: {
        me: mem('me', 'in', [it(r1, 0, 1), it(r1, 13, 1)], true),
        mariam: mem('mariam', 'in', [it(r1, 6, 1), it(r1, 9, 1)], true),
        youssef: mem('youssef', 'in', [it(r1, 7, 2)], true)
      },
      charges: [{ id: 'ch6', kind: 'service', label: N('رسوم الخدمة', 'Service fee'), amount: 9.5, split: 'share' }],
      roundUp: true,
      payments: {
        mariam: { amount: 60, method: 'cash', status: 'confirmed', at: now - 6 * day },
        youssef: { amount: 72, method: 'instapay', status: 'confirmed', at: now - 6 * day }
      }
    }, snap(r1), host('me'));

    // price history read from the group's receipts (the falafel went from 17 to 18)
    const day0 = 1795419240000;
    const hist = r => r.items.map(i => ({ item: i.name, price: i.price, at: r.id === 'demo-r2' ? 1795506600000 : day0, source: 'receipt' }));
    const prices = { [r1.name]: [{ item: 'سندوتش فلافل سلطه و طحينه', price: 17, at: null, source: 'receipt' }].concat(hist(r1)), [r2.name]: hist(r2), [r3.name]: hist(r3) };
    prices[r1.name].push({ item: 'سندوتش فول اسكندراني', price: 28, at: now - 3600000, source: 'menu' });
    r1.items[0].price = 28; today.menu = r1.items;

    return {
      prices,
      actingUid: 'me', people,
      groups: { [gid]: group },
      restaurants: { [r1.id]: r1, [r2.id]: r2, [r3.id]: r3 },
      carts: { [today.id]: today, [raai.id]: raai, [karimHost.id]: karimHost, [old.id]: old }
    };
  }


  /* every item name goes through the spelling fixes (core.js fixSpelling) before it is saved */
  const spell = d => (window.TarweeqaCore && window.TarweeqaCore.spellData) ? window.TarweeqaCore.spellData(d) : d;
  for (const K of [LocalStore, CloudStore, SupaStore]) {
    const P = K.prototype;
    for (const [fn, at] of [['saveRestaurant', 1], ['patchRestaurant', 2], ['createCart', 1], ['patchCart', 2]]) {
      if (typeof P[fn] !== 'function') continue;
      const orig = P[fn];
      P[fn] = function (...a) { a[at] = spell(a[at]); return orig.apply(this, a); };
    }
    if (typeof P.setMember === 'function') {
      const orig = P.setMember;
      P.setMember = function (gid, cartId, key, m) { return orig.call(this, gid, cartId, key, spell({ members: { x: m } }).members.x); };
    }
  }
  window.TarweeqaStore = { LocalStore, CloudStore, SupaStore, rid, LS, clone };
})();
