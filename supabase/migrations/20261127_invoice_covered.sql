-- Tarweeqa — invoice stamp follows every payment (migration invoice_covered, 2026-11-27)
-- A payment recorded "for everything" lands on the person's latest order, so older invoices used to stay "unpaid".
-- The invoice now also returns `covered`: the person's confirmed payments to this host, applied oldest invoice first,
-- and how much of them reaches this invoice. `isHost` marks the host's own invoice (he paid the restaurant himself).
create or replace function tq_invoice(p_gid text, p_cid text, p_key text, p_secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c jsonb; g jsonb; at_ms bigint; paid numeric; before numeric; mine numeric; last_pay jsonb;
begin
  select data into c from tq_carts where id = p_cid and group_id = p_gid;
  if c is null or coalesce(c->>'invoiceKey', '') = '' or c->>'invoiceKey' <> coalesce(p_secret, '') then raise exception 'invoice not found'; end if;
  if not (coalesce(c->'invoices', '{}'::jsonb) ? p_key) then raise exception 'invoice not found'; end if;
  select data into g from tq_groups where id = p_gid;
  at_ms := (c->>'createdAt')::bigint;
  mine := coalesce((c->'invoices'->p_key->>'total')::numeric, 0);
  select coalesce(sum((x.data->'payments'->p_key->>'amount')::numeric) filter (where x.data->'payments'->p_key->>'status' = 'confirmed'), 0),
         coalesce(sum((x.data->'invoices'->p_key->>'total')::numeric) filter (where (x.data->>'createdAt')::bigint < at_ms), 0)
    into paid, before
    from tq_carts x
   where x.group_id = p_gid and x.data->>'ownerId' = c->>'ownerId' and x.data->>'stage' in ('ordered', 'settled');
  select x.data->'payments'->p_key into last_pay from tq_carts x
   where x.group_id = p_gid and x.data->>'ownerId' = c->>'ownerId' and x.data->'payments'->p_key->>'status' = 'confirmed'
   order by (x.data->'payments'->p_key->>'at')::bigint desc nulls last limit 1;
  return jsonb_build_object(
    'invoice', c->'invoices'->p_key, 'payment', c->'payments'->p_key,
    'covered', round(greatest(0, least(mine, paid - before)), 2), 'lastPayment', last_pay,
    'isHost', p_key = c->>'ownerId',
    'restaurant', c->'restaurant', 'title', c->'title', 'createdAt', c->'createdAt',
    'ownerName', c->'ownerName', 'ownerPhone', c->'ownerPhone', 'payInfo', c->'payInfo', 'groupName', g->'name');
end $$;
grant execute on function tq_invoice(text, text, text, text) to anon, authenticated;
