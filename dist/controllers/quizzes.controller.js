"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listMine = listMine;
exports.listByMaterial = listByMaterial;
exports.createQuiz = createQuiz;
exports.getQuiz = getQuiz;
exports.updateQuiz = updateQuiz;
const zod_1 = require("zod");
const prisma_1 = require("../lib/prisma");
const createSchema = zod_1.z.object({
    materialId: zod_1.z.string().optional().nullable(),
    materialTitle: zod_1.z.string().optional().nullable(),
    courseCode: zod_1.z.string().optional().nullable(),
    courseTitle: zod_1.z.string().optional().nullable(),
    difficulty: zod_1.z.string().optional().nullable(),
    questionCount: zod_1.z.number().int().min(0).optional(),
    questionIds: zod_1.z.array(zod_1.z.string()).default([]),
    sectionNote: zod_1.z.string().optional().nullable(),
    status: zod_1.z.string().optional(),
});
const updateSchema = zod_1.z.object({
    status: zod_1.z.string().optional(),
    score: zod_1.z.number().int().min(0).max(100).optional().nullable(),
    answers: zod_1.z.any().optional(),
    completedAt: zod_1.z.string().datetime().optional().nullable(),
});
async function listMine(req, res) {
    try {
        const userId = req.user.id;
        const quizzes = await prisma_1.prisma.generatedQuiz.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
        });
        return res.json({ quizzes });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message || "Failed to list quizzes" });
    }
}
async function listByMaterial(req, res) {
    try {
        const materialId = String(req.query.materialId || "");
        if (!materialId) {
            return res.status(400).json({ error: "materialId is required" });
        }
        const quizzes = await prisma_1.prisma.generatedQuiz.findMany({
            where: { materialId },
            orderBy: { createdAt: "desc" },
            take: 100,
        });
        return res.json({ quizzes });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message || "Failed to list quizzes" });
    }
}
async function createQuiz(req, res) {
    try {
        const body = createSchema.parse(req.body);
        const userId = req.user.id;
        const quiz = await prisma_1.prisma.generatedQuiz.create({
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
    }
    catch (err) {
        if (err?.name === "ZodError") {
            return res.status(400).json({ error: err.errors });
        }
        console.error(err);
        return res.status(500).json({ error: err.message || "Failed to create quiz" });
    }
}
async function getQuiz(req, res) {
    try {
        const id = String(req.params.id || "");
        if (!id)
            return res.status(400).json({ error: "Quiz id is required" });
        const quiz = await prisma_1.prisma.generatedQuiz.findUnique({ where: { id } });
        if (!quiz)
            return res.status(404).json({ error: "Quiz not found" });
        const isOwner = quiz.userId === req.user.id;
        const isStaff = ["admin", "alphaAgent", "agent"].includes(req.user.role);
        if (!isOwner && !isStaff) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const ids = Array.isArray(quiz.questionIds) ? quiz.questionIds : [];
        const questions = ids.length > 0 ? await prisma_1.prisma.cbtQuestion.findMany({ where: { id: { in: ids } } }) : [];
        const byId = new Map(questions.map((q) => [q.id, q]));
        const ordered = ids.map((qid) => byId.get(qid)).filter(Boolean);
        return res.json({ quiz, questions: ordered });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message || "Failed to get quiz" });
    }
}
async function updateQuiz(req, res) {
    try {
        const id = String(req.params.id || "");
        if (!id)
            return res.status(400).json({ error: "Quiz id is required" });
        const body = updateSchema.parse(req.body);
        const existing = await prisma_1.prisma.generatedQuiz.findUnique({ where: { id } });
        if (!existing)
            return res.status(404).json({ error: "Quiz not found" });
        if (existing.userId !== req.user.id) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const quiz = await prisma_1.prisma.generatedQuiz.update({
            where: { id },
            data: {
                ...(body.status != null ? { status: body.status } : {}),
                ...(body.score !== undefined ? { score: body.score } : {}),
                ...(body.answers !== undefined ? { answers: body.answers } : {}),
                ...(body.completedAt !== undefined ? { completedAt: body.completedAt ? new Date(body.completedAt) : null } : {}),
            },
        });
        return res.json({ quiz });
    }
    catch (err) {
        if (err?.name === "ZodError") {
            return res.status(400).json({ error: err.errors });
        }
        console.error(err);
        return res.status(500).json({ error: err.message || "Failed to update quiz" });
    }
}
//# sourceMappingURL=quizzes.controller.js.map