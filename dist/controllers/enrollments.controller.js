"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listEnrollments = listEnrollments;
exports.createEnrollment = createEnrollment;
exports.deleteEnrollment = deleteEnrollment;
exports.updateEnrollment = updateEnrollment;
const zod_1 = require("zod");
const prisma_1 = require("../lib/prisma");
const enrollmentSchema = zod_1.z.object({
    courseId: zod_1.z.string().min(1),
    progressPct: zod_1.z.number().int().min(0).max(100).optional(),
    topicLabel: zod_1.z.string().optional(),
});
async function listEnrollments(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const enrollments = await prisma_1.prisma.enrollment.findMany({
        where: { userId: req.user.id },
        include: { course: true },
        orderBy: { updatedAt: "desc" },
    });
    res.json({ enrollments });
}
async function createEnrollment(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    try {
        const body = enrollmentSchema.parse(req.body);
        const enrollment = await prisma_1.prisma.enrollment.upsert({
            where: { userId_courseId: { userId: req.user.id, courseId: body.courseId } },
            create: { ...body, userId: req.user.id },
            update: { ...body },
            include: { course: true },
        });
        res.status(201).json({ enrollment });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError)
            return res.status(400).json({ error: err.errors });
        res.status(500).json({ error: "Enrollment failed" });
    }
}
async function deleteEnrollment(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const enrollment = await prisma_1.prisma.enrollment.findFirst({ where: { id: String(req.params.id), userId: req.user.id } });
    if (!enrollment)
        return res.status(404).json({ error: "Enrollment not found" });
    await prisma_1.prisma.enrollment.delete({ where: { id: enrollment.id } });
    res.status(204).send();
}
async function updateEnrollment(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    try {
        const body = enrollmentSchema.partial().omit({ courseId: true }).parse(req.body);
        const enrollment = await prisma_1.prisma.enrollment.findFirst({ where: { id: String(req.params.id), userId: req.user.id } });
        if (!enrollment)
            return res.status(404).json({ error: "Enrollment not found" });
        const updated = await prisma_1.prisma.enrollment.update({ where: { id: enrollment.id }, data: body, include: { course: true } });
        return res.json({ enrollment: updated });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError)
            return res.status(400).json({ error: err.errors });
        return res.status(500).json({ error: "Enrollment update failed" });
    }
}
//# sourceMappingURL=enrollments.controller.js.map