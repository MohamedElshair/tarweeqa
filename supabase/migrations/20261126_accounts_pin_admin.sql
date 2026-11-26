-- Tarweeqa — accounts with a PIN, sign-in on any device, profile history, and a site admin page.
-- (migration accounts_pin_admin, 2026-11-26)
--
-- * The phone number alone no longer opens an account: a number seen before needs its PIN (4–6 digits).
--   5 wrong tries lock that number for 15 minutes.
-- * One person can be signed in on several devices (tq_people: device token → person).
-- * Forgotten PIN: the site admin issues a one-time 6-digit code (valid 24h); signing in with it asks for a new PIN.
-- * Site admin (tq_persons.is_site_admin): passes every group's admin checks, is the only one who can create
--   groups or change who is a group admin, and has the admin page functions (tq_admin_*).

alter table tq_persons
  add column if not exists pin_hash text,
  add column if not exists pin_set_at bigint,
  add column if not exists must_set_pin boolean not null default false,
  add column if not exists fails int not null default 0,
  add column if not exists locked_until bigint not null default 0,
  add column if not exists reset_hash text,
  add column if not exists reset_until bigint,
  add column if not exists is_site_admin boolean not null default false,
  add column if not exists last_seen bigint;

-- the person who built the app is the site admin (owner of the first group)
update tq_persons set is_site_admin = true
where uid in (select data->>'ownerId' from tq_groups order by ms limit 1);

create or replace function tq_site_admin(p_uid text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_site_admin from tq_persons where uid = p_uid), false) $$;

create or replace function tq_pin_ok(p_pin text) returns boolean
language sql immutable as $$ select coalesce(p_pin, '') ~ '^[0-9]{4,6}$' $$;

