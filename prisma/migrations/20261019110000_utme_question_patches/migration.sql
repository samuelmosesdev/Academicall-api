CREATE TABLE "utme_question_patches" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "qid" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "isNew" BOOLEAN NOT NULL DEFAULT false,
    "data" JSONB,
    "note" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "utme_question_patches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "utme_media" (
    "id" TEXT NOT NULL,
    "slug" TEXT,
    "mime" TEXT NOT NULL DEFAULT 'image/webp',
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "utme_media_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "utme_question_patches_slug_qid_key" ON "utme_question_patches"("slug", "qid");
CREATE INDEX "utme_question_patches_updatedAt_idx" ON "utme_question_patches"("updatedAt");

ALTER TABLE "utme_question_patches"
ADD CONSTRAINT "utme_question_patches_updatedById_fkey"
FOREIGN KEY ("updatedById") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
