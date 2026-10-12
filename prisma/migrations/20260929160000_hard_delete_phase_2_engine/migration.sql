ALTER TABLE "ImportRow" DROP CONSTRAINT "ImportRow_targetProductId_fkey";
ALTER TABLE "ImportRow"
  ADD CONSTRAINT "ImportRow_targetProductId_fkey"
  FOREIGN KEY ("targetProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ImportRow" ADD COLUMN "hardDeleteOperationId" UUID;
CREATE INDEX "ImportRow_hardDeleteOperationId_idx" ON "ImportRow"("hardDeleteOperationId");
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_hardDeleteOperationId_fkey"
  FOREIGN KEY ("hardDeleteOperationId") REFERENCES "HardDeleteOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportRow" DROP CONSTRAINT "ImportRow_action_shape_check";
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_action_shape_check" CHECK (
  ("action" = 'CREATE' AND "targetProductId" IS NULL AND "targetUpdatedAtSnapshot" IS NULL AND "normalizedData" IS NOT NULL AND jsonb_array_length("errors") = 0)
  OR ("action" IN ('UPDATE', 'NO_CHANGE') AND "targetProductId" IS NOT NULL AND "targetUpdatedAtSnapshot" IS NOT NULL AND "normalizedData" IS NOT NULL AND jsonb_array_length("errors") = 0 AND "hardDeleteOperationId" IS NULL)
  OR ("action" IN ('UPDATE', 'NO_CHANGE') AND "targetProductId" IS NULL AND "resolvedProductId" IS NULL AND "hardDeleteOperationId" IS NOT NULL AND "targetUpdatedAtSnapshot" IS NOT NULL AND "normalizedData" IS NOT NULL AND jsonb_array_length("errors") = 0)
  OR ("action" = 'ERROR' AND jsonb_array_length("errors") > 0 AND "hardDeleteOperationId" IS NULL)
);

ALTER TABLE "HardDeleteOperation"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "expiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "leaseToken" UUID,
  ADD COLUMN "leaseOwner" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "lastHeartbeatAt" TIMESTAMPTZ(3),
  ADD COLUMN "verification" JSONB;

UPDATE "HardDeleteOperation"
SET "expiresAt" = "requestedAt" + INTERVAL '30 minutes'
WHERE "expiresAt" IS NULL;
ALTER TABLE "HardDeleteOperation" ALTER COLUMN "expiresAt" SET NOT NULL;

ALTER TABLE "HardDeleteFileTask"
  ADD COLUMN "errorCode" TEXT,
  ADD COLUMN "leaseToken" UUID,
  ADD COLUMN "leaseOwner" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMPTZ(3);

ALTER TABLE "HardDeleteOperation" DROP CONSTRAINT "HardDeleteOperation_status_time_check";
ALTER TABLE "HardDeleteOperation" DROP CONSTRAINT "HardDeleteOperation_failure_check";
ALTER TABLE "HardDeleteOperation" ADD CONSTRAINT "HardDeleteOperation_version_attempts_check"
  CHECK ("version" > 0 AND "attempts" >= 0 AND "expiresAt" > "requestedAt");
