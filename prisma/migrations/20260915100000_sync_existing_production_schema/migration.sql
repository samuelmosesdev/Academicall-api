-- Backfill schema additions that were present in schema.prisma but missing from the original production migration.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'new_student';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'lecture_update';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'announcement_published';

ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "approvedById" TEXT,
  ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3);

ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "readByAdmin" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "cbt_questions"
  ADD COLUMN IF NOT EXISTS "documentId" TEXT,
  ADD COLUMN IF NOT EXISTS "materialId" TEXT,
  ADD COLUMN IF NOT EXISTS "marks" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "referenceCode" TEXT,
  ADD COLUMN IF NOT EXISTS "hintEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "source" TEXT,
  ADD COLUMN IF NOT EXISTS "generatedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS "department_memberships" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "department" TEXT NOT NULL,
  "faculty" TEXT,
  "level" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "admittedAt" TIMESTAMP(3),
  "admittedById" TEXT,
  "withdrawRequestedAt" TIMESTAMP(3),
  "withdrawReason" TEXT,
  "withdrawStatus" TEXT,
  "withdrawReviewedAt" TIMESTAMP(3),
  "withdrawReviewedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "department_memberships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "department_memberships_userId_department_key"
  ON "department_memberships"("userId", "department");
CREATE INDEX IF NOT EXISTS "department_memberships_department_status_idx"
  ON "department_memberships"("department", "status");
CREATE INDEX IF NOT EXISTS "department_memberships_userId_idx"
  ON "department_memberships"("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'department_memberships_userId_fkey'
  ) THEN
    ALTER TABLE "department_memberships"
      ADD CONSTRAINT "department_memberships_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "generated_quizzes" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "materialId" TEXT,
  "materialTitle" TEXT,
  "courseCode" TEXT,
  "courseTitle" TEXT,
  "difficulty" TEXT,
  "questionCount" INTEGER NOT NULL DEFAULT 0,
  "questionIds" JSONB NOT NULL,
  "sectionNote" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ready',
  "score" INTEGER,
  "answers" JSONB,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "generated_quizzes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "generated_quizzes_userId_idx" ON "generated_quizzes"("userId");
CREATE INDEX IF NOT EXISTS "generated_quizzes_materialId_idx" ON "generated_quizzes"("materialId");
CREATE INDEX IF NOT EXISTS "generated_quizzes_userId_createdAt_idx" ON "generated_quizzes"("userId", "createdAt");
