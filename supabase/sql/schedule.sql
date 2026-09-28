-- Run after deploying functions and setting WORKER_SECRET.
-- First create two secrets in Dashboard > Integrations > Vault:
-- scout_project_url = https://YOUR_PROJECT_REF.supabase.co
-- scout_worker_secret = the SAME random value as the Edge Function WORKER_SECRET
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Re-running this file replaces this app's schedules only.
select cron.unschedule(jobid) from cron.job where jobname in ('scout-worker-pulse','scout-retention');
select cron.schedule('scout-worker-pulse','* * * * *',$job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='scout_project_url') || '/functions/v1/scout-worker',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='scout_worker_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 110000
  ) from generate_series(1,4);
$job$);
-- Retain operational evidence while bounding short-lived queue/token storage.
select cron.schedule('scout-retention','17 3 * * *',$job$
  select public.scout_cleanup_classifieds();
  delete from public.scout_drafts where expires_at<now();
  delete from public.scout_jobs where status in ('done','dead') and finished_at<now()-interval '7 days';
  delete from public.scout_usage where day<current_date-90;
  delete from public.scout_cooldowns where until_at<now();
  delete from cron.job_run_details where end_time<now()-interval '7 days';
$job$);
