-- Manual Marketplace V1. No provider credentials or approved provider are seeded.
create table public.scout_source_configs (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('ebay','facebook_marketplace')),
  provider text not null,
  access_mode text not null check (access_mode in ('authorized_api','licensed_provider','user_submitted')),
  enabled boolean not null default false,
  config jsonb not null default '{}',
  poll_interval_minutes integer not null default 360 check (poll_interval_minutes >= 360),
  daily_request_limit integer not null default 0 check (daily_request_limit >= 0),
  daily_cost_limit numeric not null default 0 check (daily_cost_limit >= 0),
  terms_reviewed_at timestamptz, terms_reference text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(source,provider),
  check (not enabled or access_mode <> 'licensed_provider' or (terms_reviewed_at is not null and terms_reference is not null)),
  check (not (config ?| array['api_key','token','password','secret','cookies','authorization']))
);
create table public.scout_ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source_config_id uuid references public.scout_source_configs(id) on delete cascade,
  watch_id uuid references public.scout_watches(id) on delete set null,
  provider_request_id text, status text not null check (status in ('running','succeeded','failed','quarantined','budget_exhausted')),
  pages_requested integer not null default 0 check(pages_requested>=0),
  records_received integer not null default 0 check(records_received>=0),
  records_accepted integer not null default 0 check(records_accepted>=0),
  cost_units numeric not null default 0 check(cost_units>=0), error_kind text,
  started_at timestamptz not null default now(), finished_at timestamptz
);
create table public.scout_submissions (
  id uuid primary key default gen_random_uuid(), owner_id text not null, guild_id text not null,
  interaction_id text not null unique, data jsonb not null,
  expires_at timestamptz not null default now()+interval '15 minutes'
);
create index scout_submissions_expiry on public.scout_submissions(expires_at);
create table public.scout_evaluations (
  id uuid primary key, owner_id text not null, guild_id text not null, data jsonb not null,
  expires_at timestamptz not null default now()+interval '30 days'
);
create index scout_evaluations_expiry on public.scout_evaluations(expires_at);

-- Identity is currently stored in data and the namespaced primary key; the initial
-- migration has no source/source_item_id columns. Preserve deployed eBay IDs.
create index scout_listings_source on public.scout_listings((data->>'source'));
alter table public.scout_comparables add constraint scout_no_marketplace_asking_prices
  check (lower(data->>'source') <> 'facebook_marketplace' and lower(data->>'sourceUrl') !~ '^https://([^/]*\.)?facebook\.com([/:?#]|$)') not valid;

create function public.scout_consume_submission(p_id uuid,p_owner text,p_guild text) returns jsonb
language plpgsql set search_path=public as $$
declare result jsonb;
begin
  delete from scout_submissions where id=p_id and owner_id=p_owner and guild_id=p_guild and expires_at>now() returning data into result;
  if result is null then raise exception 'Evaluation preview expired, already used or not owned by you'; end if;
  return result;
end $$;

create function public.scout_cleanup_classifieds() returns void
language sql set search_path=public as $$
  delete from scout_submissions where expires_at<=now();
  delete from scout_evaluations where expires_at<=now();
  delete from scout_ingestion_runs where started_at<now()-interval '30 days';
$$;

-- Atomic accounting groundwork; no provider can run in V1 even if a row is enabled.
create table public.scout_source_usage (
  source_config_id uuid not null references public.scout_source_configs(id) on delete cascade,
  day date not null default (now() at time zone 'utc')::date,
  requests integer not null default 0, cost_units numeric not null default 0,
  primary key(source_config_id,day)
);
create function public.scout_take_source_budget(p_config uuid,p_cost numeric) returns boolean
language plpgsql set search_path=public as $$
declare c scout_source_configs; used integer;
begin
  select * into c from scout_source_configs where id=p_config for update;
  if not found or not c.enabled or p_cost is null or p_cost<0 or c.daily_request_limit<=0
    or p_cost>c.daily_cost_limit or (c.access_mode='licensed_provider' and c.terms_reviewed_at is null) then return false; end if;
  insert into scout_source_usage(source_config_id,requests,cost_units) values(p_config,1,p_cost)
    on conflict(source_config_id,day) do update set requests=scout_source_usage.requests+1,cost_units=scout_source_usage.cost_units+p_cost
    where scout_source_usage.requests<c.daily_request_limit and scout_source_usage.cost_units+p_cost<=c.daily_cost_limit
    returning requests into used;
  return used is not null;
end $$;

create function public.scout_purge_classifieds(p_source text) returns void
language plpgsql set search_path=public as $$
begin
  if p_source <> 'facebook_marketplace' or p_source is null then raise exception 'Only Marketplace purge is supported'; end if;
  update scout_source_configs set enabled=false where source=p_source;
  delete from scout_jobs where kind='listing' and payload->'listing'->>'source'=p_source;
  delete from scout_jobs where kind='interaction' and (
    (payload->'data'->>'name'='listing' and payload->'data'->'options'->0->>'name'='evaluate')
    or payload->'data'->>'custom_id' like 'manual:%');
  delete from scout_submissions where data->'listing'->>'source'=p_source;
  delete from scout_evaluations;
  delete from scout_listings where data->>'source'=p_source;
  delete from scout_ingestion_runs where source_config_id in (select id from scout_source_configs where source=p_source);
end $$;

do $$ declare t text; f regprocedure; begin
  foreach t in array array['scout_source_configs','scout_ingestion_runs','scout_submissions','scout_source_usage','scout_evaluations'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('scout_consume_submission','scout_cleanup_classifieds','scout_take_source_budget','scout_purge_classifieds') loop
    execute format('revoke all on function %s from public,anon,authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;
end $$;
