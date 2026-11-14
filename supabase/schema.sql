-- Rally shared ladder. Run once in your Supabase project's SQL editor.
-- Anyone with the app can read and add matches.
-- A match can only be deleted by the phone that logged it (matched by the x-device-id header the app sends).
-- Nobody can edit a saved match.

create table if not exists public.matches (
  id          text primary key check (char_length(id) between 6 and 40),
  data        jsonb not null,
  ended_at    bigint not null,
  by          text not null check (char_length(by) between 6 and 64),
  created_at  timestamptz not null default now()
);

create index if not exists matches_ended_at_idx on public.matches (ended_at);

alter table public.matches enable row level security;

drop policy if exists "read matches" on public.matches;
create policy "read matches" on public.matches
  for select to anon using (true);

drop policy if exists "add matches" on public.matches;
create policy "add matches" on public.matches
  for insert to anon
  with check (
    pg_column_size(data) < 20000
    and by = coalesce(current_setting('request.headers', true)::json->>'x-device-id', '')
  );

drop policy if exists "delete own matches" on public.matches;
create policy "delete own matches" on public.matches
  for delete to anon
  using (by = coalesce(current_setting('request.headers', true)::json->>'x-device-id', ''));

grant select, insert, delete on public.matches to anon;
