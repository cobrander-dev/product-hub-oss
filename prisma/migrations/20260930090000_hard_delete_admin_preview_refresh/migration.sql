-- Forward-only UI control. No deletion closure, table, or historical migration changes.
CREATE FUNCTION public.refresh_hard_delete_preview(
  p_target_type public."HardDeleteTargetType", p_target_id TEXT,
  p_admin_id TEXT, p_preview JSONB, p_digest TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  admin_user public."User"%ROWTYPE;
  op public."HardDeleteOperation"%ROWTYPE;
  fresh_plan JSONB;
  operation_id UUID;
BEGIN
  SELECT * INTO admin_user FROM public."User" WHERE "id"=p_admin_id FOR KEY SHARE;
  IF NOT FOUND OR admin_user."role"<>'ADMIN' OR admin_user."banned" IS TRUE OR admin_user."username" IS NULL THEN
    RAISE EXCEPTION 'enabled admin required' USING ERRCODE='42501';
  END IF;
  IF p_target_type='IMPORT_JOB' OR p_target_id IS NULL OR length(p_target_id) NOT BETWEEN 1 AND 255
    OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_preview IS NULL
    OR p_preview->>'schemaVersion' IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'invalid preview' USING ERRCODE='22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_target_type::TEXT || ':' || p_target_id, 0));
  SELECT * INTO op FROM public."HardDeleteOperation"
    WHERE "targetType"=p_target_type AND "targetId"=p_target_id
      AND "status" IN ('PREVIEWED','CONFIRMED','EXECUTING','FILES_PENDING') FOR UPDATE;
  IF FOUND AND op."status"<>'PREVIEWED' THEN RETURN op."id"; END IF;
  fresh_plan := public.plan_hard_delete(p_target_type,p_target_id);
  IF fresh_plan IS DISTINCT FROM p_preview->'databasePlan' OR jsonb_array_length(fresh_plan->'blockers')<>0 THEN
    RAISE EXCEPTION 'preview is stale or blocked' USING ERRCODE='40001';
  END IF;
  IF op."id" IS NOT NULL THEN
    UPDATE public."HardDeleteOperation" SET
      "preview"=p_preview,"previewSha256"=p_digest,"version"="version"+1,
      "targetLabelSnapshot"=fresh_plan->'target'->>'label',
      "requestedByUserId"=admin_user."id","requestedByUsernameSnapshot"=admin_user."username",
      "requestedAt"=pg_catalog.clock_timestamp(),"expiresAt"=pg_catalog.clock_timestamp()+INTERVAL '30 minutes'
      WHERE "id"=op."id" AND "status"='PREVIEWED';
    RETURN op."id";
  END IF;
  operation_id := pg_catalog.gen_random_uuid();
  INSERT INTO public."HardDeleteOperation" (
    "id","targetType","targetId","targetLabelSnapshot","preview","previewSha256",
    "requestedByUserId","requestedByUsernameSnapshot","requestedAt","expiresAt"
  ) VALUES (
    operation_id,p_target_type,p_target_id,fresh_plan->'target'->>'label',p_preview,p_digest,
    admin_user."id",admin_user."username",pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp()+INTERVAL '30 minutes'
  );
  RETURN operation_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.refresh_hard_delete_preview(public."HardDeleteTargetType",TEXT,TEXT,JSONB,TEXT) FROM PUBLIC;
