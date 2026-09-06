"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listDocuments = listDocuments;
exports.getDocument = getDocument;
exports.createDocument = createDocument;
exports.updateDocument = updateDocument;
exports.deleteDocument = deleteDocument;
const zod_1 = require("zod");
const prisma_1 = require("../lib/prisma");
const client_1 = require("@prisma/client");
async function listDocuments(req, res) {
    const courseId = req.query.courseId;
    const q = req.query.q;
    const documents = await prisma_1.prisma.document.findMany({
        where: {
            ...(courseId ? { courseId } : {}),
            ...(q
                ? { title: { contains: q, mode: "insensitive" } }
                : {}),
        },
        include: {
            uploadedBy: { select: { id: true, name: true, email: true } },
            course: { select: { id: true, title: true, code: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
    });
    res.json({ documents });
}
async function getDocument(req, res) {
    const doc = await prisma_1.prisma.document.findUnique({
        where: { id: String(req.params.id) },
        include: {
            uploadedBy: { select: { id: true, name: true, email: true } },
            course: true,
        },
    });
    if (!doc)
        return res.status(404).json({ error: "Document not found" });
    res.json({ document: doc });
}
const createSchema = zod_1.z.object({
    title: zod_1.z.string().min(1),
    description: zod_1.z.string().optional(),
    fileUrl: zod_1.z.string().url().optional(),
    thumbnailUrl: zod_1.z.string().url().optional().nullable(),
    courseId: zod_1.z.string().min(1).optional().nullable(),
    source: zod_1.z.string().optional(),
    fileName: zod_1.z.string().optional().nullable(),
    fileSize: zod_1.z.number().int().nonnegative().optional().nullable(),
    tags: zod_1.z.array(zod_1.z.string()).optional().nullable(),
    faculty: zod_1.z.string().optional().nullable(),
    department: zod_1.z.string().optional().nullable(),
    level: zod_1.z.string().optional().nullable(),
});
async function createDocument(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    try {
        const body = createSchema.parse(req.body);
        const doc = await prisma_1.prisma.document.create({
            data: {
                ...body,
                tags: body.tags === null ? client_1.Prisma.JsonNull : body.tags,
                uploadedById: req.user.id,
                source: body.source || (req.user.role === "courseRep" ? "courseRep" : "staff"),
            },
        });
        res.status(201).json({ document: doc });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            return res.status(400).json({ error: err.errors });
        }
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
    // owner or staff
    const isStaff = ["admin", "alphaAgent", "agent"].includes(req.user.role);
    if (existing.uploadedById !== req.user.id && !isStaff) {
        return res.status(403).json({ error: "Forbidden" });
    }
    const doc = await prisma_1.prisma.document.update({
        where: { id: String(req.params.id) },
        data: req.body,
    });
    res.json({ document: doc });
}
async function deleteDocument(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const existing = await prisma_1.prisma.document.findUnique({ where: { id: String(req.params.id) } });
    if (!existing)
        return res.status(404).json({ error: "Document not found" });
    const isStaff = ["admin", "alphaAgent", "agent"].includes(req.user.role);
    if (existing.uploadedById !== req.user.id && !isStaff) {
        return res.status(403).json({ error: "Forbidden" });
    }
    await prisma_1.prisma.document.delete({ where: { id: String(req.params.id) } });
    res.status(204).send();
}
//# sourceMappingURL=documents.controller.js.map