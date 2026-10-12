ALTER TYPE "ActivityEventType" ADD VALUE 'USER_CREATED';
ALTER TYPE "ActivityEventType" ADD VALUE 'USER_ENABLED';
ALTER TYPE "ActivityEventType" ADD VALUE 'USER_DISABLED';

ALTER TABLE "ActivityLog" DROP CONSTRAINT "ActivityLog_event_entity_check";
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_event_entity_check" CHECK (
  ("eventType"::text LIKE 'PRODUCT_%' AND "entityType" = 'PRODUCT') OR
  ("eventType"::text LIKE 'CATEGORY_%' AND "entityType" = 'CATEGORY') OR
  ("eventType"::text LIKE 'MATERIAL_%' AND "entityType" = 'MATERIAL') OR
  ("eventType"::text LIKE 'FACTORY_PRIVATE_IMAGE_%' AND "entityType" = 'ASSIGNMENT') OR
  ("eventType"::text LIKE 'FACTORY_%' AND "entityType" = 'FACTORY') OR
  ("eventType"::text LIKE 'ASSIGNMENT_%' AND "entityType" = 'ASSIGNMENT') OR
  ("eventType"::text LIKE 'QUOTE_%' AND "entityType" = 'QUOTE') OR
  ("eventType"::text LIKE 'USER_%' AND "entityType" = 'USER')
);
