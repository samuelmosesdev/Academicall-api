import { Request, Response } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { Role } from "@prisma/client";

const VERIFICATION_TTL_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 45 * 1000;
const MAX_VERIFICATION_ATTEMPTS = 5;

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function signToken(user: { id: string; email: string; role: Role }) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET || "dev-secret",
    { expiresIn: "7d" }
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

function verificationConfig() {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail) {
    throw new Error("Email verification is not configured on the API");
  }
  return { apiKey, senderEmail, senderName: process.env.BREVO_SENDER_NAME || "Academicall" };
}

async function sendVerificationCode(user: { id: string; email: string; name: string | null }) {
  const config = verificationConfig();
  const existing = await prisma.user.findUnique({
    where: { id: user.id },
    select: { emailVerificationSentAt: true },
  });
  if (
    existing?.emailVerificationSentAt &&
    Date.now() - existing.emailVerificationSentAt.getTime() < RESEND_COOLDOWN_MS
  ) {
    throw Object.assign(new Error("Please wait before requesting another code"), { status: 429 });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerificationHash: await bcrypt.hash(code, 10),
      emailVerificationExpiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
      emailVerificationSentAt: new Date(),
      emailVerificationAttempts: 0,
    },
  });

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": config.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: { name: config.senderName, email: config.senderEmail },
      to: [{ email: user.email, name: user.name || user.email }],
      subject: "Your Academicall verification code",
      htmlContent: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px"><h1 style="color:#0f9f8a;font-size:22px">Academicall</h1><p>Use this code to verify your email. It expires in <strong>15 minutes</strong>.</p><p style="font-size:32px;letter-spacing:8px;font-weight:700;color:#0b7a6a">${code}</p><p style="color:#6b7f76;font-size:13px">If you did not create an Academicall account, you can ignore this email.</p></div>`,
      textContent: `Academicall verification code: ${code}\n\nExpires in 15 minutes.`,
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw Object.assign(new Error(`Email provider error: ${detail}`), { status: 502 });
  }
}

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
    let attempts = 0;

    while (attempts < 10) {
      const random = Math.floor(1000 + Math.random() * 9000);
      const candidate = `UAR-${year}-${random}`;
      const exists = await prisma.user.findUnique({ where: { uniqueId: candidate } });
      if (!exists) {
        uniqueId = candidate;
        break;
      }
      attempts++;
    }

    const user = await prisma.user.create({
      data: {
        email: body.email,
        passwordHash,
        name: body.name || body.email.split("@")[0],
        role: "user",
        plan: "free",
        uniqueId,
        emailVerified: false,
      },
    });

    const token = signToken(user);

    res.status(201).json({
      token,
      user: publicUser(user),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors });
    }
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
}

export async function sendVerification(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, name: true, emailVerified: true },
    });
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
  if (!user.emailVerificationHash || !user.emailVerificationExpiresAt) {
    return res.status(400).json({ error: "No active code. Request a new one." });
  }
  if (user.emailVerificationExpiresAt.getTime() < Date.now()) {
    return res.status(400).json({ error: "Code expired. Request a new one." });
  }
  if (user.emailVerificationAttempts >= MAX_VERIFICATION_ATTEMPTS) {
    return res.status(429).json({ error: "Too many attempts. Request a new code." });
  }

  const matches = await bcrypt.compare(code, user.emailVerificationHash);
  if (!matches) {
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerificationAttempts: { increment: 1 } },
    });
    return res.status(400).json({ error: "Invalid code" });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerified: true,
      emailVerificationHash: null,
      emailVerificationExpiresAt: null,
      emailVerificationSentAt: null,
      emailVerificationAttempts: 0,
    },
  });
  return res.json({ ok: true, verified: true });
}

export async function login(req: Request, res: Response) {
  try {
    const body = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (user.status !== "active") {
      return res.status(401).json({ error: "User not found or inactive" });
    }

    const ok = await bcrypt.compare(body.password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signToken(user);

    res.json({
      token,
      user: publicUser(user),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors });
    }
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
}

export async function me(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      plan: true,
      uniqueId: true,
      department: true,
      photoUrl: true,
      status: true,
      profileComplete: true,
      emailVerified: true,
      coursesEnrolledCount: true,
      questionsPracticedCount: true,
      studyStreakDays: true,
      materialsOpenedCount: true,
      lastActiveDate: true,
      lastActiveAt: true,
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
      createdAt: true,
    },
  });

  if (!user || user.status !== "active") {
    return res.status(401).json({ error: "User not found or inactive" });
  }

  res.json({ user });
}
