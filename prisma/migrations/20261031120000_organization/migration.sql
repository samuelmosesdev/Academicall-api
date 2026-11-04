-- Organisation: offices, positions, supervision and assigned staff work
CREATE TABLE "offices" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'department',
    "description" TEXT,
    "parentId" TEXT,
    "headId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "offices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "offices_name_key" ON "offices"("name");
CREATE UNIQUE INDEX "offices_code_key" ON "offices"("code");
CREATE INDEX "offices_parentId_idx" ON "offices"("parentId");

CREATE TABLE "staff_tasks" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'todo',
    "officeId" TEXT,
    "assigneeId" TEXT NOT NULL,
    "createdById" TEXT,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "staff_tasks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "staff_tasks_assigneeId_status_idx" ON "staff_tasks"("assigneeId", "status");
CREATE INDEX "staff_tasks_officeId_idx" ON "staff_tasks"("officeId");

ALTER TABLE "users" ADD COLUMN "officeId" TEXT;
ALTER TABLE "users" ADD COLUMN "positionTitle" TEXT;
ALTER TABLE "users" ADD COLUMN "orgRole" TEXT;
ALTER TABLE "users" ADD COLUMN "supervisorId" TEXT;
CREATE INDEX "users_officeId_idx" ON "users"("officeId");
CREATE INDEX "users_supervisorId_idx" ON "users"("supervisorId");

ALTER TABLE "offices" ADD CONSTRAINT "offices_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "offices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "offices" ADD CONSTRAINT "offices_headId_fkey" FOREIGN KEY ("headId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_officeId_fkey" FOREIGN KEY ("officeId") REFERENCES "offices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "staff_tasks" ADD CONSTRAINT "staff_tasks_officeId_fkey" FOREIGN KEY ("officeId") REFERENCES "offices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "staff_tasks" ADD CONSTRAINT "staff_tasks_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_tasks" ADD CONSTRAINT "staff_tasks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
