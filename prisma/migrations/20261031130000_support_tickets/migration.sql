CREATE TYPE "SupportTicketStatus" AS ENUM ('open', 'in_progress', 'waiting_on_user', 'resolved', 'closed');
CREATE TYPE "SupportTicketPriority" AS ENUM ('low', 'normal', 'high', 'urgent');

CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "screenshotUrl" TEXT,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'open',
    "priority" "SupportTicketPriority" NOT NULL DEFAULT 'normal',
    "assigneeId" TEXT,
    "internalNotes" TEXT,
    "firstRepliedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "support_ticket_replies" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isStaff" BOOLEAN NOT NULL DEFAULT false,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_ticket_replies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "support_canned_replies" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "support_canned_replies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_tickets_userId_idx" ON "support_tickets"("userId");
CREATE INDEX "support_tickets_status_idx" ON "support_tickets"("status");
CREATE INDEX "support_tickets_assigneeId_idx" ON "support_tickets"("assigneeId");
CREATE INDEX "support_tickets_createdAt_idx" ON "support_tickets"("createdAt");
CREATE INDEX "support_ticket_replies_ticketId_idx" ON "support_ticket_replies"("ticketId");

ALTER TABLE "support_tickets"
    ADD CONSTRAINT "support_tickets_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_tickets"
    ADD CONSTRAINT "support_tickets_assigneeId_fkey"
    FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "support_ticket_replies"
    ADD CONSTRAINT "support_ticket_replies_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_ticket_replies"
    ADD CONSTRAINT "support_ticket_replies_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
