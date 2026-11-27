-- Tarweeqa — group-locked ordering, solo orders, and a test account (migration group_lock_solo_test, 2026-11-27)
--
-- * Solo order: a member who doesn't want the group's restaurant can leave the group order and order by himself
--   from any of the group's restaurants. The order is marked {solo: true}; only he (and the admin) see it,
--   and he is its host (closes it, copies the list). Members still can't start group orders.
-- * tq_bundle: members only get the group's orders plus their own solo orders — never someone else's solo order.
-- * Test account: phone 123456 (PIN 1234) is accepted, so the admin can try the app as a second person.
--   It lives in the "تجربة" test group only, so the real group never sees it.

create or replace function tq_test_phone(p text) returns boolean
language sql immutable as $$ select tq_norm_phone(p) = '123456' $$;

create or replace function tq_check_phone(p_token text, p_phone text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ph text := tq_norm_phone(p_phone); p tq_persons;
begin
  if p_token is null or length(p_token) < 24 then raise exception 'bad token'; end if;
  if length(ph) < 10 and not tq_test_phone(ph) then raise exception 'bad phone'; end if;
  select * into p from tq_persons where phone = ph;
  return jsonb_build_object('exists', p.uid is not null, 'hasPin', p.pin_hash is not null,
    'locked', coalesce(p.locked_until, 0) > tq_now(), 'until', p.locked_until);
end $$;

-- group orders: admins only. Solo orders: any member, for himself, from one of the group's restaurants.
create or replace function tq_create_cart(p_token text, p_gid text, p_data jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); cid text := tq_new_id(); solo boolean := coalesce((p_data->>'solo')::boolean, false); d jsonb;
begin
  if solo then
    perform tq_group_for(p_gid, u);
    if not exists (select 1 from tq_restaurants where id = p_data->>'restaurantId' and group_id = p_gid and not deleted) then
      raise exception 'no restaurant';
    end if;
    d := (p_data - 'id' - 'members' - 'payments' - 'invoices')
         || jsonb_build_object('stage', 'ordering', 'payments', '{}'::jsonb,
              'members', case when coalesce(p_data->'members', '{}'::jsonb) ? u then jsonb_build_object(u, p_data->'members'->u) else '{}'::jsonb end);
  else
    perform tq_group_for(p_gid, u, true);
    d := p_data - 'id';
  end if;
  insert into tq_carts(id, group_id, data, ms)
  values (cid, p_gid, d || jsonb_build_object('groupId', p_gid, 'ownerId', u, 'solo', solo), tq_now());
  return cid;
end $$;

create or replace function tq_bundle(p_token text, p_gid text, p_since bigint default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); g jsonb; member boolean; adm boolean; now_ms bigint := tq_now();
begin
  select data || jsonb_build_object('id', id) into g from tq_groups where id = p_gid;
  if g is null then return jsonb_build_object('group', null, 'now', now_ms); end if;
  adm := tq_site_admin(u) or (g->'adminIds' ? u);
  member := (g->'memberUids' ? u) or tq_site_admin(u);
  if not member then
    return jsonb_build_object('group', jsonb_build_object('id', p_gid, 'name', g->'name', 'memberUids', g->'memberUids'), 'member', false, 'now', now_ms);
  end if;
  return jsonb_build_object(
    'group', g, 'member', true, 'now', now_ms, 'uid', u,
    'restaurants', coalesce((select jsonb_agg(data || jsonb_build_object('id', id)) from tq_restaurants where group_id = p_gid and not deleted and ms > coalesce(p_since, 0)), '[]'::jsonb),
    'restaurantIds', coalesce((select jsonb_agg(id) from tq_restaurants where group_id = p_gid and not deleted), '[]'::jsonb),
    'carts', coalesce((select jsonb_agg(data || jsonb_build_object('id', id)) from tq_carts
        where group_id = p_gid and ms > coalesce(p_since, 0)
          and (adm or not coalesce((data->>'solo')::boolean, false) or data->>'ownerId' = u)), '[]'::jsonb),
    'cartIds', coalesce((select jsonb_agg(id) from tq_carts
        where group_id = p_gid and (adm or not coalesce((data->>'solo')::boolean, false) or data->>'ownerId' = u)), '[]'::jsonb)
  );
end $$;

-- the test person: phone 123456, PIN 1234, member of the test group "تجربة" only
insert into tq_persons(uid, phone, name, data, ms, pin_hash, pin_set_at, last_seen)
values ('utest123456', '123456', 'مستخدم تجربة', '{"test": true}'::jsonb, tq_now(), extensions.crypt('1234', extensions.gen_salt('bf', 8)), tq_now(), tq_now())
on conflict (uid) do nothing;

update tq_groups g set
  data = jsonb_set(
           jsonb_set(g.data, '{memberUids}', (g.data->'memberUids') || '"utest123456"'::jsonb),
           '{roster,utest123456}', jsonb_build_object('name', 'مستخدم تجربة', 'phone', '123456', 'joinedAt', tq_now(), 'test', true), true),
  ms = tq_now()
where g.data->>'name' = 'تجربة' and not (g.data->'memberUids' ? 'utest123456');

revoke execute on function tq_test_phone(text) from public;
grant execute on function tq_check_phone(text, text), tq_create_cart(text, text, jsonb), tq_bundle(text, text, bigint) to anon, authenticated;
