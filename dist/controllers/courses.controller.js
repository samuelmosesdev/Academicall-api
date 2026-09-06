"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listCourses = listCourses;
exports.getCourse = getCourse;
exports.createCourse = createCourse;
exports.updateCourse = updateCourse;
exports.deleteCourse = deleteCourse;
const zod_1 = require("zod");
const prisma_1 = require("../lib/prisma");
async function listCourses(req, res) {
    const q = req.query.q;
    const courses = await prisma_1.prisma.course.findMany({
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
        take: 5000,
    });
    res.json({ courses });
}
async function getCourse(req, res) {
    const course = await prisma_1.prisma.course.findUnique({
        where: { id: String(req.params.id) },
        include: { documents: { take: 20 } },
    });
    if (!course)
        return res.status(404).json({ error: "Course not found" });
    res.json({ course });
}
const createSchema = zod_1.z.object({
    title: zod_1.z.string().min(1),
    code: zod_1.z.string().optional().nullable(),
    faculty: zod_1.z.string().optional().nullable(),
    department: zod_1.z.string().optional().nullable(),
    level: zod_1.z.string().optional().nullable(),
    semester: zod_1.z.string().optional().nullable(),
    description: zod_1.z.string().optional().nullable(),
    thumbnailUrl: zod_1.z.string().url().optional().nullable(),
    category: zod_1.z.string().optional().nullable(),
    source: zod_1.z.string().optional().nullable(),
    published: zod_1.z.boolean().optional(),
    approvedBy: zod_1.z.string().optional().nullable(),
    requestedBy: zod_1.z.string().optional().nullable(),
});
async function createCourse(req, res) {
    try {
        const body = createSchema.parse(req.body);
        const course = await prisma_1.prisma.course.create({ data: body });
        res.status(201).json({ course });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            return res.status(400).json({ error: err.errors });
        }
        console.error(err);
        res.status(500).json({ error: "Create failed" });
    }
}
async function updateCourse(req, res) {
    try {
        const body = createSchema.partial().parse(req.body);
        const course = await prisma_1.prisma.course.update({
            where: { id: String(req.params.id) },
            data: body,
        });
        res.json({ course });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Update failed" });
    }
}
async function deleteCourse(req, res) {
    await prisma_1.prisma.course.delete({ where: { id: String(req.params.id) } });
    res.status(204).send();
}
//# sourceMappingURL=courses.controller.js.map