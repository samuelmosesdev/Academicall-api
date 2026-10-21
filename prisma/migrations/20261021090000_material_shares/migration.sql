-- Material sharing: send a file or folder from My materials to another user by Unique ID
CREATE TABLE "material_shares" (
    "id" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "folderCount" INTEGER NOT NULL DEFAULT 0,
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "copiedFolderId" TEXT,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "material_shares_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "material_shares_recipientId_status_idx" ON "material_shares"("recipientId", "status");
CREATE INDEX "material_shares_senderId_createdAt_idx" ON "material_shares"("senderId", "createdAt");
ALTER TABLE "material_shares" ADD CONSTRAINT "material_shares_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "material_shares" ADD CONSTRAINT "material_shares_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