create or replace function tq_person_json(p_uid text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('uid', uid, 'phone', phone, 'name', name, 'data', data,
    'hasPin', pin_hash is not null, 'mustSetPin', must_set_pin, 'isAdmin', is_site_admin)
  from tq_persons where uid = p_uid $$;

create or replace function tq_hello(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token);
begin
  update tq_persons set last_seen = tq_now() where uid = u;
  return jsonb_build_object('uid', u, 'now', tq_now(), 'person', tq_person_json(u));
end $$;

-- new account (or update of the signed-in one). A number that belongs to someone else must sign in instead.
drop function if exists tq_register(text, text, text, jsonb);
create or replace function tq_register(p_token text, p_phone text, p_name text, p_data jsonb default '{}'::jsonb, p_pin text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare u text := tq_me(p_token); ph text := tq_norm_phone(p_phone); existing text; mine tq_persons;
begin
  if length(ph) < 10 then raise exception 'bad phone'; end if;
  if p_pin is not null and not tq_pin_ok(p_pin) then raise exception 'bad pin'; end if;
  select uid into existing from tq_persons where phone = ph;
  if existing is not null and existing <> u then raise exception 'phone taken'; end if;
  select * into mine from tq_persons where uid = u;
  if mine.uid is null then
    if coalesce(nullif(trim(p_name), ''), '') = '' then raise exception 'name required'; end if;
    insert into tq_persons(uid, phone, name, data, ms, pin_hash, pin_set_at, last_seen)
    values (u, ph, trim(p_name), coalesce(p_data, '{}'::jsonb), tq_now(),
            case when p_pin is null then null else crypt(p_pin, gen_salt('bf', 8)) end,
            case when p_pin is null then null else tq_now() end, tq_now());
  else
    update tq_persons set name = coalesce(nullif(trim(p_name), ''), name), data = data || coalesce(p_data, '{}'::jsonb), ms = tq_now(),
      pin_hash = case when pin_hash is null and p_pin is not null then crypt(p_pin, gen_salt('bf', 8)) else pin_hash end,
      pin_set_at = case when pin_hash is null and p_pin is not null then tq_now() else pin_set_at end
    where uid = u;
  end if;
  return jsonb_build_object('uid', u, 'existing', mine.uid is not null, 'person', tq_person_json(u));
end $$;

-- sign in with phone + PIN (or a reset code). Errors come back as {error}, so the failed-try counter is kept.
create or replace function tq_login(p_token text, p_phone text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare ph text := tq_norm_phone(p_phone); p tq_persons; now_ms bigint := tq_now(); ok boolean := false; viacode boolean := false;
begin
  if p_token is null or length(p_token) < 24 then raise exception 'bad token'; end if;
  select * into p from tq_persons where phone = ph for update;
  if p.uid is null then return jsonb_build_object('error', 'no_account'); end if;
  if p.locked_until > now_ms then return jsonb_build_object('error', 'locked', 'until', p.locked_until); end if;
  if p.pin_hash is null and (p.reset_hash is null or p.reset_until < now_ms) then return jsonb_build_object('error', 'no_pin'); end if;
  if p.pin_hash is not null and crypt(coalesce(p_pin, ''), p.pin_hash) = p.pin_hash then ok := true;
  elsif p.reset_hash is not null and p.reset_until >= now_ms and crypt(coalesce(p_pin, ''), p.reset_hash) = p.reset_hash then ok := true; viacode := true;
  end if;
  if not ok then
    if p.fails + 1 >= 5 then
      update tq_persons set fails = 0, locked_until = now_ms + 15 * 60000 where uid = p.uid;
      return jsonb_build_object('error', 'locked', 'until', now_ms + 15 * 60000);
    end if;
    update tq_persons set fails = p.fails + 1 where uid = p.uid;
    return jsonb_build_object('error', 'wrong_pin', 'left', 5 - (p.fails + 1));
  end if;
  update tq_persons set fails = 0, locked_until = 0, last_seen = now_ms,
    reset_hash = case when viacode then null else reset_hash end,
    reset_until = case when viacode then null else reset_until end,
    must_set_pin = case when viacode then true else must_set_pin end
  where uid = p.uid;
  insert into tq_people(token_hash, uid) values (tq_hash(p_token), p.uid)
  on conflict (token_hash) do update set uid = excluded.uid;
  return jsonb_build_object('uid', p.uid, 'person', tq_person_json(p.uid));
end $$;

-- set or change the PIN of the signed-in person (the old PIN is needed unless one was never set or a reset code was used)
create or replace function tq_set_pin(p_token text, p_pin text, p_old text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u text := tq_me(p_token); p tq_persons;
begin
  select * into p from tq_persons where uid = u for update;
  if p.uid is null then raise exception 'no account'; end if;
  if not tq_pin_ok(p_pin) then raise exception 'bad pin'; end if;
  if p.pin_hash is not null and not p.must_set_pin and crypt(coalesce(p_old, ''), p.pin_hash) <> p.pin_hash then
    return jsonb_build_object('error', 'wrong_pin');
  end if;
  update tq_persons set pin_hash = crypt(p_pin, gen_salt('bf', 8)), pin_set_at = tq_now(), must_set_pin = false, fails = 0 where uid = u;
  return jsonb_build_object('person', tq_person_json(u));
end $$;

-- sign out this device only
create or replace function tq_logout(p_token text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_token is null or length(p_token) < 24 then return; end if;
  delete from tq_people where token_hash = tq_hash(p_token);
end $$;

-- every order this person was in (also the ones the host entered for them as a guest with the same phone)
create or replace function tq_my_history(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); ph text;
begin
  select phone into ph from tq_persons where uid = u;
  return coalesce((
    with keys as (
      select g.id gid, u k from tq_groups g where g.data->'memberUids' ? u
      union
      select g.id, r.key from tq_groups g, jsonb_each(coalesce(g.data->'roster', '{}'::jsonb)) r(key, val)
      where ph is not null and r.key <> u and coalesce((r.val->>'guest')::boolean, false) and tq_norm_phone(r.val->>'phone') = ph
    )
    select jsonb_agg(jsonb_build_object(
      'gid', c.group_id, 'groupName', g.data->'name', 'cid', c.id, 'key', k.k,
      'createdAt', c.data->'createdAt', 'closesAt', c.data->'closesAt', 'stage', c.data->'stage',
      'restaurant', coalesce(c.data->'restaurant'->'name', to_jsonb(''::text)), 'title', c.data->'title',
      'ownerName', c.data->'ownerName', 'ownerPhone', c.data->'ownerPhone', 'payInfo', c.data->'payInfo',
      'member', c.data->'members'->k.k, 'invoice', c.data->'invoices'->k.k, 'payment', c.data->'payments'->k.k,
      'invoiceKey', case when c.data->'invoices' ? k.k then c.data->'invoiceKey' else null end
    ) order by (c.data->>'createdAt')::bigint desc nulls last)
    from keys k join tq_carts c on c.group_id = k.gid join tq_groups g on g.id = k.gid
    where coalesce(c.data->'members', '{}'::jsonb) ? k.k or coalesce(c.data->'invoices', '{}'::jsonb) ? k.k or coalesce(c.data->'payments', '{}'::jsonb) ? k.k
  ), '[]'::jsonb);
end $$;

-- group rules: the site admin passes every check ---------------------------------
create or replace function tq_group_for(p_gid text, p_uid text, p_admin boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g jsonb; sa boolean := tq_site_admin(p_uid);
begin
  select data into g from tq_groups where id = p_gid;
  if g is null then raise exception 'no group'; end if;
  if not sa and not (g->'memberUids' ? p_uid) then raise exception 'not a member'; end if;
  if p_admin and not sa and not (g->'adminIds' ? p_uid) then raise exception 'not an admin'; end if;
  return g;
end $$;

create or replace function tq_cart_for(p_gid text, p_cid text, p_uid text, out cart jsonb, out host boolean)
language plpgsql security definer set search_path = public as $$
declare g jsonb;
begin
  g := tq_group_for(p_gid, p_uid);
  select data into cart from tq_carts where id = p_cid and group_id = p_gid for update;
  if cart is null then raise exception 'no order'; end if;
  host := (cart->>'ownerId') = p_uid or (g->'adminIds' ? p_uid) or tq_site_admin(p_uid);
end $$;

create or replace function tq_bundle(p_token text, p_gid text, p_since bigint default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); g jsonb; member boolean; now_ms bigint := tq_now();
begin
  select data || jsonb_build_object('id', id) into g from tq_groups where id = p_gid;
  if g is null then return jsonb_build_object('group', null, 'now', now_ms); end if;
  member := (g->'memberUids' ? u) or tq_site_admin(u);
  if not member then
    return jsonb_build_object('group', jsonb_build_object('id', p_gid, 'name', g->'name', 'memberUids', g->'memberUids'), 'member', false, 'now', now_ms);
  end if;
  return jsonb_build_object(
    'group', g, 'member', true, 'now', now_ms, 'uid', u,
    'restaurants', coalesce((select jsonb_agg(data || jsonb_build_object('id', id)) from tq_restaurants where group_id = p_gid and not deleted and ms > coalesce(p_since, 0)), '[]'::jsonb),
    'restaurantIds', coalesce((select jsonb_agg(id) from tq_restaurants where group_id = p_gid and not deleted), '[]'::jsonb),
    'carts', coalesce((select jsonb_agg(data || jsonb_build_object('id', id)) from tq_carts where group_id = p_gid and ms > coalesce(p_since, 0)), '[]'::jsonb),
    'cartIds', coalesce((select jsonb_agg(id) from tq_carts where group_id = p_gid), '[]'::jsonb)
  );
end $$;

create or replace function tq_my_groups(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); sa boolean := tq_site_admin(u);
begin
  return coalesce((select jsonb_agg(data || jsonb_build_object('id', id) order by ms) from tq_groups where sa or data->'memberUids' ? u), '[]'::jsonb);
end $$;

-- only the site admin creates groups
create or replace function tq_create_group(p_token text, p_data jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); gid text := tq_new_id(); d jsonb;
begin
  if not tq_site_admin(u) then raise exception 'admins only'; end if;
  d := coalesce(p_data, '{}'::jsonb) - 'id'
       || jsonb_build_object('ownerId', u, 'adminIds', jsonb_build_array(u), 'memberUids', jsonb_build_array(u),
                             'roster', jsonb_build_object(u, coalesce(p_data->'roster'->u, '{}'::jsonb)));
  insert into tq_groups(id, data, ms) values (gid, d, tq_now());
  perform tq_seed_group(gid);
  return gid;
end $$;

-- only the site admin changes who is an admin or a member
create or replace function tq_patch_group(p_token text, p_gid text, p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); g jsonb; owner text;
begin
  g := tq_group_for(p_gid, u, true);
  owner := g->>'ownerId';
  if not tq_site_admin(u) and exists (select 1 from jsonb_object_keys(p_patch) k where k ~ '^(adminIds|memberUids|ownerId)') then raise exception 'only the site admin manages admins'; end if;
  g := tq_apply(g, p_patch - 'ownerId' - 'id');
  if not (g->'adminIds' ? owner) then g := jsonb_set(g, '{adminIds}', coalesce(g->'adminIds', '[]'::jsonb) || to_jsonb(owner)); end if;
  update tq_groups set data = g, ms = tq_now() where id = p_gid;
end $$;

-- admin page ---------------------------------------------------------------------
create or replace function tq_admin_me(p_token text) returns text
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token);
begin
  if not tq_site_admin(u) then raise exception 'admins only'; end if;
  return u;
end $$;

create or replace function tq_admin_overview(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u text := tq_admin_me(p_token); now_ms bigint := tq_now();
begin
  return jsonb_build_object(
    'now', now_ms,
    'people', coalesce((select jsonb_agg(jsonb_build_object(
        'uid', p.uid, 'name', p.name, 'phone', p.phone, 'hasPin', p.pin_hash is not null, 'isAdmin', p.is_site_admin,
        'locked', p.locked_until > now_ms, 'resetPending', p.reset_hash is not null and p.reset_until >= now_ms,
        'lastSeen', p.last_seen, 'joined', p.ms,
        'devices', (select count(*) from tq_people d where d.uid = p.uid),
        'groups', coalesce((select jsonb_agg(g.id) from tq_groups g where g.data->'memberUids' ? p.uid), '[]'::jsonb)
      ) order by p.name) from tq_persons p), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(jsonb_build_object(
        'id', g.id, 'name', g.data->'name', 'ownerId', g.data->'ownerId', 'memberUids', g.data->'memberUids', 'roster', g.data->'roster',
        'restaurants', (select count(*) from tq_restaurants r where r.group_id = g.id and not r.deleted),
        'carts', (select count(*) from tq_carts c where c.group_id = g.id),
        'lastOrder', (select max((c.data->>'createdAt')::bigint) from tq_carts c where c.group_id = g.id)
      ) order by g.ms) from tq_groups g), '[]'::jsonb),
    'dues', coalesce((select jsonb_agg(jsonb_build_object(
        'gid', c.group_id, 'cid', c.id, 'key', i.key, 'name', i.val->'name', 'phone', i.val->'phone',
        'restaurant', c.data->'restaurant'->'name', 'createdAt', c.data->'createdAt', 'ownerId', c.data->'ownerId',
        'net', i.val->'net', 'self', i.val->'self', 'sentAt', i.val->'sentAt', 'payment', c.data->'payments'->i.key
      ) order by (c.data->>'createdAt')::bigint desc) from tq_carts c, jsonb_each(coalesce(c.data->'invoices', '{}'::jsonb)) i(key, val)), '[]'::jsonb),
    'catalog', (select count(*) from tq_catalog)
  );
end $$;

-- forgotten PIN / locked out: a one-time 6-digit code, valid 24 hours
create or replace function tq_admin_reset_pin(p_token text, p_uid text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u text := tq_admin_me(p_token); code text := lpad((floor(random() * 1000000))::int::text, 6, '0'); p tq_persons;
begin
  select * into p from tq_persons where uid = p_uid for update;
  if p.uid is null then raise exception 'no account'; end if;
  update tq_persons set reset_hash = crypt(code, gen_salt('bf', 8)), reset_until = tq_now() + 24 * 3600000, fails = 0, locked_until = 0 where uid = p_uid;
  return jsonb_build_object('code', code, 'name', p.name, 'phone', p.phone, 'until', tq_now() + 24 * 3600000);
end $$;

-- sign a person out of every device
create or replace function tq_admin_signout(p_token text, p_uid text) returns void
language plpgsql security definer set search_path = public as $$
declare u text := tq_admin_me(p_token);
begin
  if p_uid = u then raise exception 'not yourself'; end if;
  delete from tq_people where uid = p_uid;
end $$;

-- take a person out of a group (their past orders stay)
create or replace function tq_admin_remove_member(p_token text, p_gid text, p_uid text) returns void
language plpgsql security definer set search_path = public as $$
declare u text := tq_admin_me(p_token); g jsonb;
begin
  select data into g from tq_groups where id = p_gid for update;
  if g is null then raise exception 'no group'; end if;
  if g->>'ownerId' = p_uid then raise exception 'not the owner'; end if;
  g := jsonb_set(g, '{memberUids}', coalesce((select jsonb_agg(x) from jsonb_array_elements(g->'memberUids') x where x <> to_jsonb(p_uid)), '[]'::jsonb));
  g := jsonb_set(g, '{adminIds}', coalesce((select jsonb_agg(x) from jsonb_array_elements(coalesce(g->'adminIds', '[]'::jsonb)) x where x <> to_jsonb(p_uid)), '[]'::jsonb));
  g := jsonb_set(g, '{roster}', coalesce(g->'roster', '{}'::jsonb) - p_uid);
  update tq_groups set data = g, ms = tq_now() where id = p_gid;
end $$;

create or replace function tq_admin_rename_person(p_token text, p_uid text, p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare u text := tq_admin_me(p_token);
begin
  if coalesce(trim(p_name), '') = '' then raise exception 'name required'; end if;
  update tq_persons set name = trim(p_name), ms = tq_now() where uid = p_uid;
end $$;

-- grants: only the app's functions are callable -------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  tq_hello(text), tq_my_groups(text), tq_bundle(text, text, bigint),
  tq_create_group(text, jsonb), tq_join_group(text, text, jsonb), tq_patch_group(text, text, jsonb),
  tq_save_restaurant(text, text, text, jsonb), tq_patch_restaurant(text, text, text, jsonb), tq_delete_restaurant(text, text, text),
  tq_create_cart(text, text, jsonb), tq_set_member(text, text, text, text, jsonb), tq_vote(text, text, text, text),
  tq_report_payment(text, text, text, jsonb), tq_patch_cart(text, text, text, jsonb),
  tq_register(text, text, text, jsonb, text), tq_save_profile(text, text, jsonb),
  tq_price_history(text, text, text), tq_save_receipt(text, text, text, text, text, bigint, jsonb, text),
  tq_receipts_list(text, text, text), tq_receipt_get(text, text, text), tq_invoice(text, text, text, text),
  tq_login(text, text, text), tq_set_pin(text, text, text), tq_logout(text), tq_my_history(text),
  tq_admin_overview(text), tq_admin_reset_pin(text, text), tq_admin_signout(text, text),
  tq_admin_remove_member(text, text, text), tq_admin_rename_person(text, text, text)
to anon, authenticated;
