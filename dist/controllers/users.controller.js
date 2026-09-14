"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listUsers = listUsers;
exports.courseRepStatus = courseRepStatus;
exports.getUser = getUser;
exports.updateMe = updateMe;
exports.adminUpdateUser = adminUpdateUser;
exports.adminResetPassword = adminResetPassword;
exports.createAgent = createAgent;
exports.deleteUser = deleteUser;
const zod_1 = require("zod");
const prisma_1 = require("../lib/prisma");
const client_1 = require("@prisma/client");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const node_crypto_1 = __importDefault(require("node:crypto"));
async function listUsers(req, res) {
    const role = req.query.role;
    const search = req.query.q;
    const users = await prisma_1.prisma.user.findMany({
        where: {
            status: { not: "deleted" },
            ...(role ? { role: role } : {}),
            ...(search
                ? {
                    OR: [
                        { email: { contains: search, mode: "insensitive" } },
                        { name: { contains: search, mode: "insensitive" } },
                        { uniqueId: { contains: search, mode: "insensitive" } },
                    ],
                }
                : {}),
        },
        select: {
            id: true,
            email: true,
            name: true,
            role: true,
            plan: true,
            uniqueId: true,
            department: true,
            faculty: true,
            level: true,
            status: true,
            photoUrl: true,
            courseRepMeta: true,
            mustChangePassword: true,
            createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 100,
    });
    res.json({ users });
}
function normalizeLevel(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/\s*level\s*/g, "")
        .replace(/\s+/g, "");
}
/** Any authenticated user can check whether a department-level Course Rep exists. */
async function courseRepStatus(req, res) {
    try {
        const department = String(req.query.department || "").trim();
        const level = String(req.query.level || "").trim();
        if (!department || !level) {
            return res.status(400).json({
                error: "department and level are required",
                hasCourseRep: false,
            });
        }
        const reps = await prisma_1.prisma.user.findMany({
            where: { role: "courseRep", status: "active" },
            select: {
                id: true,
                name: true,
                department: true,
                level: true,
                courseRepMeta: true,
            },
            take: 200,
        });
        const found = reps.find((candidate) => {
            const meta = candidate.courseRepMeta || {};
            const candidateDepartment = String(meta.department || candidate.department || "").trim();
            const candidateLevel = String(meta.level || candidate.level || "").trim();
            return (candidateDepartment.toLowerCase() === department.toLowerCase() &&
                normalizeLevel(candidateLevel) === normalizeLevel(level));
        });
        return res.json({
            hasCourseRep: Boolean(found),
            rep: found
                ? {
                    id: found.id,
                    name: found.name,
                    department: found.courseRepMeta?.department ||
                        found.department,
                    level: found.courseRepMeta?.level ||
                        found.level,
                }
                : null,
        });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed", hasCourseRep: false });
    }
}
async function getUser(req, res) {
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: String(req.params.id) },
        select: {
            id: true,
            email: true,
            name: true,
            role: true,
            plan: true,
            uniqueId: true,
            department: true,
            faculty: true,
            level: true,
            matricNumber: true,
            phone: true,
            bio: true,
            photoUrl: true,
            avatarUrl: true,
            status: true,
            profileComplete: true,
            emailVerified: true,
            mustChangePassword: true,
            courseRepMeta: true,
            assignedBy: true,
            assignedAt: true,
            coursesEnrolledCount: true,
            questionsPracticedCount: true,
            studyStreakDays: true,
            materialsOpenedCount: true,
            lastActiveAt: true,
            createdAt: true,
            updatedAt: true,
        },
    });
    if (!user)
        return res.status(404).json({ error: "User not found" });
    res.json({ user });
}
const updateProfileSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).optional(),
    department: zod_1.z.string().optional().nullable(),
    faculty: zod_1.z.string().optional().nullable(),
    level: zod_1.z.string().optional().nullable(),
    matricNumber: zod_1.z.string().optional().nullable(),
    phone: zod_1.z.string().optional().nullable(),
    bio: zod_1.z.string().optional().nullable(),
    interests: zod_1.z.string().optional().nullable(),
    dob: zod_1.z.string().optional().nullable(),
    gender: zod_1.z.string().optional().nullable(),
    nickname: zod_1.z.string().optional().nullable(),
    showDepartment: zod_1.z.boolean().optional(),
    showPhone: zod_1.z.boolean().optional(),
    allowAnonymousComments: zod_1.z.boolean().optional(),
    studyStreakDays: zod_1.z.number().int().min(0).optional(),
    materialsOpenedCount: zod_1.z.number().int().min(0).optional(),
    lastActiveDate: zod_1.z.string().optional().nullable(),
    lastActiveAt: zod_1.z.coerce.date().optional().nullable(),
    photoUrl: zod_1.z.string().max(2000000).optional().nullable(),
    avatarUrl: zod_1.z.string().max(2000000).optional().nullable(),
    fcmToken: zod_1.z.string().optional().nullable(),
    deviceToken: zod_1.z.string().optional().nullable(),
    settings: zod_1.z.record(zod_1.z.any()).optional().nullable(),
    profileComplete: zod_1.z.boolean().optional(),
    uniqueId: zod_1.z.string().optional(), // only allowed if currently null
    canImportAI: zod_1.z.boolean().optional(),
    autoPublish: zod_1.z.boolean().optional(),
    courseRepMeta: zod_1.z.record(zod_1.z.any()).nullable().optional(),
    customCourses: zod_1.z.array(zod_1.z.any()).optional(),
});
async function createUniqueId() {
    const year = new Date().getFullYear().toString().slice(-2);
    for (let attempt = 0; attempt < 12; attempt += 1) {
        const candidate = `UAR-${year}-${Math.floor(1000 + Math.random() * 9000)}`;
        const existing = await prisma_1.prisma.user.findUnique({ where: { uniqueId: candidate } });
        if (!existing)
            return candidate;
    }
    throw new Error("Could not generate a unique ID. Please try again.");
}
async function updateMe(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    try {
        const body = updateProfileSchema.parse(req.body);
        const current = await prisma_1.prisma.user.findUnique({ where: { id: req.user.id } });
        if (!current)
            return res.status(404).json({ error: "User not found" });
        // uniqueId can only be set once
        if (body.uniqueId && current.uniqueId) {
            return res.status(400).json({ error: "uniqueId already set" });
        }
        const generatedUniqueId = body.profileComplete && !current.uniqueId
            ? await createUniqueId()
            : undefined;
        const user = await prisma_1.prisma.user.update({
            where: { id: req.user.id },
            data: {
                name: body.name,
                department: body.department,
                faculty: body.faculty,
                level: body.level,
                matricNumber: body.matricNumber,
                phone: body.phone,
                bio: body.bio,
                interests: body.interests,
                dob: body.dob,
                gender: body.gender,
                nickname: body.nickname,
                showDepartment: body.showDepartment,
                showPhone: body.showPhone,
                allowAnonymousComments: body.allowAnonymousComments,
                photoUrl: body.photoUrl,
                avatarUrl: body.avatarUrl,
                fcmToken: body.fcmToken,
                deviceToken: body.deviceToken,
                ...(body.settings !== undefined ? { settings: body.settings === null ? client_1.Prisma.JsonNull : body.settings } : {}),
                profileComplete: body.profileComplete,
                studyStreakDays: body.studyStreakDays,
                materialsOpenedCount: body.materialsOpenedCount,
                lastActiveDate: body.lastActiveDate,
                lastActiveAt: body.lastActiveAt,
                ...(body.uniqueId && !current.uniqueId
                    ? { uniqueId: body.uniqueId }
                    : generatedUniqueId
                        ? { uniqueId: generatedUniqueId }
                        : {}),
                canImportAI: body.canImportAI,
                autoPublish: body.autoPublish,
                ...(body.courseRepMeta !== undefined
                    ? { courseRepMeta: body.courseRepMeta === null ? client_1.Prisma.JsonNull : body.courseRepMeta }
                    : {}),
                customCourses: body.customCourses,
            },
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
                plan: true,
                uniqueId: true,
                department: true,
                photoUrl: true,
                faculty: true,
                level: true,
                matricNumber: true,
                phone: true,
                bio: true,
                interests: true,
                dob: true,
                gender: true,
                nickname: true,
                showDepartment: true,
                showPhone: true,
                allowAnonymousComments: true,
                profileComplete: true,
                studyStreakDays: true,
                materialsOpenedCount: true,
                lastActiveDate: true,
                lastActiveAt: true,
                emailVerified: true,
            },
        });
        res.json({ user });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            return res.status(400).json({ error: err.errors });
        }
        console.error(err);
        res.status(500).json({ error: "Update failed" });
    }
}
const adminUpdateSchema = zod_1.z.object({
    role: zod_1.z.enum(["admin", "alphaAgent", "agent", "courseRep", "user"]).optional(),
    plan: zod_1.z.enum(["free", "pro", "annual"]).optional(),
    status: zod_1.z.enum(["active", "suspended", "deleted"]).optional(),
    name: zod_1.z.string().optional(),
    department: zod_1.z.string().nullable().optional(),
    faculty: zod_1.z.string().nullable().optional(),
    level: zod_1.z.string().nullable().optional(),
    mustChangePassword: zod_1.z.boolean().optional(),
    assignedBy: zod_1.z.string().nullable().optional(),
    assignedAt: zod_1.z.coerce.date().nullable().optional(),
    courseRepMeta: zod_1.z.record(zod_1.z.any()).nullable().optional(),
    fcmToken: zod_1.z.string().nullable().optional(),
    deviceToken: zod_1.z.string().nullable().optional(),
    avatarUrl: zod_1.z.string().nullable().optional(),
});
async function adminUpdateUser(req, res) {
    try {
        const body = adminUpdateSchema.parse(req.body);
        const data = {};
        if (body.role !== undefined)
            data.role = body.role;
        if (body.plan !== undefined)
            data.plan = body.plan;
        if (body.status !== undefined)
            data.status = body.status;
        if (body.name !== undefined)
            data.name = body.name;
        if (body.department !== undefined)
            data.department = body.department;
        if (body.faculty !== undefined)
            data.faculty = body.faculty;
        if (body.level !== undefined)
            data.level = body.level;
        if (body.mustChangePassword !== undefined) {
            data.mustChangePassword = body.mustChangePassword;
        }
        if (body.assignedBy !== undefined)
            data.assignedBy = body.assignedBy;
        if (body.assignedAt !== undefined)
            data.assignedAt = body.assignedAt;
        if (body.fcmToken !== undefined)
            data.fcmToken = body.fcmToken;
        if (body.deviceToken !== undefined)
            data.deviceToken = body.deviceToken;
        if (body.avatarUrl !== undefined)
            data.avatarUrl = body.avatarUrl;
        if (body.courseRepMeta !== undefined) {
            data.courseRepMeta = body.courseRepMeta === null ? client_1.Prisma.JsonNull : body.courseRepMeta;
        }
        if (body.role === "courseRep" && body.courseRepMeta) {
            data.courseRepMeta = body.courseRepMeta;
        }
        if (body.role === "user") {
            data.courseRepMeta = client_1.Prisma.JsonNull;
        }
        const user = await prisma_1.prisma.user.update({
            where: { id: String(req.params.id) },
            data,
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
                plan: true,
                status: true,
                department: true,
                faculty: true,
                level: true,
                courseRepMeta: true,
                assignedBy: true,
                assignedAt: true,
                mustChangePassword: true,
            },
        });
        res.json({ user });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            return res.status(400).json({ error: err.errors });
        }
        console.error("adminUpdateUser failed:", err);
        const reason = err instanceof client_1.Prisma.PrismaClientValidationError
            ? "Invalid update — field does not match schema."
            : err instanceof client_1.Prisma.PrismaClientKnownRequestError
                ? `Database error (${err.code})`
                : err instanceof Error
                    ? err.message
                    : "Unknown error";
        res.status(500).json({ error: "Update failed", reason });
    }
}
function generateTempPassword() {
    // 12 random chars from an unambiguous alphabet (no 0/O/1/l/I) — easy to
    // read aloud over a phone call when handing it to a user who lost access.
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let out = "";
    const bytes = node_crypto_1.default.randomBytes(12);
    for (let i = 0; i < 12; i++)
        out += alphabet[bytes[i] % alphabet.length];
    return out;
}
/**
 * Admin-triggered password reset for a user who lost access to their email.
 *
 * IMPORTANT: this does NOT expose the user's existing password or its hash —
 * bcrypt hashes are one-way, so there is no way to "recover" a lost password
 * from its hash even if you could see it. Showing hashes to admins would add
 * real security risk (offline cracking, leak surface) without solving the
 * actual problem. Instead this issues a brand-new temporary password, shown
 * to the admin exactly once in this response, and forces the user to change
 * it on next login. Verify the user's identity through another channel
 * (student ID, phone call, etc.) before handing over the temp password.
 */
