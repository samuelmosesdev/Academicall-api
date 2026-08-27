import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { verifyFirebaseIdToken } from "../lib/firebase";
import { Role } from "@prisma/client";

interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
}

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  const token = header.slice(7);

  try {
    // 1. Try JWT first
    try {
      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || "dev-secret"
      ) as JwtPayload;

      const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
      if (!user || user.status !== "active") {
        return res.status(401).json({ error: "User not found or inactive" });
      }

      req.user = {
        id: user.id,
        email: user.email,
        role: user.role,
        firebaseUid: user.firebaseUid,
      };
      return next();
    } catch {
      // not a valid JWT – try Firebase ID token
    }

    // 2. Try Firebase ID token (hybrid mode)
    try {
      const decoded = await verifyFirebaseIdToken(token);
      let user = await prisma.user.findFirst({
        where: {
          OR: [
            { firebaseUid: decoded.uid },
            { email: decoded.email ?? undefined },
          ],
        },
      });

      // Auto-provision on first Firebase login if missing
      if (!user && decoded.email) {
        user = await prisma.user.create({
          data: {
            firebaseUid: decoded.uid,
            email: decoded.email,
            name: decoded.name || decoded.email.split("@")[0],
            emailVerified: decoded.email_verified ?? false,
            role: "user",
            plan: "free",
          },
        });
      }

      if (!user || user.status !== "active") {
        return res.status(401).json({ error: "User not found or inactive" });
      }

      // Keep firebaseUid in sync
      if (!user.firebaseUid) {
        await prisma.user.update({
          where: { id: user.id },
          data: { firebaseUid: decoded.uid },
        });
      }

      req.user = {
        id: user.id,
        email: user.email,
        role: user.role,
        firebaseUid: user.firebaseUid,
      };
      return next();
    } catch (fbErr) {
      console.warn("Token verification failed:", (fbErr as Error).message);
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Authentication error" });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthenticated" });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}

export const requireAdmin = requireRole("admin");
export const requireStaff = requireRole("admin", "alphaAgent", "agent");
export const requireAdminOrAlpha = requireRole("admin", "alphaAgent");
