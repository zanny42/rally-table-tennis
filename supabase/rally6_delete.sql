-- Rally 6: deleting finished matches and tournaments. Run after rally5_doubles.sql. Safe to run again.
-- Who can delete:
--   a match (and its ladder result): whoever started it, either player on it (a_user / b_user), or a club admin.
--     Tournament matches are removed by deleting their tournament, so the bracket never loses a played match.
--   a tournament (its matches, players and ladder results go with it): its host, or a club admin.
-- Club admins are listed in club_admins. Make someone an admin in the SQL editor:
--   insert into public.club_admins (user_id) values ('<their user id>') on conflict do nothing;

create table if not exists public.club_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.club_admins enable row level security;
drop policy if exists "see own admin row" on public.club_admins;
create policy "see own admin row" on public.club_admins for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.club_admins from anon, authenticated;
grant select on public.club_admins to authenticated;

create or replace function public.rally_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select (select auth.uid()) is not null and exists (select 1 from public.club_admins where user_id = (select auth.uid()))
$$;
revoke all on function public.rally_is_admin() from public, anon;
grant execute on function public.rally_is_admin() to authenticated;

-- May the signed-in player delete this ladder result? (its id is the match's id)
create or replace function public.rally_can_delete_result(rid text, rby text) returns boolean
language sql stable security definer set search_path = public as $$
  select (select auth.uid()) is not null and (
    rby = (select auth.uid())::text
    or public.rally_is_admin()
    or exists (select 1 from public.live_matches lm where lm.id::text = rid and lm.tournament_id is null
               and (select auth.uid()) in (lm.owner, lm.a_user, lm.b_user))
  )
$$;
revoke all on function public.rally_can_delete_result(text, text) from public, anon;
grant execute on function public.rally_can_delete_result(text, text) to authenticated;

-- Ladder results. The first version's device-id rule is gone: a request header could claim any id.
drop policy if exists "delete own matches" on public.matches;
drop policy if exists "players delete own matches" on public.matches;
drop policy if exists "delete results" on public.matches;
create policy "delete results" on public.matches for delete to authenticated
  using (public.rally_can_delete_result(id, by) and not (data ? 'tournamentId' and exists (select 1 from public.tournaments t where t.id::text = data->>'tournamentId')));
revoke delete on public.matches from anon;
grant delete on public.matches to authenticated;

-- Matches. Unchanged: the host deletes their match; tournament keepers remove unstarted tournament matches.
-- New: a player on a finished match, or a club admin, deletes it (not inside a tournament).
drop policy if exists "owner removes match" on public.live_matches;
create policy "owner removes match" on public.live_matches for delete to authenticated
  using (owner = (select auth.uid())
    or (tournament_id is not null and games = array['']::text[] and public.rally_is_tkeeper(tournament_id))
    or (tournament_id is null and (public.rally_is_admin() or (status = 'done' and (select auth.uid()) in (a_user, b_user)))));

-- Deleting a match also deletes its ladder result.
create or replace function public.rally_live_ad() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.matches where id = old.id::text;
  return old;
end $$;
revoke all on function public.rally_live_ad() from public, anon, authenticated;
drop trigger if exists rally_live_ad on public.live_matches;
create trigger rally_live_ad after delete on public.live_matches for each row execute function public.rally_live_ad();

-- Tournaments: the host or a club admin.
drop policy if exists "host deletes tournaments" on public.tournaments;
create policy "host deletes tournaments" on public.tournaments for delete to authenticated
  using (owner = (select auth.uid()) or public.rally_is_admin());
