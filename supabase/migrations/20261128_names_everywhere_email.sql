-- Tarweeqa — one name per person everywhere, and e-mail notifications
--
-- 1) Names: tq_persons.name is the one true name. Renaming a person (in their profile, from the admin
--    people page, or in a group order's member list) updates every group roster, every order basket,
--    every invoice and the "owner" name on orders they host.
-- 2) E-mail: people add an address in their profile (tq_persons.data.email). Events queue mails in
--    tq_mail (one per event per person, never twice); the send-mail edge function sends them.

-- ---------- 1) names everywhere ----------
create or replace function tq_sync_person_name(p_uid text, p_name text, p_phone text) returns void
language plpgsql security definer set search_path = public as $$
declare g record; c record; k text; d jsonb; ph text := tq_norm_phone(p_phone); nm text := trim(coalesce(p_name, ''));
begin
  if nm = '' then return; end if;
  for g in select id, data from tq_groups loop
    d := g.data;
    for k in select e.key from jsonb_each(coalesce(d->'roster', '{}'::jsonb)) e
              where jsonb_typeof(e.value) = 'object'
                and (e.key = p_uid or (ph <> '' and tq_norm_phone(e.value->>'phone') = ph)) loop
      d := jsonb_set(d, array['roster', k, 'name'], to_jsonb(nm));
    end loop;
    if d->'schedule'->'base'->>'ownerId' = p_uid then
      d := jsonb_set(d, '{schedule,base,ownerName}', to_jsonb(nm));
    end if;
    if d is distinct from g.data then update tq_groups set data = d, ms = tq_now() where id = g.id; end if;
  end loop;
  for c in select id, data from tq_carts loop
    d := c.data;
    for k in select e.key from jsonb_each(coalesce(d->'members', '{}'::jsonb)) e
              where jsonb_typeof(e.value) = 'object'
                and (e.key = p_uid or (ph <> '' and tq_norm_phone(e.value->>'phone') = ph)) loop
      d := jsonb_set(d, array['members', k, 'name'], to_jsonb(nm));
    end loop;
    for k in select e.key from jsonb_each(coalesce(d->'invoices', '{}'::jsonb)) e
              where jsonb_typeof(e.value) = 'object'
                and (e.key = p_uid or (ph <> '' and tq_norm_phone(e.value->>'phone') = ph)) loop
      d := jsonb_set(d, array['invoices', k, 'name'], to_jsonb(nm));
    end loop;
    if d->>'ownerId' = p_uid then d := jsonb_set(d, '{ownerName}', to_jsonb(nm)); end if;
    if d is distinct from c.data then update tq_carts set data = d, ms = tq_now() where id = c.id; end if;
  end loop;
end $$;
revoke all on function tq_sync_person_name(text, text, text) from public, anon, authenticated;

-- a person renamed → everywhere
create or replace function tq_persons_name_trg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.name is distinct from old.name and pg_trigger_depth() <= 2 then
    perform tq_sync_person_name(new.uid, new.name, new.phone);
  end if;
  return new;
end $$;
drop trigger if exists tq_persons_name on tq_persons;
create trigger tq_persons_name after update of name on tq_persons
  for each row execute function tq_persons_name_trg();

-- a name edited in a group order's member list → that person's name (and from there everywhere)
create or replace function tq_groups_roster_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; v jsonb; ov jsonb; ph text; nm text;
begin
  if pg_trigger_depth() > 1 then return new; end if;
  for k, v in select * from jsonb_each(coalesce(new.data->'roster', '{}'::jsonb)) loop
    ov := old.data->'roster'->k;
    nm := trim(coalesce(v->>'name', ''));
    if ov is not null and nm <> '' and nm is distinct from ov->>'name' then
      ph := tq_norm_phone(v->>'phone');
      update tq_persons set name = nm, ms = tq_now()
       where (uid = k or (ph <> '' and phone = ph)) and name is distinct from nm;
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists tq_groups_roster on tq_groups;
create trigger tq_groups_roster after update on tq_groups
  for each row execute function tq_groups_roster_trg();

-- bring everything in line with the names people already fixed
do $$ declare p record; begin
  for p in select uid, name, phone from tq_persons loop perform tq_sync_person_name(p.uid, p.name, p.phone); end loop;
end $$;

-- ---------- 2) e-mail notifications ----------
create table if not exists tq_mail (
  id bigserial primary key,
  uid text not null,
  email text not null,
  kind text not null,
  ref text not null,
  subject text not null,
  html text not null,
  created_at bigint not null default tq_now(),
  sent_at bigint,
  tries int not null default 0,
  error text,
  unique (kind, ref, uid)
);
create index if not exists tq_mail_pending on tq_mail(created_at) where sent_at is null;
alter table tq_mail enable row level security;
revoke all on tq_mail from anon, authenticated;

