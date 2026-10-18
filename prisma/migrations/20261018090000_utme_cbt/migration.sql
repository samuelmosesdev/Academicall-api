-- UTME CBT practice history
CREATE TABLE "utme_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "style" TEXT NOT NULL,
    "subjects" JSONB NOT NULL,
    "config" JSONB NOT NULL,
    "answers" JSONB,
    "total" INTEGER NOT NULL,
    "correct" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "maxScore" INTEGER NOT NULL,
    "durationSec" INTEGER NOT NULL,
    "timeLimitSec" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "utme_attempts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "utme_attempts_userId_createdAt_idx" ON "utme_attempts"("userId", "createdAt");
ALTER TABLE "utme_attempts" ADD CONSTRAINT "utme_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
