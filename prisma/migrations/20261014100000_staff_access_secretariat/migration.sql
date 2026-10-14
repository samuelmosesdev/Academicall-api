-- Staff access control, Document Center recovery and the Secretariat.

-- Users: add-on duties, per-person capabilities, forced sign-out
ALTER TABLE "users" ADD COLUMN "staffTags" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "users" ADD COLUMN "permissions" JSONB;
ALTER TABLE "users" ADD COLUMN "sessionsRevokedAt" TIMESTAMP(3);

-- News Agent is now an add-on duty any user can hold, not a role of its own.
UPDATE "users" SET "staffTags" = array_append(COALESCE("staffTags", ARRAY[]::TEXT[]), 'news'), "role" = 'user' WHERE "role" = 'newsAgent';

-- Soft delete so lost uploads can be restored
ALTER TABLE "documents" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "documents" ADD COLUMN "deletedById" TEXT;
CREATE INDEX "documents_deletedAt_idx" ON "documents"("deletedAt");
ALTER TABLE "study_group_messages" ADD COLUMN "archive" JSONB;
ALTER TABLE "vault_folders" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "vault_folders" ADD COLUMN "originalName" TEXT;
ALTER TABLE "vault_files" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "vault_files" ADD COLUMN "deletedById" TEXT;

-- Secretariat register
CREATE TABLE "secretariat_records" (
    "id" TEXT NOT NULL,
    "refNo" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'memo',
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "body" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "confidential" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attachments" JSONB,
    "meetingDate" TIMESTAMP(3),
    "createdById" TEXT,
    "updatedByName" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "secretariat_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "secretariat_records_refNo_key" ON "secretariat_records"("refNo");
CREATE INDEX "secretariat_records_kind_status_idx" ON "secretariat_records"("kind", "status");
CREATE INDEX "secretariat_records_createdAt_idx" ON "secretariat_records"("createdAt");
ALTER TABLE "secretariat_records" ADD CONSTRAINT "secretariat_records_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