ALTER TABLE "HardDeleteOperation" ADD CONSTRAINT "HardDeleteOperation_lease_check" CHECK (
  (("leaseToken" IS NULL) = ("leaseOwner" IS NULL))
  AND (("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL))
  AND ("leaseOwner" IS NULL OR char_length("leaseOwner") BETWEEN 1 AND 100)
  AND ("lastHeartbeatAt" IS NULL OR "leaseToken" IS NOT NULL)
);
ALTER TABLE "HardDeleteOperation" ADD CONSTRAINT "HardDeleteOperation_failure_check" CHECK (
  ("status" = 'FAILED' AND "failedAt" IS NOT NULL AND char_length("failureCode") BETWEEN 1 AND 100 AND char_length("lastError") BETWEEN 1 AND 500)
  OR ("status" <> 'FAILED' AND "failedAt" IS NULL AND "failureCode" IS NULL AND "lastError" IS NULL)
);
ALTER TABLE "HardDeleteOperation" ADD CONSTRAINT "HardDeleteOperation_status_time_check" CHECK (
  ("status" = 'PREVIEWED' AND "confirmedAt" IS NULL AND "startedAt" IS NULL AND "databaseCommittedAt" IS NULL AND "completedAt" IS NULL AND "leaseToken" IS NULL)
  OR ("status" = 'CONFIRMED' AND "confirmedAt" IS NOT NULL AND "confirmedByUserId" IS NOT NULL AND "confirmedByUsernameSnapshot" IS NOT NULL AND "startedAt" IS NULL AND "databaseCommittedAt" IS NULL AND "completedAt" IS NULL AND "leaseToken" IS NULL)
  OR ("status" = 'EXECUTING' AND "confirmedAt" IS NOT NULL AND "confirmedByUsernameSnapshot" IS NOT NULL AND "startedAt" IS NOT NULL AND "databaseCommittedAt" IS NULL AND "completedAt" IS NULL AND "leaseToken" IS NOT NULL)
  OR ("status" = 'FILES_PENDING' AND "confirmedAt" IS NOT NULL AND "confirmedByUsernameSnapshot" IS NOT NULL AND "startedAt" IS NOT NULL AND "databaseCommittedAt" IS NOT NULL AND "completedAt" IS NULL)
  OR ("status" = 'COMPLETED' AND "confirmedAt" IS NOT NULL AND "confirmedByUsernameSnapshot" IS NOT NULL AND "startedAt" IS NOT NULL AND "databaseCommittedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "leaseToken" IS NULL AND "verification" IS NOT NULL)
  OR ("status" = 'FAILED' AND "confirmedAt" IS NOT NULL AND "confirmedByUsernameSnapshot" IS NOT NULL AND "completedAt" IS NULL AND "leaseToken" IS NULL)
);

ALTER TABLE "HardDeleteFileTask" DROP CONSTRAINT "HardDeleteFileTask_status_check";
ALTER TABLE "HardDeleteFileTask" ADD CONSTRAINT "HardDeleteFileTask_errorCode_check"
  CHECK ("errorCode" IS NULL OR char_length("errorCode") BETWEEN 1 AND 100);
ALTER TABLE "HardDeleteFileTask" ADD CONSTRAINT "HardDeleteFileTask_lease_check" CHECK (
  (("leaseToken" IS NULL) = ("leaseOwner" IS NULL))
  AND (("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL))
  AND ("leaseOwner" IS NULL OR char_length("leaseOwner") BETWEEN 1 AND 100)
);
ALTER TABLE "HardDeleteFileTask" ADD CONSTRAINT "HardDeleteFileTask_status_check" CHECK (
  ("status" = 'PENDING' AND "deletedAt" IS NULL AND "nextAttemptAt" IS NULL AND "errorCode" IS NULL AND "lastError" IS NULL AND "leaseToken" IS NULL)
  OR ("status" = 'PROCESSING' AND "deletedAt" IS NULL AND "nextAttemptAt" IS NULL AND "errorCode" IS NULL AND "lastError" IS NULL AND "leaseToken" IS NOT NULL)
  OR ("status" = 'RETRYABLE' AND "deletedAt" IS NULL AND "nextAttemptAt" IS NOT NULL AND "errorCode" IS NOT NULL AND "lastError" IS NOT NULL AND "leaseToken" IS NULL)
  OR ("status" = 'DELETED' AND "deletedAt" IS NOT NULL AND "nextAttemptAt" IS NULL AND "errorCode" IS NULL AND "lastError" IS NULL AND "leaseToken" IS NULL)
  OR ("status" = 'FAILED' AND "deletedAt" IS NULL AND "nextAttemptAt" IS NULL AND "errorCode" IS NOT NULL AND "lastError" IS NOT NULL AND "leaseToken" IS NULL)
);

CREATE INDEX "HardDeleteOperation_status_leaseExpiresAt_requestedAt_idx"
  ON "HardDeleteOperation"("status", "leaseExpiresAt", "requestedAt");
CREATE INDEX "HardDeleteFileTask_operationId_status_leaseExpiresAt_createdAt_idx"
  ON "HardDeleteFileTask"("operationId", "status", "leaseExpiresAt", "createdAt");

CREATE OR REPLACE FUNCTION public.plan_hard_delete(p_target_type public."HardDeleteTargetType", p_target_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_uuid UUID;
  v_label TEXT;
  v_status TEXT;
  v_version TEXT;
  v_product_ids UUID[] := ARRAY[]::UUID[];
  v_factory_ids UUID[] := ARRAY[]::UUID[];
  v_user_ids TEXT[] := ARRAY[]::TEXT[];
  v_category_ids UUID[] := ARRAY[]::UUID[];
  v_material_ids UUID[] := ARRAY[]::UUID[];
  v_assignment_ids UUID[] := ARRAY[]::UUID[];
  v_quote_ids UUID[] := ARRAY[]::UUID[];
  v_history_ids UUID[] := ARRAY[]::UUID[];
  v_main_image_ids UUID[] := ARRAY[]::UUID[];
  v_private_image_ids UUID[] := ARRAY[]::UUID[];
  v_stored_object_ids UUID[] := ARRAY[]::UUID[];
  v_relation_object_ids UUID[] := ARRAY[]::UUID[];
  v_activity_ids UUID[] := ARRAY[]::UUID[];
  v_import_row_ids UUID[] := ARRAY[]::UUID[];
  v_blockers TEXT[] := ARRAY[]::TEXT[];
  v_preserve_products UUID[] := ARRAY[]::UUID[];
  v_preserve_factories UUID[] := ARRAY[]::UUID[];
  v_preserve_categories UUID[] := ARRAY[]::UUID[];
  v_preserve_materials UUID[] := ARRAY[]::UUID[];
  v_preserve_main_images UUID[] := ARRAY[]::UUID[];
  v_preserve_private_images UUID[] := ARRAY[]::UUID[];
  v_preserve_assignments UUID[] := ARRAY[]::UUID[];
  v_files JSONB;
  v_imports JSONB;
BEGIN
  IF p_target_type = 'IMPORT_JOB' THEN
    RAISE EXCEPTION 'import job hard delete is not authorized in phase 2' USING ERRCODE = '0A000';
  END IF;

  IF p_target_type <> 'USER' THEN
    v_uuid := p_target_id::UUID;
  END IF;

  CASE p_target_type
    WHEN 'USER' THEN
      SELECT u."username", CASE WHEN u."banned" IS TRUE THEN 'DISABLED' ELSE 'ENABLED' END,
             u."updatedAt"::TEXT
      INTO v_label, v_status, v_version
      FROM public."User" u WHERE u."id" = p_target_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'target not found' USING ERRCODE = 'P0002'; END IF;
      IF EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = p_target_id AND (u."role" <> 'FACTORY' OR u."banned" IS NOT TRUE)) THEN
        v_blockers := array_append(v_blockers, 'USER_NOT_DISABLED_FACTORY');
      END IF;
      v_user_ids := ARRAY[p_target_id];

    WHEN 'PRODUCT' THEN
      SELECT p."name", p."status"::TEXT, p."updatedAt"::TEXT,
             ARRAY[p."id"], ARRAY[p."categoryId"], ARRAY[p."materialId"]
      INTO v_label, v_status, v_version, v_product_ids, v_preserve_categories, v_preserve_materials
      FROM public."Product" p WHERE p."id" = v_uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'target not found' USING ERRCODE = 'P0002'; END IF;
      IF v_status <> 'DISABLED' THEN v_blockers := array_append(v_blockers, 'PRODUCT_NOT_DISABLED'); END IF;
      SELECT COALESCE(array_agg(a."id" ORDER BY a."id"), ARRAY[]::UUID[]),
             COALESCE(array_agg(DISTINCT a."factoryId" ORDER BY a."factoryId"), ARRAY[]::UUID[])
      INTO v_assignment_ids, v_preserve_factories
      FROM public."ProductFactoryAssignment" a WHERE a."productId" = v_uuid;
      SELECT COALESCE(array_agg(q."id" ORDER BY q."id"), ARRAY[]::UUID[]) INTO v_quote_ids
      FROM public."FactoryQuote" q WHERE q."assignmentId" = ANY(v_assignment_ids);
      SELECT COALESCE(array_agg(m."id" ORDER BY m."id"), ARRAY[]::UUID[]) INTO v_main_image_ids
      FROM public."ProductMainImage" m WHERE m."productId" = v_uuid;
      SELECT COALESCE(array_agg(i."id" ORDER BY i."id"), ARRAY[]::UUID[]) INTO v_private_image_ids
      FROM public."FactoryPrivateImage" i WHERE i."assignmentId" = ANY(v_assignment_ids);
      SELECT COALESCE(array_agg(r."id" ORDER BY r."id"), ARRAY[]::UUID[]) INTO v_import_row_ids
      FROM public."ImportRow" r WHERE r."targetProductId" = v_uuid OR r."resolvedProductId" = v_uuid;

    WHEN 'FACTORY' THEN
      SELECT f."name", f."status"::TEXT, f."updatedAt"::TEXT, ARRAY[f."id"]
      INTO v_label, v_status, v_version, v_factory_ids
      FROM public."Factory" f WHERE f."id" = v_uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'target not found' USING ERRCODE = 'P0002'; END IF;
      IF v_status <> 'DISABLED' THEN v_blockers := array_append(v_blockers, 'FACTORY_NOT_DISABLED'); END IF;
      SELECT COALESCE(array_agg(u."id" ORDER BY u."id"), ARRAY[]::TEXT[]) INTO v_user_ids
      FROM public."User" u WHERE u."factoryId" = v_uuid;
      IF EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = ANY(v_user_ids) AND u."role" = 'ADMIN') THEN
        v_blockers := array_append(v_blockers, 'FACTORY_CONTAINS_ADMIN');
      END IF;
      IF EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = ANY(v_user_ids) AND u."banned" IS NOT TRUE) THEN
        v_blockers := array_append(v_blockers, 'FACTORY_HAS_ENABLED_USERS');
      END IF;
      SELECT COALESCE(array_agg(a."id" ORDER BY a."id"), ARRAY[]::UUID[]),
             COALESCE(array_agg(DISTINCT a."productId" ORDER BY a."productId"), ARRAY[]::UUID[])
      INTO v_assignment_ids, v_preserve_products
      FROM public."ProductFactoryAssignment" a WHERE a."factoryId" = v_uuid;
      SELECT COALESCE(array_agg(q."id" ORDER BY q."id"), ARRAY[]::UUID[]) INTO v_quote_ids
      FROM public."FactoryQuote" q WHERE q."assignmentId" = ANY(v_assignment_ids);
      SELECT COALESCE(array_agg(i."id" ORDER BY i."id"), ARRAY[]::UUID[]) INTO v_private_image_ids
      FROM public."FactoryPrivateImage" i WHERE i."assignmentId" = ANY(v_assignment_ids);
      SELECT COALESCE(array_agg(m."id" ORDER BY m."id"), ARRAY[]::UUID[]) INTO v_preserve_main_images
      FROM public."ProductMainImage" m WHERE m."productId" = ANY(v_preserve_products);

    WHEN 'CATEGORY' THEN
      SELECT c."name", c."status"::TEXT, c."updatedAt"::TEXT, ARRAY[c."id"]
      INTO v_label, v_status, v_version, v_category_ids FROM public."Category" c WHERE c."id" = v_uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'target not found' USING ERRCODE = 'P0002'; END IF;
      IF v_status <> 'DISABLED' THEN v_blockers := array_append(v_blockers, 'CATEGORY_NOT_DISABLED'); END IF;
      IF EXISTS (SELECT 1 FROM public."Product" p WHERE p."categoryId" = v_uuid) THEN v_blockers := array_append(v_blockers, 'CATEGORY_HAS_PRODUCTS'); END IF;

    WHEN 'MATERIAL' THEN
      SELECT m."name", m."status"::TEXT, m."updatedAt"::TEXT, ARRAY[m."id"]
      INTO v_label, v_status, v_version, v_material_ids FROM public."Material" m WHERE m."id" = v_uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'target not found' USING ERRCODE = 'P0002'; END IF;
      IF v_status <> 'DISABLED' THEN v_blockers := array_append(v_blockers, 'MATERIAL_NOT_DISABLED'); END IF;
      IF EXISTS (SELECT 1 FROM public."Product" p WHERE p."materialId" = v_uuid) THEN v_blockers := array_append(v_blockers, 'MATERIAL_HAS_PRODUCTS'); END IF;

    WHEN 'ASSIGNMENT' THEN
      SELECT p."name" || ' / ' || f."name", a."status"::TEXT, a."updatedAt"::TEXT,
             ARRAY[a."id"], ARRAY[a."productId"], ARRAY[a."factoryId"]
      INTO v_label, v_status, v_version, v_assignment_ids, v_preserve_products, v_preserve_factories
      FROM public."ProductFactoryAssignment" a
      JOIN public."Product" p ON p."id" = a."productId"
      JOIN public."Factory" f ON f."id" = a."factoryId" WHERE a."id" = v_uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'target not found' USING ERRCODE = 'P0002'; END IF;
      IF v_status <> 'REVOKED' THEN v_blockers := array_append(v_blockers, 'ASSIGNMENT_NOT_REVOKED'); END IF;
      SELECT COALESCE(array_agg(q."id" ORDER BY q."id"), ARRAY[]::UUID[]) INTO v_quote_ids FROM public."FactoryQuote" q WHERE q."assignmentId" = v_uuid;
      SELECT COALESCE(array_agg(i."id" ORDER BY i."id"), ARRAY[]::UUID[]) INTO v_private_image_ids FROM public."FactoryPrivateImage" i WHERE i."assignmentId" = v_uuid;
      SELECT COALESCE(array_agg(m."id" ORDER BY m."id"), ARRAY[]::UUID[]) INTO v_preserve_main_images FROM public."ProductMainImage" m WHERE m."productId" = ANY(v_preserve_products);

    WHEN 'QUOTE' THEN
      SELECT p."name" || ' / ' || f."name", a."status"::TEXT, q."version"::TEXT || ':' || q."updatedAt"::TEXT,
             ARRAY[q."id"], ARRAY[a."id"], ARRAY[a."productId"], ARRAY[a."factoryId"]
      INTO v_label, v_status, v_version, v_quote_ids, v_preserve_assignments, v_preserve_products, v_preserve_factories
      FROM public."FactoryQuote" q
      JOIN public."ProductFactoryAssignment" a ON a."id" = q."assignmentId"
      JOIN public."Product" p ON p."id" = a."productId"
      JOIN public."Factory" f ON f."id" = a."factoryId" WHERE q."id" = v_uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'target not found' USING ERRCODE = 'P0002'; END IF;
      IF v_status <> 'REVOKED' THEN v_blockers := array_append(v_blockers, 'ASSIGNMENT_NOT_REVOKED'); END IF;
      SELECT COALESCE(array_agg(i."id" ORDER BY i."id"), ARRAY[]::UUID[]) INTO v_preserve_private_images
      FROM public."FactoryPrivateImage" i WHERE i."assignmentId" = ANY(v_preserve_assignments);

    WHEN 'PRODUCT_MAIN_IMAGE' THEN
      SELECT p."name", 'ATTACHED', m."updatedAt"::TEXT, ARRAY[m."id"], ARRAY[p."id"]
      INTO v_label, v_status, v_version, v_main_image_ids, v_preserve_products
      FROM public."ProductMainImage" m JOIN public."Product" p ON p."id" = m."productId" WHERE m."id" = v_uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'target not found' USING ERRCODE = 'P0002'; END IF;

    WHEN 'FACTORY_PRIVATE_IMAGE' THEN
      SELECT p."name" || ' / ' || f."name", 'ATTACHED', i."updatedAt"::TEXT, ARRAY[i."id"], ARRAY[a."id"], ARRAY[a."productId"], ARRAY[a."factoryId"]
      INTO v_label, v_status, v_version, v_private_image_ids, v_preserve_assignments, v_preserve_products, v_preserve_factories
      FROM public."FactoryPrivateImage" i
      JOIN public."ProductFactoryAssignment" a ON a."id" = i."assignmentId"
      JOIN public."Product" p ON p."id" = a."productId"
      JOIN public."Factory" f ON f."id" = a."factoryId" WHERE i."id" = v_uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'target not found' USING ERRCODE = 'P0002'; END IF;
  END CASE;

  SELECT COALESCE(array_agg(h."id" ORDER BY h."id"), ARRAY[]::UUID[]) INTO v_history_ids
  FROM public."PriceHistory" h WHERE h."factoryQuoteId" = ANY(v_quote_ids);

  SELECT COALESCE(array_agg(DISTINCT candidate."storedObjectId" ORDER BY candidate."storedObjectId"), ARRAY[]::UUID[])
  INTO v_relation_object_ids
  FROM (
    SELECT m."storedObjectId" FROM public."ProductMainImage" m WHERE m."id" = ANY(v_main_image_ids)
    UNION ALL
    SELECT i."storedObjectId" FROM public."FactoryPrivateImage" i WHERE i."id" = ANY(v_private_image_ids)
  ) candidate;

  SELECT COALESCE(array_agg(object_id ORDER BY object_id), ARRAY[]::UUID[]) INTO v_stored_object_ids
  FROM unnest(v_relation_object_ids) object_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public."ProductMainImage" surviving
    WHERE surviving."storedObjectId" = object_id AND NOT (surviving."id" = ANY(v_main_image_ids))
  ) AND NOT EXISTS (
    SELECT 1 FROM public."FactoryPrivateImage" surviving
    WHERE surviving."storedObjectId" = object_id AND NOT (surviving."id" = ANY(v_private_image_ids))
  );

  SELECT COALESCE(array_agg(a."id" ORDER BY a."id"), ARRAY[]::UUID[]) INTO v_activity_ids
  FROM public."ActivityLog" a
  WHERE (a."entityType" = 'PRODUCT' AND a."entityId" = ANY(ARRAY(SELECT x::TEXT FROM unnest(v_product_ids) x)))
     OR (a."entityType" = 'PRODUCT' AND a."entityId" = ANY(ARRAY(SELECT x::TEXT FROM unnest(v_preserve_products) x))
         AND cardinality(v_main_image_ids) > 0
         AND a."eventType" IN ('PRODUCT_MAIN_IMAGE_SET','PRODUCT_MAIN_IMAGE_REPLACED','PRODUCT_MAIN_IMAGE_REMOVED','PRODUCT_MAIN_IMAGE_PROMOTED')
         AND ((a."changes"#>>'{storedObjectId,before}') = ANY(ARRAY(SELECT x::TEXT FROM unnest(v_relation_object_ids) x))
              OR (a."changes"#>>'{storedObjectId,after}') = ANY(ARRAY(SELECT x::TEXT FROM unnest(v_relation_object_ids) x))))
     OR (a."entityType" = 'FACTORY' AND a."entityId" = ANY(ARRAY(SELECT x::TEXT FROM unnest(v_factory_ids) x)))
     OR (a."entityType" = 'CATEGORY' AND a."entityId" = ANY(ARRAY(SELECT x::TEXT FROM unnest(v_category_ids) x)))
     OR (a."entityType" = 'MATERIAL' AND a."entityId" = ANY(ARRAY(SELECT x::TEXT FROM unnest(v_material_ids) x)))
     OR (a."entityType" = 'ASSIGNMENT' AND a."entityId" = ANY(ARRAY(SELECT x::TEXT FROM unnest(v_assignment_ids) x)))
     OR (a."entityType" = 'ASSIGNMENT' AND a."entityId" = ANY(ARRAY(SELECT x::TEXT FROM unnest(v_preserve_assignments) x))
         AND cardinality(v_private_image_ids) > 0
         AND a."eventType" IN ('FACTORY_PRIVATE_IMAGE_SET','FACTORY_PRIVATE_IMAGE_REPLACED','FACTORY_PRIVATE_IMAGE_REMOVED')
         AND ((a."changes"#>>'{storedObjectId,before}') = ANY(ARRAY(SELECT x::TEXT FROM unnest(v_relation_object_ids) x))
              OR (a."changes"#>>'{storedObjectId,after}') = ANY(ARRAY(SELECT x::TEXT FROM unnest(v_relation_object_ids) x))))
     OR (a."entityType" = 'QUOTE' AND a."entityId" = ANY(ARRAY(SELECT x::TEXT FROM unnest(v_quote_ids) x)))
     OR (a."entityType" = 'USER' AND a."entityId" = ANY(v_user_ids) AND a."eventType" IN ('USER_CREATED','USER_ENABLED','USER_DISABLED'));

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'storedObjectId', s."id", 'storageProvider', s."storageProvider", 'storageKey', s."storageKey",
      'checksumSha256', s."checksumSha256", 'sizeBytes', s."sizeBytes"::TEXT
    ) ORDER BY s."id"), '[]'::JSONB)
  INTO v_files FROM public."StoredObject" s WHERE s."id" = ANY(v_stored_object_ids);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'rowId', r."id", 'jobId', r."jobId", 'targetProductId', r."targetProductId",
      'resolvedProductId', r."resolvedProductId", 'jobCounters', jsonb_build_array(j."totalRows",j."createRows",j."updateRows",j."noChangeRows",j."errorRows")
    ) ORDER BY r."id"), '[]'::JSONB)
  INTO v_imports FROM public."ImportRow" r JOIN public."ImportJob" j ON j."id" = r."jobId" WHERE r."id" = ANY(v_import_row_ids);

  RETURN jsonb_build_object(
    'schemaVersion', 2,
    'target', jsonb_build_object('type', p_target_type, 'id', p_target_id, 'label', v_label, 'status', v_status, 'version', v_version),
    'blockers', to_jsonb(v_blockers),
    'delete', jsonb_build_object(
      'products', to_jsonb(v_product_ids), 'factories', to_jsonb(v_factory_ids), 'users', to_jsonb(v_user_ids),
      'categories', to_jsonb(v_category_ids), 'materials', to_jsonb(v_material_ids), 'assignments', to_jsonb(v_assignment_ids),
      'quotes', to_jsonb(v_quote_ids), 'priceHistories', to_jsonb(v_history_ids), 'mainImages', to_jsonb(v_main_image_ids),
      'privateImages', to_jsonb(v_private_image_ids), 'storedObjects', to_jsonb(v_stored_object_ids), 'activityLogs', to_jsonb(v_activity_ids),
      'importRowsToDetach', to_jsonb(v_import_row_ids)
    ),
    'preserve', jsonb_build_object(
      'products', to_jsonb(v_preserve_products), 'factories', to_jsonb(v_preserve_factories),
      'categories', to_jsonb(v_preserve_categories), 'materials', to_jsonb(v_preserve_materials),
      'assignments', to_jsonb(v_preserve_assignments), 'mainImages', to_jsonb(v_preserve_main_images), 'privateImages', to_jsonb(v_preserve_private_images),
      'imports', v_imports
    ),
    'files', v_files
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.plan_hard_delete(public."HardDeleteTargetType", TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.confirm_hard_delete_operation(p_operation_id UUID, p_admin_user_id TEXT, p_preview_digest TEXT, p_expected_version INTEGER)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE op public."HardDeleteOperation"%ROWTYPE; admin_user public."User"%ROWTYPE; fresh_plan JSONB;
BEGIN
  SELECT * INTO op FROM public."HardDeleteOperation" WHERE "id"=p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation not found' USING ERRCODE='P0002'; END IF;
  IF op."status"<>'PREVIEWED' OR op."version"<>p_expected_version OR op."previewSha256"<>p_preview_digest THEN
    RAISE EXCEPTION 'preview confirmation conflict' USING ERRCODE='40001';
  END IF;
  IF op."expiresAt"<=pg_catalog.clock_timestamp() THEN RAISE EXCEPTION 'preview expired' USING ERRCODE='40001'; END IF;
  SELECT * INTO admin_user FROM public."User" WHERE "id"=p_admin_user_id FOR KEY SHARE;
  IF NOT FOUND OR admin_user."role"<>'ADMIN' OR admin_user."banned" IS TRUE OR admin_user."username" IS NULL THEN
    RAISE EXCEPTION 'enabled admin required' USING ERRCODE='42501';
  END IF;
  IF op."targetType"='USER' AND op."targetId"=p_admin_user_id THEN RAISE EXCEPTION 'current admin cannot be deleted' USING ERRCODE='42501'; END IF;
  fresh_plan := public.plan_hard_delete(op."targetType",op."targetId");
  IF fresh_plan IS DISTINCT FROM op."preview"->'databasePlan' OR jsonb_array_length(fresh_plan->'blockers')<>0 THEN
    RAISE EXCEPTION 'preview is stale or blocked' USING ERRCODE='40001';
  END IF;
  UPDATE public."HardDeleteOperation" SET "status"='CONFIRMED',"confirmedByUserId"=admin_user."id",
    "confirmedByUsernameSnapshot"=admin_user."username","confirmedAt"=pg_catalog.clock_timestamp(),"version"="version"+1
  WHERE "id"=p_operation_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.confirm_hard_delete_operation(UUID,TEXT,TEXT,INTEGER) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.claim_hard_delete_operation(p_operation_id UUID, p_worker_id TEXT, p_lease_seconds INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  op public."HardDeleteOperation"%ROWTYPE;
  now_at TIMESTAMPTZ(3) := pg_catalog.clock_timestamp();
  new_token UUID := pg_catalog.gen_random_uuid();
BEGIN
  IF char_length(p_worker_id) NOT BETWEEN 1 AND 100 OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid worker lease request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO op FROM public."HardDeleteOperation" WHERE "id" = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation not found' USING ERRCODE = 'P0002'; END IF;
  IF op."status" IN ('COMPLETED','FAILED','PREVIEWED') THEN
    RETURN jsonb_build_object('claimed', false, 'reason', op."status");
  END IF;
  IF op."status" = 'CONFIRMED' AND op."expiresAt" <= now_at THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'EXPIRED');
  END IF;
  IF op."status" IN ('EXECUTING','FILES_PENDING') AND op."leaseExpiresAt" IS NOT NULL AND op."leaseExpiresAt" > now_at THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'LEASED');
  END IF;

  UPDATE public."HardDeleteOperation"
  SET "status" = CASE WHEN op."status" = 'FILES_PENDING' THEN 'FILES_PENDING'::public."HardDeleteOperationStatus" ELSE 'EXECUTING'::public."HardDeleteOperationStatus" END,
      "startedAt" = COALESCE("startedAt", now_at), "leaseToken" = new_token, "leaseOwner" = p_worker_id,
      "leaseExpiresAt" = now_at + pg_catalog.make_interval(secs => p_lease_seconds), "lastHeartbeatAt" = now_at,
      "attempts" = "attempts" + 1, "version" = "version" + 1
  WHERE "id" = p_operation_id RETURNING * INTO op;

  RETURN jsonb_build_object('claimed', true, 'operationId', op."id", 'status', op."status", 'targetType', op."targetType",
    'targetId', op."targetId", 'preview', op."preview", 'previewSha256', op."previewSha256", 'leaseToken', op."leaseToken",
    'leaseExpiresAt', op."leaseExpiresAt", 'attempts', op."attempts");
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_next_hard_delete_operation(p_worker_id TEXT, p_lease_seconds INTEGER)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE candidate_id UUID; now_at TIMESTAMPTZ(3) := pg_catalog.clock_timestamp();
BEGIN
  IF char_length(p_worker_id) NOT BETWEEN 1 AND 100 OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid worker lease request' USING ERRCODE='22023';
  END IF;
  SELECT "id" INTO candidate_id FROM public."HardDeleteOperation"
  WHERE ("status"='CONFIRMED' AND "expiresAt">now_at)
     OR ("status" IN ('EXECUTING','FILES_PENDING') AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt"<=now_at))
  ORDER BY CASE WHEN "status"='FILES_PENDING' THEN 0 WHEN "status"='EXECUTING' THEN 1 ELSE 2 END, "requestedAt", "id"
  FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('claimed',false,'reason','EMPTY'); END IF;
  RETURN public.claim_hard_delete_operation(candidate_id,p_worker_id,p_lease_seconds);
END;
$function$;

CREATE OR REPLACE FUNCTION public.renew_hard_delete_operation_lease(p_operation_id UUID, p_lease_token UUID, p_lease_seconds INTEGER)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE renewed_at TIMESTAMPTZ(3) := pg_catalog.clock_timestamp(); new_expiry TIMESTAMPTZ(3);
BEGIN
  IF p_lease_seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'invalid lease duration' USING ERRCODE = '22023'; END IF;
  UPDATE public."HardDeleteOperation" SET "leaseExpiresAt" = renewed_at + pg_catalog.make_interval(secs => p_lease_seconds), "lastHeartbeatAt" = renewed_at
  WHERE "id" = p_operation_id AND "leaseToken" = p_lease_token AND "status" IN ('EXECUTING','FILES_PENDING') AND "leaseExpiresAt" > renewed_at
  RETURNING "leaseExpiresAt" INTO new_expiry;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation lease unavailable' USING ERRCODE = '55P03'; END IF;
  RETURN new_expiry;
END;
$function$;

CREATE OR REPLACE FUNCTION public.execute_confirmed_hard_delete(p_operation_id UUID, p_preview_digest TEXT, p_lease_token UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  op public."HardDeleteOperation"%ROWTYPE;
  requester public."User"%ROWTYPE;
  confirmer public."User"%ROWTYPE;
  fresh_plan JSONB;
  now_at TIMESTAMPTZ(3) := pg_catalog.clock_timestamp();
BEGIN
  IF p_preview_digest !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid preview digest' USING ERRCODE = '22023'; END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(p_operation_id::TEXT, 7462)) THEN
    RAISE EXCEPTION 'operation locked' USING ERRCODE = '55P03';
  END IF;
  SELECT * INTO op FROM public."HardDeleteOperation" WHERE "id" = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation not found' USING ERRCODE = 'P0002'; END IF;
  IF op."status" <> 'EXECUTING' OR op."leaseToken" IS DISTINCT FROM p_lease_token OR op."leaseExpiresAt" <= now_at THEN
    RAISE EXCEPTION 'operation lease unavailable' USING ERRCODE = '55P03';
  END IF;
  IF op."previewSha256" <> p_preview_digest THEN RAISE EXCEPTION 'preview digest mismatch' USING ERRCODE = '40001'; END IF;
  IF op."requestedByUserId" IS NULL OR op."confirmedByUserId" IS NULL THEN RAISE EXCEPTION 'admin provenance unavailable' USING ERRCODE = '42501'; END IF;
  SELECT * INTO requester FROM public."User" WHERE "id" = op."requestedByUserId" FOR KEY SHARE;
  SELECT * INTO confirmer FROM public."User" WHERE "id" = op."confirmedByUserId" FOR KEY SHARE;
  IF requester."id" IS NULL OR requester."role" <> 'ADMIN' OR requester."banned" IS TRUE
     OR confirmer."id" IS NULL OR confirmer."role" <> 'ADMIN' OR confirmer."banned" IS TRUE THEN
    RAISE EXCEPTION 'enabled admins required' USING ERRCODE = '42501';
  END IF;
  IF op."targetType" = 'USER' AND op."targetId" IN (op."requestedByUserId", op."confirmedByUserId") THEN
    RAISE EXCEPTION 'current admin cannot be deleted' USING ERRCODE = '42501';
  END IF;

  LOCK TABLE public."User", public."Account", public."Session", public."Product", public."Factory", public."Category", public."Material",
    public."ProductFactoryAssignment", public."FactoryQuote", public."PriceHistory", public."ActivityLog", public."StoredObject",
    public."ProductMainImage", public."FactoryPrivateImage", public."ImportJob", public."ImportRow" IN SHARE ROW EXCLUSIVE MODE;

  fresh_plan := public.plan_hard_delete(op."targetType", op."targetId");
  IF fresh_plan IS DISTINCT FROM op."preview"->'databasePlan' THEN
    RAISE EXCEPTION 'hard delete preview is stale' USING ERRCODE = '40001';
  END IF;
  IF jsonb_array_length(fresh_plan->'blockers') <> 0 THEN RAISE EXCEPTION 'target is blocked' USING ERRCODE = '42501'; END IF;

  INSERT INTO public."HardDeleteFileTask" (
    "operationId","storedObjectId","storageProvider","storageKey","checksumSha256","sizeBytes","status","attempts","createdAt","updatedAt"
  )
  SELECT p_operation_id, (f->>'storedObjectId')::UUID, (f->>'storageProvider')::public."StorageProvider", f->>'storageKey',
         f->>'checksumSha256', (f->>'sizeBytes')::BIGINT, 'PENDING', 0, now_at, now_at
  FROM jsonb_array_elements(fresh_plan->'files') f
  ON CONFLICT ("operationId","storageKey") DO NOTHING;

  UPDATE public."ActivityLog" SET "actorUserId" = NULL, "actorUsernameSnapshot" = '已永久删除用户'
  WHERE "actorUserId" IN (SELECT value FROM jsonb_array_elements_text(fresh_plan#>'{delete,users}'));
  DELETE FROM public."ActivityLog" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(fresh_plan#>'{delete,activityLogs}'));
  UPDATE public."ImportRow" SET "targetProductId" = NULL, "resolvedProductId" = NULL, "hardDeleteOperationId" = p_operation_id
  WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(fresh_plan#>'{delete,importRowsToDetach}'));
  DELETE FROM public."ProductMainImage" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(fresh_plan#>'{delete,mainImages}'));
  DELETE FROM public."FactoryPrivateImage" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(fresh_plan#>'{delete,privateImages}'));
  DELETE FROM public."StoredObject" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(fresh_plan#>'{delete,storedObjects}'));
  DELETE FROM public."PriceHistory" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(fresh_plan#>'{delete,priceHistories}'));
  DELETE FROM public."FactoryQuote" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(fresh_plan#>'{delete,quotes}'));
  DELETE FROM public."ProductFactoryAssignment" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(fresh_plan#>'{delete,assignments}'));
  DELETE FROM public."User" WHERE "id" IN (SELECT value FROM jsonb_array_elements_text(fresh_plan#>'{delete,users}'));
  DELETE FROM public."Product" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(fresh_plan#>'{delete,products}'));
  DELETE FROM public."Factory" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(fresh_plan#>'{delete,factories}'));
  DELETE FROM public."Category" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(fresh_plan#>'{delete,categories}'));
  DELETE FROM public."Material" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(fresh_plan#>'{delete,materials}'));

  UPDATE public."HardDeleteOperation"
  SET "status" = 'FILES_PENDING', "databaseCommittedAt" = now_at, "version" = "version" + 1,
      "targetLabelSnapshot" = CASE WHEN "targetType" = 'USER' THEN '已永久删除用户' ELSE "targetLabelSnapshot" END
  WHERE "id" = p_operation_id;
  RETURN jsonb_build_object('status','FILES_PENDING','fileTaskCount',jsonb_array_length(fresh_plan->'files'));
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_hard_delete_file_task(p_operation_id UUID, p_operation_lease_token UUID, p_worker_id TEXT, p_lease_seconds INTEGER)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE task public."HardDeleteFileTask"%ROWTYPE; now_at TIMESTAMPTZ(3) := pg_catalog.clock_timestamp(); new_token UUID := pg_catalog.gen_random_uuid();
BEGIN
  IF char_length(p_worker_id) NOT BETWEEN 1 AND 100 OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'invalid task lease request' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM public."HardDeleteOperation" WHERE "id"=p_operation_id AND "status"='FILES_PENDING' AND "leaseToken"=p_operation_lease_token AND "leaseExpiresAt">now_at FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation lease unavailable' USING ERRCODE = '55P03'; END IF;
  SELECT * INTO task FROM public."HardDeleteFileTask"
  WHERE "operationId"=p_operation_id AND (
    "status"='PENDING' OR ("status"='RETRYABLE' AND "nextAttemptAt"<=now_at) OR ("status"='PROCESSING' AND "leaseExpiresAt"<=now_at)
  ) ORDER BY "createdAt","id" FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed',false,'remainingTasks',(
      SELECT count(*) FROM public."HardDeleteFileTask" WHERE "operationId"=p_operation_id AND "status"<>'DELETED'
    ));
  END IF;
  UPDATE public."HardDeleteFileTask" SET "status"='PROCESSING',"attempts"="attempts"+1,"nextAttemptAt"=NULL,"errorCode"=NULL,"lastError"=NULL,
    "leaseToken"=new_token,"leaseOwner"=p_worker_id,"leaseExpiresAt"=now_at+pg_catalog.make_interval(secs=>p_lease_seconds),"updatedAt"=now_at
  WHERE "id"=task."id" RETURNING * INTO task;
  RETURN jsonb_build_object('claimed',true,'taskId',task."id",'storageProvider',task."storageProvider",'storageKey',task."storageKey",
    'checksumSha256',task."checksumSha256",'sizeBytes',task."sizeBytes"::TEXT,'leaseToken',task."leaseToken",'attempts',task."attempts");
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_hard_delete_file_task(p_task_id UUID, p_task_lease_token UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  UPDATE public."HardDeleteFileTask" SET "status"='DELETED',"deletedAt"=pg_catalog.clock_timestamp(),"leaseToken"=NULL,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"updatedAt"=pg_catalog.clock_timestamp()
  WHERE "id"=p_task_id AND "status"='PROCESSING' AND "leaseToken"=p_task_lease_token AND "leaseExpiresAt">pg_catalog.clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'task lease unavailable' USING ERRCODE = '55P03'; END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.retry_hard_delete_file_task(p_task_id UUID, p_task_lease_token UUID, p_error_code TEXT, p_error_summary TEXT, p_delay_seconds INTEGER)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_error_code !~ '^[A-Z0-9_]{1,100}$' OR char_length(p_error_summary) NOT BETWEEN 1 AND 500 OR p_delay_seconds NOT BETWEEN 1 AND 86400 THEN
    RAISE EXCEPTION 'invalid retry data' USING ERRCODE = '22023';
  END IF;
  UPDATE public."HardDeleteFileTask" SET "status"='RETRYABLE',"nextAttemptAt"=pg_catalog.clock_timestamp()+pg_catalog.make_interval(secs=>p_delay_seconds),
    "errorCode"=p_error_code,"lastError"=p_error_summary,"leaseToken"=NULL,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"updatedAt"=pg_catalog.clock_timestamp()
  WHERE "id"=p_task_id AND "status"='PROCESSING' AND "leaseToken"=p_task_lease_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'task lease unavailable' USING ERRCODE = '55P03'; END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fail_hard_delete_operation(p_operation_id UUID, p_lease_token UUID, p_error_code TEXT, p_error_summary TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_error_code !~ '^[A-Z0-9_]{1,100}$' OR char_length(p_error_summary) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid failure data' USING ERRCODE='22023'; END IF;
  UPDATE public."HardDeleteOperation" SET "status"='FAILED',"failedAt"=pg_catalog.clock_timestamp(),"failureCode"=p_error_code,"lastError"=p_error_summary,
    "leaseToken"=NULL,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"lastHeartbeatAt"=NULL,"version"="version"+1
  WHERE "id"=p_operation_id AND "leaseToken"=p_lease_token AND "status" IN ('EXECUTING','FILES_PENDING');
  IF NOT FOUND THEN RAISE EXCEPTION 'operation lease unavailable' USING ERRCODE='55P03'; END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_hard_delete_operation(p_operation_id UUID, p_lease_token UUID, p_verification JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE op public."HardDeleteOperation"%ROWTYPE; plan JSONB;
BEGIN
  IF p_verification IS NULL OR jsonb_typeof(p_verification)<>'object' OR p_verification->>'filesAbsent'<>'true' OR p_verification->>'noNewUnknownOrphans'<>'true' THEN
    RAISE EXCEPTION 'final verification incomplete' USING ERRCODE='22023';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(p_operation_id::TEXT,7462)) THEN RAISE EXCEPTION 'operation locked' USING ERRCODE='55P03'; END IF;
  SELECT * INTO op FROM public."HardDeleteOperation" WHERE "id"=p_operation_id FOR UPDATE;
  IF NOT FOUND OR op."status"<>'FILES_PENDING' OR op."leaseToken" IS DISTINCT FROM p_lease_token OR op."leaseExpiresAt"<=pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'operation lease unavailable' USING ERRCODE='55P03';
  END IF;
  IF EXISTS (SELECT 1 FROM public."HardDeleteFileTask" WHERE "operationId"=p_operation_id AND "status"<>'DELETED') THEN RAISE EXCEPTION 'file tasks incomplete' USING ERRCODE='55000'; END IF;
  plan := op."preview"->'databasePlan';
  IF EXISTS (SELECT 1 FROM public."Product" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(plan#>'{delete,products}'))) OR
     EXISTS (SELECT 1 FROM public."Factory" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(plan#>'{delete,factories}'))) OR
     EXISTS (SELECT 1 FROM public."User" WHERE "id" IN (SELECT value FROM jsonb_array_elements_text(plan#>'{delete,users}'))) OR
     EXISTS (SELECT 1 FROM public."Category" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(plan#>'{delete,categories}'))) OR
     EXISTS (SELECT 1 FROM public."Material" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(plan#>'{delete,materials}'))) OR
     EXISTS (SELECT 1 FROM public."ProductFactoryAssignment" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(plan#>'{delete,assignments}'))) OR
     EXISTS (SELECT 1 FROM public."FactoryQuote" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(plan#>'{delete,quotes}'))) OR
     EXISTS (SELECT 1 FROM public."PriceHistory" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(plan#>'{delete,priceHistories}'))) OR
     EXISTS (SELECT 1 FROM public."ProductMainImage" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(plan#>'{delete,mainImages}'))) OR
     EXISTS (SELECT 1 FROM public."FactoryPrivateImage" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(plan#>'{delete,privateImages}'))) OR
     EXISTS (SELECT 1 FROM public."StoredObject" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(plan#>'{delete,storedObjects}'))) OR
     EXISTS (SELECT 1 FROM public."ActivityLog" WHERE "id" IN (SELECT value::UUID FROM jsonb_array_elements_text(plan#>'{delete,activityLogs}'))) THEN
    RAISE EXCEPTION 'database closure incomplete' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public."ImportRow" r WHERE r."id" IN (SELECT value::UUID FROM jsonb_array_elements_text(plan#>'{delete,importRowsToDetach}')) AND (r."targetProductId" IS NOT NULL OR r."resolvedProductId" IS NOT NULL OR r."hardDeleteOperationId" IS DISTINCT FROM p_operation_id)) THEN
    RAISE EXCEPTION 'import provenance not detached' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(plan#>'{preserve,products}') item WHERE NOT EXISTS (SELECT 1 FROM public."Product" p WHERE p."id"=item.value::UUID)) OR
     EXISTS (SELECT 1 FROM jsonb_array_elements_text(plan#>'{preserve,factories}') item WHERE NOT EXISTS (SELECT 1 FROM public."Factory" f WHERE f."id"=item.value::UUID)) OR
     EXISTS (SELECT 1 FROM jsonb_array_elements_text(plan#>'{preserve,categories}') item WHERE NOT EXISTS (SELECT 1 FROM public."Category" c WHERE c."id"=item.value::UUID)) OR
     EXISTS (SELECT 1 FROM jsonb_array_elements_text(plan#>'{preserve,materials}') item WHERE NOT EXISTS (SELECT 1 FROM public."Material" m WHERE m."id"=item.value::UUID)) OR
     EXISTS (SELECT 1 FROM jsonb_array_elements_text(plan#>'{preserve,assignments}') item WHERE NOT EXISTS (SELECT 1 FROM public."ProductFactoryAssignment" a WHERE a."id"=item.value::UUID)) OR
     EXISTS (SELECT 1 FROM jsonb_array_elements_text(plan#>'{preserve,mainImages}') item WHERE NOT EXISTS (SELECT 1 FROM public."ProductMainImage" m WHERE m."id"=item.value::UUID)) OR
     EXISTS (SELECT 1 FROM jsonb_array_elements_text(plan#>'{preserve,privateImages}') item WHERE NOT EXISTS (SELECT 1 FROM public."FactoryPrivateImage" i WHERE i."id"=item.value::UUID)) THEN
    RAISE EXCEPTION 'preserved object is missing' USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(plan#>'{preserve,imports}') snapshot
    WHERE NOT EXISTS (
      SELECT 1 FROM public."ImportRow" r JOIN public."ImportJob" j ON j."id"=r."jobId"
      WHERE r."id"=(snapshot->>'rowId')::UUID AND r."jobId"=(snapshot->>'jobId')::UUID
        AND r."targetProductId" IS NULL AND r."resolvedProductId" IS NULL
        AND jsonb_build_array(j."totalRows",j."createRows",j."updateRows",j."noChangeRows",j."errorRows")=snapshot->'jobCounters'
    )
  ) THEN RAISE EXCEPTION 'import job preservation failed' USING ERRCODE='55000'; END IF;
  UPDATE public."HardDeleteOperation" SET "status"='COMPLETED',"completedAt"=pg_catalog.clock_timestamp(),"verification"=p_verification,
    "leaseToken"=NULL,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"lastHeartbeatAt"=NULL,"version"="version"+1 WHERE "id"=p_operation_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.hard_delete_storage_catalog()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
  SELECT jsonb_build_object(
    'storedKeys', COALESCE((SELECT jsonb_agg(s."storageKey" ORDER BY s."storageKey") FROM public."StoredObject" s),'[]'::JSONB),
    'pendingKeys', COALESCE((SELECT jsonb_agg(DISTINCT t."storageKey" ORDER BY t."storageKey") FROM public."HardDeleteFileTask" t WHERE t."status"<>'DELETED'),'[]'::JSONB)
  )
$function$;

CREATE OR REPLACE FUNCTION public.execute_confirmed_user_hard_delete(p_operation_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'legacy hard delete entrypoint disabled; use phase 2 worker' USING ERRCODE='0A000';
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_hard_delete_operation(UUID,TEXT,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_next_hard_delete_operation(TEXT,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.renew_hard_delete_operation_lease(UUID,UUID,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.execute_confirmed_hard_delete(UUID,TEXT,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_hard_delete_file_task(UUID,UUID,TEXT,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_hard_delete_file_task(UUID,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retry_hard_delete_file_task(UUID,UUID,TEXT,TEXT,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fail_hard_delete_operation(UUID,UUID,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_hard_delete_operation(UUID,UUID,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hard_delete_storage_catalog() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.execute_confirmed_user_hard_delete(UUID) FROM PUBLIC;
