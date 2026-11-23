-- Automatic "[Programme] [Level] / semester / course" folders, pinning, and course codes on materials
ALTER TABLE "material_folders" ADD COLUMN "kind" TEXT;
ALTER TABLE "material_folders" ADD COLUMN "autoKey" TEXT;
ALTER TABLE "material_folders" ADD COLUMN "courseCode" TEXT;
ALTER TABLE "material_folders" ADD COLUMN "semester" TEXT;
ALTER TABLE "material_folders" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "material_folders" ADD COLUMN "pinnedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "material_folders_userId_autoKey_key" ON "material_folders"("userId", "autoKey");
CREATE INDEX "material_folders_userId_pinned_idx" ON "material_folders"("userId", "pinned");

ALTER TABLE "documents" ADD COLUMN "courseCode" TEXT;
ALTER TABLE "documents" ADD COLUMN "courseTitle" TEXT;
CREATE INDEX "documents_courseCode_idx" ON "documents"("courseCode");
