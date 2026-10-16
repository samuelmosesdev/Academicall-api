-- Aspirants + Aspirant Houses, House Leaders, dashboard board, Chief News Agent, news subscriptions & audiences
-- AlterEnum


ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'house';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'news';

-- AlterEnum
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'aspirant';

-- AlterTable
ALTER TABLE "news_posts" ADD COLUMN     "audience" JSONB,
ADD COLUMN     "moderatedAt" TIMESTAMP(3),
ADD COLUMN     "moderatedById" TEXT,
ADD COLUMN     "moderationNote" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "aspirantMeta" JSONB,
ADD COLUMN     "newsAlerts" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "newsStatus" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "newsStatusAt" TIMESTAMP(3),
ADD COLUMN     "newsStatusReason" TEXT;

-- CreateTable
CREATE TABLE "aspirations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "institutionId" TEXT NOT NULL,
    "course" TEXT,
    "programId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aspirations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aspirant_houses" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "motto" TEXT,
    "coverUrl" TEXT,
    "rules" TEXT,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "threadCount" INTEGER NOT NULL DEFAULT 0,
    "lastThreadAt" TIMESTAMP(3),
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aspirant_houses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aspirant_house_members" (
    "id" TEXT NOT NULL,
    "houseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "choiceRank" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "reason" TEXT,
    "statusById" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aspirant_house_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aspirant_house_leaders" (
    "houseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assignedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aspirant_house_leaders_pkey" PRIMARY KEY ("houseId","userId")
);

-- CreateTable
CREATE TABLE "house_threads" (
    "id" TEXT NOT NULL,
    "houseId" TEXT NOT NULL,
    "authorId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "imageUrl" TEXT,
    "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "pinnedAt" TIMESTAMP(3),
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "lastReplyAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "house_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "house_replies" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "imageUrl" TEXT,
    "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "house_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_slides" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'message',
    "title" TEXT,
    "body" TEXT,
    "imageUrl" TEXT,
    "ctaLabel" TEXT,
    "ctaUrl" TEXT,
    "theme" TEXT NOT NULL DEFAULT 'midnight',
    "audience" TEXT NOT NULL DEFAULT 'students',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_slides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "news_subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "news_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "aspirations_institutionId_idx" ON "aspirations"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "aspirations_userId_rank_key" ON "aspirations"("userId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "aspirations_userId_institutionId_key" ON "aspirations"("userId", "institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "aspirant_houses_institutionId_key" ON "aspirant_houses"("institutionId");

-- CreateIndex
CREATE INDEX "aspirant_houses_memberCount_idx" ON "aspirant_houses"("memberCount");

-- CreateIndex
CREATE INDEX "aspirant_house_members_userId_status_idx" ON "aspirant_house_members"("userId", "status");

-- CreateIndex
CREATE INDEX "aspirant_house_members_houseId_status_idx" ON "aspirant_house_members"("houseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "aspirant_house_members_houseId_userId_key" ON "aspirant_house_members"("houseId", "userId");

-- CreateIndex
CREATE INDEX "aspirant_house_leaders_userId_idx" ON "aspirant_house_leaders"("userId");

-- CreateIndex
CREATE INDEX "house_threads_houseId_pinned_createdAt_idx" ON "house_threads"("houseId", "pinned", "createdAt");

-- CreateIndex
CREATE INDEX "house_replies_threadId_createdAt_idx" ON "house_replies"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "dashboard_slides_active_sortOrder_idx" ON "dashboard_slides"("active", "sortOrder");

-- CreateIndex
CREATE INDEX "news_subscriptions_kind_value_idx" ON "news_subscriptions"("kind", "value");

-- CreateIndex
CREATE UNIQUE INDEX "news_subscriptions_userId_kind_value_key" ON "news_subscriptions"("userId", "kind", "value");

-- AddForeignKey
ALTER TABLE "aspirations" ADD CONSTRAINT "aspirations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aspirations" ADD CONSTRAINT "aspirations_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aspirant_houses" ADD CONSTRAINT "aspirant_houses_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aspirant_house_members" ADD CONSTRAINT "aspirant_house_members_houseId_fkey" FOREIGN KEY ("houseId") REFERENCES "aspirant_houses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aspirant_house_members" ADD CONSTRAINT "aspirant_house_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aspirant_house_leaders" ADD CONSTRAINT "aspirant_house_leaders_houseId_fkey" FOREIGN KEY ("houseId") REFERENCES "aspirant_houses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aspirant_house_leaders" ADD CONSTRAINT "aspirant_house_leaders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "house_threads" ADD CONSTRAINT "house_threads_houseId_fkey" FOREIGN KEY ("houseId") REFERENCES "aspirant_houses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "house_threads" ADD CONSTRAINT "house_threads_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "house_replies" ADD CONSTRAINT "house_replies_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "house_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "house_replies" ADD CONSTRAINT "house_replies_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "news_subscriptions" ADD CONSTRAINT "news_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
