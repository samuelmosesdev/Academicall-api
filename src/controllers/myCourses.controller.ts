/**
 * A student's own course list, and the suggestions shown on the Courses page.
 *
 *   GET    /me/courses                 the list (Enrollment rows), oldest first
 *   GET    /me/courses/suggestions     courses from the student's programme curricula,
 *                                      their department's admin-assigned courses and
 *                                      the department's existing course rows
 *   GET    /catalog/courses            search the whole catalogue (paginated)
 *   POST   /me/courses                 add one: { courseId } or { code, title }
 *   POST   /me/courses/bulk            add several: { courseIds: [] }
 *   DELETE /me/courses/:id             remove one
 *
 * Enrollment is the source of truth. A course code appears at most once per student
 * (unique userId + courseCode), so a catalogue course and a hand-typed one can't collide.
 * The older profile JSON (customCourses) is copied into enrollments once and left in place.
 */
import { Request, Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { HttpError, handle, pageParams } from "../lib/http";

export const FREE_COURSE_LIMIT = 5;
const isPaid = (plan?: string | null) => plan === "pro" || plan === "annual";

export const normCode = (code?: string | null) => {
  const c = String(code || "").toUpperCase().replace(/\s+/g, " ").trim();
  const m = /^([A-Z]{2,5})\s*-?\s*(\d{3}[A-Z]?)$/.exec(c);
  return m ? `${m[1]} ${m[2]}` : c;
};
const levelNum = (lvl?: string | null) => {
  const m = /(\d{3})/.exec(String(lvl || ""));
  if (m) return Number(m[1]);
  const r = /(ND|HND|NCE)\s*(I{1,3})\b/i.exec(String(lvl || ""));
  if (r) return (r[1].toUpperCase() === "HND" ? 300 : 0) + r[2].length * 100;
  return null;
};

const enrollmentOut = (e: any) => ({
  id: e.id,
  courseId: e.courseId,
  code: e.course?.code || e.courseCode || null,
  title: e.course?.title || e.courseTitle || e.courseCode || "Untitled course",
  units: e.course?.units ?? null,
  level: e.course?.level ?? null,
  semester: e.course?.semester ?? null,
  source: e.source || (e.courseId ? "catalogue" : "custom"),
  archived: Boolean(e.course?.archivedAt),
  progressPct: e.progressPct,
  addedAt: e.createdAt,
});

/** Copy the old profile JSON list into enrollments, once. */
async function importLegacyCustom(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { customCourses: true, settings: true } });
  const settings = (user?.settings && typeof user.settings === "object" ? user.settings : {}) as Record<string, any>;
  const list = Array.isArray(user?.customCourses) ? (user!.customCourses as any[]) : [];
  if (settings.coursesImportedAt || !list.length) return;
  for (const c of list) {
    const code = normCode(c?.code);
    if (!code || c?.enabled === false) continue;
    await prisma.enrollment
      .create({ data: { userId, courseCode: code, courseTitle: String(c?.title || code).slice(0, 200), source: c?.source === "ai" ? "ai" : "custom" } })
      .catch(() => null); // already there
  }
  await prisma.user.update({ where: { id: userId }, data: { settings: { ...settings, coursesImportedAt: new Date().toISOString() } } });
}

export async function listMine(userId: string) {
  const rows = await prisma.enrollment.findMany({ where: { userId }, include: { course: true }, orderBy: { createdAt: "asc" } });
  return rows.map(enrollmentOut);
}

export const getMyCourses = handle(async (req: Request, res: Response) => {
  const me = req.user!;
  await importLegacyCustom(me.id);
  const [courses, user] = await Promise.all([
    listMine(me.id),
    prisma.user.findUnique({ where: { id: me.id }, select: { plan: true } }),
  ]);
  res.json({ courses, limit: isPaid(user?.plan) ? null : FREE_COURSE_LIMIT });
});

