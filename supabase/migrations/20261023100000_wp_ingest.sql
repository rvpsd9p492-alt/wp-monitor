-- WP-Monitor: Zählerstände automatisch übernehmen (z. B. aus Home Assistant).
-- Jeder Benutzer kann einen geheimen Schlüssel erzeugen (in der App unter Sicherung → Home Assistant).
-- Damit ruft Home Assistant die Funktion wp_ingest auf, die Ablesungen in wp_records anlegt; die App übernimmt sie
-- beim nächsten Abgleich. Der Schlüssel ist die Berechtigung (Home Assistant meldet sich nicht an).
-- Das Skript kann gefahrlos mehrfach ausgeführt werden.

create table if not exists public.wp_ingest_tokens (
  user_id    uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  token      text        not null unique check (length(token) >= 24),
  created_at timestamptz not null default now()
);

alter table public.wp_ingest_tokens enable row level security;
revoke all on public.wp_ingest_tokens from anon, authenticated;

drop policy if exists "wp_ingest_tokens_select_own" on public.wp_ingest_tokens;
drop policy if exists "wp_ingest_tokens_insert_own" on public.wp_ingest_tokens;
drop policy if exists "wp_ingest_tokens_update_own" on public.wp_ingest_tokens;
drop policy if exists "wp_ingest_tokens_delete_own" on public.wp_ingest_tokens;
create policy "wp_ingest_tokens_select_own" on public.wp_ingest_tokens
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "wp_ingest_tokens_insert_own" on public.wp_ingest_tokens
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "wp_ingest_tokens_update_own" on public.wp_ingest_tokens
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "wp_ingest_tokens_delete_own" on public.wp_ingest_tokens
  for delete to authenticated using ((select auth.uid()) = user_id);
grant select, insert, update, delete on public.wp_ingest_tokens to authenticated;

-- Legt zum Schlüssel je Zähler eine Ablesung an. p_values: {"hp_heat_total": "123.4", …} (Zahlen oder Text, Komma
-- oder Punkt). Nicht übernommen (mit Grund in "skipped"): unbekannte Zähler, keine Zahl (z. B. "unavailable"),
-- negative Werte, Werte unter dem Vorwert (Zählerrücksprung → in der App mit „Reset“ erfassen), eine Ablesung
-- innerhalb von 6 Stunden davor oder danach (begrenzt die Datenmenge auf dem Gerät).
create or replace function public.wp_ingest(p_token text, p_values jsonb, p_ts timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_ts timestamptz := coalesce(p_ts, now());
  v_now timestamptz := clock_timestamp();
  v_key text; v_raw jsonb; v_txt text; v_val numeric; v_prev numeric; v_id text;
  v_saved jsonb := '[]'::jsonb; v_skipped jsonb := '[]'::jsonb;
  v_allowed constant text[] := array['house_el', 'hp_el', 'hp_heat_total', 'hp_heat_heating', 'hp_heat_dhw',
    'hp_el_ctrl_total', 'hp_el_heating', 'hp_el_dhw', 'hp_el_backup_heating', 'hp_el_backup_dhw',
    'hp_compressor_starts_heating', 'hp_compressor_starts_dhw', 'hp_compressor_hours_heating', 'hp_compressor_hours_dhw'];
begin
  if p_token is null or length(p_token) < 24 then return jsonb_build_object('error', 'Schlüssel ungültig'); end if;
  select user_id into v_user from public.wp_ingest_tokens where token = p_token;
  if v_user is null then return jsonb_build_object('error', 'Schlüssel ungültig'); end if;
  if v_ts > now() + interval '5 minutes' or v_ts < now() - interval '400 days' then
    return jsonb_build_object('error', 'Zeitpunkt unplausibel');
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'object' then
    return jsonb_build_object('error', 'values muss ein Objekt {Zähler: Wert} sein');
  end if;

  for v_key, v_raw in select key, value from jsonb_each(p_values) loop
    if not (v_key = any (v_allowed)) then
      v_skipped := v_skipped || jsonb_build_object('meter', v_key, 'reason', 'unbekannter Zähler'); continue;
    end if;
    v_txt := replace(trim(both '"' from v_raw::text), ',', '.');
    if v_txt !~ '^-?[0-9]+(\.[0-9]+)?$' then
      v_skipped := v_skipped || jsonb_build_object('meter', v_key, 'reason', 'keine Zahl: ' || left(v_txt, 30)); continue;
    end if;
    v_val := v_txt::numeric;
    if v_val < 0 then
      v_skipped := v_skipped || jsonb_build_object('meter', v_key, 'reason', 'negativ'); continue;
    end if;
    if exists (select 1 from public.wp_records r
               where r.user_id = v_user and r.kind = 'reading' and not r.deleted and r.data ->> 'meter' = v_key
                 and abs(extract(epoch from ((r.data ->> 'ts')::timestamptz - v_ts))) < 6 * 3600) then
      v_skipped := v_skipped || jsonb_build_object('meter', v_key, 'reason', 'Ablesung innerhalb von 6 h vorhanden'); continue;
    end if;
    select (r.data ->> 'value')::numeric into v_prev from public.wp_records r
      where r.user_id = v_user and r.kind = 'reading' and not r.deleted and r.data ->> 'meter' = v_key
        and (r.data ->> 'ts')::timestamptz < v_ts
      order by (r.data ->> 'ts')::timestamptz desc limit 1;
    if v_prev is not null and v_val < v_prev - 0.0001 then
      v_skipped := v_skipped || jsonb_build_object('meter', v_key, 'reason', 'kleiner als Vorwert ' || v_prev); continue;
    end if;
    v_id := gen_random_uuid()::text;
    insert into public.wp_records (user_id, kind, id, data, deleted, updated_at)
    values (v_user, 'reading', v_id, jsonb_build_object(
      'id', v_id, 'meter', v_key, 'value', v_val, 'reset', false, 'note', null, 'source', 'ha',
      'ts', to_char(v_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'updatedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), false, v_now);
    v_saved := v_saved || to_jsonb(v_key);
  end loop;
  return jsonb_build_object('saved', v_saved, 'skipped', v_skipped);
end;
$$;

revoke all on function public.wp_ingest(text, jsonb, timestamptz) from public;
grant execute on function public.wp_ingest(text, jsonb, timestamptz) to anon, authenticated;
