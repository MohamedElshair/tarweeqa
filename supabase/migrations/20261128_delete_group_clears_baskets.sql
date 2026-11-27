-- Tarweeqa — deleting a group order (migration delete_group_clears_baskets, 2026-11-28)
-- * Orders that never went through (voting / ordering) are cancelled and every basket in them is emptied:
--   nobody keeps a reminder or items for a restaurant order that will never be placed.
-- * Orders that were placed (ordered / settled) stay as they are, so each person keeps their invoices and
--   any unpaid amounts are still owed.
-- * A deleted group order disappears from members' phones (tq_bundle answers "no group").
-- * Cancelled orders without an invoice don't show in anyone's history.

create or replace function tq_cancel_open_carts(p_gid text, p_by text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update tq_carts set
    data = data || jsonb_build_object('stage', 'cancelled', 'cancelledAt', tq_now(), 'cancelledBy', p_by,
              'cancelledFrom', data->'stage', 'members', '{}'::jsonb),
    ms = tq_now()
  where group_id = p_gid and data->>'stage' in ('voting', 'ordering');
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function tq_cancel_open_carts(text, text) from public, anon, authenticated;

create or replace function tq_admin_delete_group(p_token text, p_gid text) returns void
language plpgsql security definer set search_path = public as $$
declare u text := tq_admin_me(p_token);
begin
  update tq_groups set data = jsonb_set(jsonb_set(data, '{deletedAt}', to_jsonb(tq_now())), '{deletedBy}', to_jsonb(u))
                            || case when data ? 'schedule' then jsonb_build_object('schedule', (data->'schedule') || '{"on": false}'::jsonb) else '{}'::jsonb end,
                       ms = tq_now()
   where id = p_gid;
  if not found then raise exception 'no group'; end if;
  perform tq_cancel_open_carts(p_gid, u);
end $$;

create or replace function tq_bundle(p_token text, p_gid text, p_since bigint default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); g jsonb; member boolean; adm boolean; now_ms bigint := tq_now();
begin
  select data || jsonb_build_object('id', id) into g from tq_groups where id = p_gid;
  if g is null or g ? 'deletedAt' then return jsonb_build_object('group', null, 'deleted', g is not null, 'now', now_ms); end if;
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
        where group_id = p_gid and ms > coalesce(p_since, 0) and data->>'stage' <> 'cancelled'
          and (adm or not coalesce((data->>'solo')::boolean, false) or data->>'ownerId' = u)), '[]'::jsonb),
    'cartIds', coalesce((select jsonb_agg(id) from tq_carts
        where group_id = p_gid and data->>'stage' <> 'cancelled' and (adm or not coalesce((data->>'solo')::boolean, false) or data->>'ownerId' = u)), '[]'::jsonb)
  );
end $$;

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
      'gid', c.group_id, 'groupName', g.data->'name', 'groupDeleted', g.data ? 'deletedAt', 'cid', c.id, 'key', k.k,
      'createdAt', c.data->'createdAt', 'closesAt', c.data->'closesAt', 'stage', c.data->'stage',
      'restaurant', coalesce(c.data->'restaurant'->'name', to_jsonb(''::text)), 'title', c.data->'title',
      'ownerName', c.data->'ownerName', 'ownerPhone', c.data->'ownerPhone', 'payInfo', c.data->'payInfo',
      'member', c.data->'members'->k.k, 'invoice', c.data->'invoices'->k.k, 'payment', c.data->'payments'->k.k,
      'invoiceKey', case when c.data->'invoices' ? k.k then c.data->'invoiceKey' else null end
    ) order by (c.data->>'createdAt')::bigint desc nulls last)
    from keys k join tq_carts c on c.group_id = k.gid join tq_groups g on g.id = k.gid
    where (coalesce(c.data->'members', '{}'::jsonb) ? k.k or coalesce(c.data->'invoices', '{}'::jsonb) ? k.k or coalesce(c.data->'payments', '{}'::jsonb) ? k.k)
      and not (c.data->>'stage' = 'cancelled' and not coalesce(c.data->'invoices', '{}'::jsonb) ? k.k)
  ), '[]'::jsonb);
end $$;

grant execute on function tq_admin_delete_group(text, text), tq_bundle(text, text, bigint), tq_my_history(text) to anon, authenticated;

-- the group "تجربة" was deleted before this rule existed: empty its open orders now
select tq_cancel_open_carts(id, data->>'deletedBy') from tq_groups where data ? 'deletedAt';