create or replace function tq_h(p text) returns text language sql immutable as $$
  select replace(replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;')
$$;

create or replace function tq_money(p numeric) returns text language sql immutable as $$
  select trim(to_char(round(coalesce(p, 0), 2), 'FM999G999G990D00')) || ' ج.م'
$$;

-- the whole e-mail: Tarweeqa header, a title, the body, one button
create or replace function tq_mail_html(p_title text, p_body text, p_btn text, p_url text) returns text
language sql immutable as $$
  select '<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#FFF6E9;font-family:Tahoma,Arial,sans-serif;color:#2B1D14">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFF6E9"><tr><td align="center" style="padding:24px 12px">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden">'
    || '<tr><td style="background:#E5432D;color:#ffffff;padding:18px 24px;font-size:22px;font-weight:bold">ترويقة</td></tr>'
    || '<tr><td style="padding:24px;text-align:right;direction:rtl">'
    || '<h1 style="margin:0 0 14px;font-size:20px;line-height:1.5">' || tq_h(p_title) || '</h1>'
    || '<div style="font-size:15px;line-height:1.8">' || p_body || '</div>'
    || case when coalesce(p_url, '') <> '' then
         '<p style="margin:22px 0 4px"><a href="' || tq_h(p_url) || '" style="display:inline-block;background:#C8331F;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:12px;font-weight:bold">' || tq_h(p_btn) || '</a></p>'
       else '' end
    || '</td></tr><tr><td style="padding:14px 24px;background:#FFF6E9;color:#6B5A4E;font-size:12px;text-align:right;direction:rtl">'
    || 'وصلك الإيميل ده لأنك ضايف بريدك في بروفايلك على ترويقة. تقدر تشيله من البروفايل في أي وقت.'
    || '</td></tr></table></td></tr></table></body></html>'
$$;

-- who a basket/roster key is: the person by id, else by phone (guests added by phone who signed up later)
create or replace function tq_person_of(p_key text, p_phone text)
returns table(uid text, name text, email text)
language sql stable security definer set search_path = public as $$
  select p.uid, p.name, nullif(trim(p.data->>'email'), '')
    from tq_persons p
   where p.uid = p_key or (tq_norm_phone(p_phone) <> '' and p.phone = tq_norm_phone(p_phone))
   order by (p.uid = p_key) desc
   limit 1
$$;

create or replace function tq_mail_queue(p_key text, p_phone text, p_kind text, p_ref text, p_subject text, p_title text, p_body text, p_btn text, p_url text)
returns void language plpgsql security definer set search_path = public as $$
declare who record;
begin
  select * into who from tq_person_of(p_key, p_phone);
  if who.uid is null or who.email is null or who.email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return; end if;
  insert into tq_mail(uid, email, kind, ref, subject, html)
  values (who.uid, who.email, p_kind, p_ref, p_subject, tq_mail_html(p_title, p_body, p_btn, p_url))
  on conflict (kind, ref, uid) do nothing;
end $$;

create or replace function tq_items_html(p_items jsonb) returns text language sql immutable as $$
  select coalesce('<ul style="padding-inline-start:18px;margin:8px 0">' || string_agg(
           '<li>' || case when coalesce((i->>'qty')::numeric, 1) > 1 then (i->>'qty') || '× ' else '' end || tq_h(i->>'name') || '</li>', '') || '</ul>', '')
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) i
$$;

create or replace function tq_cairo_time(p_ms bigint) returns text language sql immutable as $$
  select to_char(to_timestamp(p_ms / 1000.0) at time zone 'Africa/Cairo', 'HH12:MI') ||
         case when extract(hour from to_timestamp(p_ms / 1000.0) at time zone 'Africa/Cairo') < 12 then ' ص' else ' م' end
$$;

-- order events → mails
create or replace function tq_carts_mail_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  d jsonb := new.data; o jsonb := case when tg_op = 'UPDATE' then old.data else '{}'::jsonb end;
  g jsonb; rest text; gname text; site text := 'https://tarweaqa.com/'; link text; k text; v jsonb; ov jsonb; key text;
