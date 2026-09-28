-- Keyword watch rework: cross-source keyword matching replaces sold-comparable pricing,
-- the fixed category list and manual Marketplace submissions.

-- Retention and purge no longer touch the removed submission/evaluation tables.
create or replace function public.scout_cleanup_classifieds() returns void
language sql set search_path=public as $$
  delete from scout_ingestion_runs where started_at<now()-interval '30 days';
$$;

create or replace function public.scout_purge_classifieds(p_source text) returns void
language plpgsql set search_path=public as $$
begin
  if p_source is null or p_source not in ('ebay','facebook_marketplace') then
    raise exception 'Unknown source';
  end if;
  update scout_source_configs set enabled=false where source=p_source;
  delete from scout_jobs where kind='listing' and payload->'listing'->>'source'=p_source;
  delete from scout_listings where data->>'source'=p_source;
  delete from scout_ingestion_runs where source_config_id in (select id from scout_source_configs where source=p_source);
end $$;

drop function if exists public.scout_import_comparables(jsonb);
drop table if exists public.scout_comparables;
drop function if exists public.scout_consume_submission(uuid,text,text);
drop table if exists public.scout_submissions;
drop table if exists public.scout_evaluations;
delete from public.scout_jobs where status in ('queued','running') and kind='interaction' and (
  (payload->'data'->>'name'='listing' and payload->'data'->'options'->0->>'name'='evaluate')
  or payload->'data'->>'custom_id' like 'manual:%');

-- Normalization is a cache keyed by evidence/model/prompt/search-intent hash, not category.
delete from public.scout_normalized;
alter table public.scout_normalized drop constraint scout_normalized_pkey;
alter table public.scout_normalized drop column category;
alter table public.scout_normalized add primary key(listing_id,hash);

-- "Not a match" is now "Not relevant"; older alert buttons keep working.
alter table public.scout_feedback drop constraint scout_feedback_action_check;
alter table public.scout_feedback add constraint scout_feedback_action_check
  check(action in ('reviewed','saved','dismissed','incorrect_match','not_relevant'));

-- Convert existing watches to the keyword shape. Pricing thresholds are dropped; an
-- asking-price or all-in budget becomes the maximum listing price. Previews expire in
-- 15 minutes and use the old shape, so they are discarded.
delete from public.scout_drafts;
update public.scout_watches set revision=revision+1, config=(config - array[
    'purpose','category','minAllIn','maxAllIn','maxAskingPrice','minDiscountPercent',
    'minProfit','minComparables','lookbackDays','minConfidence','fees','possibleChannelId'])
  || jsonb_build_object(
    'sources', coalesce(config->'sources','["ebay"]'::jsonb),
    'location', coalesce(config->'location','null'::jsonb),
    'deliveryModes', coalesce(config->'deliveryModes','null'::jsonb),
    'estimatedTravelCost', coalesce(config->'estimatedTravelCost','0'::jsonb),
    'minPrice', coalesce(config->'minAllIn','null'::jsonb),
    'maxPrice', coalesce(nullif(config->'maxAskingPrice','null'::jsonb),config->'maxAllIn','null'::jsonb),
    'minSellerPercent', coalesce(config->'minSellerPercent','null'::jsonb))
  where config ? 'category';

do $$ declare t text; f regprocedure; begin
  foreach t in array array['scout_normalized','scout_feedback'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('scout_cleanup_classifieds','scout_purge_classifieds') loop
    execute format('revoke all on function %s from public,anon,authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;
end $$;
