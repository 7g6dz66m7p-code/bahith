-- Reverts 0016_ai_usage_stats: platform_stats as defined in 0010.
CREATE OR REPLACE FUNCTION app.platform_stats() RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $fn$
  SELECT jsonb_build_object(
    'users', (SELECT count(*) FROM public.users),
    'verifiedUsers', (SELECT count(*) FROM public.users WHERE email_verified),
    'workspaces', (SELECT count(*) FROM public.workspaces),
    'projects', (SELECT count(*) FROM public.projects),
    'sources', (SELECT count(*) FROM public.sources),
    'files', (SELECT coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
                FROM (SELECT status, count(*) AS n FROM public.files GROUP BY status) f),
    'chunks', (SELECT count(*) FROM public.chunks),
    'embeddedChunks', (SELECT count(*) FROM public.chunks WHERE embedding IS NOT NULL),
    'documents', (SELECT count(*) FROM public.documents),
    'agentRunsThisMonth', (
      SELECT coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
        FROM (SELECT status, count(*) AS n FROM public.agent_runs
               WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC')
               GROUP BY status) r),
    'aiRequestsThisMonth', (
      SELECT coalesce(sum(used), 0) FROM public.usage_counters
       WHERE metric = 'ai_requests_per_month'
         AND period_start = date_trunc('month', now() AT TIME ZONE 'UTC')::date)
  )
$fn$;
