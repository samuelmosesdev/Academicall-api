"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listActivity = listActivity;
exports.createActivity = createActivity;
const zod_1 = require("zod");
const prisma_1 = require("../lib/prisma");
const activitySchema = zod_1.z.object({
    action: zod_1.z.string().min(1),
    status: zod_1.z.string().optional(),
    reference: zod_1.z.string().nullable().optional(),
    meta: zod_1.z.any().optional(),
});
async function listActivity(req, res) {
    const activity = await prisma_1.prisma.activityLog.findMany({
        where: req.query.agentId ? { meta: { path: ["targetUid"], equals: String(req.query.agentId) } } : undefined,
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "desc" }, take: 200,
    });
    res.json({ activity });
}
async function createActivity(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    try {
        const body = activitySchema.parse(req.body);
        const activity = await prisma_1.prisma.activityLog.create({
            data: { ...body, userId: req.user.id, userName: req.user.email },
        });
        res.status(201).json({ activity });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError)
            return res.status(400).json({ error: err.errors });
        res.status(500).json({ error: "Activity log failed" });
    }
}
//# sourceMappingURL=activity.controller.js.map