-- Rally tournaments: King of the hill, round robin and knockout brackets, with teams.
-- Run after schema.sql and rally2.sql. Safe to run again.
-- Matches inside a tournament are ordinary live_matches rows with tournament_id, round and slot set;
-- (tournament_id, round, slot) is unique, so several phones can create the next round at the same time safely.

create table if not exists public.tournaments (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 60),
  mode text not null check (mode in ('koth', 'round_robin', 'bracket')),
  cross_team boolean not null default true,
  draw text not null default 'random' check (draw in ('random', 'seeded')),
  seed int not null default floor(random() * 2147483646 + 1)::int,
  best_of int not null default 1 check (best_of in (1, 3, 5, 7)),
  target int not null default 11 check (target in (11, 21)),
  join_code text not null default lpad(floor(random() * 10000)::int::text, 4, '0'),
  status text not null default 'live' check (status in ('live', 'done')),
  champion uuid,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create table if not exists public.tournament_players (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 32),
  team text not null default '' check (char_length(team) <= 32),
  user_id uuid references auth.users(id) on delete set null,
  position int not null default 0,
  joined_round int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists tournament_players_t_idx on public.tournament_players (tournament_id, position);
create table if not exists public.tournament_keepers (
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (tournament_id, user_id)
);

alter table public.live_matches add column if not exists tournament_id uuid references public.tournaments(id) on delete cascade;
alter table public.live_matches add column if not exists round int;
alter table public.live_matches add column if not exists slot int;
alter table public.live_matches add column if not exists a_tp uuid references public.tournament_players(id) on delete cascade;
alter table public.live_matches add column if not exists b_tp uuid references public.tournament_players(id) on delete cascade;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'live_matches_tslot') then
    alter table public.live_matches add constraint live_matches_tslot unique (tournament_id, round, slot);
  end if;
end $$;
alter table public.live_matches drop constraint if exists live_matches_keepers_check;
alter table public.live_matches add constraint live_matches_keepers_check check (keepers in ('owner', 'players', 'club', 'tournament'));

-- Is the signed-in player the host or a scorekeeper of this tournament?
create or replace function public.rally_is_tkeeper(tid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    exists (select 1 from public.tournaments t where t.id = tid and t.owner = auth.uid())
    or exists (select 1 from public.tournament_keepers k where k.tournament_id = tid and k.user_id = auth.uid())
  )
$$;
-- Both players of a tournament match belong to that tournament.
create or replace function public.rally_tp_ok(tid uuid, a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select a is not null and b is not null and a <> b
    and (select count(*) from public.tournament_players p where p.tournament_id = tid and p.id in (a, b)) = 2
$$;
revoke all on function public.rally_is_tkeeper(uuid) from public, anon;
revoke all on function public.rally_tp_ok(uuid, uuid, uuid) from public, anon;
grant execute on function public.rally_is_tkeeper(uuid) to authenticated;
grant execute on function public.rally_tp_ok(uuid, uuid, uuid) to authenticated;

create or replace function public.rally_can_score(m public.live_matches) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    auth.uid() = m.owner
    or m.keepers = 'club'
    or (m.keepers = 'players' and auth.uid() in (m.a_user, m.b_user))
    or (m.keepers = 'tournament' and m.tournament_id is not null and public.rally_is_tkeeper(m.tournament_id))
    or exists (select 1 from public.match_keepers k where k.match_id = m.id and k.user_id = auth.uid())
  )
$$;
revoke all on function public.rally_can_score(public.live_matches) from public, anon, authenticated;

drop policy if exists "players start matches" on public.live_matches;
create policy "players start matches" on public.live_matches for insert to authenticated
  with check (owner = auth.uid() and status = 'live' and games = array['']::text[] and version = 0
    and (tournament_id is null or (keepers = 'tournament' and public.rally_is_tkeeper(tournament_id) and public.rally_tp_ok(tournament_id, a_tp, b_tp))));
drop policy if exists "owner removes match" on public.live_matches;
create policy "owner removes match" on public.live_matches for delete to authenticated
  using (owner = auth.uid() or (tournament_id is not null and games = array['']::text[] and public.rally_is_tkeeper(tournament_id)));

