-- Platform administration without giving the application role cross-tenant access.
-- Both functions run as the migration owner (SECURITY DEFINER) with a fixed search_path.
-- Who may call them is decided by the application (verified platform admins only); the
-- functions themselves return only aggregate counts and change only plan limits.

-- Aggregate counts across all workspaces: numbers only, never research content,
-- titles, names or email addresses.
CREATE FUNCTION app.platform_stats() RETURNS jsonb
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.platform_stats() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.platform_stats() TO bahith_app;--> statement-breakpoint
-- Sets one known numeric limit of a plan; anything else is refused.
CREATE FUNCTION app.set_plan_limit(plan_code text, metric text, value integer) RETURNS jsonb
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $fn$
DECLARE
  result jsonb;
BEGIN
  IF metric IS DISTINCT FROM 'ai_requests_per_month' THEN
    RAISE EXCEPTION 'unknown plan metric' USING ERRCODE = '22023';
  END IF;
  IF value IS NULL OR value < 0 OR value > 1000000 THEN
    RAISE EXCEPTION 'plan limit out of range' USING ERRCODE = '22003';
  END IF;
  UPDATE public.plans
     SET limits = limits || jsonb_build_object(metric, value), updated_at = now()
   WHERE code = plan_code
  RETURNING limits INTO result;
  IF result IS NULL THEN
    RAISE EXCEPTION 'unknown plan' USING ERRCODE = 'P0002';
  END IF;
  RETURN result;
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.set_plan_limit(text, text, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.set_plan_limit(text, text, integer) TO bahith_app;
