import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";

const activitySchema = z.object({
  action: z.string().min(1),
  status: z.string().optional(),
  reference: z.string().nullable().optional(),
  meta: z.any().optional(),
});

function isReversible(action: string) {
  return [
    "role.change",
    "user.suspend",
    "user.reactivate",
    "user.force_password_change",
  ].includes(action);
}

export async function listActivity(req: Request, res: Response) {
  try {
    const userId = req.query.userId ? String(req.query.userId) : undefined;
    const agentId = req.query.agentId ? String(req.query.agentId) : undefined;
    const action = req.query.action ? String(req.query.action) : undefined;
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;
    const limit = Math.min(Number(req.query.limit) || 100, 300);

    const where: any = {};
    if (userId) {
      where.OR = [
        { userId },
        { meta: { path: ["targetUid"], equals: userId } },
      ];
    }
    if (agentId) {
      where.meta = { path: ["targetUid"], equals: agentId };
    }
    if (action) where.action = { contains: action, mode: "insensitive" };
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to) where.createdAt.lte = to;
    }

    const activities = await prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return res.json({
      activities: activities.map((a) => ({
        id: a.id,
        action: a.action,
        actorUid: a.userId,
        actorName: a.userName,
        targetUid: (a.meta as any)?.targetUid ?? null,
        targetName: (a.meta as any)?.targetName ?? null,
        meta: a.meta,
        createdAt: a.createdAt,
        status: a.status,
        reference: a.reference,
        reversed: Boolean((a.meta as any)?.reversed),
        reversible: isReversible(a.action) && !(a.meta as any)?.reversed,
      })),
      total: activities.length,
    });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Failed to list activity" });
  }
}

export async function revertActivity(req: Request, res: Response) {
  try {
    if (!req.user || !["admin", "alphaAgent"].includes(req.user.role)) {
      return res.status(403).json({ error: "Admin only" });
    }

    const id = String(req.params.id);
    const log = await prisma.activityLog.findUnique({ where: { id } });
    if (!log) return res.status(404).json({ error: "Not found" });

    const meta = (log.meta as any) || {};
    if (meta.reversed) {
      return res.status(400).json({ error: "Already reversed" });
    }
    if (!isReversible(log.action)) {
      return res.status(400).json({ error: "This action cannot be auto-reverted" });
    }

    const targetUid = meta.targetUid;
    if (!targetUid) {
      return res.status(400).json({ error: "No target user on this log" });
    }

    if (log.action === "role.change") {
      const prev = meta.from || "user";
      await prisma.user.update({
        where: { id: targetUid },
        data: {
          role: prev,
          ...(prev === "user" ? { courseRepMeta: Prisma.JsonNull } : {}),
        },
      });
    } else if (log.action === "user.suspend") {
      await prisma.user.update({ where: { id: targetUid }, data: { status: "active" } });
    } else if (log.action === "user.reactivate") {
      await prisma.user.update({ where: { id: targetUid }, data: { status: "suspended" } });
    } else if (log.action === "user.force_password_change") {
      await prisma.user.update({ where: { id: targetUid }, data: { mustChangePassword: false } });
    }

    await prisma.activityLog.update({
      where: { id },
      data: {
        meta: {
          ...meta,
          reversed: true,
          reversedAt: new Date().toISOString(),
          reversedBy: req.user.id,
        },
      },
    });

    await prisma.activityLog.create({
      data: {
        userId: req.user.id,
        userName: req.user.email,
        action: "activity.revert",
        status: "success",
        reference: id,
        meta: {
          targetUid,
          targetName: meta.targetName,
          originalAction: log.action,
        },
      },
    });

    return res.json({ ok: true });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Revert failed" });
  }
}

export async function createActivity(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const body = activitySchema.parse(req.body);
    const activity = await prisma.activityLog.create({
      data: { ...body, userId: req.user.id, userName: req.user.email },
    });
    res.status(201).json({ activity });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    res.status(500).json({ error: "Activity log failed" });
  }
}