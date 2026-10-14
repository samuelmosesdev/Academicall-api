-- Restore fields present in the current DepartmentMembership model but absent
-- from the original production-sync migration.
ALTER TABLE "department_memberships"
  ADD COLUMN IF NOT EXISTS "reviewedById" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);
