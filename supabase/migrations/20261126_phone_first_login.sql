-- Tarweeqa — phone-first sign-in (migration phone_first_login, 2026-11-26)
-- After moving to tarweaqa.com every browser started fresh, and accounts made before PINs existed could not get in.
-- * tq_check_phone: is this number registered, and does it have a PIN? (decides the next screen)
-- * tq_login: an account with no PIN yet signs in with the phone alone and is then asked to set a PIN.

create or replace function tq_check_phone(p_token text, p_phone text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ph text := tq_norm_phone(p_phone); p tq_persons;
begin
  if p_token is null or length(p_token) < 24 then raise exception 'bad token'; end if;
  if length(ph) < 10 then raise exception 'bad phone'; end if;
  select * into p from tq_persons where phone = ph;
  return jsonb_build_object('exists', p.uid is not null, 'hasPin', p.pin_hash is not null,
    'locked', coalesce(p.locked_until, 0) > tq_now(), 'until', p.locked_until);
end $$;

create or replace function tq_login(p_token text, p_phone text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare ph text := tq_norm_phone(p_phone); p tq_persons; now_ms bigint := tq_now(); ok boolean := false; viacode boolean := false;
begin
  if p_token is null or length(p_token) < 24 then raise exception 'bad token'; end if;
  select * into p from tq_persons where phone = ph for update;
  if p.uid is null then return jsonb_build_object('error', 'no_account'); end if;
  if p.locked_until > now_ms then return jsonb_build_object('error', 'locked', 'until', p.locked_until); end if;
  if p.pin_hash is null and (p.reset_hash is null or p.reset_until < now_ms) then
    ok := true;   -- account from before PINs: let them in once, the app asks for a PIN right away
  elsif p.pin_hash is not null and crypt(coalesce(p_pin, ''), p.pin_hash) = p.pin_hash then ok := true;
  elsif p.reset_hash is not null and p.reset_until >= now_ms and crypt(coalesce(p_pin, ''), p.reset_hash) = p.reset_hash then ok := true; viacode := true;
  end if;
  if not ok then
    if p.fails + 1 >= 5 then
      update tq_persons set fails = 0, locked_until = now_ms + 15 * 60000 where uid = p.uid;
      return jsonb_build_object('error', 'locked', 'until', now_ms + 15 * 60000);
    end if;
    update tq_persons set fails = p.fails + 1 where uid = p.uid;
    return jsonb_build_object('error', 'wrong_pin', 'left', 5 - (p.fails + 1));
  end if;
  update tq_persons set fails = 0, locked_until = 0, last_seen = now_ms,
    reset_hash = case when viacode then null else reset_hash end,
    reset_until = case when viacode then null else reset_until end,
    must_set_pin = case when viacode then true else must_set_pin end
  where uid = p.uid;
  insert into tq_people(token_hash, uid) values (tq_hash(p_token), p.uid)
  on conflict (token_hash) do update set uid = excluded.uid;
  return jsonb_build_object('uid', p.uid, 'person', tq_person_json(p.uid));
end $$;

revoke execute on function tq_check_phone(text, text) from public;
grant execute on function tq_check_phone(text, text), tq_login(text, text, text) to anon, authenticated;
