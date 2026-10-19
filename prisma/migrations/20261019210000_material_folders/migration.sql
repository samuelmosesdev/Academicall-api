-- My materials: students' own folders for uploads and saved materials
CREATE TABLE "material_folders" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'violet',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "material_folders_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "material_folders_userId_parentId_idx" ON "material_folders"("userId", "parentId");
ALTER TABLE "material_folders" ADD CONSTRAINT "material_folders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "material_folders" ADD CONSTRAINT "material_folders_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "material_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "documents" ADD COLUMN "folderId" TEXT;
CREATE INDEX "documents_folderId_idx" ON "documents"("folderId");
ALTER TABLE "documents" ADD CONSTRAINT "documents_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "material_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "material_saves" ADD COLUMN "folderId" TEXT;
CREATE INDEX "material_saves_folderId_idx" ON "material_saves"("folderId");
ALTER TABLE "material_saves" ADD CONSTRAINT "material_saves_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "material_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
