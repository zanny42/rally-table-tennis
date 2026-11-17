-- Rally 4: tournament fixes. Run after schema.sql, rally2.sql and rally3_tournaments.sql. Safe to run again.
--  1. Join codes are picked by the server, never repeat between two live tournaments (or two live matches),
--     and a client can no longer choose a code or a created_at to take over another tournament's code.
--  2. Tournament matches must have a round, a slot and two players of that tournament; their names, users,
--     format and scoring mode come from the tournament, and teammates can't be paired in a cross-team round robin.
--  3. Only the host edits or removes players; scorekeepers may add players (king of the hill, or before play starts).
--  4. The champion must be a player of the tournament.
--  5. Ladder entries of tournament matches belong to the host, and are removed when the tournament is deleted.
--  6. Undoing the last point of a finished bracket or round robin reopens the tournament.
--  7. Indexes for foreign keys and lookups, tighter grants on profiles, cheaper RLS checks.

-- ---------- 1. join codes ----------
create or replace function public.rally_free_code(kind text, self uuid default null) returns text
language plpgsql volatile security definer set search_path = public as $$
declare c text; i int := 0;
begin
  loop
    c := lpad(floor(random() * 10000)::int::text, 4, '0');
    if kind = 't' then
      exit when not exists (select 1 from public.tournaments where join_code = c and status = 'live' and id is distinct from self);
    else
      exit when not exists (select 1 from public.live_matches where join_code = c and status = 'live' and id is distinct from self);
    end if;
    i := i + 1;
    if i > 500 then raise exception 'no free join code, try again later'; end if;
  end loop;
  return c;
end $$;
revoke all on function public.rally_free_code(text, uuid) from public, anon, authenticated;

create unique index if not exists tournaments_live_code on public.tournaments (join_code) where status = 'live';
create unique index if not exists live_matches_live_code on public.live_matches (join_code) where status = 'live';

create or replace function public.rally_tournament_bi() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.join_code := public.rally_free_code('t', new.id);
  new.created_at := now();
  new.champion := null;
  new.ended_at := null;
  return new;
end $$;
create or replace function public.rally_tournament_bu() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'live' and old.status <> 'live'
     and exists (select 1 from public.tournaments where join_code = new.join_code and status = 'live' and id <> new.id) then
    new.join_code := public.rally_free_code('t', new.id);
  end if;
  if new.status = 'done' and new.ended_at is null then new.ended_at := now(); end if;
  if new.status = 'live' then new.ended_at := null; end if;
  return new;
end $$;
revoke all on function public.rally_tournament_bi() from public, anon, authenticated;
revoke all on function public.rally_tournament_bu() from public, anon, authenticated;
drop trigger if exists rally_tournament_bi on public.tournaments;
create trigger rally_tournament_bi before insert on public.tournaments for each row execute function public.rally_tournament_bi();
drop trigger if exists rally_tournament_bu on public.tournaments;
create trigger rally_tournament_bu before update on public.tournaments for each row execute function public.rally_tournament_bu();

-- ---------- 2. shape of tournament matches ----------
create or replace function public.rally_live_bi() returns trigger
language plpgsql security definer set search_path = public as $$
declare t public.tournaments; pa public.tournament_players; pb public.tournament_players;
begin
  new.join_code := public.rally_free_code('m', new.id);
  new.started_at := now();
  new.updated_at := now();
  new.ended_at := null;
  if new.tournament_id is null then
    new.round := null; new.slot := null; new.a_tp := null; new.b_tp := null;
  else
    select * into t from public.tournaments where id = new.tournament_id;
    select * into pa from public.tournament_players where id = new.a_tp and tournament_id = new.tournament_id;
    select * into pb from public.tournament_players where id = new.b_tp and tournament_id = new.tournament_id;
    if t.id is not null then new.best_of := t.best_of; new.target := t.target; new.keepers := 'tournament'; end if;
    if pa.id is not null then new.a_name := pa.name; new.a_user := pa.user_id; end if;
    if pb.id is not null then new.b_name := pb.name; new.b_user := pb.user_id; end if;
  end if;
  return new;
end $$;
create or replace function public.rally_live_bu() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'live' and old.status <> 'live'
     and exists (select 1 from public.live_matches where join_code = new.join_code and status = 'live' and id <> new.id) then
    new.join_code := public.rally_free_code('m', new.id);
  end if;
  return new;
