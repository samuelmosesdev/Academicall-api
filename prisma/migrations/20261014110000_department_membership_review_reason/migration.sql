-- Bring fresh and existing databases in line with DepartmentMembership.reviewReason.
ALTER TABLE "department_memberships"
  ADD COLUMN IF NOT EXISTS "reviewReason" TEXT;
