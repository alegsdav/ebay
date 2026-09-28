-- Cloud state is accessible only to service_role. Discord ownership is enforced by signed handlers.
create table public.scout_watches (
  id uuid primary key default gen_random_uuid(), owner_id text not null, guild_id text not null,
  config jsonb not null, active boolean not null default true, revision integer not null default 1,
  next_scan_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create table public.scout_drafts (
  id uuid primary key default gen_random_uuid(), owner_id text not null, guild_id text not null,
  config jsonb not null, query text not null, watch_id uuid references public.scout_watches(id) on delete cascade,
  revision integer, expires_at timestamptz not null default now()+interval '15 minutes',
  interaction_id text unique
);
create table public.scout_listings (
  id text primary key, data jsonb not null, first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now()
);
create table public.scout_normalized (
  listing_id text not null references public.scout_listings(id) on delete cascade,
  category text not null, hash text not null, data jsonb not null, model text not null, prompt_version text not null,
  created_at timestamptz not null default now(), primary key(listing_id,category)
);
create table public.scout_processing (
  watch_id uuid not null references public.scout_watches(id) on delete cascade,
  listing_id text not null references public.scout_listings(id) on delete cascade,
  status text not null, details jsonb not null, updated_at timestamptz not null default now(), primary key(watch_id,listing_id)
);
create table public.scout_comparables (
  id text primary key, source_url text not null unique, category text not null, sale_date timestamptz not null,
  data jsonb not null check(data->>'evidence'='verified_completed_sale')
);
create index scout_comps_category_date on public.scout_comparables(category,sale_date);
create table public.scout_alerts (
  id uuid primary key default gen_random_uuid(), watch_id uuid not null references public.scout_watches(id) on delete cascade,
  listing_id text not null references public.scout_listings(id) on delete cascade,
  payload jsonb not null, status text not null default 'sending', message_id text, created_at timestamptz not null default now(),
  unique(watch_id,listing_id)
);
create table public.scout_feedback (
  alert_id uuid not null references public.scout_alerts(id) on delete cascade, user_id text not null,
  action text not null check(action in ('reviewed','saved','dismissed','incorrect_match')),
  updated_at timestamptz not null default now(), primary key(alert_id,user_id)
);
create table public.scout_usage (
  service text not null, day date not null default (now() at time zone 'utc')::date,
  calls integer not null default 0, primary key(service,day)
);
create table public.scout_cooldowns (service text primary key, until_at timestamptz not null);
create table public.scout_jobs (
  id uuid primary key default gen_random_uuid(), dedupe_key text not null unique,
  kind text not null check(kind in ('interaction','scan','listing')), payload jsonb not null,
  status text not null default 'queued' check(status in ('queued','running','done','dead')),
  attempts integer not null default 0, available_at timestamptz not null default now(),
  lease_token uuid, lease_until timestamptz, error_kind text,
  created_at timestamptz not null default now(), finished_at timestamptz
);
create index scout_jobs_ready on public.scout_jobs(status,available_at);

create function public.scout_take_budget(p_service text,p_limit integer) returns boolean
language plpgsql set search_path=public as $$
declare used integer;
begin
  if exists(select 1 from scout_cooldowns where service=p_service and until_at>now()) then return false; end if;
  insert into scout_usage(service,calls) values(p_service,1)
  on conflict(service,day) do update set calls=scout_usage.calls+1 where scout_usage.calls<p_limit
  returning calls into used;
  return used is not null;
end $$;

create function public.scout_confirm_draft(p_id uuid,p_owner text,p_guild text) returns uuid
language plpgsql set search_path=public as $$
declare d scout_drafts; result uuid;
begin
  select * into d from scout_drafts where id=p_id and owner_id=p_owner and guild_id=p_guild and expires_at>now() for update;
  if not found then raise exception 'Preview expired or unavailable'; end if;
  if d.watch_id is null then
    insert into scout_watches(owner_id,guild_id,config) values(p_owner,p_guild,d.config) returning id into result;
  else
    update scout_watches set config=d.config,revision=revision+1,next_scan_at=now()
      where id=d.watch_id and owner_id=p_owner and guild_id=p_guild and revision=d.revision returning id into result;
    if result is null then raise exception 'Watch changed; create a fresh preview'; end if;
  end if;
  delete from scout_drafts where id=p_id;
  return result;
end $$;

create function public.scout_set_active(p_id uuid,p_owner text,p_guild text,p_active boolean) returns boolean
language plpgsql set search_path=public as $$
begin
  update scout_watches set active=p_active,revision=revision+1,next_scan_at=now() where id=p_id and owner_id=p_owner and guild_id=p_guild;
  return found;
end $$;

create function public.scout_enqueue_due() returns integer
language plpgsql set search_path=public as $$
declare w scout_watches; added integer:=0;
begin
  for w in select * from scout_watches where active and next_scan_at<=now() order by next_scan_at for update skip locked limit 20 loop
    insert into scout_jobs(dedupe_key,kind,payload) values('scan:'||w.id||':'||extract(epoch from w.next_scan_at)::text,'scan',jsonb_build_object('watchId',w.id,'revision',w.revision)) on conflict do nothing;
    update scout_watches set next_scan_at=now()+greatest(60,least(10080,(config->>'intervalMinutes')::integer))*interval '1 minute' where id=w.id;
    added:=added+1;
  end loop;
  return added;
end $$;

create function public.scout_claim_job() returns setof public.scout_jobs
language plpgsql set search_path=public as $$
declare chosen uuid;
begin
  update scout_jobs set status='dead',payload='{}',error_kind='retry_exhausted_or_token_expired',finished_at=now()
    where status in ('queued','running') and ((attempts>=3 and (lease_until is null or lease_until<now()))
      or (kind='interaction' and created_at<now()-interval '12 minutes'));
  select id into chosen from scout_jobs
    where ((status='queued' and available_at<=now()) or (status='running' and lease_until<now())) and attempts<3
    order by case kind when 'interaction' then 0 when 'scan' then 1 else 2 end,available_at,created_at
    for update skip locked limit 1;
  if chosen is null then return; end if;
  return query update scout_jobs set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes'
    where id=chosen returning *;
end $$;

create function public.scout_finish_job(p_id uuid,p_lease uuid,p_status text,p_retry_at timestamptz default null,p_error text default null) returns boolean
language plpgsql set search_path=public as $$
begin
  if p_status not in ('done','dead','queued') then raise exception 'Invalid job status'; end if;
  update scout_jobs set status=p_status,error_kind=p_error,available_at=coalesce(p_retry_at,now()),
    finished_at=case when p_status in ('done','dead') then now() else null end,
    payload=case when p_status in ('done','dead') then '{}'::jsonb else payload end,
    lease_token=null,lease_until=null
    where id=p_id and lease_token=p_lease and status='running';
  return found;
end $$;

create function public.scout_reserve_alert(p_watch uuid,p_revision integer,p_listing text,p_payload jsonb) returns uuid
language plpgsql set search_path=public as $$
declare result uuid;
begin
  perform 1 from scout_watches where id=p_watch and active and revision=p_revision for update;
  if not found then return null; end if;
  insert into scout_alerts(watch_id,listing_id,payload) values(p_watch,p_listing,p_payload)
    on conflict(watch_id,listing_id) do nothing returning id into result;
  return result;
end $$;

create function public.scout_import_comparables(p_rows jsonb) returns integer
language plpgsql set search_path=public as $$
declare r jsonb; added integer:=0; n integer;
begin
  for r in select value from jsonb_array_elements(p_rows) loop
    if r->'data'->>'evidence'<>'verified_completed_sale' or (r->'data'->>'saleDate')::timestamptz>now()
      or (r->'data'->>'retrievedAt')::timestamptz>now()
      or (r->'data'->>'retrievedAt')::timestamptz<(r->'data'->>'saleDate')::timestamptz then raise exception 'Invalid completed sale'; end if;
    insert into scout_comparables(id,source_url,category,sale_date,data)
      values(r->>'id',r->>'source_url',r->>'category',(r->>'sale_date')::timestamptz,r->'data') on conflict do nothing;
    get diagnostics n=row_count; added:=added+n;
  end loop;
  return added;
end $$;

-- Deny both anonymous and authenticated browser clients; only server functions use these tables/RPCs.
do $$ declare t text; f regprocedure; begin
  foreach t in array array['scout_watches','scout_drafts','scout_listings','scout_normalized','scout_processing','scout_comparables','scout_alerts','scout_feedback','scout_usage','scout_cooldowns','scout_jobs'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'scout_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;
end $$;
