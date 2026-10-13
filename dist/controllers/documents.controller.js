"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listDocuments = listDocuments;
exports.listMyDocuments = listMyDocuments;
exports.getDocument = getDocument;
exports.createDocument = createDocument;
exports.updateDocument = updateDocument;
exports.approveDocument = approveDocument;
exports.deleteDocument = deleteDocument;
const zod_1 = require("zod");
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
function isStaff(role) {
    return ["admin", "alphaAgent", "agent"].includes(role || "");
}
async function listDocuments(req, res) {
    const courseId = req.query.courseId;
    const q = req.query.q;
    const status = req.query.status;
    const staff = isStaff(req.user?.role);
    const documents = await prisma_1.prisma.document.findMany({
        where: {
            ...(courseId ? { courseId } : {}),
            ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
            ...(!staff
                ? {
                    status: "approved",
                    AND: [{ OR: [{ source: null }, { source: { not: "personal" } }] }],
                }
                : status
                    ? { status }
                    : {}),
        },
        include: {
            uploadedBy: { select: { id: true, name: true, email: true } },
            course: { select: { id: true, title: true, code: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 200,
    });
    res.json({ documents });
}
async function listMyDocuments(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const documents = await prisma_1.prisma.document.findMany({
        where: { uploadedById: req.user.id, source: "personal" },
        include: { course: { select: { id: true, title: true, code: true } } },
        orderBy: { createdAt: "desc" },
        take: 200,
    });
    res.json({ documents });
}
async function getDocument(req, res) {
    const document = await prisma_1.prisma.document.findUnique({
        where: { id: String(req.params.id) },
        include: { uploadedBy: { select: { id: true, name: true, email: true } }, course: true },
    });
    if (!document)
        return res.status(404).json({ error: "Document not found" });
    if (document.source === "personal" &&
        document.uploadedById !== req.user?.id &&
        !isStaff(req.user?.role)) {
        return res.status(404).json({ error: "Document not found" });
    }
    if (!isStaff(req.user?.role) && document.status !== "approved") {
        return res.status(403).json({ error: "Material not yet approved" });
    }
    res.json({ document });
}
const createSchema = zod_1.z.object({
    title: zod_1.z.string().min(1),
    description: zod_1.z.string().optional().nullable(),
    fileUrl: zod_1.z.string().url().optional().nullable(),
    thumbnailUrl: zod_1.z.string().url().optional().nullable(),
    courseId: zod_1.z.string().min(1).optional().nullable(),
    source: zod_1.z.string().optional(),
    fileName: zod_1.z.string().optional().nullable(),
    fileSize: zod_1.z.number().int().nonnegative().optional().nullable(),
    tags: zod_1.z.array(zod_1.z.string()).optional().nullable(),
    faculty: zod_1.z.string().optional().nullable(),
    department: zod_1.z.string().optional().nullable(),
    program: zod_1.z.string().trim().min(1).optional().nullable(),
    level: zod_1.z.string().optional().nullable(),
    status: zod_1.z.enum(["pending", "approved", "rejected"]).optional(),
});
function normalizeScope(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}
function levelsMatch(first, second) {
    const normalizeLevel = (value) => normalizeScope(value).replace(/\s*level\s*/g, "");
    return Boolean(normalizeLevel(first) && normalizeLevel(first) === normalizeLevel(second));
}
async function createDocument(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    try {
        const body = createSchema.parse(req.body);
        const staff = isStaff(req.user.role);
        const isCourseRep = req.user.role === "courseRep";
        const isStudent = req.user.role === "user";
        if ((isCourseRep || isStudent) && !body.fileUrl) {
            return res.status(400).json({ error: "A file URL is required to upload a material" });
        }
        const uploader = await prisma_1.prisma.user.findUnique({
            where: { id: req.user.id },
            select: { plan: true, courseRepMeta: true, autoPublish: true },
        });
        if (!uploader)
            return res.status(401).json({ error: "User not found" });
        if (isStudent && uploader.plan === "free") {
            return res.status(403).json({ error: "A premium plan is required to upload personal materials" });
        }
        if (!staff && !isCourseRep && !isStudent) {
            return res.status(403).json({ error: "You don't have permission to upload materials" });
        }
        let assignedProgram = null;
        let level = null;
        if (isCourseRep) {
            const meta = uploader.courseRepMeta;
            assignedProgram = String(meta?.program || "").trim() || null;
            level = String(meta?.level || "").trim() || null;
            if (!assignedProgram ||
                !level ||
                (body.program && normalizeScope(body.program) !== normalizeScope(assignedProgram)) ||
                (body.level && !levelsMatch(body.level, level))) {
                return res.status(403).json({ error: "Course Reps can only upload materials for their assigned program and level" });
            }
            if (body.courseId) {
                const course = await prisma_1.prisma.course.findUnique({
                    where: { id: body.courseId },
                    select: { department: true, level: true },
                });
                if (!course ||
                    normalizeScope(course.department) !== normalizeScope(assignedProgram) ||
                    !levelsMatch(course.level, level)) {
                    return res.status(403).json({ error: "Course Reps can only attach materials to courses in their assigned program and level" });
                }
            }
        }
        const { program: requestedProgram, ...documentBody } = body;
        const status = isStudent || isCourseRep
            ? "approved"
            : body.status || (staff || uploader.autoPublish ? "approved" : "pending");
        const document = await prisma_1.prisma.document.create({
            data: {
                ...documentBody,
                ...(isStudent
                    ? { courseId: null, faculty: null, department: null, level: null, source: "personal" }
                    : isCourseRep
                        ? { department: assignedProgram, level, source: "courseRep" }
                        : requestedProgram
                            ? { department: requestedProgram }
                            : {}),
                tags: body.tags === null ? client_1.Prisma.JsonNull : body.tags,
                uploadedById: req.user.id,
                source: isStudent
                    ? "personal"
                    : isCourseRep
                        ? "courseRep"
                        : body.source || "staff",
                status,
                ...(status === "approved" && !isStudent && !isCourseRep
                    ? { approvedById: req.user.id, approvedAt: new Date() }
                    : {}),
                ...(isStudent || isCourseRep ? { approvedAt: new Date() } : {}),
            },
        });
        res.status(201).json({ document });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError)
            return res.status(400).json({ error: err.errors });
        console.error(err);
        res.status(500).json({ error: "Create failed" });
    }
}
async function updateDocument(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const existing = await prisma_1.prisma.document.findUnique({ where: { id: String(req.params.id) } });
    if (!existing)
        return res.status(404).json({ error: "Document not found" });
    if (existing.uploadedById !== req.user.id && !isStaff(req.user.role))
        return res.status(403).json({ error: "Forbidden" });
    let data = req.body;
    if (existing.source === "personal" && !isStaff(req.user.role)) {
        const parsed = zod_1.z.object({
            title: zod_1.z.string().min(1).optional(),
            description: zod_1.z.string().nullable().optional(),
            fileUrl: zod_1.z.string().url().nullable().optional(),
            thumbnailUrl: zod_1.z.string().url().nullable().optional(),
            fileName: zod_1.z.string().nullable().optional(),
            fileSize: zod_1.z.number().int().nonnegative().nullable().optional(),
            tags: zod_1.z.array(zod_1.z.string()).nullable().optional(),
        }).safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: parsed.error.errors });
        data = parsed.data;
    }
    const document = await prisma_1.prisma.document.update({ where: { id: existing.id }, data });
    res.json({ document });
}
async function approveDocument(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    if (!isStaff(req.user.role))
        return res.status(403).json({ error: "Forbidden" });
    const existing = await prisma_1.prisma.document.findUnique({ where: { id: String(req.params.id) } });
    if (!existing)
        return res.status(404).json({ error: "Document not found" });
    const status = req.body?.status === "rejected" ? "rejected" : "approved";
    const document = await prisma_1.prisma.document.update({
        where: { id: existing.id },
        data: { status, approvedById: req.user.id, approvedAt: new Date() },
    });
    res.json({ document });
}
async function deleteDocument(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const existing = await prisma_1.prisma.document.findUnique({ where: { id: String(req.params.id) } });
    if (!existing)
        return res.status(404).json({ error: "Document not found" });
    if (existing.uploadedById !== req.user.id && !isStaff(req.user.role))
        return res.status(403).json({ error: "Forbidden" });
    await prisma_1.prisma.document.delete({ where: { id: existing.id } });
    res.status(204).send();
}
//# sourceMappingURL=documents.controller.js.map