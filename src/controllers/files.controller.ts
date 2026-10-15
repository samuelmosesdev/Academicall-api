/**
 * Document Center — every upload on the platform in one place, so staff can
 * find, restore and tidy what students and reps have put up.
 *
 *  - Materials (course documents): active, pending, rejected and deleted.
 *  - Study-group files: images, videos and documents shared in groups,
 *    including ones that were deleted (kept in `archive`).
 *  - Vault (admins only): who uses it, how much, what's in the trash.
 *    File names are visible; opening a file needs a written reason, is
 *    logged, and the student is told. Deleted vault files can be restored
 *    for 30 days.
 */
import { Request, Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { audit } from "../lib/audit";
import { hasCap } from "../lib/access";
import { decrypt, purgeVaultTrash, VAULT_TRASH_DAYS } from "./vault.controller";

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0]?.message || "Invalid input" });
    const e = err as { status?: number; message?: string };
    if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message });
    console.error("[files]", err);
    return res.status(500).json({ error: "Something went wrong in the Document Center" });
  }
};
const take = (req: Request, max = 200) => Math.min(Math.max(Number(req.query.limit) || 60, 1), max);
const userBrief = { id: true, name: true, email: true, uniqueId: true, role: true, photoUrl: true } as const;

async function namesFor(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter(Boolean) as string[])];
  if (!unique.length) return new Map<string, string>();
  const rows = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, email: true } });
  return new Map(rows.map((r) => [r.id, r.name || r.email]));
}

// ── overview ─────────────────────────────────────────────────────────────────
export const summary = handle(async (req, res) => {
  const [active, pending, deletedDocs, groupFiles, groupDeleted] = await Promise.all([
    prisma.document.count({ where: { deletedAt: null } }),
    prisma.document.count({ where: { deletedAt: null, status: "pending" } }),
    prisma.document.count({ where: { deletedAt: { not: null } } }),
    prisma.studyGroupMessage.count({ where: { deletedAt: null, attachmentName: { not: null } } }),
    prisma.studyGroupMessage.count({ where: { deletedAt: { not: null }, attachmentName: { not: null } } }),
  ]);
  let vault = null;
  if (hasCap(req.user!, "vault.recover")) {
    const [acc, live, trash] = await Promise.all([
      prisma.vaultAccount.count(),
      prisma.vaultFile.aggregate({ where: { deletedAt: null }, _count: true, _sum: { size: true } }),
      prisma.vaultFile.count({ where: { deletedAt: { not: null } } }),
    ]);
    vault = { users: acc, files: live._count, bytes: live._sum.size || 0, trash, trashDays: VAULT_TRASH_DAYS };
  }
  res.json({ materials: { active, pending, deleted: deletedDocs }, groupFiles: { active: groupFiles, deleted: groupDeleted }, vault });
});

// ── materials ────────────────────────────────────────────────────────────────
export const listMaterials = handle(async (req, res) => {
  const q = String(req.query.q || "").trim();
  const state = String(req.query.state || "active");
  const status = String(req.query.status || "");
  const where: Prisma.DocumentWhereInput = {
    deletedAt: state === "deleted" ? { not: null } : null,
    ...(status && state !== "deleted" ? { status } : {}),
    ...(req.query.userId ? { uploadedById: String(req.query.userId) } : {}),
    ...(q
      ? { OR: [
          { title: { contains: q, mode: "insensitive" } },
          { fileName: { contains: q, mode: "insensitive" } },
          { department: { contains: q, mode: "insensitive" } },
          { course: { code: { contains: q, mode: "insensitive" } } },
          { uploadedBy: { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { uniqueId: { contains: q, mode: "insensitive" } }] } },
        ] }
      : {}),
  };
  const rows = await prisma.document.findMany({
    where,
    include: { uploadedBy: { select: userBrief }, course: { select: { id: true, code: true, title: true } } },
    orderBy: state === "deleted" ? { deletedAt: "desc" } : { createdAt: "desc" },
    take: take(req),
  });
  const names = await namesFor(rows.map((r) => r.deletedById));
  res.json({
    materials: rows.map((d) => ({
      id: d.id, title: d.title, fileName: d.fileName, fileUrl: d.fileUrl, thumbnailUrl: d.thumbnailUrl, fileSize: d.fileSize,
      status: d.status, source: d.source, department: d.department, level: d.level, course: d.course, uploadedBy: d.uploadedBy,
      openCount: d.openCount, createdAt: d.createdAt, deletedAt: d.deletedAt, deletedBy: d.deletedById ? names.get(d.deletedById) || "Unknown" : null,
    })),
  });
});

