-- Hourly Facebook Marketplace polling through Bright Data background snapshots.

-- Snapshot jobs collect a triggered Bright Data search on a later worker run.
alter table public.scout_jobs drop constraint scout_jobs_kind_check;
alter table public.scout_jobs add constraint scout_jobs_kind_check
  check(kind in ('interaction','scan','listing','snapshot'));

-- Testing cap: 5 active watches that include Marketplace, polled at most hourly.
create or replace function public.scout_limit_marketplace_watches() returns trigger
language plpgsql set search_path=public as $$
begin
  if new.active and new.config->'sources' @> '["facebook_marketplace"]'::jsonb then
    perform pg_advisory_xact_lock(24092410);
    if (select count(*) from scout_watches where active
        and config->'sources' @> '["facebook_marketplace"]'::jsonb
        and id<>new.id) >= 5 then
      raise exception 'Maximum 5 active Marketplace watches. Pause or delete one first.';
    end if;
    if coalesce((new.config->>'intervalMinutes')::integer,0) < 60 then
      raise exception 'Marketplace watches require at least 60 minutes between searches.';
    end if;
  end if;
  return new;
end $$;

-- Bright Data bills per returned record. Reserve before a search (positive amount)
-- and refund unused records afterwards (negative amount) against a UTC-month cap.
create function public.scout_take_monthly_budget(p_service text,p_amount integer,p_limit integer) returns boolean
language plpgsql set search_path=public as $$
declare used bigint;
begin
  if p_service is null or p_amount is null or p_limit is null then return false; end if;
  perform pg_advisory_xact_lock(hashtext('scout_monthly_budget:'||p_service));
  if p_amount>0 then
    select coalesce(sum(calls),0) into used from scout_usage
      where service=p_service and day>=date_trunc('month',now() at time zone 'utc')::date;
    if used+p_amount>p_limit then return false; end if;
  end if;
  insert into scout_usage(service,calls) values(p_service,p_amount)
    on conflict(service,day) do update set calls=scout_usage.calls+p_amount;
  return true;
end $$;

-- A new keyword/city combination gets a larger first search; later polls stay small.
alter table public.scout_ingestion_runs add column query_key text;
create index scout_ingestion_runs_watch_query on public.scout_ingestion_runs(watch_id,query_key,status);

do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('scout_take_monthly_budget','scout_limit_marketplace_watches') loop
    execute format('revoke all on function %s from public,anon,authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;
end $$;
