-- Rally 2.0: player accounts, shared live matches and server-side scoring.
-- Run after schema.sql. Safe to run again.

-- Profiles: one per signed-in player, created automatically at sign-up.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 32),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "profiles readable by players" on public.profiles;
create policy "profiles readable by players" on public.profiles for select to authenticated using (true);
drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
revoke all on public.profiles from anon;
grant select, update on public.profiles to authenticated;

create or replace function public.rally_new_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name)
  values (new.id, left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), split_part(new.email, '@', 1), 'Player'), 32))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists rally_on_new_user on auth.users;
create trigger rally_on_new_user after insert on auth.users for each row execute function public.rally_new_profile();

-- Live matches. Points are only ever added through score_point / undo_point.
create table if not exists public.live_matches (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  a_name text not null check (char_length(trim(a_name)) between 1 and 32),
  b_name text not null check (char_length(trim(b_name)) between 1 and 32),
  a_user uuid references auth.users(id) on delete set null,
  b_user uuid references auth.users(id) on delete set null,
  best_of int not null default 3 check (best_of in (1, 3, 5, 7)),
  target int not null default 11 check (target in (11, 21)),
  first_server int not null default 0 check (first_server in (0, 1)),
  keepers text not null default 'players' check (keepers in ('owner', 'players', 'club')),
  join_code text not null default lpad(floor(random() * 10000)::int::text, 4, '0'),
  games text[] not null default array['']::text[],
  status text not null default 'live' check (status in ('live', 'done')),
  version int not null default 0,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz,
  constraint live_names_differ check (lower(trim(a_name)) <> lower(trim(b_name)))
);
create index if not exists live_matches_status_idx on public.live_matches (status, updated_at desc);
create table if not exists public.match_keepers (
  match_id uuid not null references public.live_matches(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (match_id, user_id)
);
alter table public.live_matches enable row level security;
alter table public.match_keepers enable row level security;
drop policy if exists "players see live matches" on public.live_matches;
create policy "players see live matches" on public.live_matches for select to authenticated using (true);
drop policy if exists "players start matches" on public.live_matches;
create policy "players start matches" on public.live_matches for insert to authenticated with check (owner = auth.uid() and status = 'live' and games = array['']::text[] and version = 0);
drop policy if exists "owner removes match" on public.live_matches;
create policy "owner removes match" on public.live_matches for delete to authenticated using (owner = auth.uid());
drop policy if exists "see own keeper rows" on public.match_keepers;
create policy "see own keeper rows" on public.match_keepers for select to authenticated using (user_id = auth.uid());
revoke all on public.live_matches from anon, authenticated;
revoke all on public.match_keepers from anon, authenticated;
grant select, insert, delete on public.live_matches to authenticated;
grant select on public.match_keepers to authenticated;

-- Ladder table: signed-in players read it and may delete entries they own.
drop policy if exists "players read matches" on public.matches;
create policy "players read matches" on public.matches for select to authenticated using (true);
drop policy if exists "players delete own matches" on public.matches;
create policy "players delete own matches" on public.matches for delete to authenticated using (by = auth.uid()::text);
grant select, delete on public.matches to authenticated;

create or replace function public.rally_game_over(s text, t int) returns boolean
language sql immutable set search_path = public as $$
  select greatest(a, b) >= t and abs(a - b) >= 2
  from (select length(replace(s, '1', '')) as a, length(replace(s, '0', '')) as b) x
$$;

create or replace function public.rally_can_score(m public.live_matches) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    auth.uid() = m.owner
    or m.keepers = 'club'
    or (m.keepers = 'players' and auth.uid() in (m.a_user, m.b_user))
    or exists (select 1 from public.match_keepers k where k.match_id = m.id and k.user_id = auth.uid())
  )
$$;

