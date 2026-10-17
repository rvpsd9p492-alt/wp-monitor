-- WP-Monitor: Cloud-Sicherung (gleiches Supabase-Projekt wie die Leichtathletik-App, eigene Tabelle).
-- Von Hand im Supabase-Dashboard ausführen: SQL Editor → New query → einfügen → Run.
-- Das Skript kann gefahrlos mehrfach ausgeführt werden.

-- Ein Datensatz je Ablesung, Tarif, Investition … bzw. die Konfiguration, getrennt nach Benutzer.
create table if not exists public.wp_records (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text        not null check (kind in ('reading', 'tariff', 'relief', 'degree_day', 'baseline',
                                                  'investment', 'event', 'config')),
  id         text        not null,
  data       jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null,                -- Zeitpunkt der Änderung auf dem Gerät: neuere Änderung gewinnt
  server_at  timestamptz not null default now(),  -- Zeitpunkt auf dem Server: "was ist neu seit …"
  primary key (user_id, kind, id)
);

create index if not exists wp_records_user_server_at on public.wp_records (user_id, server_at);

-- Zeilenweise Zugriffsrechte: jeder Benutzer sieht und ändert nur seine eigenen Daten.
alter table public.wp_records enable row level security;

drop policy if exists "wp_records_select_own" on public.wp_records;
drop policy if exists "wp_records_insert_own" on public.wp_records;
drop policy if exists "wp_records_update_own" on public.wp_records;
create policy "wp_records_select_own" on public.wp_records
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "wp_records_insert_own" on public.wp_records
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "wp_records_update_own" on public.wp_records
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

revoke all on public.wp_records from anon, authenticated;
grant select, insert, update on public.wp_records to authenticated;

-- Ältere Änderungen überschreiben nie neuere (z. B. ein Gerät, das lange offline war).
create or replace function public.wp_records_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return old;
  end if;
  new.server_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists wp_records_touch on public.wp_records;
create trigger wp_records_touch
  before insert or update on public.wp_records
  for each row execute function public.wp_records_touch();
