import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { Role } from "@prisma/client";
import { effectiveCaps, requireCap } from "../lib/access";

interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  iat?: number;
}

/** While a password change is forced, only these calls work. */
const PASSWORD_GATE_ALLOW = [
  /^GET \/auth\/me$/,
  /^GET \/users\/me$/,
  /^POST \/auth\/password\/change$/,
  /^POST \/auth\/verification\//,
  /^GET \/settings\//,
];

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
    let decoded: JwtPayload;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET || "dev-secret") as JwtPayload;
    } catch {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
    if (!user || user.status !== "active") {
      return res.status(401).json({ error: "User not found or inactive" });
    }

    // JWT timestamps have one-second resolution, so same-second tokens count as older.
    if (user.sessionsRevokedAt && typeof decoded.iat === "number" && decoded.iat * 1000 < user.sessionsRevokedAt.getTime()) {
      return res.status(401).json({ error: "You were signed out. Sign in again.", code: "session_revoked" });
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      staffTags: user.staffTags || [],
      caps: effectiveCaps(user),
    };

    if (user.mustChangePassword) {
      const route = `${req.method} ${(req.baseUrl + req.path).replace(/^\/api\/v1/, "").replace(/\/$/, "")}`;
      if (!PASSWORD_GATE_ALLOW.some((rx) => rx.test(route))) {
        return res.status(403).json({ error: "Set a new password before you continue.", code: "password_change_required" });
      }
    }
    return next();
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
export { requireCap };
export const requireStaff = requireRole("admin", "alphaAgent", "agent");
export const requireAdminOrAlpha = requireRole("admin", "alphaAgent");
