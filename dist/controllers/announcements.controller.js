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
    program: zod_1.z.string().nullable().optional(),
    level: zod_1.z.string().nullable().optional(),
    courseCode: zod_1.z.string().nullable().optional(),
    pinned: zod_1.z.boolean().optional(),
});
function normalizeScope(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}
function levelsMatch(first, second) {
    const a = normalizeScope(first).replace(/\s*level\s*/g, "");
    const b = normalizeScope(second).replace(/\s*level\s*/g, "");
    return Boolean(a && b && a === b);
}
async function listAnnouncements(req, res) {
    const isStaff = ["admin", "alphaAgent", "agent"].includes(req.user?.role || "");
    const user = req.user && !isStaff ? await prisma_1.prisma.user.findUnique({
        where: { id: req.user.id },
        select: { role: true, faculty: true, department: true, program: true, level: true, courseRepMeta: true },
    }) : null;
    const meta = user?.courseRepMeta;
    const scope = user?.role === "courseRep" ? meta?.program : user?.program;
    const level = user?.role === "courseRep" ? meta?.level : user?.level;
    const candidates = await prisma_1.prisma.announcement.findMany({
        where: isStaff ? undefined : { published: true },
        orderBy: { createdAt: "desc" },
        take: 200,
    });
    const announcements = isStaff ? candidates : candidates.filter((item) => {
        const audience = item.audience || "all";
        if (audience === "all")
            return true;
        if (audience === "faculty")
            return normalizeScope(item.faculty) === normalizeScope(user?.faculty);
        if (audience === "department") {
            const sameScope = Boolean(scope && normalizeScope(scope) === normalizeScope(item.department));
            return sameScope && (!item.level || (level && levelsMatch(item.level, level)));
        }
        return false;
    });
    res.json({ announcements });
}
async function createAnnouncement(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    if (!["admin", "alphaAgent", "agent", "courseRep"].includes(req.user.role)) {
        return res.status(403).json({ error: "Only Course Reps and staff can create announcements" });
    }
    try {
        const { program, ...parsed } = announcementSchema.parse(req.body);
        if (parsed.audience === "department" && !String(program || "").trim()) {
            return res.status(400).json({ error: "Program is required for program-scoped announcements" });
        }
        const body = { ...parsed, department: String(program || "").trim() || null };
        if (req.user.role === "courseRep") {
            if (body.audience !== "department" || !body.department || !body.level) {
                return res.status(403).json({ error: "Course Reps can only post to their assigned program and level" });
            }
            const rep = await prisma_1.prisma.user.findUnique({
                where: { id: req.user.id },
                select: { department: true, program: true, level: true, courseRepMeta: true },
            });
            const meta = rep?.courseRepMeta;
            const assignedScope = meta?.program || "";
            const assignedLevel = meta?.level || "";
            if (normalizeScope(assignedScope) !== normalizeScope(body.department) || !levelsMatch(assignedLevel, body.level)) {
                return res.status(403).json({ error: "You can only post to your assigned program and level" });
            }
        }
        const author = await prisma_1.prisma.user.findUnique({
            where: { id: req.user.id },
            select: { name: true, nickname: true },
        });
        const announcement = await prisma_1.prisma.$transaction(async (tx) => {
            const created = await tx.announcement.create({ data: { ...body, createdBy: req.user.id } });
            if (body.audience === "department" && body.department) {
                await tx.feedPost.create({
                    data: {
                        kind: "course",
                        title: body.title,
                        body: body.body || null,
                        courseCode: body.courseCode || null,
                        faculty: body.faculty || null,
                        department: body.department,
                        level: body.level || null,
                        pinned: body.pinned || false,
                        authorId: req.user.id,
                        authorName: author?.name || author?.nickname || "Course Rep",
                        authorRole: req.user.role,
                        comments: [],
                        reactions: [],
                    },
                });
            }
            return created;
        });
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
        const { program, ...parsed } = announcementSchema.partial().parse(req.body);
        if (parsed.department !== undefined && program === undefined) {
            return res.status(400).json({ error: "Use the program field to update a program-scoped announcement" });
        }
        const body = program === undefined ? parsed : { ...parsed, department: program };
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