/**
 * One search box: courses, materials, study groups and news in one call.
 * (UTME past-question topics and app pages are matched in the browser from
 * files it already has, so they cost the API nothing.)
 */
import { prisma } from "../lib/prisma";
import { handle } from "../lib/http";
import { isStaffRole } from "../lib/access";

const contains = (q: string) => ({ contains: q, mode: "insensitive" as const });

/** GET /search?q=&limit= */
export const search = handle(async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 80);
  const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 20);
  if (q.length < 2) return res.json({ q, courses: [], materials: [], groups: [], news: [] });
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { id: true, role: true, institutionId: true } });
  const staff = isStaffRole(user?.role);
  const student = user?.role === "user" || user?.role === "courseRep" || staff;
  const code = q.toUpperCase().replace(/\s+/g, " ");
  const codeCompact = code.replace(/\s+/g, "");

  const [myCourses, catalog, materials, groups, news] = await Promise.all([
    student
      ? prisma.enrollment.findMany({
          where: { userId: req.user!.id, OR: [{ courseCode: { contains: code, mode: "insensitive" } }, { courseCode: { contains: codeCompact, mode: "insensitive" } }, { courseTitle: contains(q) }] },
          select: { id: true, courseCode: true, courseTitle: true }, take: limit,
        })
      : Promise.resolve([]),
    student
      ? prisma.course.findMany({
          where: { archivedAt: null, OR: [{ code: { contains: code, mode: "insensitive" } }, { code: { contains: codeCompact, mode: "insensitive" } }, { title: contains(q) }] },
          select: { id: true, code: true, title: true, units: true, level: true }, take: limit * 4, orderBy: { code: "asc" },
        })
      : Promise.resolve([]),
    student
      ? prisma.document.findMany({
          where: {
            deletedAt: null, status: "approved",
            ...(user?.institutionId && !staff ? { OR: [{ institutionId: user.institutionId }, { institutionId: null }] } : {}),
            AND: [{ OR: [{ title: contains(q) }, { description: contains(q) }, { course: { code: { contains: codeCompact, mode: "insensitive" } } }] }],
          },
          select: { id: true, title: true, fileName: true, level: true, department: true, course: { select: { code: true } } }, take: limit, orderBy: { openCount: "desc" },
        })
      : Promise.resolve([]),
    prisma.studyGroup.findMany({
      where: { archived: false, members: { some: { userId: req.user!.id, status: "active" } }, OR: [{ name: contains(q) }, { courseCode: { contains: codeCompact, mode: "insensitive" } }, { description: contains(q) }] },
      select: { id: true, name: true, code: true, courseCode: true, memberCount: true }, take: limit,
    }),
    prisma.newsPost.findMany({
      where: { status: "published", OR: [{ title: contains(q) }, { excerpt: contains(q) }] },
      select: { id: true, slug: true, title: true, category: true, publishedAt: true }, take: limit, orderBy: { publishedAt: "desc" },
    }),
  ]);

  const mine = new Set(myCourses.map((c) => (c.courseCode || "").replace(/\s+/g, "").toUpperCase()));
  res.json({
    q,
    courses: [
      ...myCourses.map((c) => ({ id: c.id, code: c.courseCode, title: c.courseTitle, mine: true })),
      ...catalog.filter((c) => {
        const k = (c.code || "").replace(/\s+/g, "").toUpperCase();
        if (mine.has(k)) return false;
        mine.add(k); // the same code appears in many curricula; show it once
        return true;
      }).map((c) => ({ id: c.id, code: c.code, title: c.title, units: c.units, level: c.level, mine: false })),
    ].slice(0, limit),
    materials: materials.map((m) => ({ id: m.id, title: m.title, courseCode: m.course?.code || null, level: m.level, department: m.department })),
    groups,
    news,
  });
});