alter table public.tournaments enable row level security;
alter table public.tournament_players enable row level security;
alter table public.tournament_keepers enable row level security;
drop policy if exists "see tournaments" on public.tournaments;
create policy "see tournaments" on public.tournaments for select to authenticated using (true);
drop policy if exists "host tournaments" on public.tournaments;
create policy "host tournaments" on public.tournaments for insert to authenticated with check (owner = auth.uid() and status = 'live');
drop policy if exists "keepers update tournaments" on public.tournaments;
create policy "keepers update tournaments" on public.tournaments for update to authenticated using (public.rally_is_tkeeper(id)) with check (public.rally_is_tkeeper(id));
drop policy if exists "host deletes tournaments" on public.tournaments;
create policy "host deletes tournaments" on public.tournaments for delete to authenticated using (owner = auth.uid());
drop policy if exists "see tournament players" on public.tournament_players;
create policy "see tournament players" on public.tournament_players for select to authenticated using (true);
drop policy if exists "keepers manage players" on public.tournament_players;
create policy "keepers manage players" on public.tournament_players for all to authenticated using (public.rally_is_tkeeper(tournament_id)) with check (public.rally_is_tkeeper(tournament_id));
drop policy if exists "see own tournament keeper rows" on public.tournament_keepers;
create policy "see own tournament keeper rows" on public.tournament_keepers for select to authenticated using (user_id = auth.uid());
revoke all on public.tournaments, public.tournament_players, public.tournament_keepers from anon, authenticated;
grant select, insert, delete on public.tournaments to authenticated;
grant update (status, ended_at, champion) on public.tournaments to authenticated;
grant select, insert, update, delete on public.tournament_players to authenticated;
grant select on public.tournament_keepers to authenticated;

create or replace function public.join_tournament(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare tid uuid;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select id into tid from public.tournaments where join_code = p_code and status = 'live' order by created_at desc limit 1;
  if tid is null then raise exception 'no live tournament with that code'; end if;
  insert into public.tournament_keepers (tournament_id, user_id) values (tid, auth.uid()) on conflict do nothing;
  return tid;
end $$;
revoke all on function public.join_tournament(text) from public, anon;
grant execute on function public.join_tournament(text) to authenticated;

-- Finished matches go to the ladder tagged with their tournament's name.
create or replace function public.rally_publish(m public.live_matches) returns void
language plpgsql security definer set search_path = public as $$
declare wa int := 0; wb int := 0; g text; tname text;
begin
  foreach g in array m.games loop
    if g <> '' and public.rally_game_over(g, m.target) then
      if length(replace(g, '1', '')) > length(replace(g, '0', '')) then wa := wa + 1; else wb := wb + 1; end if;
    end if;
  end loop;
  if m.tournament_id is not null then select name into tname from public.tournaments where id = m.tournament_id; end if;
  insert into public.matches (id, data, ended_at, by)
  values (
    m.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'a', trim(m.a_name), 'b', trim(m.b_name),
      'aKey', lower(regexp_replace(trim(m.a_name), '\s+', ' ', 'g')),
      'bKey', lower(regexp_replace(trim(m.b_name), '\s+', ' ', 'g')),
      'bestOf', m.best_of, 'target', m.target, 'firstServer', m.first_server,
      'g', to_jsonb(array_remove(m.games, '')),
      'winner', case when wa > wb then 0 else 1 end,
      'gw', jsonb_build_array(wa, wb),
      'startedAt', (extract(epoch from m.started_at) * 1000)::bigint,
      'endedAt', (extract(epoch from coalesce(m.ended_at, now())) * 1000)::bigint,
      'tournament', tname,
      'tournamentId', m.tournament_id
    )),
    (extract(epoch from coalesce(m.ended_at, now())) * 1000)::bigint,
    m.owner::text
  )
  on conflict (id) do update set data = excluded.data, ended_at = excluded.ended_at;
end $$;
revoke all on function public.rally_publish(public.live_matches) from public, anon, authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'tournaments') then
    alter publication supabase_realtime add table public.tournaments;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'tournament_players') then
    alter publication supabase_realtime add table public.tournament_players;
  end if;
end $$;