export const getSuggestions = handle(async (req: Request, res: Response) => {
  const me = req.user!;
  const includeLegacy = req.query.legacy === "1" || req.query.legacy === "true";
  const user = await prisma.user.findUnique({
    where: { id: me.id },
    select: { programId: true, departmentId: true, department: true, level: true, program: true, institutionId: true, institution: { select: { name: true, displayName: true, abbreviation: true, type: true } } },
  });
  if (!user) throw new HttpError(404, "User not found");
  const mine = await prisma.enrollment.findMany({ where: { userId: me.id }, select: { courseId: true, courseCode: true, course: { select: { code: true } } } });
  const haveIds = new Set(mine.map((m) => m.courseId).filter(Boolean));
  const haveCodes = new Set(mine.map((m) => normCode(m.course?.code || m.courseCode)).filter(Boolean));

  type Sug = { courseId: string; code: string | null; title: string; units: number | null; level: string | null; semester: string | null; status: string | null; from: string; curriculum: string | null; edition: string | null; legacy: boolean; added: boolean };
  const byCode = new Map<string, Sug>();
  const put = (s: Sug) => {
    const key = normCode(s.code) || `id:${s.courseId}`;
    const prev = byCode.get(key);
    // department assignments beat curricula; current curricula beat the older scheme
    const score = (x: Sug) => (x.from === "department" || x.from === "courseRep" ? 3 : x.legacy ? 1 : 2);
    if (!prev || score(s) > score(prev)) byCode.set(key, s);
  };
  const mark = (courseId: string, code?: string | null) => haveIds.has(courseId) || haveCodes.has(normCode(code));

  const curricula: { id: string; name: string; tier: string; edition: string | null; legacyEdition: string | null; general: boolean }[] = [];
  if (user.programId) {
    const links = await prisma.programCurriculum.findMany({
      where: { programId: user.programId, curriculum: { active: true } },
      include: {
        curriculum: {
          include: {
            entries: {
              where: { ...(includeLegacy ? {} : { legacy: false }), course: { archivedAt: null } },
              include: { course: { select: { id: true, code: true, title: true, units: true } } },
            },
          },
        },
      },
    });
    for (const l of links) {
      const c = l.curriculum;
      curricula.push({ id: c.id, name: c.name, tier: c.tier, edition: c.edition, legacyEdition: c.legacyEdition, general: c.general });
      for (const e of c.entries) {
        put({
          courseId: e.course.id, code: e.course.code, title: e.course.title, units: e.units ?? e.course.units ?? null,
          level: e.level, semester: e.semester, status: e.status, from: c.general ? "general" : "curriculum",
          curriculum: c.name, edition: e.legacy ? c.legacyEdition : c.edition, legacy: e.legacy, added: mark(e.course.id, e.course.code),
        });
      }
    }
  }
  if (user.departmentId) {
    const assigned = await prisma.departmentCourse.findMany({
      where: { departmentId: user.departmentId, course: { archivedAt: null } },
      include: { course: { select: { id: true, code: true, title: true, units: true, level: true, semester: true } } },
    });
    for (const a of assigned) {
      put({
        courseId: a.course.id, code: a.course.code, title: a.course.title, units: a.course.units, level: a.level || a.course.level,
        semester: a.semester || a.course.semester, status: a.status, from: "department", curriculum: null, edition: null, legacy: false,
        added: mark(a.course.id, a.course.code),
      });
    }
  }
  if (user.department) {
    // Courses already created for this department by staff and course reps (pre-catalogue rows).
    const own = await prisma.course.findMany({
      where: { department: { equals: user.department, mode: "insensitive" }, archivedAt: null, published: true, OR: [{ source: null }, { source: { not: "catalogue" } }] },
      select: { id: true, code: true, title: true, units: true, level: true, semester: true, source: true },
      take: 400,
    });
    for (const c of own) {
      put({ courseId: c.id, code: c.code, title: c.title, units: c.units, level: c.level, semester: c.semester, status: null, from: c.source === "courseRep" ? "courseRep" : "department", curriculum: null, edition: null, legacy: false, added: mark(c.id, c.code) });
    }
  }

  const myLevel = levelNum(user.level);
  const suggestions = [...byCode.values()].sort((a, b) =>
    (levelNum(a.level) ?? 999) - (levelNum(b.level) ?? 999) ||
    String(a.semester || "").localeCompare(String(b.semester || "")) ||
    String(a.code || "").localeCompare(String(b.code || "")),
  );
  res.json({
    suggestions,
    curricula,
    profile: {
      institution: user.institution ? user.institution.displayName || user.institution.name : null,
      tier: user.institution?.type || null,
      department: user.department, programme: user.program, level: user.level, levelNumber: myLevel,
      hasProgramme: Boolean(user.programId), hasDepartment: Boolean(user.departmentId || user.department),
    },
  });
});

export const searchCatalog = handle(async (req: Request, res: Response) => {
  const q = String(req.query.q || "").trim();
  const tier = String(req.query.tier || "").trim();
  const { page, pageSize, skip, take } = pageParams(req.query, { def: 20, max: 50 });
  const where: Prisma.CourseWhereInput = { archivedAt: null, published: true };
  if (q) {
    const code = normCode(q);
    where.OR = [
      { code: { startsWith: code, mode: "insensitive" } },
      { code: { contains: q.replace(/\s+/g, " "), mode: "insensitive" } },
      { title: { contains: q, mode: "insensitive" } },
    ];
  }
  if (tier) where.category = tier;
  const [rows, total, mine] = await Promise.all([
    prisma.course.findMany({ where, orderBy: [{ code: "asc" }, { title: "asc" }], skip, take, select: { id: true, code: true, title: true, units: true, level: true, semester: true, category: true, department: true } }),
    prisma.course.count({ where }),
    prisma.enrollment.findMany({ where: { userId: req.user!.id }, select: { courseId: true, courseCode: true, course: { select: { code: true } } } }),
  ]);
  const ids = new Set(mine.map((m) => m.courseId));
  const codes = new Set(mine.map((m) => normCode(m.course?.code || m.courseCode)));
  res.json({ courses: rows.map((c) => ({ ...c, added: ids.has(c.id) || codes.has(normCode(c.code)) })), total, page, pageSize });
});

