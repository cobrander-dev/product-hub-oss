#!/bin/sh
set -eu

case "${POSTGRES_DB:-}" in
  *_test) ;;
  *) echo 'Refusing non-test database' >&2; exit 1 ;;
esac
: "${HARD_DELETE_WORKER_DB_USER:?HARD_DELETE_WORKER_DB_USER is required}"
: "${HARD_DELETE_WORKER_DB_PASSWORD:?HARD_DELETE_WORKER_DB_PASSWORD is required}"

admin_sql() {
  psql -X -w -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "$1"
}
worker_sql() {
  PGPASSWORD="$HARD_DELETE_WORKER_DB_PASSWORD" psql -X -w -qAt -h 127.0.0.1 \
    -U "$HARD_DELETE_WORKER_DB_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "$1"
}
expect_worker_denied() {
  label=$1
  statement=$2
  if worker_sql "$statement" >/dev/null 2>&1; then
    echo "FAIL: $label unexpectedly allowed" >&2
    exit 1
  fi
  echo "PASS: $label denied"
}

worker_functions='public.plan_hard_delete(public."HardDeleteTargetType",text)
public.claim_hard_delete_operation(uuid,text,integer)
public.claim_next_hard_delete_operation(text,integer)
public.renew_hard_delete_operation_lease(uuid,uuid,integer)
public.execute_confirmed_hard_delete(uuid,text,uuid)
public.claim_hard_delete_file_task(uuid,uuid,text,integer)
public.complete_hard_delete_file_task(uuid,uuid)
public.retry_hard_delete_file_task(uuid,uuid,text,text,integer)
public.fail_hard_delete_operation(uuid,uuid,text,text)
public.complete_hard_delete_operation(uuid,uuid,jsonb)
public.hard_delete_storage_catalog()'

printf '%s\n' "$worker_functions" | while IFS= read -r function_name; do
  [ "$(admin_sql "SELECT has_function_privilege('$HARD_DELETE_WORKER_DB_USER', '$function_name', 'EXECUTE')")" = t ]
  [ "$(admin_sql "SELECT p.prosecdef || ':' || array_to_string(p.proconfig, ',') || ':' || pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid='$function_name'::regprocedure")" = "true:search_path=pg_catalog:product_hub_migration" ]
done

[ "$(admin_sql "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='$HARD_DELETE_WORKER_DB_USER'")" = 0 ]
[ "$(admin_sql "SELECT has_function_privilege('$HARD_DELETE_WORKER_DB_USER', 'public.execute_confirmed_user_hard_delete(uuid)', 'EXECUTE')")" = f ]
[ "$(admin_sql "SELECT has_function_privilege('$HARD_DELETE_WORKER_DB_USER', 'public.confirm_hard_delete_operation(uuid,text,text,integer)', 'EXECUTE')")" = f ]
[ "$(admin_sql "SELECT has_function_privilege('product_hub_app', 'public.plan_hard_delete(public.\"HardDeleteTargetType\",text)', 'EXECUTE')")" = t ]
[ "$(admin_sql "SELECT has_function_privilege('product_hub_app', 'public.confirm_hard_delete_operation(uuid,text,text,integer)', 'EXECUTE')")" = t ]
[ "$(admin_sql "SELECT has_function_privilege('product_hub_app', 'public.execute_confirmed_hard_delete(uuid,text,uuid)', 'EXECUTE')")" = f ]
refresh_function='public.refresh_hard_delete_preview(public."HardDeleteTargetType",text,text,jsonb,text)'
[ "$(admin_sql "SELECT has_function_privilege('product_hub_app', '$refresh_function', 'EXECUTE')")" = t ]
[ "$(admin_sql "SELECT has_function_privilege('$HARD_DELETE_WORKER_DB_USER', '$refresh_function', 'EXECUTE')")" = f ]
[ "$(admin_sql "SELECT p.prosecdef || ':' || array_to_string(p.proconfig, ',') || ':' || pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid='$refresh_function'::regprocedure")" = "true:search_path=pg_catalog:product_hub_migration" ]
[ "$(admin_sql "SELECT count(*) FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='$refresh_function'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'")" = 0 ]
echo 'PASS: preview refresh App-only EXECUTE, fixed definer owner/search_path and PUBLIC denial'

expect_worker_denied 'worker direct User SELECT' 'SELECT * FROM "User" LIMIT 0'
expect_worker_denied 'worker direct HardDeleteOperation UPDATE' 'UPDATE "HardDeleteOperation" SET "status"="status" WHERE false'
expect_worker_denied 'worker direct ActivityLog DELETE' 'DELETE FROM "ActivityLog" WHERE false'
expect_worker_denied 'worker direct PriceHistory DELETE' 'DELETE FROM "PriceHistory" WHERE false'
expect_worker_denied 'worker preview refresh EXECUTE' "SELECT public.refresh_hard_delete_preview('USER','probe','probe','{}'::jsonb,repeat('a',64))"
expect_worker_denied 'legacy User entrypoint' "SELECT public.execute_confirmed_user_hard_delete('00000000-0000-4000-8000-000000000000')"
expect_worker_denied 'missing operation claim' "SELECT public.claim_hard_delete_operation('00000000-0000-4000-8000-000000000000','probe',30)"

echo 'HARD_DELETE_PHASE3_PRIVILEGES=PASS'
