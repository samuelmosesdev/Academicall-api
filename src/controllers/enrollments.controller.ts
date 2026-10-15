import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { HttpError } from "../lib/http";
import { addCourseFor } from "./myCourses.controller";

const enrollmentSchema = z.object({
  courseId: z.string().min(1),
  progressPct: z.number().int().min(0).max(100).optional(),
  topicLabel: z.string().optional(),
});

export async function listEnrollments(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const enrollments = await prisma.enrollment.findMany({
    where: { userId: req.user.id },
    include: { course: true },
    orderBy: { updatedAt: "desc" },
  });
  res.json({ enrollments });
}

export async function createEnrollment(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const body = enrollmentSchema.parse(req.body);
    // Same rules as POST /me/courses (no duplicate codes, plan limit); re-enrolling just updates progress.
    const existing = await prisma.enrollment.findFirst({ where: { userId: req.user.id, courseId: body.courseId } });
    if (!existing) await addCourseFor(req.user.id, { courseId: body.courseId });
    const enrollment = await prisma.enrollment.update({
      where: { userId_courseId: { userId: req.user.id, courseId: body.courseId } },
      data: { progressPct: body.progressPct, topicLabel: body.topicLabel },
      include: { course: true },
    });
    res.status(existing ? 200 : 201).json({ enrollment });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    res.status(500).json({ error: "Enrollment failed" });
  }
}

export async function deleteEnrollment(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const enrollment = await prisma.enrollment.findFirst({ where: { id: String(req.params.id), userId: req.user.id } });
  if (!enrollment) return res.status(404).json({ error: "Enrollment not found" });
  await prisma.enrollment.delete({ where: { id: enrollment.id } });
  res.status(204).send();
}

export async function updateEnrollment(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const body = enrollmentSchema.partial().omit({ courseId: true }).parse(req.body);
    const enrollment = await prisma.enrollment.findFirst({ where: { id: String(req.params.id), userId: req.user.id } });
    if (!enrollment) return res.status(404).json({ error: "Enrollment not found" });
    const updated = await prisma.enrollment.update({ where: { id: enrollment.id }, data: body, include: { course: true } });
    return res.json({ enrollment: updated });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    return res.status(500).json({ error: "Enrollment update failed" });
  }
}