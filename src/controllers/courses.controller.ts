import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";

export async function listCourses(req: Request, res: Response) {
  const q = req.query.q as string | undefined;

  const courses = await prisma.course.findMany({
    where: q
      ? {
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { code: { contains: q, mode: "insensitive" } },
            { category: { contains: q, mode: "insensitive" } },
          ],
        }
      : undefined,
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  res.json({ courses });
}

export async function getCourse(req: Request, res: Response) {
  const course = await prisma.course.findUnique({
    where: { id: String(req.params.id) },
    include: { documents: { take: 20 } },
  });

  if (!course) return res.status(404).json({ error: "Course not found" });
  res.json({ course });
}

const createSchema = z.object({
  title: z.string().min(1),
  code: z.string().optional(),
  description: z.string().optional(),
  thumbnailUrl: z.string().url().optional(),
  category: z.string().optional(),
  source: z.string().optional(),
});

export async function createCourse(req: Request, res: Response) {
  try {
    const body = createSchema.parse(req.body);
    const course = await prisma.course.create({ data: body });
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
    const course = await prisma.course.update({
      where: { id: String(req.params.id) },
      data: req.body,
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