export const restoreMaterial = handle(async (req, res) => {
  const doc = await prisma.document.findUnique({ where: { id: String(req.params.id) } });
  if (!doc) throw new HttpError(404, "Material not found");
  if (!doc.deletedAt) throw new HttpError(400, "That material isn't deleted");
  const restored = await prisma.document.update({ where: { id: doc.id }, data: { deletedAt: null, deletedById: null } });
  await audit(req.user, "material.restore", { id: doc.id, label: doc.title }, { uploadedById: doc.uploadedById });
  res.json({ material: restored });
});

export const setMaterialStatus = handle(async (req, res) => {
  const { status } = z.object({ status: z.enum(["pending", "approved", "rejected"]) }).parse(req.body || {});
  const doc = await prisma.document.findUnique({ where: { id: String(req.params.id) } });
  if (!doc || doc.deletedAt) throw new HttpError(404, "Material not found");
  const updated = await prisma.document.update({ where: { id: doc.id }, data: { status, approvedById: req.user!.id, approvedAt: new Date() } });
  await audit(req.user, `material.${status}`, { id: doc.id, label: doc.title });
  res.json({ material: updated });
});

export const removeMaterial = handle(async (req, res) => {
  const doc = await prisma.document.findUnique({ where: { id: String(req.params.id) } });
  if (!doc) throw new HttpError(404, "Material not found");
  if (doc.deletedAt) {
    // Second delete = permanent. Admins only.
    if (req.user!.role !== "admin") throw new HttpError(403, "Only admins can delete permanently");
    await prisma.document.delete({ where: { id: doc.id } });
    await audit(req.user, "material.purge", { id: doc.id, label: doc.title });
    return res.json({ ok: true, purged: true });
  }
  await prisma.document.update({ where: { id: doc.id }, data: { deletedAt: new Date(), deletedById: req.user!.id } });
  await audit(req.user, "material.delete", { id: doc.id, label: doc.title });
  res.json({ ok: true, purged: false });
});

// ── study-group files ────────────────────────────────────────────────────────
export const listGroupFiles = handle(async (req, res) => {
  const q = String(req.query.q || "").trim();
  const state = String(req.query.state || "active");
  const kind = String(req.query.kind || "");
  const rows = await prisma.studyGroupMessage.findMany({
    where: {
      attachmentName: { not: null },
      deletedAt: state === "deleted" ? { not: null } : null,
      ...(kind ? { type: kind } : {}),
      ...(req.query.userId ? { senderId: String(req.query.userId) } : {}),
      ...(q
        ? { OR: [
            { attachmentName: { contains: q, mode: "insensitive" } },
            { group: { name: { contains: q, mode: "insensitive" } } },
            { sender: { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] } },
          ] }
        : {}),
    },
    include: { group: { select: { id: true, name: true, code: true } }, sender: { select: userBrief } },
    orderBy: { createdAt: "desc" },
    take: take(req),
  });
  const names = await namesFor(rows.map((r) => r.deletedById));
  res.json({
    files: rows.map((m) => {
      const arc = (m.archive as any) || {};
      return {
        id: m.id, type: m.type, name: m.attachmentName, mime: m.attachmentMime, size: m.attachmentBytes,
        url: m.attachmentUrl || arc.attachmentUrl || null, thumbnailUrl: m.thumbnailUrl || arc.thumbnailUrl || null,
        group: m.group, sender: m.sender, createdAt: m.createdAt, deletedAt: m.deletedAt,
        deletedBy: m.deletedById ? names.get(m.deletedById) || "Unknown" : null,
        restorable: !!m.deletedAt && !!arc.attachmentUrl,
      };
    }),
  });
});

export const restoreGroupFile = handle(async (req, res) => {
  const m = await prisma.studyGroupMessage.findUnique({ where: { id: String(req.params.id) }, include: { group: { select: { name: true } } } });
  if (!m) throw new HttpError(404, "File not found");
  const arc = (m.archive as any) || null;
  if (!m.deletedAt || !arc?.attachmentUrl) throw new HttpError(400, "This file can't be restored");
  await prisma.studyGroupMessage.update({
    where: { id: m.id },
    data: { deletedAt: null, deletedById: null, text: arc.text ?? null, attachmentUrl: arc.attachmentUrl, thumbnailUrl: arc.thumbnailUrl ?? null, archive: Prisma.JsonNull },
  });
  await audit(req.user, "group_file.restore", { id: m.id, label: m.attachmentName }, { group: m.group?.name, senderId: m.senderId });
  res.json({ ok: true });
});

