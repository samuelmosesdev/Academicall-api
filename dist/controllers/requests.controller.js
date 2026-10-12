"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listRequests = listRequests;
exports.createRequest = createRequest;
exports.updateRequest = updateRequest;
exports.listProfileChangeRequests = listProfileChangeRequests;
exports.createProfileChangeRequest = createProfileChangeRequest;
exports.updateProfileChangeRequest = updateProfileChangeRequest;
exports.deleteProfileChangeRequest = deleteProfileChangeRequest;
const zod_1 = require("zod");
const prisma_1 = require("../lib/prisma");
const requestSchema = zod_1.z.object({
    type: zod_1.z.string().optional(), title: zod_1.z.string().optional(), body: zod_1.z.string().optional(),
    status: zod_1.z.enum(["pending", "approved", "rejected"]).optional(), meta: zod_1.z.any().optional(),
    requesterName: zod_1.z.string().optional(), requesterEmail: zod_1.z.string().optional(), requesterRole: zod_1.z.string().optional(),
    field: zod_1.z.string().optional(), fieldLabel: zod_1.z.string().optional(), requestedValue: zod_1.z.string().optional(), reason: zod_1.z.string().optional(),
    reviewedAt: zod_1.z.coerce.date().nullable().optional(), reviewedBy: zod_1.z.string().nullable().optional(), reviewedByName: zod_1.z.string().nullable().optional(), reviewNote: zod_1.z.string().nullable().optional(),
});
async function listRequests(req, res) {
    const requests = await prisma_1.prisma.request.findMany({
        where: req.user?.role === "user" ? { requesterUid: req.user.id } : undefined,
        orderBy: { createdAt: "desc" }, take: 200,
    });
    res.json({ requests });
}
async function createRequest(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    try {
        const body = requestSchema.parse(req.body);
        const request = await prisma_1.prisma.request.create({ data: { ...body, requesterUid: req.user.id } });
        res.status(201).json({ request });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError)
            return res.status(400).json({ error: err.errors });
        res.status(500).json({ error: "Create failed" });
    }
}
async function updateRequest(req, res) {
    try {
        const body = requestSchema.partial().parse(req.body);
        const request = await prisma_1.prisma.request.update({ where: { id: String(req.params.id) }, data: body });
        res.json({ request });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError)
            return res.status(400).json({ error: err.errors });
        res.status(500).json({ error: "Update failed" });
    }
}
const profileChangeSchema = zod_1.z.object({
    userId: zod_1.z.string().optional(), userName: zod_1.z.string().optional(), userEmail: zod_1.z.string().optional(), uniqueId: zod_1.z.string().nullable().optional(),
    body: zod_1.z.string().optional(),
    field: zod_1.z.string().optional(), fieldLabel: zod_1.z.string().optional(), currentValue: zod_1.z.string().nullable().optional(), requestedValue: zod_1.z.string().optional(), reason: zod_1.z.string().optional(),
    status: zod_1.z.enum(["pending", "approved", "rejected"]).optional(), reviewedAt: zod_1.z.coerce.date().nullable().optional(), reviewedBy: zod_1.z.string().nullable().optional(), reviewedByName: zod_1.z.string().nullable().optional(), adminNote: zod_1.z.string().nullable().optional(), meta: zod_1.z.any().optional(),
});
function profileChangeView(item) { return { ...item, userId: item.userId, userName: item.userName, userEmail: item.userEmail }; }
async function listProfileChangeRequests(req, res) {
    const requests = await prisma_1.prisma.profileChangeRequest.findMany({ where: req.user?.role === "user" ? { userId: req.user.id } : undefined, orderBy: { createdAt: "desc" }, take: 200 });
    res.json({ requests: requests.map(profileChangeView) });
}
async function createProfileChangeRequest(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    try {
        const body = profileChangeSchema.parse(req.body);
        const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
        const field = body.field || meta.field;
        const requestedValue = body.requestedValue || meta.requestedValue;
        if (!field || !requestedValue)
            return res.status(400).json({ error: "field and requestedValue are required" });
        const request = await prisma_1.prisma.profileChangeRequest.create({ data: {
                userId: req.user.id, userName: body.userName || meta.userName, userEmail: body.userEmail || meta.userEmail, uniqueId: body.uniqueId ?? meta.uniqueId,
                field, fieldLabel: body.fieldLabel || meta.fieldLabel, currentValue: body.currentValue ?? meta.currentValue, requestedValue,
                reason: body.reason || meta.reason || body.body, status: "pending",
            } });
        res.status(201).json({ request: profileChangeView(request) });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError)
            return res.status(400).json({ error: err.errors });
        res.status(500).json({ error: "Create failed" });
    }
}
async function updateProfileChangeRequest(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    try {
        const body = profileChangeSchema.partial().parse(req.body);
        const current = await prisma_1.prisma.profileChangeRequest.findUnique({ where: { id: String(req.params.id) } });
        if (!current)
            return res.status(404).json({ error: "Profile change request not found" });
        if (!["admin", "alphaAgent", "agent"].includes(req.user.role) && current.userId !== req.user.id)
            return res.status(403).json({ error: "Forbidden" });
        if (body.status === "approved") {
            const fieldRaw = String(current.field || "").trim();
            const fieldKey = fieldRaw.toLowerCase().replace(/\s+/g, "");
            const fieldAliases = {
                name: "name",
                fullname: "name",
                phone: "phone",
                phonenumber: "phone",
                faculty: "faculty",
                program: "program",
                programme: "program",
                department: "department",
                dept: "department",
                level: "level",
                matricnumber: "matricNumber",
                matric: "matricNumber",
            };
            const normalizedField = fieldAliases[fieldKey];
            const allowedFields = ["name", "phone", "faculty", "program", "department", "level", "matricNumber"];
            if (!normalizedField || !allowedFields.includes(normalizedField)) {
                return res.status(400).json({
                    error: "Field cannot be approved",
                    detail: `Unsupported field "${fieldRaw}". Allowed: ${allowedFields.join(", ")}`,
                });
            }
            const user = await prisma_1.prisma.user.findUnique({
                where: { id: current.userId },
                select: { faculty: true, department: true, program: true, profileComplete: true },
            });
            if (!user)
                return res.status(404).json({ error: "Request owner not found" });
            const updateData = {
                [normalizedField]: current.requestedValue,
            };
            if (normalizedField === "program") {
                const setting = await prisma_1.prisma.setting.findUnique({ where: { key: "academicCatalog" } });
                const catalog = setting?.value;
                const faculties = catalog?.faculties || [];
                const matches = faculties.flatMap((faculty) => (faculty.departments || [])
                    .filter((department) => (department.programs || []).some((program) => String(program).trim().toLowerCase() ===
                    String(current.requestedValue).trim().toLowerCase()))
                    .map((department) => ({ faculty: faculty.name || "", department: department.name || "" })));
                if (!matches.length) {
                    return res.status(400).json({ error: "The requested program is not in the academic catalog." });
                }
                const match = matches.find((item) => item.faculty === user.faculty && item.department === user.department) ||
                    matches.find((item) => item.faculty === user.faculty) ||
                    matches[0];
                updateData.faculty = match.faculty;
                updateData.department = match.department;
            }
            if (normalizedField === "faculty") {
                if (user.faculty !== current.requestedValue) {
                    updateData.department = "";
                    updateData.program = "";
                    updateData.profileComplete = false;
                }
            }
            if (normalizedField === "department") {
                const setting = await prisma_1.prisma.setting.findUnique({ where: { key: "academicCatalog" } });
                const catalog = setting?.value;
                const faculty = catalog?.faculties?.find((item) => item.name === user.faculty);
                const department = faculty?.departments?.find((item) => item.name === current.requestedValue);
                if (!department) {
                    return res.status(400).json({ error: "The requested department is not in the user's faculty catalog." });
                }
                if (!(department.programs || []).includes(user.program || "")) {
                    updateData.program = "";
                    updateData.profileComplete = false;
                }
            }
            await prisma_1.prisma.user.update({ where: { id: current.userId }, data: updateData });
        }
        const request = await prisma_1.prisma.profileChangeRequest.update({
            where: { id: current.id },
            data: {
                status: body.status,
                reviewedAt: body.reviewedAt || (body.status ? new Date() : undefined),
                reviewedBy: body.reviewedBy,
                reviewedByName: body.reviewedByName,
                adminNote: body.adminNote,
            },
        });
        res.json({ request: profileChangeView(request) });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError)
            return res.status(400).json({ error: err.errors });
        res.status(500).json({ error: "Update failed" });
    }
}
async function deleteProfileChangeRequest(req, res) {
    if (!req.user || !["admin", "alphaAgent", "agent"].includes(req.user.role))
        return res.status(403).json({ error: "Forbidden" });
    await prisma_1.prisma.profileChangeRequest.delete({ where: { id: String(req.params.id) } });
    res.status(204).send();
}
//# sourceMappingURL=requests.controller.js.map