begin
  select data into g from tq_groups where id = new.group_id;
  rest := coalesce(nullif(d->'restaurant'->>'name', ''), nullif(d->>'title', ''), 'الطلب');
  gname := coalesce(g->>'name', '');
  link := site || '?g=' || new.group_id || '&c=' || new.id;

  -- a) the restaurant is open for ordering in the group order
  if d->>'stage' = 'ordering' and coalesce(o->>'stage', '') <> 'ordering' and coalesce((d->>'solo')::boolean, false) = false then
    for key in select distinct x from (
        select jsonb_array_elements_text(coalesce(g->'memberUids', '[]'::jsonb)) x
        union select jsonb_object_keys(coalesce(g->'roster', '{}'::jsonb))) s loop
      continue when key = d->>'ownerId';
      perform tq_mail_queue(key, g->'roster'->key->>'phone', 'open', new.id,
        rest || ' متاح دلوقتي للطلب 🍳',
        rest || ' متاح دلوقتي للطلب',
        'الطلب الجماعي <b>' || tq_h(gname) || '</b> فتح الطلب من <b>' || tq_h(rest) || '</b>.'
          || case when d ? 'closesAt' then '<br>الطلب بيقفل الساعة <b>' || tq_cairo_time((d->>'closesAt')::bigint) || '</b>، اختار أكلك قبلها.' else '' end,
        'اطلب دلوقتي', link);
    end loop;
  end if;

  -- b) a bill was issued → it is due
  for k, v in select * from jsonb_each(coalesce(d->'invoices', '{}'::jsonb)) loop
    continue when jsonb_typeof(v) <> 'object' or coalesce((v->>'self')::boolean, false) or (o->'invoices') ? k;
    continue when coalesce(d->'payments'->k->>'status', '') = 'confirmed' or coalesce((v->>'net')::numeric, 0) <= 0;
    perform tq_mail_queue(k, v->>'phone', 'bill', new.id,
      'فاتورتك من ' || rest || ': ' || tq_money((v->>'net')::numeric),
      'فاتورتك جاهزة — مستحقة الدفع',
      'فاتورة رقم <b>' || tq_h(v->>'no') || '</b> من <b>' || tq_h(rest) || '</b>' || tq_items_html(v->'items')
        || 'المطلوب منك: <b>' || tq_money((v->>'net')::numeric) || '</b>'
        || case when coalesce(d->>'ownerName', '') <> '' then '<br>بتتدفع لـ ' || tq_h(d->>'ownerName') || '.' else '' end,
      'افتح الفاتورة وادفع',
      site || '?inv=1&g=' || new.group_id || '&c=' || new.id || '&p=' || k || '&k=' || coalesce(d->>'invoiceKey', ''));
  end loop;

  -- c) a payment was confirmed → thank you
  for k, v in select * from jsonb_each(coalesce(d->'payments', '{}'::jsonb)) loop
    continue when jsonb_typeof(v) <> 'object' or v->>'status' <> 'confirmed';
    ov := o->'payments'->k;
    continue when ov is not null and ov->>'status' = 'confirmed' and ov->>'amount' is not distinct from v->>'amount';
    perform tq_mail_queue(k, coalesce(d->'invoices'->k->>'phone', d->'members'->k->>'phone'), 'paid', new.id || ':' || coalesce(v->>'at', ''),
      'تم دفع الفاتورة ' || coalesce(d->'invoices'->k->>'no', '') || ' — شكراً',
      'تم دفع الفاتورة، شكراً لك 🙏',
      'تم دفع الفاتورة رقم <b>' || tq_h(coalesce(d->'invoices'->k->>'no', '')) || '</b> من <b>' || tq_h(rest) || '</b> بقيمة <b>'
        || tq_money((v->>'amount')::numeric) || '</b>.',
      '', '');
  end loop;

  -- d) the food arrived (button on the group order)
  if d ? 'arrivedAt' and d->>'arrivedAt' is distinct from o->>'arrivedAt' then
    for k, v in select * from jsonb_each(coalesce(d->'members', '{}'::jsonb)) loop
      continue when jsonb_typeof(v) <> 'object' or k = d->>'ownerId'
                 or jsonb_array_length(case when jsonb_typeof(v->'items') = 'array' then v->'items' else '[]'::jsonb end) = 0;
      perform tq_mail_queue(k, v->>'phone', 'arrived', new.id || ':' || (d->>'arrivedAt'),
        'الأكل وصل 🎉 — ' || rest,
        'الأكل وصل 🎉',
        'طلب <b>' || tq_h(rest) || '</b> وصل' || case when coalesce(d->>'ownerName', '') <> '' then ' عند ' || tq_h(d->>'ownerName') else '' end
          || '. طلبك:' || tq_items_html(v->'items'),
        'افتح الطلب', link);
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists tq_carts_mail on tq_carts;
create trigger tq_carts_mail after insert or update on tq_carts
  for each row execute function tq_carts_mail_trg();

