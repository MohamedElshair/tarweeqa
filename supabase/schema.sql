-- Tarweeqa — database (Supabase / Postgres)
-- Every read and write goes through the functions below; the tables themselves are closed to the public.
-- Each browser has a secret device token; the database maps it to a person id (uid).
-- The rules are the same as the app's: members see their group, each person edits only their own order
-- while it's open, votes only for themselves, only reports payments; the host or an admin controls the rest.

create extension if not exists pgcrypto with schema extensions;

create table if not exists tq_people (
  token_hash text primary key,
  uid text not null unique,
  created_at timestamptz not null default now()
);
create table if not exists tq_groups (
  id text primary key,
  data jsonb not null,
  ms bigint not null
);
create table if not exists tq_restaurants (
  id text primary key,
  group_id text not null references tq_groups(id) on delete cascade,
  data jsonb not null,
  ms bigint not null,
  deleted boolean not null default false
);
create table if not exists tq_carts (
  id text primary key,
  group_id text not null references tq_groups(id) on delete cascade,
  data jsonb not null,
  ms bigint not null
);
create index if not exists tq_restaurants_group on tq_restaurants(group_id, ms);
create index if not exists tq_carts_group on tq_carts(group_id, ms);

alter table tq_people enable row level security;
alter table tq_groups enable row level security;
alter table tq_restaurants enable row level security;
alter table tq_carts enable row level security;
revoke all on tq_people, tq_groups, tq_restaurants, tq_carts from anon, authenticated;

-- helpers -------------------------------------------------------------------
create or replace function tq_now() returns bigint language sql volatile as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint
$$;

create or replace function tq_new_id() returns text language sql volatile set search_path = public, extensions as $$
  select substr(encode(gen_random_bytes(12), 'hex'), 1, 20)
$$;

