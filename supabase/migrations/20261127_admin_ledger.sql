-- Tarweeqa — money across every group for the site admin (migration admin_ledger, 2026-11-27)
-- The Money screen used to count only the group that is open on the phone. The site admin now also gets every
-- billed order (ordered / settled) of every group, so the app can show each person's debt and wallet in one list.
create or replace function tq_admin_ledger(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u text := tq_admin_me(p_token);
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'gid', g.id, 'name', g.data->'name', 'roster', g.data->'roster',
      'carts', coalesce((select jsonb_agg(c.data || jsonb_build_object('id', c.id)) from tq_carts c
                         where c.group_id = g.id and c.data->>'stage' in ('ordered', 'settled')), '[]'::jsonb)
    ) order by g.ms) from tq_groups g), '[]'::jsonb);
end $$;
revoke execute on function tq_admin_ledger(text) from public;
grant execute on function tq_admin_ledger(text) to anon, authenticated;
