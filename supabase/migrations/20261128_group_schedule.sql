-- Tarweeqa — group management and daily schedule (migration group_schedule, 2026-11-28)
--
-- * Joining by link: someone the admin added by name + phone (a "guest" row in the roster) is merged into the real
--   account when that person signs in with the same number and opens the group link — no duplicate names.
-- * Daily schedule: group.schedule = { on, days[0-6, 0 = Sunday], from 'HH:MM', to 'HH:MM', restaurant: 'last' | <restaurant id>,
--   base: { the admin's host settings: ownerId, ownerName, ownerPhone, payInfo, fees … }, lastRun 'YYYY-MM-DD' }.
--   Every minute, tq_schedule_run() opens the group's order on the chosen days at 'from' (Cairo time), closing at 'to',
--   unless the group already has an order today. It closes on its own at 'to' (the app treats a past closesAt as closed).

create or replace function tq_join_group(p_token text, p_gid text, p_entry jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare u text := tq_me(p_token); g jsonb; ph text; k text; v jsonb;
begin
  select data into g from tq_groups where id = p_gid for update;
  if g is null then raise exception 'no group'; end if;
  select phone into ph from tq_persons where uid = u;
  -- a guest row with this person's number becomes this person
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

-- the order a restaurant row opens, the same shape the app builds (snapshotOf in app.js)
create or replace function tq_rest_snapshot(r jsonb, p_rid text) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'restaurantId', p_rid,
    'restaurant', jsonb_build_object('name', coalesce(r->>'name', ''), 'phone', coalesce(r->>'phone', ''), 'talabatUrl', coalesce(r->>'talabatUrl', ''), 'logo', coalesce(r->>'logo', '')),
    'menu', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', i->'id', 'name', i->'name', 'price', i->'price', 'category', coalesce(i->>'category', ''),
        'og', case when jsonb_typeof(i->'og') = 'array' and jsonb_array_length(i->'og') > 0 then i->'og' end)))
      from jsonb_array_elements(coalesce(r->'items', '[]'::jsonb)) i), '[]'::jsonb),
    'optGroups', coalesce((select jsonb_agg(g) from jsonb_array_elements(coalesce(r->'optGroups', '[]'::jsonb)) g
      where jsonb_array_length(coalesce(g->'choices', '[]'::jsonb)) > 0
        and exists (select 1 from jsonb_array_elements(coalesce(r->'items', '[]'::jsonb)) i where coalesce(i->'og', '[]'::jsonb) ? (g->>'id'))), '[]'::jsonb),
    'estimate', jsonb_build_object('delivery', 0, 'service', 0, 'taxPct', 0, 'tip', 0) || coalesce(r->'fees', '{}'::jsonb)
  )
$$;

create or replace function tq_schedule_run() returns int
language plpgsql security definer set search_path = public, extensions as $$
declare
  g record; s jsonb; local_now timestamp := now() at time zone 'Africa/Cairo'; today date := (now() at time zone 'Africa/Cairo')::date;
  dow int := extract(dow from (now() at time zone 'Africa/Cairo'))::int; t_from time; t_to time; rid text; r jsonb;
  closes bigint; opened int := 0; base jsonb; cid text;
begin
  for g in select id, data from tq_groups where coalesce((data->'schedule'->>'on')::boolean, false) for update loop
    s := g.data->'schedule';
    if s->>'lastRun' = today::text then continue; end if;
    if not (coalesce(s->'days', '[]'::jsonb) @> to_jsonb(dow)) then continue; end if;
    begin t_from := (s->>'from')::time; t_to := (s->>'to')::time; exception when others then continue; end;
    if t_to <= t_from or local_now::time < t_from or local_now::time >= t_to then continue; end if;
    -- the admin already opened today's group order by hand
    if exists (select 1 from tq_carts c where c.group_id = g.id and not coalesce((c.data->>'solo')::boolean, false)
               and to_timestamp((c.data->>'createdAt')::bigint / 1000.0) at time zone 'Africa/Cairo' >= today::timestamp) then
      update tq_groups set data = jsonb_set(data, '{schedule,lastRun}', to_jsonb(today::text)), ms = tq_now() where id = g.id;
      continue;
    end if;
    rid := nullif(s->>'restaurant', 'last');
    if rid is null then
      select c.data->>'restaurantId' into rid from tq_carts c
       where c.group_id = g.id and not coalesce((c.data->>'solo')::boolean, false) and c.data->>'restaurantId' is not null
       order by (c.data->>'createdAt')::bigint desc limit 1;
    end if;
    select data into r from tq_restaurants where id = rid and group_id = g.id and not deleted;
    if r is null then continue; end if;
    base := coalesce(s->'base', '{}'::jsonb);
    if base->>'ownerId' is null then base := base || jsonb_build_object('ownerId', g.data->>'ownerId'); end if;
    closes := (extract(epoch from ((today + t_to) at time zone 'Africa/Cairo')) * 1000)::bigint;
    cid := tq_new_id();
    insert into tq_carts(id, group_id, data, ms) values (cid, g.id,
      (base - 'id' - 'members' - 'payments' - 'invoices')
      || jsonb_build_object('title', coalesce(s->>'title', ''), 'createdAt', tq_now(), 'closesAt', closes, 'stage', 'ordering',
           'candidates', '[]'::jsonb, 'candidateInfo', '{}'::jsonb, 'votes', '{}'::jsonb, 'members', '{}'::jsonb, 'payments', '{}'::jsonb, 'charges', '[]'::jsonb,
           'groupId', g.id, 'solo', false, 'scheduled', true)
      || tq_rest_snapshot(r, rid),
      tq_now());
    update tq_restaurants set data = jsonb_set(data, '{lastOrderedAt}', to_jsonb(tq_now())), ms = tq_now() where id = rid;
    update tq_groups set data = jsonb_set(data, '{schedule,lastRun}', to_jsonb(today::text)), ms = tq_now() where id = g.id;
    opened := opened + 1;
  end loop;
  return opened;
end $$;

revoke execute on function tq_schedule_run() from public, anon, authenticated;
revoke execute on function tq_rest_snapshot(jsonb, text) from public, anon, authenticated;
grant execute on function tq_join_group(text, text, jsonb) to anon, authenticated;

create extension if not exists pg_cron;
select cron.unschedule('tarweeqa-schedule') where exists (select 1 from cron.job where jobname = 'tarweeqa-schedule');
select cron.schedule('tarweeqa-schedule', '* * * * *', 'select public.tq_schedule_run()');
