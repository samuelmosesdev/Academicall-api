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
    const isStaff = ["admin", "alphaAgent", "agent"].includes(req.user?.role || "");
    const courses = await prisma_1.prisma.course.findMany({
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
        if (!req.user || !["admin", "alphaAgent", "agent", "courseRep"].includes(req.user.role)) {
            return res.status(403).json({ error: "Only staff and Course Reps can add courses" });
        }
        const body = createSchema.parse(req.body);
        let data = body;
        if (req.user?.role === "courseRep") {
            const rep = await prisma_1.prisma.user.findUnique({
                where: { id: req.user.id },
                select: { courseRepMeta: true },
            });
            const meta = rep?.courseRepMeta;
            const program = String(meta?.program || "").trim();
            const assignedLevel = String(meta?.level || "").trim();
            const normalize = (value) => value.toLowerCase().replace(/\s+/g, " ").trim();
            const normalizeLevel = (value) => normalize(value).replace(/\s*level\s*/g, "");
            if (!program || !assignedLevel) {
                return res.status(403).json({ error: "A Course Rep must have an assigned program and level to add courses" });
            }
            if (!body.level || normalizeLevel(body.level) !== normalizeLevel(assignedLevel)) {
                return res.status(403).json({ error: "Course Reps can only add courses for their assigned level" });
            }
            if (body.code) {
                const duplicate = await prisma_1.prisma.course.findFirst({
                    where: {
                        code: { equals: body.code, mode: "insensitive" },
                        department: { equals: program, mode: "insensitive" },
                        level: { equals: assignedLevel, mode: "insensitive" },
                    },
                    select: { id: true },
                });
                if (duplicate)
                    return res.status(409).json({ error: "That course already exists in your program and level" });
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
        const course = await prisma_1.prisma.course.create({ data });
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