async function adminResetPassword(req, res) {
    try {
        const userId = String(req.params.id);
        const user = await prisma_1.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
        if (!user)
            return res.status(404).json({ error: "User not found" });
        const tempPassword = generateTempPassword();
        await prisma_1.prisma.user.update({
            where: { id: userId },
            data: {
                passwordHash: await bcryptjs_1.default.hash(tempPassword, 12),
                mustChangePassword: true,
                passwordResetHash: null,
                passwordResetExpiresAt: null,
            },
        });
        return res.json({
            email: user.email,
            tempPassword,
            note: "Share this with the verified user through a secure channel. It is shown only once — run this again to issue a new one if it's lost.",
        });
    }
    catch (err) {
        console.error("adminResetPassword failed:", err);
        return res.status(500).json({ error: "Could not reset password" });
    }
}
const createAgentSchema = zod_1.z.object({
    email: zod_1.z.string().trim().email().transform((value) => value.toLowerCase()),
    password: zod_1.z.string().min(6),
    name: zod_1.z.string().trim().min(1).optional(),
    role: zod_1.z.enum(["agent", "alphaAgent"]),
});
async function createAgent(req, res) {
    try {
        const body = createAgentSchema.parse(req.body);
        const existing = await prisma_1.prisma.user.findUnique({ where: { email: body.email } });
        if (existing)
            return res.status(409).json({ error: "Email already registered" });
        const user = await prisma_1.prisma.user.create({
            data: {
                email: body.email,
                passwordHash: await bcryptjs_1.default.hash(body.password, 12),
                name: body.name || body.email.split("@")[0],
                role: body.role,
                emailVerified: true,
                profileComplete: true,
                mustChangePassword: true,
                agentDomain: body.email.split("@")[1],
                createdByAdmin: true,
                createdByUid: req.user?.id,
            },
            select: { id: true, email: true, name: true, role: true, plan: true, uniqueId: true, status: true, emailVerified: true, profileComplete: true, mustChangePassword: true },
        });
        return res.status(201).json({ user });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError)
            return res.status(400).json({ error: err.errors });
        console.error(err);
        return res.status(500).json({ error: "Could not create agent" });
    }
}
async function deleteUser(req, res) {
    try {
        await prisma_1.prisma.user.update({ where: { id: String(req.params.id) }, data: { status: "deleted" } });
        return res.json({ ok: true });
    }
    catch (err) {
        console.error(err);
        return res.status(404).json({ error: "User not found" });
    }
}
//# sourceMappingURL=users.controller.js.map