import { Request, Response } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { Role } from "@prisma/client";

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
        emailVerified: true,
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