-- Copies a finished match onto the ladder (public.matches) in the format the app reads.
create or replace function public.rally_publish(m public.live_matches) returns void
language plpgsql security definer set search_path = public as $$
declare wa int := 0; wb int := 0; g text;
begin
  foreach g in array m.games loop
    if g <> '' and public.rally_game_over(g, m.target) then
      if length(replace(g, '1', '')) > length(replace(g, '0', '')) then wa := wa + 1; else wb := wb + 1; end if;
    end if;
  end loop;
  insert into public.matches (id, data, ended_at, by)
  values (
    m.id::text,
    jsonb_build_object(
      'a', trim(m.a_name), 'b', trim(m.b_name),
      'aKey', lower(regexp_replace(trim(m.a_name), '\s+', ' ', 'g')),
      'bKey', lower(regexp_replace(trim(m.b_name), '\s+', ' ', 'g')),
      'bestOf', m.best_of, 'target', m.target, 'firstServer', m.first_server,
      'g', to_jsonb(array_remove(m.games, '')),
      'winner', case when wa > wb then 0 else 1 end,
      'gw', jsonb_build_array(wa, wb),
      'startedAt', (extract(epoch from m.started_at) * 1000)::bigint,
      'endedAt', (extract(epoch from coalesce(m.ended_at, now())) * 1000)::bigint
    ),
    (extract(epoch from coalesce(m.ended_at, now())) * 1000)::bigint,
    m.owner::text
  )
  on conflict (id) do update set data = excluded.data, ended_at = excluded.ended_at;
end $$;

create or replace function public.score_point(p_id uuid, p_player int) returns public.live_matches
language plpgsql security definer set search_path = public as $$
declare m public.live_matches; g text[]; n int; need int; wa int := 0; wb int := 0; i int;
begin
  if p_player not in (0, 1) then raise exception 'player must be 0 or 1'; end if;
  select * into m from public.live_matches where id = p_id for update;
  if not found then raise exception 'match not found'; end if;
  if not public.rally_can_score(m) then raise exception 'not allowed to score this match' using errcode = '42501'; end if;
  if m.status <> 'live' then return m; end if;
  g := m.games; n := array_length(g, 1);
  g[n] := g[n] || p_player::text;
  need := (m.best_of + 1) / 2;
  for i in 1..n loop
    if public.rally_game_over(g[i], m.target) then
      if length(replace(g[i], '1', '')) > length(replace(g[i], '0', '')) then wa := wa + 1; else wb := wb + 1; end if;
    end if;
  end loop;
  if wa >= need or wb >= need then
    update public.live_matches set games = g, status = 'done', ended_at = now(), updated_at = now(), version = version + 1
      where id = p_id returning * into m;
    perform public.rally_publish(m);
  else
    if public.rally_game_over(g[n], m.target) then g := g || ''::text; end if;
    update public.live_matches set games = g, updated_at = now(), version = version + 1 where id = p_id returning * into m;
  end if;
  return m;
end $$;

create or replace function public.undo_point(p_id uuid) returns public.live_matches
language plpgsql security definer set search_path = public as $$
declare m public.live_matches; g text[]; n int;
begin
  select * into m from public.live_matches where id = p_id for update;
  if not found then raise exception 'match not found'; end if;
  if not public.rally_can_score(m) then raise exception 'not allowed to score this match' using errcode = '42501'; end if;
  g := m.games; n := array_length(g, 1);
  if n > 1 and g[n] = '' then g := g[1:n - 1]; n := n - 1; end if;
  if g[n] = '' then return m; end if;
  g[n] := left(g[n], length(g[n]) - 1);
  if m.status = 'done' then delete from public.matches where id = m.id::text; end if;
  update public.live_matches set games = g, status = 'live', ended_at = null, updated_at = now(), version = version + 1
    where id = p_id returning * into m;
  return m;
end $$;

create or replace function public.join_match(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare mid uuid;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select id into mid from public.live_matches where join_code = p_code and status = 'live' order by started_at desc limit 1;
  if mid is null then raise exception 'no live match with that code'; end if;
  insert into public.match_keepers (match_id, user_id) values (mid, auth.uid()) on conflict do nothing;
  return mid;
end $$;

revoke all on function public.rally_can_score(public.live_matches) from public, anon, authenticated;
revoke all on function public.rally_publish(public.live_matches) from public, anon, authenticated;
revoke all on function public.rally_new_profile() from public, anon, authenticated;
revoke all on function public.score_point(uuid, int) from public, anon;
revoke all on function public.undo_point(uuid) from public, anon;
revoke all on function public.join_match(text) from public, anon;
grant execute on function public.score_point(uuid, int) to authenticated;
grant execute on function public.undo_point(uuid) to authenticated;
grant execute on function public.join_match(text) to authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_matches') then
    alter publication supabase_realtime add table public.live_matches;
  end if;
end $$;