/** Shared by POST /me/courses, the bulk add and the older POST /enrollments. */
export async function addCourseFor(userId: string, input: { courseId?: string | null; code?: string | null; title?: string | null; source?: string | null }) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { plan: true } });
  const count = await prisma.enrollment.count({ where: { userId } });
  let course: { id: string; code: string | null; title: string; archivedAt: Date | null } | null = null;
  if (input.courseId) {
    course = await prisma.course.findUnique({ where: { id: input.courseId }, select: { id: true, code: true, title: true, archivedAt: true } });
    if (!course) throw new HttpError(404, "That course isn't in the catalogue");
    if (course.archivedAt) throw new HttpError(409, `${course.code || course.title} has been retired and can't be added`);
  }
  const code = normCode(course?.code || input.code);
  const title = (course?.title || input.title || "").trim();
  if (!course && (!code || !title)) throw new HttpError(400, "Give the course code and title");
  if (!course && !/^[A-Z0-9][A-Z0-9 /.-]{1,19}$/.test(code)) throw new HttpError(400, "That doesn't look like a course code");

  const dup = await prisma.enrollment.findFirst({
    where: { userId, OR: [...(course ? [{ courseId: course.id }] : []), ...(code ? [{ courseCode: code }, { course: { code: { equals: code, mode: "insensitive" as const } } }] : [])] },
  });
  if (dup) throw new HttpError(409, `${code || title} is already on your list`, "duplicate");
  if (!isPaid(user?.plan) && count >= FREE_COURSE_LIMIT) {
    throw new HttpError(403, `The free plan holds ${FREE_COURSE_LIMIT} courses. Remove one or upgrade to add more.`, "limit");
  }
  try {
    const row = await prisma.enrollment.create({
      data: { userId, courseId: course?.id || null, courseCode: code || null, courseTitle: title.slice(0, 200), source: course ? "catalogue" : input.source === "ai" ? "ai" : "custom" },
      include: { course: true },
    });
    return enrollmentOut(row);
  } catch (err: any) {
    if (err?.code === "P2002") throw new HttpError(409, `${code || title} is already on your list`, "duplicate");
    throw err;
  }
}

const addSchema = z.object({
  courseId: z.string().min(1).max(80).optional(),
  code: z.string().trim().max(20).optional(),
  title: z.string().trim().max(200).optional(),
  source: z.enum(["custom", "ai"]).optional(),
}).refine((b) => b.courseId || (b.code && b.title), { message: "Give a courseId, or a code and title" });

export const addMyCourse = handle(async (req: Request, res: Response) => {
  const body = addSchema.parse(req.body);
  const course = await addCourseFor(req.user!.id, body);
  res.status(201).json({ course });
});

export const addMyCoursesBulk = handle(async (req: Request, res: Response) => {
  const body = z.object({
    courseIds: z.array(z.string().min(1).max(80)).max(100).optional(),
    custom: z.array(z.object({ code: z.string().trim().max(20), title: z.string().trim().max(200) })).max(50).optional(),
    source: z.enum(["custom", "ai"]).optional(),
  }).parse(req.body);
  const added: any[] = []; const skipped: { ref: string; reason: string; code?: string }[] = [];
  const work = [
    ...(body.courseIds || []).map((courseId) => ({ courseId })),
    ...(body.custom || []).map((c) => ({ code: c.code, title: c.title, source: body.source })),
  ];
  for (const item of work) {
    try { added.push(await addCourseFor(req.user!.id, item)); } catch (err: any) {
      if (err instanceof HttpError) {
        skipped.push({ ref: (item as any).courseId || (item as any).code, reason: err.message, code: err.code });
        if (err.code === "limit") break;
      } else throw err;
    }
  }
  res.status(added.length ? 201 : 200).json({ added, skipped });
});

export const removeMyCourse = handle(async (req: Request, res: Response) => {
  const row = await prisma.enrollment.findFirst({ where: { id: String(req.params.id), userId: req.user!.id } });
  if (!row) throw new HttpError(404, "That course isn't on your list");
  await prisma.enrollment.delete({ where: { id: row.id } });
  res.status(204).send();
});
