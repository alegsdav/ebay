-- Remove Facebook Marketplace support: the bot watches eBay only.

-- Stop and delete Marketplace work and data. Deleting listings cascades to their
-- processing rows, normalization cache and alerts.
delete from public.scout_jobs where kind='snapshot'
  or payload->'listing'->>'source'='facebook_marketplace';
delete from public.scout_listings where data->>'source'='facebook_marketplace';
delete from public.scout_usage where service in ('brightdata','brightdata_records');
delete from public.scout_cooldowns where service in ('brightdata','brightdata_records');
alter table public.scout_jobs drop constraint scout_jobs_kind_check;
alter table public.scout_jobs add constraint scout_jobs_kind_check
  check(kind in ('interaction','scan','listing'));

drop trigger if exists scout_marketplace_watch_limit on public.scout_watches;
drop function if exists public.scout_limit_marketplace_watches();
drop function if exists public.scout_take_monthly_budget(text,integer,integer);
drop function if exists public.scout_take_source_budget(uuid,numeric);
drop function if exists public.scout_purge_classifieds(text);
drop function if exists public.scout_cleanup_classifieds();
drop table if exists public.scout_ingestion_runs;
drop table if exists public.scout_source_usage;
drop table if exists public.scout_source_configs;
drop table if exists public.scout_user_defaults;

-- Watches keep their keywords, filters, channel and frequency; Marketplace fields go.
-- Watches that searched only Marketplace have nothing left to search and are paused.
delete from public.scout_drafts;
update public.scout_watches set active=false
  where config ? 'sources' and not config->'sources' @> '["ebay"]'::jsonb;
update public.scout_watches set revision=revision+1,
  config=config - array['sources','location','deliveryModes','estimatedTravelCost']
  where config ?| array['sources','location','deliveryModes','estimatedTravelCost'];
