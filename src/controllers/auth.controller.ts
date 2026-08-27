import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import jwt from "jsonwebtoken";
import { Role } from "@prisma/client";
import { verifyFirebaseIdToken, isFirebaseEnabled } from "../lib/firebase";

const VERIFICATION_TTL_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 45 * 1000;
const MAX_VERIFICATION_ATTEMPTS = 5;

function signToken(user: { id: string; email: string; role: Role }) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET || "dev-secret",
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" } as jwt.SignOptions
  );
}

function publicUser(user: {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  plan: string;
  uniqueId: string | null;
  emailVerified?: boolean;
  profileComplete?: boolean;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    plan: user.plan,
    uniqueId: user.uniqueId,
    emailVerified: user.emailVerified,
    profileComplete: user.profileComplete,
  };
}

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function register(req: Request, res: Response) {
  try {
    const body = registerSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(body.password, 12);

    // Generate uniqueId → UAR-26-XXXX
    const year = new Date().getFullYear().toString().slice(-2);
    let uniqueId: string | null = null;

    for (let i = 0; i < 10; i++) {
      const random = Math.floor(1000 + Math.random() * 9000);
      const candidate = `UAR-${year}-${random}`;
      const exists = await prisma.user.findUnique({ where: { uniqueId: candidate } });
      if (!exists) {
        uniqueId = candidate;
        break;
      }
    }

    const user = await prisma.user.create({
      data: {
        email: body.email,
        passwordHash,
        name: body.name || body.email.split("@")[0],
        role: "user",
        plan: "free",
        uniqueId,
      },
    });

    const token = signToken(user);

    return res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        plan: user.plan,
        uniqueId: user.uniqueId,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors });
    }
    console.error(err);
    return res.status(500).json({ error: "Registration failed" });
  }
}

export async function login(req: Request, res: Response) {
  try {
    const body = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signToken(user);

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        plan: user.plan,
        uniqueId: user.uniqueId,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors });
    }
    console.error(err);
    return res.status(500).json({ error: "Login failed" });
  }
}

export async function firebaseLogin(req: Request, res: Response) {
  try {
    if (!isFirebaseEnabled()) {
      return res.status(503).json({ error: "Google sign-in is not configured on the API" });
    }

    const idToken = z.string().min(1).parse(req.body?.idToken);
    const decoded = await verifyFirebaseIdToken(idToken);
    if (!decoded.email) {
      return res.status(400).json({ error: "Google account does not have an email address" });
    }

    let user = await prisma.user.findFirst({
      where: { OR: [{ firebaseUid: decoded.uid }, { email: decoded.email }] },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          firebaseUid: decoded.uid,
          email: decoded.email,
          name: decoded.name || decoded.email.split("@")[0],
          photoUrl: decoded.picture,
          emailVerified: decoded.email_verified ?? false,
          role: "user",
          plan: "free",
        },
      });
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          firebaseUid: decoded.uid,
          emailVerified: decoded.email_verified ?? user.emailVerified,
          ...(decoded.name && !user.name ? { name: decoded.name } : {}),
          ...(decoded.picture && !user.photoUrl ? { photoUrl: decoded.picture } : {}),
        },
      });
    }

    if (user.status !== "active") {
      return res.status(401).json({ error: "User not found or inactive" });
    }

    return res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Firebase ID token is required" });
    }
    console.error("Firebase login failed:", err);
    return res.status(401).json({ error: "Invalid or expired Firebase ID token" });
  }
}

function verificationConfig() {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error("Email verification is not configured on the API");
  return { apiKey, senderEmail: process.env.BREVO_SENDER_EMAIL || "noreply@academicall.site" };
}

async function sendVerificationCode(user: { id: string; email: string; name: string | null }) {
  const config = verificationConfig();
  const existing = await prisma.user.findUnique({ where: { id: user.id }, select: { emailVerificationSentAt: true } });
  if (existing?.emailVerificationSentAt && Date.now() - existing.emailVerificationSentAt.getTime() < RESEND_COOLDOWN_MS) {
    throw Object.assign(new Error("Please wait before requesting another code"), { status: 429 });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await prisma.user.update({ where: { id: user.id }, data: { emailVerificationHash: await bcrypt.hash(code, 10), emailVerificationExpiresAt: new Date(Date.now() + VERIFICATION_TTL_MS), emailVerificationSentAt: new Date(), emailVerificationAttempts: 0 } });
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { accept: "application/json", "api-key": config.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ sender: { name: "Academicall", email: config.senderEmail }, replyTo: { email: process.env.BREVO_REPLY_TO_EMAIL || config.senderEmail }, to: [{ email: user.email, name: user.name || user.email }], subject: "Your Academicall verification code", textContent: `Academicall verification code: ${code}\n\nExpires in 15 minutes.` }),
  });
  if (!response.ok) throw Object.assign(new Error("Email provider error"), { status: 502 });
}

export async function sendVerification(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, email: true, name: true, emailVerified: true } });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.emailVerified) return res.json({ ok: true, verified: true });
    await sendVerificationCode(user);
    return res.json({ ok: true, message: "Verification code sent" });
  } catch (err) {
    const error = err as Error & { status?: number };
    return res.status(error.status || 500).json({ error: error.message || "Could not send verification code" });
  }
}

export async function verifyEmail(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const code = String(req.body?.code || "").trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "Code must be 6 digits" });
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.emailVerified) return res.json({ ok: true, verified: true });
  if (!user.emailVerificationHash || !user.emailVerificationExpiresAt || user.emailVerificationExpiresAt.getTime() < Date.now()) return res.status(400).json({ error: "Code expired or unavailable. Request a new one." });
  if (user.emailVerificationAttempts >= MAX_VERIFICATION_ATTEMPTS) return res.status(429).json({ error: "Too many attempts. Request a new code." });
  if (!await bcrypt.compare(code, user.emailVerificationHash)) {
    await prisma.user.update({ where: { id: user.id }, data: { emailVerificationAttempts: { increment: 1 } } });
    return res.status(400).json({ error: "Invalid code" });
  }
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true, emailVerificationHash: null, emailVerificationExpiresAt: null, emailVerificationSentAt: null, emailVerificationAttempts: 0 } });
  return res.json({ ok: true, verified: true });
}

export async function me(req: Request, res: Response) {
  try {
    // @ts-ignore – req.user is set by authenticate middleware
    const userId = req.user?.id || req.user?.sub;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        plan: true,
        uniqueId: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({ user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch user" });
  }
}