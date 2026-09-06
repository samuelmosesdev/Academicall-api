"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.register = register;
exports.login = login;
exports.changePassword = changePassword;
exports.googleLogin = googleLogin;
exports.requestPasswordReset = requestPasswordReset;
exports.confirmPasswordReset = confirmPasswordReset;
exports.sendVerification = sendVerification;
exports.verifyEmail = verifyEmail;
exports.me = me;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const zod_1 = require("zod");
const prisma_1 = require("../lib/prisma");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const client_1 = require("@prisma/client");
const google_auth_library_1 = require("google-auth-library");
const node_crypto_1 = __importDefault(require("node:crypto"));
const VERIFICATION_TTL_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 45 * 1000;
const MAX_VERIFICATION_ATTEMPTS = 5;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
function signToken(user) {
    return jsonwebtoken_1.default.sign({ sub: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET || "dev-secret", { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });
}
function publicUser(user) {
    return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        plan: user.plan,
        uniqueId: user.uniqueId,
        emailVerified: user.emailVerified,
        profileComplete: user.profileComplete,
        status: user.status,
        department: user.department,
        faculty: user.faculty,
        level: user.level,
        matricNumber: user.matricNumber,
        phone: user.phone,
        photoUrl: user.photoUrl,
        mustChangePassword: user.mustChangePassword,
    };
}
const registerSchema = zod_1.z.object({
    email: zod_1.z.string().trim().email().transform((value) => value.toLowerCase()),
    password: zod_1.z.string().min(6),
    name: zod_1.z.string().optional(),
});
const loginSchema = zod_1.z.object({
    identifier: zod_1.z.string().trim().min(1),
    password: zod_1.z.string().min(1),
});
const passwordChangeSchema = zod_1.z.object({
    currentPassword: zod_1.z.string().min(1),
    newPassword: zod_1.z.string().min(8),
});
async function register(req, res) {
    try {
        const body = registerSchema.parse(req.body);
        const existing = await prisma_1.prisma.user.findUnique({ where: { email: body.email } });
        if (existing) {
            return res.status(409).json({ error: "Email already registered" });
        }
        const passwordHash = await bcryptjs_1.default.hash(body.password, 12);
        const user = await prisma_1.prisma.user.create({
            data: {
                email: body.email,
                passwordHash,
                name: body.name || body.email.split("@")[0],
                role: "user",
                plan: "free",
                uniqueId: null,
            },
        });
        const token = signToken(user);
        return res.status(201).json({
            token,
            user: publicUser(user),
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            return res.status(400).json({ error: err.errors });
        }
        console.error(err);
        return res.status(500).json({ error: "Registration failed" });
    }
}
async function login(req, res) {
    try {
        const body = loginSchema.parse(req.body);
        const identifier = body.identifier.toUpperCase();
        const user = body.identifier.includes("@")
            ? await prisma_1.prisma.user.findUnique({ where: { email: body.identifier.toLowerCase() } })
            : await prisma_1.prisma.user.findUnique({ where: { uniqueId: identifier } });
        if (!user || !user.passwordHash) {
            return res.status(401).json({ error: "Invalid email or password" });
        }
        if (user.status !== "active") {
            return res.status(401).json({ error: "User not found or inactive" });
        }
        const valid = await bcryptjs_1.default.compare(body.password, user.passwordHash);
        if (!valid) {
            return res.status(401).json({ error: "Invalid email or password" });
        }
        const token = signToken(user);
        return res.json({ token, user: publicUser(user) });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            return res.status(400).json({ error: err.errors });
        }
        console.error(err);
        return res.status(500).json({ error: "Login failed" });
    }
}
async function changePassword(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    try {
        const body = passwordChangeSchema.parse(req.body);
        const user = await prisma_1.prisma.user.findUnique({ where: { id: req.user.id } });
        if (!user?.passwordHash || !(await bcryptjs_1.default.compare(body.currentPassword, user.passwordHash))) {
            return res.status(401).json({ error: "Current password is incorrect" });
        }
        await prisma_1.prisma.user.update({
            where: { id: user.id },
            data: { passwordHash: await bcryptjs_1.default.hash(body.newPassword, 12), passwordChangedAt: new Date(), mustChangePassword: false },
        });
        return res.json({ ok: true });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError)
            return res.status(400).json({ error: err.errors });
        console.error(err);
        return res.status(500).json({ error: "Could not change password" });
    }
}
async function googleLogin(req, res) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
        return res.status(503).json({ error: "Google sign-in is not configured on the API" });
    }
    let credential;
    try {
        credential = zod_1.z.string().min(1).parse(req.body?.credential || req.body?.idToken);
    }
    catch {
        return res.status(400).json({ error: "Google credential is required" });
    }
    // Step 1: verify the ID token with Google. Failures here really do mean an
    // invalid/expired/mismatched-audience credential.
    let payload;
    try {
        const client = new google_auth_library_1.OAuth2Client(clientId);
        const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
        payload = ticket.getPayload();
    }
    catch (err) {
        console.error("Google token verification failed:", err);
        const reason = err instanceof Error ? err.message : "Unknown error";
        return res.status(401).json({ error: "Invalid or expired Google credential", reason });
    }
    if (!payload?.sub || !payload.email) {
        return res.status(401).json({ error: "Google account details are unavailable" });
    }
    // Step 2: find-or-create the user in Postgres. Failures here are OUR bug
    // (schema mismatch, constraint violation, etc.), not a bad Google token —
    // report them as a real 500 with detail instead of blaming Google.
    try {
        let user = await prisma_1.prisma.user.findFirst({
            where: { OR: [{ googleUid: payload.sub }, { email: payload.email }] },
        });
        if (!user) {
            user = await prisma_1.prisma.user.create({
                data: {
                    googleUid: payload.sub,
                    email: payload.email,
                    name: payload.name || payload.email.split("@")[0],
                    photoUrl: payload.picture,
                    emailVerified: payload.email_verified ?? false,
                    role: "user",
                    plan: "free",
                },
            });
        }
        else {
            user = await prisma_1.prisma.user.update({
                where: { id: user.id },
                data: {
                    googleUid: payload.sub,
                    emailVerified: payload.email_verified ?? user.emailVerified,
                    ...(payload.name && !user.name ? { name: payload.name } : {}),
                    ...(payload.picture && !user.photoUrl ? { photoUrl: payload.picture } : {}),
                },
            });
        }
        if (user.status !== "active") {
            return res.status(401).json({ error: "User not found or inactive" });
        }
        return res.json({ token: signToken(user), user: publicUser(user) });
    }
    catch (err) {
        console.error("Google login — saving user failed:", err);
        const reason = err instanceof client_1.Prisma.PrismaClientKnownRequestError
            ? `Database error (${err.code}): ${err.meta?.target ? `conflict on ${JSON.stringify(err.meta.target)}` : "see server logs"}`
            : err instanceof client_1.Prisma.PrismaClientValidationError
                ? "Invalid data — one of the fields doesn't match the database schema."
                : err instanceof Error
                    ? err.message
                    : "Unknown error";
        return res.status(500).json({ error: "Could not complete sign-in", reason });
    }
}
function verificationConfig() {
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey)
        throw new Error("Email verification is not configured on the API");
    return { apiKey, senderEmail: process.env.BREVO_SENDER_EMAIL || "noreply@academicall.site" };
}
async function sendPasswordResetEmail(email, token) {
    const config = verificationConfig();
    const resetUrl = `${process.env.FRONTEND_URL || "http://localhost:5173"}/reset-password?token=${encodeURIComponent(token)}`;
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { accept: "application/json", "api-key": config.apiKey, "content-type": "application/json" },
        body: JSON.stringify({
            sender: { name: process.env.BREVO_SENDER_NAME || "Academicall", email: config.senderEmail },
            replyTo: { email: process.env.BREVO_REPLY_TO_EMAIL || config.senderEmail },
            to: [{ email }],
            subject: "Reset your Academicall password",
            textContent: `Reset your Academicall password using this link:\n\n${resetUrl}\n\nThis link expires in one hour.`,
        }),
    });
    if (!response.ok)
        throw Object.assign(new Error("Email provider error"), { status: 502 });
}
async function requestPasswordReset(req, res) {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!zod_1.z.string().email().safeParse(email).success) {
        return res.status(400).json({ error: "Enter a valid email address" });
    }
    // Always return the same response for unknown addresses.
    const user = await prisma_1.prisma.user.findUnique({ where: { email } });
    if (user?.status === "active") {
        const token = node_crypto_1.default.randomBytes(32).toString("hex");
        await prisma_1.prisma.user.update({
            where: { id: user.id },
            data: {
                passwordResetHash: node_crypto_1.default.createHash("sha256").update(token).digest("hex"),
                passwordResetExpiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
            },
        });
        await sendPasswordResetEmail(user.email, token);
    }
    return res.json({ ok: true, message: "If an account exists, a reset link has been sent." });
}
async function confirmPasswordReset(req, res) {
    const token = String(req.body?.token || "");
    const password = String(req.body?.password || "");
    if (token.length < 32 || password.length < 8) {
        return res.status(400).json({ error: "A valid token and password of at least 8 characters are required" });
    }
    const user = await prisma_1.prisma.user.findFirst({
        where: {
            passwordResetHash: node_crypto_1.default.createHash("sha256").update(token).digest("hex"),
            passwordResetExpiresAt: { gt: new Date() },
            status: "active",
        },
    });
    if (!user)
        return res.status(400).json({ error: "Reset link is invalid or expired" });
    await prisma_1.prisma.user.update({
        where: { id: user.id },
        data: {
            passwordHash: await bcryptjs_1.default.hash(password, 12),
            passwordChangedAt: new Date(),
            mustChangePassword: false,
            passwordResetHash: null,
            passwordResetExpiresAt: null,
        },
    });
    return res.json({ ok: true });
}
async function sendVerificationCode(user) {
    const config = verificationConfig();
    const existing = await prisma_1.prisma.user.findUnique({ where: { id: user.id }, select: { emailVerificationSentAt: true } });
    if (existing?.emailVerificationSentAt && Date.now() - existing.emailVerificationSentAt.getTime() < RESEND_COOLDOWN_MS) {
        throw Object.assign(new Error("Please wait before requesting another code"), { status: 429 });
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await prisma_1.prisma.user.update({ where: { id: user.id }, data: { emailVerificationHash: await bcryptjs_1.default.hash(code, 10), emailVerificationExpiresAt: new Date(Date.now() + VERIFICATION_TTL_MS), emailVerificationSentAt: new Date(), emailVerificationAttempts: 0 } });
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { accept: "application/json", "api-key": config.apiKey, "content-type": "application/json" },
        body: JSON.stringify({ sender: { name: "Academicall", email: config.senderEmail }, replyTo: { email: process.env.BREVO_REPLY_TO_EMAIL || config.senderEmail }, to: [{ email: user.email, name: user.name || user.email }], subject: "Your Academicall verification code", textContent: `Academicall verification code: ${code}\n\nExpires in 15 minutes.` }),
    });
    if (!response.ok)
        throw Object.assign(new Error("Email provider error"), { status: 502 });
}
async function sendVerification(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    try {
        const user = await prisma_1.prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, email: true, name: true, emailVerified: true } });
        if (!user)
            return res.status(404).json({ error: "User not found" });
        if (user.emailVerified)
            return res.json({ ok: true, verified: true });
        await sendVerificationCode(user);
        return res.json({ ok: true, message: "Verification code sent" });
    }
    catch (err) {
        const error = err;
        return res.status(error.status || 500).json({ error: error.message || "Could not send verification code" });
    }
}
async function verifyEmail(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const code = String(req.body?.code || "").trim();
    if (!/^\d{6}$/.test(code))
        return res.status(400).json({ error: "Code must be 6 digits" });
    const user = await prisma_1.prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user)
        return res.status(404).json({ error: "User not found" });
    if (user.emailVerified)
        return res.json({ ok: true, verified: true });
    if (!user.emailVerificationHash || !user.emailVerificationExpiresAt || user.emailVerificationExpiresAt.getTime() < Date.now())
        return res.status(400).json({ error: "Code expired or unavailable. Request a new one." });
    if (user.emailVerificationAttempts >= MAX_VERIFICATION_ATTEMPTS)
        return res.status(429).json({ error: "Too many attempts. Request a new code." });
    if (!await bcryptjs_1.default.compare(code, user.emailVerificationHash)) {
        await prisma_1.prisma.user.update({ where: { id: user.id }, data: { emailVerificationAttempts: { increment: 1 } } });
        return res.status(400).json({ error: "Invalid code" });
    }
    await prisma_1.prisma.user.update({ where: { id: user.id }, data: { emailVerified: true, emailVerificationHash: null, emailVerificationExpiresAt: null, emailVerificationSentAt: null, emailVerificationAttempts: 0 } });
    return res.json({ ok: true, verified: true });
}
async function me(req, res) {
    try {
        // @ts-ignore – req.user is set by authenticate middleware
        const userId = req.user?.id || req.user?.sub;
        if (!userId) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const user = await prisma_1.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
                plan: true,
                uniqueId: true,
                createdAt: true,
                status: true,
                emailVerified: true,
                profileComplete: true,
                department: true,
                faculty: true,
                level: true,
                matricNumber: true,
                phone: true,
                photoUrl: true,
                mustChangePassword: true,
            },
        });
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }
        return res.json({ user });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to fetch user" });
    }
}
//# sourceMappingURL=auth.controller.js.map