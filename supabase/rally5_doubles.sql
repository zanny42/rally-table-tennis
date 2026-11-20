-- Rally 5: doubles (2v2). Run after rally4_fixes.sql. Safe to run again.
-- A doubles match keeps the orange pair in a_name + a2_name and the white pair in b_name + b2_name.
-- picks[g] = {"s": 0|1, "r": 0|1}: the server the serving pair chose for game g (and, in game 1, the receiver).
-- The app works out the full serve rotation from these (www/rules.js, doublesAt).

alter table public.live_matches add column if not exists kind text not null default 'singles';
alter table public.live_matches add column if not exists a2_name text;
alter table public.live_matches add column if not exists b2_name text;
alter table public.live_matches add column if not exists picks jsonb not null default '[]'::jsonb;

create or replace function public.rally_key(n text) returns text
language sql immutable set search_path = public as $$ select lower(regexp_replace(trim(n), '\s+', ' ', 'g')) $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'live_matches_kind') then
    alter table public.live_matches add constraint live_matches_kind check (
      (kind = 'singles' and a2_name is null and b2_name is null)
      or (kind = 'doubles' and tournament_id is null
          and char_length(trim(a2_name)) between 1 and 32 and char_length(trim(b2_name)) between 1 and 32
          and public.rally_key(a2_name) not in (public.rally_key(a_name), public.rally_key(b_name), public.rally_key(b2_name))
          and public.rally_key(b2_name) not in (public.rally_key(a_name), public.rally_key(b_name)))
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'live_matches_picks') then
    alter table public.live_matches add constraint live_matches_picks check (jsonb_typeof(picks) = 'array' and jsonb_array_length(picks) <= 7);
  end if;
end $$;

-- Choose who serves (and, in game 1, who receives) before the first point of a game.
create or replace function public.set_pick(p_id uuid, p_game int, p_server int, p_receiver int default 0) returns public.live_matches
language plpgsql security definer set search_path = public as $$
declare m public.live_matches; n int; i int; arr jsonb := '[]'::jsonb;
begin
  select * into m from public.live_matches where id = p_id for update;
  if not found then raise exception 'match not found'; end if;
  if not public.rally_can_score(m) then raise exception 'not allowed to score this match' using errcode = '42501'; end if;
  if m.kind <> 'doubles' or m.status <> 'live' then raise exception 'not a live doubles match'; end if;
  n := coalesce(array_length(m.games, 1), 1);
  if p_game <> n - 1 or m.games[n] <> '' then raise exception 'the server is chosen before the first point of a game'; end if;
  if p_server not in (0, 1) or p_receiver not in (0, 1) then raise exception 'bad pick'; end if;
  for i in 0 .. p_game - 1 loop
    arr := arr || jsonb_build_array(coalesce(m.picks -> i, '{"s":0,"r":0}'::jsonb));
  end loop;
  arr := arr || jsonb_build_array(jsonb_build_object('s', p_server, 'r', p_receiver));
  update public.live_matches set picks = arr, updated_at = now(), version = version + 1 where id = p_id returning * into m;
  return m;
end $$;
revoke all on function public.set_pick(uuid, int, int, int) from public, anon;
grant execute on function public.set_pick(uuid, int, int, int) to authenticated;

-- Finished matches go to the ladder. Doubles are saved as pairs ("Ali & Sam"), keyed by both names in either order.
create or replace function public.rally_publish(m public.live_matches) returns void
language plpgsql security definer set search_path = public as $$
declare wa int := 0; wb int := 0; g text; tname text; towner uuid; dbl boolean := m.kind = 'doubles';
  an text; bn text; ak text; bk text;
begin
  foreach g in array m.games loop
    if g <> '' and public.rally_game_over(g, m.target) then
      if length(replace(g, '1', '')) > length(replace(g, '0', '')) then wa := wa + 1; else wb := wb + 1; end if;
    end if;
  end loop;
  if m.tournament_id is not null then select name, owner into tname, towner from public.tournaments where id = m.tournament_id; end if;
  if dbl then
    an := trim(m.a_name) || ' & ' || trim(m.a2_name); bn := trim(m.b_name) || ' & ' || trim(m.b2_name);
    ak := least(public.rally_key(m.a_name) collate "C", public.rally_key(m.a2_name) collate "C") || ' & ' || greatest(public.rally_key(m.a_name) collate "C", public.rally_key(m.a2_name) collate "C");
    bk := least(public.rally_key(m.b_name) collate "C", public.rally_key(m.b2_name) collate "C") || ' & ' || greatest(public.rally_key(m.b_name) collate "C", public.rally_key(m.b2_name) collate "C");
  else
    an := trim(m.a_name); bn := trim(m.b_name); ak := public.rally_key(m.a_name); bk := public.rally_key(m.b_name);
  end if;
  insert into public.matches (id, data, ended_at, by)
  values (
    m.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'a', an, 'b', bn, 'aKey', ak, 'bKey', bk,
      'kind', case when dbl then 'doubles' end,
      'ap', case when dbl then jsonb_build_array(trim(m.a_name), trim(m.a2_name)) end,
      'bp', case when dbl then jsonb_build_array(trim(m.b_name), trim(m.b2_name)) end,
      'picks', case when dbl then m.picks end,
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
