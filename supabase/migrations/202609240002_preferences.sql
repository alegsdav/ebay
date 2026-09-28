-- Per-user/per-server search defaults. No browser access or cross-user lookup.
create table public.scout_user_defaults (
  owner_id text not null,
  guild_id text not null,
  config jsonb not null,
  primary key(owner_id,guild_id)
);
alter table public.scout_user_defaults enable row level security;
revoke all on public.scout_user_defaults from public,anon,authenticated;
grant all on public.scout_user_defaults to service_role;

-- Globally cap active Marketplace watches for this deployment/free-tier account.
-- A trigger covers confirmation, updates and resumes, not just the command UI.
create function public.scout_limit_marketplace_watches() returns trigger
language plpgsql set search_path=public as $$
begin
  if new.active and new.config->'sources' @> '["facebook_marketplace"]'::jsonb then
    perform pg_advisory_xact_lock(24092410);
    if (select count(*) from scout_watches where active
        and config->'sources' @> '["facebook_marketplace"]'::jsonb
        and id<>new.id) >= 10 then
      raise exception 'Maximum 10 active Marketplace watches. Pause or delete one first.';
    end if;
    if coalesce((new.config->>'intervalMinutes')::integer,0) < 1440 then
      raise exception 'Free-tier Marketplace watches require at least 1440 minutes between searches.';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.scout_limit_marketplace_watches() from public,anon,authenticated;
grant execute on function public.scout_limit_marketplace_watches() to service_role;
create trigger scout_marketplace_watch_limit before insert or update on public.scout_watches
  for each row execute function public.scout_limit_marketplace_watches();
