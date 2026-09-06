"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listAnnouncements = listAnnouncements;
exports.createAnnouncement = createAnnouncement;
exports.updateAnnouncement = updateAnnouncement;
exports.deleteAnnouncement = deleteAnnouncement;
exports.listAnnouncementReads = listAnnouncementReads;
exports.markAnnouncementRead = markAnnouncementRead;
const zod_1 = require("zod");
const prisma_1 = require("../lib/prisma");
const announcementSchema = zod_1.z.object({
    title: zod_1.z.string().min(1),
    body: zod_1.z.string().optional(),
    published: zod_1.z.boolean().optional(),
    audience: zod_1.z.string().optional(),
    faculty: zod_1.z.string().nullable().optional(),
    department: zod_1.z.string().nullable().optional(),
    level: zod_1.z.string().nullable().optional(),
    courseCode: zod_1.z.string().nullable().optional(),
    pinned: zod_1.z.boolean().optional(),
});
async function listAnnouncements(req, res) {
    const announcements = await prisma_1.prisma.announcement.findMany({
        where: ["admin", "alphaAgent", "agent"].includes(req.user?.role || "") ? undefined : { published: true }, orderBy: { createdAt: "desc" }, take: 100,
    });
    res.json({ announcements });
}
async function createAnnouncement(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    try {
        const body = announcementSchema.parse(req.body);
        const announcement = await prisma_1.prisma.announcement.create({ data: { ...body, createdBy: req.user.id } });
        res.status(201).json({ announcement });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError)
            return res.status(400).json({ error: err.errors });
        res.status(500).json({ error: "Create failed" });
    }
}
async function updateAnnouncement(req, res) {
    try {
        const body = announcementSchema.partial().parse(req.body);
        const announcement = await prisma_1.prisma.announcement.update({ where: { id: String(req.params.id) }, data: body });
        res.json({ announcement });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError)
            return res.status(400).json({ error: err.errors });
        res.status(500).json({ error: "Update failed" });
    }
}
async function deleteAnnouncement(req, res) {
    await prisma_1.prisma.announcement.delete({ where: { id: String(req.params.id) } });
    res.status(204).send();
}
async function listAnnouncementReads(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const reads = await prisma_1.prisma.announcementRead.findMany({ where: { userId: req.user.id }, take: 200 });
    res.json({ reads });
}
async function markAnnouncementRead(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const id = `${req.user.id}_${String(req.params.id)}`;
    const read = await prisma_1.prisma.announcementRead.upsert({ where: { id }, create: { id, userId: req.user.id, announcementId: String(req.params.id), readAt: new Date() }, update: { readAt: new Date() } });
    res.json({ read });
}
//# sourceMappingURL=announcements.controller.js.map