-- someone added to a group order
create or replace function tq_groups_mail_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; v jsonb;
begin
  for k, v in select * from jsonb_each(coalesce(new.data->'roster', '{}'::jsonb)) loop
    continue when jsonb_typeof(v) <> 'object' or (tg_op = 'UPDATE' and (old.data->'roster') ? k) or k = new.data->>'ownerId';
    perform tq_mail_queue(k, v->>'phone', 'added', new.id,
      'اتضفت في الطلب الجماعي ' || coalesce(new.data->>'name', ''),
      'اتضفت في طلب جماعي 👋',
      'تم إضافتك في الطلب الجماعي <b>' || tq_h(new.data->>'name') || '</b> باسم <b>' || tq_h(v->>'name') || '</b>.<br>هيوصلك إيميل لما المطعم يفتح للطلب.',
      'افتح الطلب الجماعي', 'https://tarweaqa.com/?g=' || new.id);
  end loop;
  return new;
end $$;
drop trigger if exists tq_groups_mail on tq_groups;
create trigger tq_groups_mail after insert or update on tq_groups
  for each row execute function tq_groups_mail_trg();

-- once a day: bills still unpaid after a day get one reminder
create or replace function tq_mail_unpaid() returns void
language plpgsql security definer set search_path = public as $$
declare c record; k text; v jsonb; rest text;
begin
  for c in select id, group_id, data from tq_carts
            where data->>'stage' in ('ordered', 'settled') and data ? 'invoices'
              and coalesce((data->>'invoicesAt')::bigint, 0) < tq_now() - 86400000
              and coalesce((data->>'invoicesAt')::bigint, 0) > tq_now() - 30 * 86400000 loop
    rest := coalesce(nullif(c.data->'restaurant'->>'name', ''), 'الطلب');
    for k, v in select * from jsonb_each(c.data->'invoices') loop
      continue when jsonb_typeof(v) <> 'object' or coalesce((v->>'self')::boolean, false) or coalesce((v->>'net')::numeric, 0) <= 0;
      continue when coalesce(c.data->'payments'->k->>'status', '') = 'confirmed';
      perform tq_mail_queue(k, v->>'phone', 'unpaid', c.id,
        'فاتورة مستحقة لم تُدفع: ' || tq_money((v->>'net')::numeric),
        'فاتورة مستحقة لم تُدفع',
        'لسه فاتورة رقم <b>' || tq_h(v->>'no') || '</b> من <b>' || tq_h(rest) || '</b> مستحقة بقيمة <b>' || tq_money((v->>'net')::numeric) || '</b>.',
        'افتح الفاتورة وادفع',
        'https://tarweaqa.com/?inv=1&g=' || c.group_id || '&c=' || c.id || '&p=' || k || '&k=' || coalesce(c.data->>'invoiceKey', ''));
    end loop;
  end loop;
end $$;

-- the sender (edge function, service role) takes a batch and reports back
create or replace function tq_mail_claim(p_limit int default 20)
returns table(id bigint, email text, subject text, html text)
language plpgsql security definer set search_path = public as $$
begin
  -- an alert that waited too long is no use any more
  update tq_mail m set error = 'expired', sent_at = -1 where m.sent_at is null and m.created_at < tq_now() - 12 * 3600000;
  return query
  update tq_mail m set tries = m.tries + 1
   where m.id in (select x.id from tq_mail x where x.sent_at is null and x.tries < 5 order by x.id limit p_limit for update skip locked)
  returning m.id, m.email, m.subject, m.html;
end $$;
create or replace function tq_mail_done(p_id bigint, p_error text) returns void
language sql security definer set search_path = public as $$
  update tq_mail set sent_at = case when p_error is null then tq_now() else null end, error = p_error where id = p_id
$$;
revoke all on function tq_mail_claim(int), tq_mail_done(bigint, text), tq_mail_unpaid(), tq_mail_queue(text, text, text, text, text, text, text, text, text), tq_person_of(text, text) from public, anon, authenticated;
grant execute on function tq_mail_claim(int), tq_mail_done(bigint, text) to service_role;

-- every minute: if mail is waiting, wake the sender
create extension if not exists pg_net with schema extensions;
create or replace function tq_mail_kick() returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if exists (select 1 from tq_mail where sent_at is null and tries < 5) then
    perform net.http_post(url := 'https://vbylwccpccveazthdpmq.supabase.co/functions/v1/send-mail', body := '{}'::jsonb,
                          headers := '{"Content-Type":"application/json"}'::jsonb, timeout_milliseconds := 20000);
  end if;
end $$;
revoke all on function tq_mail_kick() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname in ('tarweeqa-mail', 'tarweeqa-unpaid');
select cron.schedule('tarweeqa-mail', '* * * * *', 'select public.tq_mail_kick()');
select cron.schedule('tarweeqa-unpaid', '0 10 * * *', 'select public.tq_mail_unpaid()');  -- 12:00 Cairo
