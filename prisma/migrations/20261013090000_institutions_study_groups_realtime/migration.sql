-- Multi-institution academic structure, study groups, class-event social fields.
-- Written to be idempotent (IF NOT EXISTS everywhere) because some production
-- tables were created outside migrations.

-- AlterTable
ALTER TABLE "class_events" ADD COLUMN IF NOT EXISTS "comments" JSONB,
ADD COLUMN IF NOT EXISTS "institutionId" TEXT,
ADD COLUMN IF NOT EXISTS "reactions" JSONB;

-- AlterTable
ALTER TABLE "department_memberships" ADD COLUMN IF NOT EXISTS "institutionId" TEXT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "institutionId" TEXT;

-- AlterTable
ALTER TABLE "feed_posts" ADD COLUMN IF NOT EXISTS "institutionId" TEXT;

-- AlterTable
ALTER TABLE "generated_quizzes" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "departmentId" TEXT,
ADD COLUMN IF NOT EXISTS "facultyId" TEXT,
ADD COLUMN IF NOT EXISTS "institutionId" TEXT,
ADD COLUMN IF NOT EXISTS "programId" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "profile_change_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT,
    "userEmail" TEXT,
    "uniqueId" TEXT,
    "field" TEXT NOT NULL,
    "fieldLabel" TEXT,
    "currentValue" TEXT,
    "requestedValue" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewedByName" TEXT,
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profile_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "institutions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT,
    "abbreviation" TEXT,
    "type" TEXT,
    "category" TEXT,
    "ownership" TEXT,
    "state" TEXT,
    "source" TEXT NOT NULL DEFAULT 'ibass',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "institutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "faculties" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'faculty',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "faculties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "academic_departments" (
    "id" TEXT NOT NULL,
    "facultyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "derived" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academic_departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "programs" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'approved',
    "duration" TEXT,
    "award" TEXT,
    "utmeSubjects" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "study_groups" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "iconUrl" TEXT,
    "createdById" TEXT NOT NULL,
    "approvalRequired" BOOLEAN NOT NULL DEFAULT true,
    "maxMembers" INTEGER NOT NULL DEFAULT 200,
    "memberCount" INTEGER NOT NULL DEFAULT 1,
    "official" BOOLEAN NOT NULL DEFAULT false,
    "institutionId" TEXT,
    "scopeType" TEXT NOT NULL DEFAULT 'open',
    "faculty" TEXT,
    "department" TEXT,
    "program" TEXT,
    "courseCode" TEXT,
    "level" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "lastMessagePreview" TEXT,
    "lastMessageSender" TEXT,
    "lastMessageType" TEXT,
    "lastScopeInviteAt" TIMESTAMP(3),
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "study_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "study_group_members" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "lastReadAt" TIMESTAMP(3),
    "historyAccess" TEXT NOT NULL DEFAULT 'none',
    "historyRequestedAt" TIMESTAMP(3),
    "historyReviewedAt" TIMESTAMP(3),
    "historyReviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "study_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "study_group_messages" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "senderId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'text',
    "text" TEXT,
    "attachmentUrl" TEXT,
    "attachmentName" TEXT,
    "attachmentMime" TEXT,
    "attachmentBytes" INTEGER,
    "attachmentWidth" INTEGER,
    "attachmentHeight" INTEGER,
    "attachmentDuration" INTEGER,
    "thumbnailUrl" TEXT,
    "clientId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_group_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "profile_change_requests_userId_idx" ON "profile_change_requests"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "profile_change_requests_status_idx" ON "profile_change_requests"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "institutions_name_idx" ON "institutions"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "institutions_state_idx" ON "institutions"("state");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "institutions_name_abbreviation_key" ON "institutions"("name", "abbreviation");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "faculties_institutionId_name_key" ON "faculties"("institutionId", "name");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "academic_departments_facultyId_name_key" ON "academic_departments"("facultyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "programs_departmentId_name_key" ON "programs"("departmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "study_groups_code_key" ON "study_groups"("code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "study_groups_createdById_idx" ON "study_groups"("createdById");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "study_groups_institutionId_program_level_idx" ON "study_groups"("institutionId", "program", "level");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "study_group_members_userId_status_idx" ON "study_group_members"("userId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "study_group_members_groupId_status_idx" ON "study_group_members"("groupId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "study_group_members_groupId_historyAccess_idx" ON "study_group_members"("groupId", "historyAccess");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "study_group_members_groupId_userId_key" ON "study_group_members"("groupId", "userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "study_group_messages_groupId_createdAt_idx" ON "study_group_messages"("groupId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "study_group_messages_groupId_clientId_key" ON "study_group_messages"("groupId", "clientId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "cbt_questions_documentId_idx" ON "cbt_questions"("documentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "cbt_questions_materialId_idx" ON "cbt_questions"("materialId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "cbt_questions_generatedByUserId_idx" ON "cbt_questions"("generatedByUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "class_events_institutionId_department_idx" ON "class_events"("institutionId", "department");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "department_memberships_institutionId_department_idx" ON "department_memberships"("institutionId", "department");

-- Keep memberships with the same programme name at different institutions distinct.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'department_memberships_userId_department_key'
      AND conrelid = '"department_memberships"'::regclass
  ) THEN
    ALTER TABLE "department_memberships" DROP CONSTRAINT "department_memberships_userId_department_key";
  ELSE
    DROP INDEX IF EXISTS "department_memberships_userId_department_key";
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "department_memberships_userId_institutionId_department_key"
  ON "department_memberships"("userId", "institutionId", "department");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "documents_status_idx" ON "documents"("status");

CREATE INDEX IF NOT EXISTS "documents_institutionId_department_level_idx" ON "documents"("institutionId", "department", "level");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "feed_posts_institutionId_kind_department_idx" ON "feed_posts"("institutionId", "kind", "department");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "notifications_readByAdmin_idx" ON "notifications"("readByAdmin");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "users_institutionId_idx" ON "users"("institutionId");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_institutionId_fkey') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profile_change_requests_userId_fkey') THEN
    ALTER TABLE "profile_change_requests" ADD CONSTRAINT "profile_change_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'faculties_institutionId_fkey') THEN
    ALTER TABLE "faculties" ADD CONSTRAINT "faculties_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'academic_departments_facultyId_fkey') THEN
    ALTER TABLE "academic_departments" ADD CONSTRAINT "academic_departments_facultyId_fkey" FOREIGN KEY ("facultyId") REFERENCES "faculties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'programs_departmentId_fkey') THEN
    ALTER TABLE "programs" ADD CONSTRAINT "programs_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "academic_departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'study_groups_createdById_fkey') THEN
    ALTER TABLE "study_groups" ADD CONSTRAINT "study_groups_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'study_groups_institutionId_fkey') THEN
    ALTER TABLE "study_groups" ADD CONSTRAINT "study_groups_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'study_group_members_groupId_fkey') THEN
    ALTER TABLE "study_group_members" ADD CONSTRAINT "study_group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "study_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'study_group_members_userId_fkey') THEN
    ALTER TABLE "study_group_members" ADD CONSTRAINT "study_group_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'study_group_messages_groupId_fkey') THEN
    ALTER TABLE "study_group_messages" ADD CONSTRAINT "study_group_messages_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "study_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'study_group_messages_senderId_fkey') THEN
    ALTER TABLE "study_group_messages" ADD CONSTRAINT "study_group_messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;



-- ─── Keep every existing record on the University of Abuja ──────────────────
INSERT INTO "institutions" ("id", "name", "displayName", "abbreviation", "type", "category", "ownership", "state", "source", "active", "createdAt", "updatedAt")
VALUES ('uofa', 'UNIVERSITY OF ABUJA, GWAGWALADA, ABUJA, FCT', 'University of Abuja', 'ABUJA', 'Degree', 'FEDERAL UNIVERSITIES', 'Federal', 'FCT', 'curated', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

UPDATE "users" SET "institutionId" = 'uofa' WHERE "institutionId" IS NULL AND ("faculty" IS NOT NULL OR "department" IS NOT NULL OR "program" IS NOT NULL);
UPDATE "feed_posts" SET "institutionId" = 'uofa' WHERE "institutionId" IS NULL;
UPDATE "class_events" SET "institutionId" = 'uofa' WHERE "institutionId" IS NULL;
UPDATE "department_memberships" SET "institutionId" = 'uofa' WHERE "institutionId" IS NULL;
UPDATE "documents" SET "institutionId" = 'uofa' WHERE "institutionId" IS NULL;
ALTER TABLE "study_groups" ADD COLUMN IF NOT EXISTS "lastScopeInviteAt" TIMESTAMP(3);
