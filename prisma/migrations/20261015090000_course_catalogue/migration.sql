-- Course catalogue: national curricula, programme links, department course assignments,
-- and code-level de-duplication of student course lists.
-- AlterTable
ALTER TABLE "courses" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "catalogKey" TEXT,
ADD COLUMN     "units" INTEGER;

-- AlterTable
ALTER TABLE "enrollments" ADD COLUMN     "courseCode" TEXT,
ADD COLUMN     "source" TEXT DEFAULT 'catalogue';

-- CreateTable
CREATE TABLE "curricula" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "edition" TEXT,
    "legacyEdition" TEXT,
    "general" BOOLEAN NOT NULL DEFAULT false,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "institutionAbbrs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL DEFAULT 'national',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "curricula_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_courses" (
    "id" TEXT NOT NULL,
    "curriculumId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "semester" TEXT,
    "units" INTEGER,
    "status" TEXT,
    "legacy" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "curriculum_courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_curricula" (
    "programId" TEXT NOT NULL,
    "curriculumId" TEXT NOT NULL,
    "matchedBy" TEXT NOT NULL DEFAULT 'jamb',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "program_curricula_pkey" PRIMARY KEY ("programId","curriculumId")
);

-- CreateTable
CREATE TABLE "department_courses" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "level" TEXT,
    "semester" TEXT,
    "status" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "department_courses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "curricula_tier_idx" ON "curricula"("tier");

-- CreateIndex
CREATE INDEX "curriculum_courses_courseId_idx" ON "curriculum_courses"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_courses_curriculumId_courseId_level_legacy_key" ON "curriculum_courses"("curriculumId", "courseId", "level", "legacy");

-- CreateIndex
CREATE INDEX "program_curricula_curriculumId_idx" ON "program_curricula"("curriculumId");

-- CreateIndex
CREATE INDEX "department_courses_courseId_idx" ON "department_courses"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "department_courses_departmentId_courseId_key" ON "department_courses"("departmentId", "courseId");

-- CreateIndex
CREATE UNIQUE INDEX "courses_catalogKey_key" ON "courses"("catalogKey");

-- CreateIndex
CREATE INDEX "courses_code_idx" ON "courses"("code");

-- Backfill course codes on existing enrollments (first row per user+code only, so the new unique index holds)
UPDATE "enrollments" e SET "courseCode" = x.code
FROM (
  SELECT e2.id, UPPER(TRIM(c.code)) AS code,
         ROW_NUMBER() OVER (PARTITION BY e2."userId", UPPER(TRIM(c.code)) ORDER BY e2."createdAt") AS rn
  FROM "enrollments" e2 JOIN "courses" c ON c.id = e2."courseId"
  WHERE c.code IS NOT NULL AND TRIM(c.code) <> ''
) x
WHERE e.id = x.id AND x.rn = 1;

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_userId_courseCode_key" ON "enrollments"("userId", "courseCode");

-- AddForeignKey
ALTER TABLE "curriculum_courses" ADD CONSTRAINT "curriculum_courses_curriculumId_fkey" FOREIGN KEY ("curriculumId") REFERENCES "curricula"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_courses" ADD CONSTRAINT "curriculum_courses_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_curricula" ADD CONSTRAINT "program_curricula_programId_fkey" FOREIGN KEY ("programId") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_curricula" ADD CONSTRAINT "program_curricula_curriculumId_fkey" FOREIGN KEY ("curriculumId") REFERENCES "curricula"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_courses" ADD CONSTRAINT "department_courses_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "academic_departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_courses" ADD CONSTRAINT "department_courses_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