create or replace function tq_me(p_token text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare h text; u text;
begin
  if p_token is null or length(p_token) < 24 then raise exception 'bad token'; end if;
  h := encode(digest(p_token, 'sha256'), 'hex');
  select uid into u from tq_people where token_hash = h;
  if u is null then
    u := 'u' || tq_new_id();
    insert into tq_people(token_hash, uid) values (h, u);
  end if;
  return u;
end $$;

-- apply {"a.b.c": value} patches; a JSON null deletes that key
create or replace function tq_apply(p_data jsonb, p_patch jsonb) returns jsonb
language plpgsql immutable as $$
declare k text; v jsonb; path text[]; i int; d jsonb := coalesce(p_data, '{}'::jsonb);
begin
  for k, v in select * from jsonb_each(coalesce(p_patch, '{}'::jsonb)) loop
    path := string_to_array(k, '.');
    if v = 'null'::jsonb then
      d := d #- path;
    else
      for i in 1 .. array_length(path, 1) - 1 loop
        if jsonb_typeof(d #> path[1:i]) is distinct from 'object' then
          d := jsonb_set(d, path[1:i], '{}'::jsonb, true);
        end if;
      end loop;
      d := jsonb_set(d, path, v, true);
    end if;
  end loop;
  return d;
end $$;

create or replace function tq_group_for(p_gid text, p_uid text, p_admin boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g jsonb;
begin
  select data into g from tq_groups where id = p_gid;
  if g is null then raise exception 'no group'; end if;
  if not (g->'memberUids' ? p_uid) then raise exception 'not a member'; end if;
  if p_admin and not (g->'adminIds' ? p_uid) then raise exception 'not an admin'; end if;
  return g;
end $$;

-- reading -------------------------------------------------------------------
create or replace function tq_hello(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return jsonb_build_object('uid', tq_me(p_token), 'now', tq_now());
end $$;

create or replace function tq_my_groups(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token);
begin
  return coalesce((select jsonb_agg(data || jsonb_build_object('id', id)) from tq_groups where data->'memberUids' ? u), '[]'::jsonb);
end $$;

-- everything a group screen needs; only rows changed since p_since (ms), plus the ids that still exist
create or replace function tq_bundle(p_token text, p_gid text, p_since bigint default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); g jsonb; member boolean; now_ms bigint := tq_now();
begin
  select data || jsonb_build_object('id', id) into g from tq_groups where id = p_gid;
  if g is null then return jsonb_build_object('group', null, 'now', now_ms); end if;
  member := g->'memberUids' ? u;
  if not member then
    -- enough to show the invite screen
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

-- groups --------------------------------------------------------------------
create or replace function tq_create_group(p_token text, p_data jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); gid text := tq_new_id(); d jsonb;
begin
  d := coalesce(p_data, '{}'::jsonb) - 'id'
       || jsonb_build_object('ownerId', u, 'adminIds', jsonb_build_array(u), 'memberUids', jsonb_build_array(u),
                             'roster', jsonb_build_object(u, coalesce(p_data->'roster'->u, '{}'::jsonb)));
  insert into tq_groups(id, data, ms) values (gid, d, tq_now());
  return gid;
end $$;

create or replace function tq_join_group(p_token text, p_gid text, p_entry jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); g jsonb;
begin
  select data into g from tq_groups where id = p_gid for update;
  if g is null then raise exception 'no group'; end if;
  g := jsonb_set(g, array['roster', u], coalesce(p_entry, '{}'::jsonb), true);
  if not (g->'memberUids' ? u) then g := jsonb_set(g, '{memberUids}', (g->'memberUids') || to_jsonb(u)); end if;
  update tq_groups set data = g, ms = tq_now() where id = p_gid;
end $$;

create or replace function tq_patch_group(p_token text, p_gid text, p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); g jsonb; owner text;
begin
  g := tq_group_for(p_gid, u, true);
  owner := g->>'ownerId';
  g := tq_apply(g, p_patch - 'ownerId' - 'id');
  if not (g->'adminIds' ? owner) then g := jsonb_set(g, '{adminIds}', coalesce(g->'adminIds', '[]'::jsonb) || to_jsonb(owner)); end if;
  update tq_groups set data = g, ms = tq_now() where id = p_gid;
end $$;

-- restaurants (shared by the whole group) -----------------------------------
create or replace function tq_save_restaurant(p_token text, p_gid text, p_id text, p_data jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); rid text := coalesce(nullif(p_id, ''), tq_new_id());
begin
  perform tq_group_for(p_gid, u);
  insert into tq_restaurants(id, group_id, data, ms) values (rid, p_gid, (p_data - 'id') || jsonb_build_object('groupId', p_gid), tq_now())
  on conflict (id) do update set data = excluded.data, ms = excluded.ms, deleted = false
    where tq_restaurants.group_id = p_gid;
  return rid;
end $$;

create or replace function tq_patch_restaurant(p_token text, p_gid text, p_id text, p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token);
begin
  perform tq_group_for(p_gid, u);
  update tq_restaurants set data = tq_apply(data, p_patch - 'groupId'), ms = tq_now() where id = p_id and group_id = p_gid;
end $$;

create or replace function tq_delete_restaurant(p_token text, p_gid text, p_id text) returns void
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token);
begin
  perform tq_group_for(p_gid, u);
  update tq_restaurants set deleted = true, ms = tq_now() where id = p_id and group_id = p_gid;
end $$;

-- orders --------------------------------------------------------------------
create or replace function tq_create_cart(p_token text, p_gid text, p_data jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); cid text := tq_new_id();
begin
  perform tq_group_for(p_gid, u);
  insert into tq_carts(id, group_id, data, ms)
  values (cid, p_gid, (p_data - 'id') || jsonb_build_object('groupId', p_gid, 'ownerId', u), tq_now());
  return cid;
end $$;

-- the cart row, locked, plus whether this person may control it
create or replace function tq_cart_for(p_gid text, p_cid text, p_uid text, out cart jsonb, out host boolean)
language plpgsql security definer set search_path = public as $$
declare g jsonb;
begin
  g := tq_group_for(p_gid, p_uid);
  select data into cart from tq_carts where id = p_cid and group_id = p_gid for update;
  if cart is null then raise exception 'no order'; end if;
  host := (cart->>'ownerId') = p_uid or (g->'adminIds' ? p_uid);
end $$;

create or replace function tq_set_member(p_token text, p_gid text, p_cid text, p_key text, p_member jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); c jsonb; h boolean;
begin
  select cart, host into c, h from tq_cart_for(p_gid, p_cid, u);
  if not h then
    if p_key <> u then raise exception 'only your own order'; end if;
    if c->>'stage' <> 'ordering' or tq_now() >= (c->>'closesAt')::bigint then raise exception 'order is closed'; end if;
  end if;
  update tq_carts set data = tq_apply(c, jsonb_build_object('members.' || p_key, p_member)), ms = tq_now() where id = p_cid;
end $$;

create or replace function tq_vote(p_token text, p_gid text, p_cid text, p_rid text) returns void
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); c jsonb; h boolean;
begin
  select cart, host into c, h from tq_cart_for(p_gid, p_cid, u);
  if c->>'stage' <> 'voting' then raise exception 'voting is over'; end if;
  update tq_carts set data = tq_apply(c, jsonb_build_object('votes.' || u, to_jsonb(p_rid))), ms = tq_now() where id = p_cid;
end $$;

create or replace function tq_report_payment(p_token text, p_gid text, p_cid text, p_payment jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); c jsonb; h boolean;
begin
  select cart, host into c, h from tq_cart_for(p_gid, p_cid, u);
  if c->>'stage' not in ('ordered', 'settled') then raise exception 'not ordered yet'; end if;
  if p_payment->>'status' <> 'reported' and not h then raise exception 'you can only report a payment'; end if;
  update tq_carts set data = tq_apply(c, jsonb_build_object('payments.' || u, p_payment)), ms = tq_now() where id = p_cid;
end $$;

create or replace function tq_patch_cart(p_token text, p_gid text, p_cid text, p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); c jsonb; h boolean;
begin
  select cart, host into c, h from tq_cart_for(p_gid, p_cid, u);
  if not h then raise exception 'only the host can change this'; end if;
  update tq_carts set data = tq_apply(c, p_patch - 'ownerId' - 'groupId' - 'id'), ms = tq_now() where id = p_cid;
end $$;

-- only the public functions are callable from the app
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  tq_hello(text), tq_my_groups(text), tq_bundle(text, text, bigint),
  tq_create_group(text, jsonb), tq_join_group(text, text, jsonb), tq_patch_group(text, text, jsonb),
  tq_save_restaurant(text, text, text, jsonb), tq_patch_restaurant(text, text, text, jsonb), tq_delete_restaurant(text, text, text),
  tq_create_cart(text, text, jsonb), tq_set_member(text, text, text, text, jsonb), tq_vote(text, text, text, text),
  tq_report_payment(text, text, text, jsonb), tq_patch_cart(text, text, text, jsonb)
to anon, authenticated;

-- ===== Shared catalog (added later) =====
-- Every menu learned from receipts, in any group, is kept here, and every new group starts with all of it.
-- The live database also replaces tq_create_group / tq_save_restaurant / tq_patch_restaurant so they seed and learn:
--   tq_create_group  → after creating the group: perform tq_seed_group(gid)
--   tq_save_restaurant, tq_patch_restaurant → after saving: perform tq_learn(<restaurant data>)
create table if not exists tq_catalog (name_key text primary key, data jsonb not null, ms bigint not null);
alter table tq_catalog enable row level security;
revoke all on tq_catalog from anon, authenticated;
create or replace function tq_name_key(p text) returns text language sql immutable as $$
  select regexp_replace(translate(lower(coalesce(p, '')), 'أإآةى', 'اااهي'), '[^[:alnum:]؀-ۿ]+', '', 'g') $$;
-- tq_learn(p_data jsonb): upsert {name, phone, talabatUrl, fees, items} by name_key (newest prices win)
-- tq_seed_group(p_gid text): copy every catalog restaurant the group doesn't have yet

-- ---------------------------------------------------------------------------
-- Saved receipts (migration saved_receipts_latest_price, 2026-11-25)
--   tq_receipts: every uploaded receipt / menu screenshot, with a light JPEG and the parsed lines.
--   tq_save_receipt(token, gid, cart_id, rest_name, order_no, at, parsed, image) → {id, dup}
--     dedupes by order number, or by identical lines when there is none; writes one dated price per line.
--   tq_receipts_list(token, gid, rest_name), tq_receipt_get(token, gid, id)
--   tq_learn: prices are dated by the item ("at"); an older-dated price never replaces a newer one.
-- ---------------------------------------------------------------------------