end $$;
revoke all on function public.rally_live_bi() from public, anon, authenticated;
revoke all on function public.rally_live_bu() from public, anon, authenticated;
drop trigger if exists rally_live_bi on public.live_matches;
create trigger rally_live_bi before insert on public.live_matches for each row execute function public.rally_live_bi();
drop trigger if exists rally_live_bu on public.live_matches;
create trigger rally_live_bu before update on public.live_matches for each row execute function public.rally_live_bu();

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'live_matches_tournament_shape') then
    alter table public.live_matches add constraint live_matches_tournament_shape check (
      (tournament_id is null and keepers <> 'tournament')
      or (tournament_id is not null and keepers = 'tournament' and round is not null and slot is not null and a_tp is not null and b_tp is not null)
    ) not valid;
  end if;
end $$;

-- Both players belong to this live tournament; in a cross-team round robin they come from different teams.
create or replace function public.rally_tp_ok(tid uuid, a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select a is not null and b is not null and a <> b
    and exists (select 1 from public.tournaments t where t.id = tid and t.status = 'live')
    and (select count(*) from public.tournament_players p where p.tournament_id = tid and p.id in (a, b)) = 2
    and not exists (
      select 1 from public.tournaments t
        join public.tournament_players pa on pa.id = a
        join public.tournament_players pb on pb.id = b
      where t.id = tid and t.mode = 'round_robin' and t.cross_team
        and trim(pa.team) <> '' and lower(trim(pa.team)) = lower(trim(pb.team))
        and (select count(distinct trim(p.team)) from public.tournament_players p where p.tournament_id = tid and trim(p.team) <> '') >= 2
    )
$$;
revoke all on function public.rally_tp_ok(uuid, uuid, uuid) from public, anon;
grant execute on function public.rally_tp_ok(uuid, uuid, uuid) to authenticated;

drop policy if exists "players start matches" on public.live_matches;
create policy "players start matches" on public.live_matches for insert to authenticated
  with check (owner = (select auth.uid()) and status = 'live' and games = array['']::text[] and version = 0
    and (tournament_id is null or (keepers = 'tournament' and public.rally_is_tkeeper(tournament_id) and public.rally_tp_ok(tournament_id, a_tp, b_tp))));
drop policy if exists "owner removes match" on public.live_matches;
create policy "owner removes match" on public.live_matches for delete to authenticated
  using (owner = (select auth.uid()) or (tournament_id is not null and games = array['']::text[] and public.rally_is_tkeeper(tournament_id)));

-- ---------- 3. players ----------
create unique index if not exists tournament_players_name_key
  on public.tournament_players (tournament_id, lower(regexp_replace(trim(name), '\s+', ' ', 'g')));
drop policy if exists "keepers manage players" on public.tournament_players;
drop policy if exists "keepers add players" on public.tournament_players;
create policy "keepers add players" on public.tournament_players for insert to authenticated
  with check (public.rally_is_tkeeper(tournament_players.tournament_id) and exists (
    select 1 from public.tournaments t where t.id = tournament_players.tournament_id and t.status = 'live'
      and (t.mode = 'koth' or not exists (select 1 from public.live_matches m where m.tournament_id = t.id))));
drop policy if exists "host edits players" on public.tournament_players;
create policy "host edits players" on public.tournament_players for update to authenticated
  using (exists (select 1 from public.tournaments t where t.id = tournament_players.tournament_id and t.owner = (select auth.uid())))
  with check (exists (select 1 from public.tournaments t where t.id = tournament_players.tournament_id and t.owner = (select auth.uid())));
drop policy if exists "host removes players" on public.tournament_players;
create policy "host removes players" on public.tournament_players for delete to authenticated
  using (exists (select 1 from public.tournaments t where t.id = tournament_players.tournament_id and t.owner = (select auth.uid())));

-- ---------- 4. tournaments ----------
drop policy if exists "host tournaments" on public.tournaments;
create policy "host tournaments" on public.tournaments for insert to authenticated
  with check (owner = (select auth.uid()) and status = 'live');
drop policy if exists "keepers update tournaments" on public.tournaments;
create policy "keepers update tournaments" on public.tournaments for update to authenticated
  using (public.rally_is_tkeeper(id))
  with check (public.rally_is_tkeeper(id)
    and (champion is null or exists (select 1 from public.tournament_players p where p.id = tournaments.champion and p.tournament_id = tournaments.id)));
drop policy if exists "host deletes tournaments" on public.tournaments;
create policy "host deletes tournaments" on public.tournaments for delete to authenticated using (owner = (select auth.uid()));
drop policy if exists "see own tournament keeper rows" on public.tournament_keepers;
create policy "see own tournament keeper rows" on public.tournament_keepers for select to authenticated using (user_id = (select auth.uid()));

-- ---------- 5. ladder ----------
create or replace function public.rally_publish(m public.live_matches) returns void
language plpgsql security definer set search_path = public as $$
declare wa int := 0; wb int := 0; g text; tname text; towner uuid;
begin
  foreach g in array m.games loop
    if g <> '' and public.rally_game_over(g, m.target) then
      if length(replace(g, '1', '')) > length(replace(g, '0', '')) then wa := wa + 1; else wb := wb + 1; end if;
    end if;
  end loop;
  if m.tournament_id is not null then select name, owner into tname, towner from public.tournaments where id = m.tournament_id; end if;
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
    coalesce(towner, m.owner)::text
  )
  on conflict (id) do update set data = excluded.data, ended_at = excluded.ended_at, by = excluded.by;
