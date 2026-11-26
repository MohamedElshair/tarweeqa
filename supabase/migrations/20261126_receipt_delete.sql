-- Tarweeqa — manage a restaurant's saved pictures (migration receipt_delete, 2026-11-26)
-- * tq_delete_receipt: an admin removes a saved menu/receipt picture and the prices that came from it.
-- * tq_receipts_list also says what kind of picture it is (menu screenshot or order receipt).

create or replace function tq_delete_receipt(p_token text, p_gid text, p_id text) returns void
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token);
begin
  perform tq_group_for(p_gid, u, true);
  delete from tq_prices where receipt_id = p_id and exists (select 1 from tq_receipts r where r.id = p_id and r.group_id = p_gid);
  delete from tq_receipts where id = p_id and group_id = p_gid;
end $$;

create or replace function tq_receipts_list(p_token text, p_gid text, p_rest_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token);
begin
  perform tq_group_for(p_gid, u);
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'at', at, 'orderNo', order_no, 'cartId', cart_id, 'ms', ms, 'kind', coalesce(parsed->>'kind', 'receipt'),
      'items', jsonb_array_length(coalesce(parsed->'items', '[]'::jsonb)), 'total', parsed->'total', 'hasImage', image is not null) order by at desc, ms desc)
    from tq_receipts where group_id = p_gid and rest_key = tq_name_key(p_rest_name)), '[]'::jsonb);
end $$;

revoke execute on function tq_delete_receipt(text, text, text) from public;
grant execute on function tq_delete_receipt(text, text, text), tq_receipts_list(text, text, text) to anon, authenticated;
