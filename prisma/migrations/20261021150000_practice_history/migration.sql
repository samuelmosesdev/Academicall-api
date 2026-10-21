-- CreateTable
CREATE TABLE "practice_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT,
    "courseCode" TEXT,
    "courseTitle" TEXT,
    "mode" TEXT,
    "quiz" BOOLEAN NOT NULL DEFAULT false,
    "correct" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "pct" INTEGER NOT NULL,
    "durationSec" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "practice_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practice_seen" (
    "userId" TEXT NOT NULL,
    "courseCode" TEXT NOT NULL,
    "questionIds" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "practice_seen_pkey" PRIMARY KEY ("userId","courseCode")
);

-- CreateIndex
CREATE INDEX "practice_attempts_userId_createdAt_idx" ON "practice_attempts"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "practice_attempts_userId_courseCode_idx" ON "practice_attempts"("userId", "courseCode");

-- CreateIndex
CREATE UNIQUE INDEX "practice_attempts_userId_clientId_key" ON "practice_attempts"("userId", "clientId");

-- CreateIndex
CREATE INDEX "announcement_reads_userId_readAt_idx" ON "announcement_reads"("userId", "readAt" DESC);

-- AddForeignKey
ALTER TABLE "practice_attempts" ADD CONSTRAINT "practice_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practice_seen" ADD CONSTRAINT "practice_seen_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
