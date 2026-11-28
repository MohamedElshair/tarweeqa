-- Order sources + per-source price history (2026-11-28)
--
-- A restaurant can be ordered from several places ("sources"): Talabat, the restaurant itself (hotline / site),
-- and any other place added later. Each source has its own menu prices and charges:
--   restaurant.sources = [{ id, kind: talabat|direct|other, name, phone, url, fees }], restaurant.defaultSource
--   item.prices = { sourceId: price }, item.pat = { sourceId: ms the price was set }
--   item.price stays = the first source's price (older screens keep working).
-- Rules kept by this migration:
--   * every price change is a new dated row in tq_prices, per restaurant + item + source (channel);
--     nothing is ever overwritten, so the history and the statistics see every change.
--   * an order copies the menu (all sources' prices) when it opens; later price changes never touch it,
--     and invoices keep the prices they were issued with.
-- Backward compatible: data without sources is read as one Talabat menu (or the restaurant's own menu
-- when it was ordered by phone / WhatsApp).

alter table tq_prices add column if not exists channel text not null default 'talabat';
create index if not exists tq_prices_item_chan on tq_prices(rest_key, item_key, channel, at);
create index if not exists tq_prices_key on tq_prices(item_key, channel);

-- the source a restaurant's plain item.price belongs to
create or replace function tq_def_source(r jsonb) returns text language sql immutable as $$
  select coalesce(
    nullif(r->>'defaultSource', ''),
    case when jsonb_typeof(r->'sources') = 'array' and jsonb_array_length(r->'sources') > 0 then r->'sources'->0->>'id' end,
    case when coalesce(r->>'orderVia', 'talabat') = 'talabat' then 'talabat' else 'direct' end)
$$;

-- a JSON value as a positive price, or null
create or replace function tq_price_of(v jsonb) returns numeric language sql immutable as $$
  select case when v is null then null
              when jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric > 0 then round((v #>> '{}')::numeric, 2)
              when jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' and (v #>> '{}')::numeric > 0 then round((v #>> '{}')::numeric, 2)
              else null end
$$;

-- learn a saved menu: one dated row for every price that differs from that item's latest price in the same source
create or replace function tq_learn(p_data jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare k text := tq_name_key(p_data->>'name'); it jsonb; ik text; src jsonb := p_data->'priceSource'; at_ms bigint;
        def text := tq_def_source(p_data); prices jsonb; ch text; pv jsonb; pr numeric; lastp numeric;
begin
  if k = '' or jsonb_array_length(coalesce(p_data->'items', '[]'::jsonb)) = 0 then return; end if;
  for it in select * from jsonb_array_elements(p_data->'items') loop
    ik := tq_name_key(it->>'name');
    if ik = '' then continue; end if;
    if jsonb_typeof(it->'prices') = 'object' then prices := it->'prices';
    elsif (it->>'price') is not null then prices := jsonb_build_object(def, it->'price');
    else continue; end if;
    for ch, pv in select * from jsonb_each(prices) loop
      pr := tq_price_of(pv);
      if pr is null or coalesce(ch, '') = '' then continue; end if;
      at_ms := coalesce((it->'pat'->>ch)::bigint,
                        case when ch = def or jsonb_typeof(it->'prices') is distinct from 'object' then (it->>'at')::bigint end,
                        (src->>'at')::bigint, tq_now());
      if exists (select 1 from tq_prices where rest_key = k and item_key = ik and channel = ch and at >= at_ms) then
        -- the same moment is already recorded, or a newer price exists: an older price never replaces a newer one
        continue;
      end if;
      select price into lastp from tq_prices where rest_key = k and item_key = ik and channel = ch order by at desc, id desc limit 1;
      if lastp is null or lastp <> pr then
        insert into tq_prices(rest_key, item_key, item_name, price, at, source, cart_id, channel)
        values (k, ik, it->>'name', pr, at_ms, coalesce(src->>'type', 'menu'), src->>'cartId', ch);
      end if;
    end loop;
  end loop;
  insert into tq_catalog(name_key, data, ms)
  values (k, jsonb_strip_nulls(jsonb_build_object('name', p_data->'name', 'phone', coalesce(p_data->'phone', '""'), 'talabatUrl', coalesce(p_data->'talabatUrl', '""'),
                              'webUrl', p_data->'webUrl', 'orderVia', p_data->'orderVia', 'sources', p_data->'sources', 'defaultSource', p_data->'defaultSource',
                              'fees', coalesce(p_data->'fees', '{}'::jsonb), 'items', p_data->'items')), tq_now())
  on conflict (name_key) do update set data = excluded.data, ms = excluded.ms;
end $$;

-- receipts: the source the order was placed from is p_parsed.channel (default Talabat)
create or replace function tq_save_receipt(p_token text, p_gid text, p_cart_id text, p_rest_name text, p_order_no text, p_at bigint, p_parsed jsonb, p_image text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); k text := tq_name_key(p_rest_name); rid text; ex text; it jsonb; ik text; at_ms bigint := coalesce(p_at, tq_now()); n int := 0;
        ch text := coalesce(nullif(p_parsed->>'channel', ''), 'talabat');
begin
  perform tq_group_for(p_gid, u, true);
  if k = '' then raise exception 'restaurant name required'; end if;
  if coalesce(p_order_no, '') <> '' then
    select id into ex from tq_receipts where group_id = p_gid and rest_key = k and order_no = p_order_no limit 1;
    if ex is not null then
      update tq_receipts set cart_id = coalesce(p_cart_id, cart_id) where id = ex;
      return jsonb_build_object('id', ex, 'dup', true);
    end if;
  end if;
  -- no order number: the same picture read twice gives the same lines
  select id into ex from tq_receipts where group_id = p_gid and rest_key = k and coalesce(order_no, '') = coalesce(p_order_no, '')
    and parsed->'items' = p_parsed->'items' and coalesce(parsed->'total', 'null') = coalesce(p_parsed->'total', 'null') limit 1;
  if ex is not null then return jsonb_build_object('id', ex, 'dup', true); end if;
  rid := tq_new_id();
  insert into tq_receipts(id, group_id, rest_key, rest_name, cart_id, order_no, at, parsed, image, uid, ms)
  values (rid, p_gid, k, p_rest_name, p_cart_id, nullif(p_order_no, ''), at_ms, p_parsed, p_image, u, tq_now());
  for it in select * from jsonb_array_elements(coalesce(p_parsed->'items', '[]'::jsonb)) loop
    if (it->>'unit') is null or coalesce((it->>'nameUnsure')::boolean, false)
       or (coalesce((it->>'unsure')::boolean, false) and not coalesce((it->>'qtyInferred')::boolean, false)) then continue; end if;
    ik := tq_name_key(it->>'name');
    if ik = '' then continue; end if;
    delete from tq_prices where rest_key = k and item_key = ik and channel = ch and at = at_ms;
    insert into tq_prices(rest_key, item_key, item_name, price, at, source, cart_id, receipt_id, channel)
    values (k, ik, it->>'name', (it->>'unit')::numeric, at_ms, coalesce(p_parsed->>'kind', 'receipt'), p_cart_id, rid, ch);
    n := n + 1;
  end loop;
  return jsonb_build_object('id', rid, 'dup', false, 'prices', n);
end $$;

-- one restaurant's history, now with the source of each price
create or replace function tq_price_history(p_token text, p_gid text, p_rest_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token);
begin
  perform tq_group_for(p_gid, u);
  return coalesce((select jsonb_agg(jsonb_build_object('item', item_name, 'key', item_key, 'price', price, 'at', at, 'source', source, 'channel', channel) order by at nulls first, id)
                   from tq_prices where rest_key = tq_name_key(p_rest_name)), '[]'::jsonb);
end $$;

-- every dated price of every restaurant (site admin): for price-rise statistics and comparing the same item across restaurants
create or replace function tq_price_stats(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform tq_admin_me(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object('rest', coalesce(c.data->>'name', p.rest_key), 'restKey', p.rest_key, 'item', p.item_name, 'key', p.item_key,
                                                       'channel', p.channel, 'price', p.price, 'at', p.at, 'source', p.source) order by p.at nulls first, p.id)
                   from tq_prices p left join tq_catalog c on c.name_key = p.rest_key), '[]'::jsonb);
end $$;

-- an order's copy of the restaurant (used by the daily automatic order): every source's prices, opened on the default source
create or replace function tq_rest_snapshot(r jsonb, p_rid text) returns jsonb
language plpgsql immutable as $$
declare def text := tq_def_source(r); srcs jsonb; fees jsonb; all_items jsonb; menu jsonb;
begin
  if jsonb_typeof(r->'sources') = 'array' and jsonb_array_length(r->'sources') > 0 then srcs := r->'sources';
  else
    srcs := jsonb_build_array(
      jsonb_build_object('id', 'talabat', 'kind', 'talabat', 'fees', case when def = 'talabat' then coalesce(r->'fees', '{}'::jsonb) else '{}'::jsonb end),
      jsonb_build_object('id', 'direct', 'kind', 'direct', 'fees', case when def = 'direct' then coalesce(r->'fees', '{}'::jsonb) else '{}'::jsonb end));
  end if;
  if not exists (select 1 from jsonb_array_elements(srcs) x where x->>'id' = def) then def := srcs->0->>'id'; end if;
  select x->'fees' into fees from jsonb_array_elements(srcs) x where x->>'id' = def limit 1;
  all_items := coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', i->'id', 'name', i->'name', 'price', i->'price', 'category', coalesce(i->>'category', ''),
        'prices', case when jsonb_typeof(i->'prices') = 'object' then i->'prices' when tq_price_of(i->'price') is not null then jsonb_build_object(def, tq_price_of(i->'price')) else '{}'::jsonb end,
        'og', case when jsonb_typeof(i->'og') = 'array' and jsonb_array_length(i->'og') > 0 then i->'og' end)))
      from jsonb_array_elements(coalesce(r->'items', '[]'::jsonb)) i), '[]'::jsonb);
  menu := coalesce((select jsonb_agg(m || jsonb_build_object('price', tq_price_of(m->'prices'->def)))
      from jsonb_array_elements(all_items) m where tq_price_of(m->'prices'->def) is not null), '[]'::jsonb);
  return jsonb_build_object(
    'restaurantId', p_rid,
    'restaurant', jsonb_build_object('name', coalesce(r->>'name', ''), 'phone', coalesce(r->>'phone', ''), 'talabatUrl', coalesce(r->>'talabatUrl', ''), 'webUrl', coalesce(r->>'webUrl', ''), 'logo', coalesce(r->>'logo', '')),
    'source', def, 'srcDef', def,
    'srcList', coalesce((select jsonb_agg(jsonb_build_object('id', x->'id', 'kind', coalesce(x->>'kind', 'other'), 'name', coalesce(x->>'name', ''), 'phone', coalesce(x->>'phone', ''), 'url', coalesce(x->>'url', ''), 'fees', coalesce(x->'fees', '{}'::jsonb)))
                         from jsonb_array_elements(srcs) x), '[]'::jsonb),
    'menuAll', all_items,
    'menu', menu,
    'optGroups', coalesce((select jsonb_agg(g) from jsonb_array_elements(coalesce(r->'optGroups', '[]'::jsonb)) g
      where jsonb_array_length(coalesce(g->'choices', '[]'::jsonb)) > 0
        and exists (select 1 from jsonb_array_elements(coalesce(r->'items', '[]'::jsonb)) i where coalesce(i->'og', '[]'::jsonb) ? (g->>'id'))), '[]'::jsonb),
    'estimate', jsonb_build_object('delivery', 0, 'service', 0, 'taxPct', 0, 'tip', 0) || coalesce(fees, '{}'::jsonb)
  );
end $$;

revoke execute on function tq_def_source(jsonb), tq_price_of(jsonb), tq_learn(jsonb), tq_rest_snapshot(jsonb, text) from public, anon, authenticated;
revoke execute on function tq_price_stats(text) from public;
grant execute on function tq_price_stats(text), tq_price_history(text, text, text), tq_save_receipt(text, text, text, text, text, bigint, jsonb, text) to anon, authenticated;
