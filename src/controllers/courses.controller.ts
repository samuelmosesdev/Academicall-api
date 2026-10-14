import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";

export async function listCourses(req: Request, res: Response) {
  const q = req.query.q as string | undefined;
  const isStaff = ["admin", "alphaAgent", "agent"].includes(req.user?.role || "");

  const courses = await prisma.course.findMany({
    where: {
      ...(!isStaff ? { published: true } : {}),
      ...(q
        ? {
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { code: { contains: q, mode: "insensitive" } },
            { category: { contains: q, mode: "insensitive" } },
          ],
        }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  res.json({ courses });
}

export async function getCourse(req: Request, res: Response) {
  const course = await prisma.course.findUnique({
    where: { id: String(req.params.id) },
    include: { documents: { where: { deletedAt: null }, take: 20 } },
  });

  if (!course) return res.status(404).json({ error: "Course not found" });
  res.json({ course });
}

const createSchema = z.object({
  title: z.string().min(1),
  code: z.string().optional().nullable(),
  faculty: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  level: z.string().optional().nullable(),
  semester: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  thumbnailUrl: z.string().url().optional().nullable(),
  category: z.string().optional().nullable(),
  source: z.string().optional().nullable(),
  published: z.boolean().optional(),
  approvedBy: z.string().optional().nullable(),
  requestedBy: z.string().optional().nullable(),
});

export async function createCourse(req: Request, res: Response) {
  try {
    if (!req.user || !["admin", "alphaAgent", "agent", "courseRep"].includes(req.user.role)) {
      return res.status(403).json({ error: "Only staff and Course Reps can add courses" });
    }
    const body = createSchema.parse(req.body);
    let data = body;
    if (req.user?.role === "courseRep") {
      const rep = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { courseRepMeta: true },
      });
      const meta = rep?.courseRepMeta as { program?: string; level?: string; faculty?: string } | null;
      const program = String(meta?.program || "").trim();
      const assignedLevel = String(meta?.level || "").trim();
      const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
      const normalizeLevel = (value: string) => normalize(value).replace(/\s*level\s*/g, "");

      if (!program || !assignedLevel) {
        return res.status(403).json({ error: "A Course Rep must have an assigned program and level to add courses" });
      }
      if (!body.level || normalizeLevel(body.level) !== normalizeLevel(assignedLevel)) {
        return res.status(403).json({ error: "Course Reps can only add courses for their assigned level" });
      }

      if (body.code) {
        const duplicate = await prisma.course.findFirst({
          where: {
            code: { equals: body.code, mode: "insensitive" },
            department: { equals: program, mode: "insensitive" },
            level: { equals: assignedLevel, mode: "insensitive" },
          },
          select: { id: true },
        });
        if (duplicate) return res.status(409).json({ error: "That course already exists in your program and level" });
      }

      data = {
        ...body,
        faculty: meta?.faculty || body.faculty || null,
        department: program,
        level: assignedLevel,
        source: "courseRep",
        published: true,
        requestedBy: req.user.id,
        approvedBy: null,
      };
    }
    const course = await prisma.course.create({ data });
    res.status(201).json({ course });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors });
    }
    console.error(err);
    res.status(500).json({ error: "Create failed" });
  }
}

export async function updateCourse(req: Request, res: Response) {
  try {
    const body = createSchema.partial().parse(req.body);
    const course = await prisma.course.update({
      where: { id: String(req.params.id) },
      data: body,
    });
    res.json({ course });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Update failed" });
  }
}

export async function deleteCourse(req: Request, res: Response) {
  await prisma.course.delete({ where: { id: String(req.params.id) } });
  res.status(204).send();
}
