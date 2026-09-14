import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";

const createSchema = z.object({
  materialId: z.string().optional().nullable(),
  materialTitle: z.string().optional().nullable(),
  courseCode: z.string().optional().nullable(),
  courseTitle: z.string().optional().nullable(),
  difficulty: z.string().optional().nullable(),
  questionCount: z.number().int().min(0).optional(),
  questionIds: z.array(z.string()).default([]),
  sectionNote: z.string().optional().nullable(),
  status: z.string().optional(),
});

const updateSchema = z.object({
  status: z.string().optional(),
  score: z.number().int().min(0).max(100).optional().nullable(),
  answers: z.any().optional(),
  completedAt: z.string().datetime().optional().nullable(),
});

export async function listMine(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const quizzes = await prisma.generatedQuiz.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    return res.json({ quizzes });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Failed to list quizzes" });
  }
}

export async function listByMaterial(req: Request, res: Response) {
  try {
    const materialId = String(req.query.materialId || "");
    if (!materialId) {
      return res.status(400).json({ error: "materialId is required" });
    }

    const quizzes = await prisma.generatedQuiz.findMany({
      where: { materialId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    return res.json({ quizzes });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Failed to list quizzes" });
  }
}

export async function createQuiz(req: Request, res: Response) {
  try {
    const body = createSchema.parse(req.body);
    const userId = req.user!.id;

    const quiz = await prisma.generatedQuiz.create({
      data: {
        userId,
        materialId: body.materialId || null,
        materialTitle: body.materialTitle || null,
        courseCode: body.courseCode || null,
        courseTitle: body.courseTitle || null,
        difficulty: body.difficulty || null,
        questionCount: body.questionCount ?? body.questionIds.length,
        questionIds: body.questionIds,
        sectionNote: body.sectionNote || null,
        status: body.status || "ready",
      },
    });

    return res.status(201).json({ quiz, id: quiz.id });
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return res.status(400).json({ error: err.errors });
    }

    console.error(err);
    return res.status(500).json({ error: err.message || "Failed to create quiz" });
  }
}

export async function getQuiz(req: Request, res: Response) {
  try {
    const id = String(req.params.id || "");
    if (!id) return res.status(400).json({ error: "Quiz id is required" });

    const quiz = await prisma.generatedQuiz.findUnique({ where: { id } });
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });

    const isOwner = quiz.userId === req.user!.id;
    const isStaff = ["admin", "alphaAgent", "agent"].includes(req.user!.role);

    if (!isOwner && !isStaff) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const ids = Array.isArray(quiz.questionIds) ? (quiz.questionIds as string[]) : [];
    const questions = ids.length > 0 ? await prisma.cbtQuestion.findMany({ where: { id: { in: ids } } }) : [];
    const byId = new Map(questions.map((q) => [q.id, q]));
    const ordered = ids.map((qid) => byId.get(qid)).filter(Boolean);

    return res.json({ quiz, questions: ordered });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Failed to get quiz" });
  }
}

export async function updateQuiz(req: Request, res: Response) {
  try {
    const id = String(req.params.id || "");
    if (!id) return res.status(400).json({ error: "Quiz id is required" });
    const body = updateSchema.parse(req.body);

    const existing = await prisma.generatedQuiz.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Quiz not found" });
    if (existing.userId !== req.user!.id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const quiz = await prisma.generatedQuiz.update({
      where: { id },
      data: {
        ...(body.status != null ? { status: body.status } : {}),
        ...(body.score !== undefined ? { score: body.score } : {}),
        ...(body.answers !== undefined ? { answers: body.answers } : {}),
        ...(body.completedAt !== undefined ? { completedAt: body.completedAt ? new Date(body.completedAt) : null } : {}),
      },
    });

    return res.json({ quiz });
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return res.status(400).json({ error: err.errors });
    }

    console.error(err);
    return res.status(500).json({ error: err.message || "Failed to update quiz" });
  }
}
