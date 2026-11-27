-- Tarweeqa — delete a group order (archive) and "the manager doesn't order" (migration group_delete_not_ordering, 2026-11-28)
--
-- * Delete: the site admin deletes a group order. It disappears for everyone (members, links, the daily schedule stops),
--   but nothing is erased: its restaurants, past orders, invoices and unpaid money stay, so invoice links and the
--   money pages keep working. The admin page lists deleted group orders and can bring one back.
-- * group.notOrdering = [uid…]: people who manage the group order but don't order in it (e.g. the admin who made it).
--   The app leaves them out of the people list, the reminders and the bill; any group admin can set it.

create or replace function tq_admin_delete_group(p_token text, p_gid text) returns void
language plpgsql security definer set search_path = public as $$
declare u text := tq_admin_me(p_token);
begin
  update tq_groups set data = jsonb_set(jsonb_set(data, '{deletedAt}', to_jsonb(tq_now())), '{deletedBy}', to_jsonb(u))
                            || case when data ? 'schedule' then jsonb_build_object('schedule', (data->'schedule') || '{"on": false}'::jsonb) else '{}'::jsonb end,
                       ms = tq_now()
   where id = p_gid;
  if not found then raise exception 'no group'; end if;
end $$;

create or replace function tq_admin_restore_group(p_token text, p_gid text) returns void
language plpgsql security definer set search_path = public as $$
declare u text := tq_admin_me(p_token);
begin
  update tq_groups set data = data - 'deletedAt' - 'deletedBy', ms = tq_now() where id = p_gid;
  if not found then raise exception 'no group'; end if;
end $$;

create or replace function tq_my_groups(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); sa boolean := tq_site_admin(u);
begin
  return coalesce((select jsonb_agg(data || jsonb_build_object('id', id) order by ms) from tq_groups
                   where (sa or data->'memberUids' ? u) and not (data ? 'deletedAt')), '[]'::jsonb);
end $$;

create or replace function tq_bundle(p_token text, p_gid text, p_since bigint default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); g jsonb; member boolean; adm boolean; now_ms bigint := tq_now();
begin
  select data || jsonb_build_object('id', id) into g from tq_groups where id = p_gid;
  if g is null or g ? 'deletedAt' then return jsonb_build_object('group', null, 'now', now_ms); end if;
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

create or replace function tq_join_group(p_token text, p_gid text, p_entry jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); g jsonb; ph text; k text; v jsonb;
begin
  select data into g from tq_groups where id = p_gid for update;
  if g is null or g ? 'deletedAt' then raise exception 'no group'; end if;
  select phone into ph from tq_persons where uid = u;
  if ph is not null then
    for k, v in select * from jsonb_each(coalesce(g->'roster', '{}'::jsonb)) loop
      if k <> u and coalesce((v->>'guest')::boolean, false) and v->>'phone' is not null and tq_norm_phone(v->>'phone') = ph then
        g := jsonb_set(g, '{roster}', (g->'roster') - k);
      end if;
    end loop;
  end if;
  g := jsonb_set(g, array['roster', u], jsonb_strip_nulls(jsonb_build_object('name', p_entry->'name', 'phone', p_entry->'phone', 'joinedAt', p_entry->'joinedAt')), true);
  if not (g->'memberUids' ? u) then g := jsonb_set(g, '{memberUids}', (g->'memberUids') || to_jsonb(u)); end if;
  update tq_groups set data = g, ms = tq_now() where id = p_gid;
end $$;

-- deleting / restoring goes through the two functions above only
create or replace function tq_patch_group(p_token text, p_gid text, p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); g jsonb; owner text;
begin
  g := tq_group_for(p_gid, u, true);
  owner := g->>'ownerId';
  if exists (select 1 from jsonb_object_keys(p_patch) k where k ~ '^deleted') then raise exception 'use delete'; end if;
  if not tq_site_admin(u) and exists (select 1 from jsonb_object_keys(p_patch) k where k ~ '^(adminIds|memberUids|ownerId)') then raise exception 'only the site admin manages admins'; end if;
  g := tq_apply(g, p_patch - 'ownerId' - 'id');
  if not (g->'adminIds' ? owner) then g := jsonb_set(g, '{adminIds}', coalesce(g->'adminIds', '[]'::jsonb) || to_jsonb(owner)); end if;
  update tq_groups set data = g, ms = tq_now() where id = p_gid;
end $$;

-- the admin page also gets deleted group orders (marked), to bring one back
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
        'groups', coalesce((select jsonb_agg(g.id) from tq_groups g where g.data->'memberUids' ? p.uid and not (g.data ? 'deletedAt')), '[]'::jsonb)
      ) order by p.name) from tq_persons p), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(jsonb_build_object(
        'id', g.id, 'name', g.data->'name', 'ownerId', g.data->'ownerId', 'memberUids', g.data->'memberUids', 'roster', g.data->'roster',
        'notOrdering', coalesce(g.data->'notOrdering', '[]'::jsonb), 'deletedAt', g.data->'deletedAt',
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

grant execute on function tq_admin_delete_group(text, text), tq_admin_restore_group(text, text), tq_my_groups(text),
  tq_bundle(text, text, bigint), tq_join_group(text, text, jsonb), tq_patch_group(text, text, jsonb), tq_admin_overview(text) to anon, authenticated;