// ── vault (admins) ───────────────────────────────────────────────────────────
export const vaultUsers = handle(async (req, res) => {
  purgeVaultTrash().catch(() => {});
  const q = String(req.query.q || "").trim();
  const accounts = await prisma.vaultAccount.findMany({
    where: q ? { user: { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { uniqueId: { contains: q, mode: "insensitive" } }] } } : {},
    include: { user: { select: userBrief } },
    orderBy: { updatedAt: "desc" },
    take: take(req, 300),
  });
  const ids = accounts.map((a) => a.userId);
  const [live, trash] = await Promise.all([
    prisma.vaultFile.groupBy({ by: ["userId"], where: { userId: { in: ids }, deletedAt: null }, _count: true, _sum: { size: true }, _max: { createdAt: true } }),
    prisma.vaultFile.groupBy({ by: ["userId"], where: { userId: { in: ids }, deletedAt: { not: null } }, _count: true }),
  ]);
  const now = new Date();
  res.json({
    users: accounts.map((a) => {
      const l = live.find((x) => x.userId === a.userId);
      return {
        user: a.user, files: l?._count || 0, bytes: l?._sum.size || 0, lastUpload: l?._max.createdAt || null,
        trash: trash.find((x) => x.userId === a.userId)?._count || 0,
        locked: !!(a.lockedUntil && a.lockedUntil > now), lockedUntil: a.lockedUntil && a.lockedUntil > now ? a.lockedUntil : null,
        failedAttempts: a.failedAttempts, pinSetAt: a.pinSetAt,
      };
    }),
    trashDays: VAULT_TRASH_DAYS,
  });
});

export const vaultUserFiles = handle(async (req, res) => {
  const userId = String(req.params.userId);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: userBrief });
  if (!user) throw new HttpError(404, "User not found");
  const [folders, files] = await Promise.all([
    prisma.vaultFolder.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
    prisma.vaultFile.findMany({
      where: { userId },
      select: { id: true, folderId: true, name: true, kind: true, mimeType: true, size: true, createdAt: true, deletedAt: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  await audit(req.user, "vault.browse", { id: userId, label: user.name || user.email }, { files: files.length });
  res.json({
    user,
    trashDays: VAULT_TRASH_DAYS,
    folders: folders.map((f) => ({ id: f.id, name: f.deletedAt ? f.originalName || f.name : f.name, color: f.color, deletedAt: f.deletedAt })),
    files,
  });
});

export const restoreVaultFile = handle(async (req, res) => {
  const file = await prisma.vaultFile.findUnique({ where: { id: String(req.params.id) }, include: { folder: true } });
  if (!file) throw new HttpError(404, "File not found");
  if (!file.deletedAt) throw new HttpError(400, "That file isn't deleted");
  if (file.folder.deletedAt) {
    // Bring the folder back too, under its old name if it's free.
    const base = file.folder.originalName || file.folder.name;
    const clash = await prisma.vaultFolder.findFirst({ where: { userId: file.userId, deletedAt: null, name: { equals: base, mode: "insensitive" } } });
    await prisma.vaultFolder.update({ where: { id: file.folderId }, data: { deletedAt: null, name: clash ? `${base} (restored)`.slice(0, 48) : base, originalName: null } });
  }
  await prisma.vaultFile.update({ where: { id: file.id }, data: { deletedAt: null, deletedById: null } });
  await prisma.notification.create({
    data: { userId: file.userId, createdById: req.user!.id, type: "system", title: "A file was restored to your vault", body: `“${file.name}” is back in your Academicall Vault.`, data: { link: "/dashboard/vault" } },
  }).catch(() => {});
  await audit(req.user, "vault.restore", { id: file.userId, label: file.name }, { fileId: file.id });
  res.json({ ok: true });
});

export const openVaultFile = handle(async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(8, "Write down why you need to open this file (at least 8 characters)").max(300) }).parse(req.body || {});
  const file = await prisma.vaultFile.findUnique({ where: { id: String(req.params.id) } });
  if (!file) throw new HttpError(404, "File not found");
  const plain = decrypt(file, `${file.userId}:${file.id}`);
  // Internal accountability only: the opening is written to the audit trail (who, when, which file, why).
  // The student is not notified; admin access is governed by the vault.recover capability and this log.
  await audit(req.user, "vault.open", { id: file.userId, label: file.name }, { fileId: file.id, reason, ip: req.ip });
  res.setHeader("Content-Type", file.mimeType);
  res.setHeader("Content-Length", String(plain.length));
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  res.end(plain);
});

export const unlockVault = handle(async (req, res) => {
  const acct = await prisma.vaultAccount.findUnique({ where: { userId: String(req.params.userId) } });
  if (!acct) throw new HttpError(404, "This student hasn't set up a vault");
  await prisma.vaultAccount.update({ where: { userId: acct.userId }, data: { failedAttempts: 0, lockedUntil: null } });
  await audit(req.user, "vault.unlock", { id: acct.userId });
  res.json({ ok: true });
});
