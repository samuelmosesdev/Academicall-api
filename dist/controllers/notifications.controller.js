"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.removeFcmToken = exports.registerFcmToken = void 0;
exports.listMyNotifications = listMyNotifications;
exports.listAdminNotifications = listAdminNotifications;
exports.markRead = markRead;
exports.markAllAdminRead = markAllAdminRead;
exports.archiveNotification = archiveNotification;
exports.createNotification = createNotification;
exports.registerDeviceToken = registerDeviceToken;
exports.removeDeviceToken = removeDeviceToken;
const zod_1 = require("zod");
const prisma_1 = require("../lib/prisma");
const staffRoles = ["admin", "alphaAgent", "agent"];
async function listMyNotifications(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const archived = req.query.archived === "true";
    const notifications = await prisma_1.prisma.notification.findMany({
        where: { userId: req.user.id, deleted: false, archived },
        orderBy: { createdAt: "desc" },
        take: 50,
    });
    res.json({ notifications });
}
async function listAdminNotifications(_req, res) {
    const notifications = await prisma_1.prisma.notification.findMany({
        where: { deleted: false },
        orderBy: { createdAt: "desc" },
        take: 100,
    });
    res.json({ notifications });
}
async function markRead(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const notif = await prisma_1.prisma.notification.findUnique({ where: { id: String(req.params.id) } });
    if (!notif)
        return res.status(404).json({ error: "Not found" });
    const isStaff = staffRoles.includes(req.user.role);
    const isOwner = notif.userId === req.user.id;
    if (!isOwner && !isStaff)
        return res.status(403).json({ error: "Forbidden" });
    const updated = await prisma_1.prisma.notification.update({
        where: { id: notif.id },
        data: {
            ...(isOwner ? { readByUser: true } : {}),
            ...(isStaff ? { readByAdmin: true } : {}),
            readAt: new Date(),
        },
    });
    res.json({ notification: updated });
}
async function markAllAdminRead(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    if (!staffRoles.includes(req.user.role))
        return res.status(403).json({ error: "Forbidden" });
    const result = await prisma_1.prisma.notification.updateMany({
        where: { deleted: false, readByAdmin: false },
        data: { readByAdmin: true, readAt: new Date() },
    });
    res.json({ updated: result.count });
}
async function archiveNotification(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const notif = await prisma_1.prisma.notification.findFirst({
        where: { id: String(req.params.id), userId: req.user.id },
    });
    if (!notif)
        return res.status(404).json({ error: "Not found" });
    const archived = req.body?.archived !== false;
    const updated = await prisma_1.prisma.notification.update({
        where: { id: notif.id },
        data: {
            archived,
            archivedAt: archived ? new Date() : null,
            ...(req.body?.deleted !== undefined
                ? { deleted: Boolean(req.body.deleted), deletedAt: req.body.deleted ? new Date() : null }
                : {}),
        },
    });
    res.json({ notification: updated });
}
const createSchema = zod_1.z.object({
    userId: zod_1.z.string().optional().nullable(),
    title: zod_1.z.string().min(1),
    body: zod_1.z.string().optional(),
    type: zod_1.z.string().optional(),
    data: zod_1.z.any().optional(),
    readByUser: zod_1.z.boolean().optional(),
    readByAdmin: zod_1.z.boolean().optional(),
});
async function createNotification(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    try {
        const body = createSchema.parse(req.body);
        const isStaff = staffRoles.includes(req.user.role);
        const userId = body.userId || (isStaff
            ? req.user.id
            : (await prisma_1.prisma.user.findFirst({ where: { role: "admin", status: "active" }, select: { id: true } }))?.id || req.user.id);
        if (userId !== req.user.id && !isStaff)
            return res.status(403).json({ error: "Cannot notify another user" });
        const allowedTypes = ["general", "payment_claim", "class_event", "announcement", "system", "new_student", "lecture_update", "announcement_published"];
        const notification = await prisma_1.prisma.notification.create({
            data: {
                userId,
                title: body.title,
                body: body.body,
                data: body.data ?? undefined,
                readByUser: body.readByUser ?? false,
                readByAdmin: body.readByAdmin ?? false,
                type: (allowedTypes.includes(body.type) ? body.type : "general"),
                createdById: req.user.id,
            },
        });
        res.status(201).json({ notification });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError)
            return res.status(400).json({ error: err.errors });
        console.error(err);
        res.status(500).json({ error: "Create failed" });
    }
}
const tokenSchema = zod_1.z.object({ token: zod_1.z.string().min(1), uid: zod_1.z.string().optional(), platform: zod_1.z.string().optional() });
async function registerDeviceToken(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const body = tokenSchema.parse(req.body);
    await prisma_1.prisma.user.update({ where: { id: req.user.id }, data: { deviceToken: body.token, fcmToken: body.token } });
    res.json({ ok: true });
}
async function removeDeviceToken(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    await prisma_1.prisma.user.update({ where: { id: req.user.id }, data: { deviceToken: null, fcmToken: null } });
    res.json({ ok: true });
}
exports.registerFcmToken = registerDeviceToken;
exports.removeFcmToken = removeDeviceToken;
//# sourceMappingURL=notifications.controller.js.map