end $$;
revoke all on function public.rally_publish(public.live_matches) from public, anon, authenticated;

create index if not exists matches_tournament_idx on public.matches ((data->>'tournamentId')) where data ? 'tournamentId';
create or replace function public.rally_tournament_ad() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.matches where data ? 'tournamentId' and data->>'tournamentId' = old.id::text;
  return old;
end $$;
revoke all on function public.rally_tournament_ad() from public, anon, authenticated;
drop trigger if exists rally_tournament_ad on public.tournaments;
create trigger rally_tournament_ad after delete on public.tournaments for each row execute function public.rally_tournament_ad();
-- Ladder rows left behind by tournaments deleted before this file ran. Uncomment to remove them:
-- delete from public.matches m where m.data ? 'tournamentId'
--   and not exists (select 1 from public.tournaments t where t.id::text = m.data->>'tournamentId');

-- ---------- 6. undo reopens a finished bracket / round robin ----------
create or replace function public.undo_point(p_id uuid) returns public.live_matches
language plpgsql security definer set search_path = public as $$
declare m public.live_matches; g text[]; n int; was_done boolean;
begin
  select * into m from public.live_matches where id = p_id for update;
  if not found then raise exception 'match not found'; end if;
  if not public.rally_can_score(m) then raise exception 'not allowed to score this match' using errcode = '42501'; end if;
  g := m.games; n := array_length(g, 1);
  if n > 1 and g[n] = '' then g := g[1:n - 1]; n := n - 1; end if;
  if g[n] = '' then return m; end if;
  g[n] := left(g[n], length(g[n]) - 1);
  was_done := m.status = 'done';
  if was_done then delete from public.matches where id = m.id::text; end if;
  update public.live_matches set games = g, status = 'live', ended_at = null, updated_at = now(), version = version + 1
    where id = p_id returning * into m;
  if was_done and m.tournament_id is not null then
    update public.tournaments set status = 'live', champion = null, ended_at = null
      where id = m.tournament_id and status = 'done' and mode <> 'koth';
  end if;
  return m;
end $$;
revoke all on function public.undo_point(uuid) from public, anon;
grant execute on function public.undo_point(uuid) to authenticated;

-- ---------- 7. indexes and grants ----------
create index if not exists live_matches_a_tp_idx on public.live_matches (a_tp);
create index if not exists live_matches_b_tp_idx on public.live_matches (b_tp);
create index if not exists live_matches_owner_idx on public.live_matches (owner);
create index if not exists live_matches_a_user_idx on public.live_matches (a_user);
create index if not exists live_matches_b_user_idx on public.live_matches (b_user);
create index if not exists match_keepers_user_idx on public.match_keepers (user_id);
create index if not exists tournament_keepers_user_idx on public.tournament_keepers (user_id);
create index if not exists tournament_players_user_idx on public.tournament_players (user_id);
create index if not exists tournaments_owner_idx on public.tournaments (owner);
create index if not exists tournaments_created_idx on public.tournaments (created_at desc);

-- Supabase's default grants gave signed-in users insert/delete/truncate on profiles; the app only updates the name.
revoke insert, update, delete, truncate, references, trigger on public.profiles from authenticated;
grant select on public.profiles to authenticated;
grant update (name) on public.profiles to authenticated;
revoke insert, truncate, references, trigger on public.matches from authenticated;
revoke update on public.tournament_players from authenticated;
grant update (name, team, position, joined_round, user_id) on public.tournament_players to authenticated;
