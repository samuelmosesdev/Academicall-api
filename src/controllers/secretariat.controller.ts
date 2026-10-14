/**
 * The Secretariat — a shared office account run by whoever holds the
 * "secretary" duty (and admins). It keeps the platform's paperwork:
 *
 *  - a numbered register of memos, minutes, letters, reports, circulars and
 *    notices (ACA/SEC/2026/0001…), each with attachments and a status
 *    (draft → filed → archived), optionally confidential;
 *  - the activity journal: what staff and users did, searchable;
 *  - an overview: what's waiting, who's on duty, this week's numbers.
 *
 * What each secretary can do is set by the admin (secretariat.* permissions).
 */
import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { audit } from "../lib/audit";
import { hasCap, isSecretary } from "../lib/access";

export const RECORD_KINDS = ["memo", "minutes", "letter", "report", "circular", "notice", "other"] as const;
export const RECORD_STATUSES = ["draft", "filed", "archived"] as const;

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0]?.message || "Invalid input" });
    console.error("[secretariat]", err);
    return res.status(500).json({ error: "Something went wrong in the Secretariat" });
  }
};

export function requireSecretariat(req: Request, res: Response, next: NextFunction) {
  if (!req.user || !isSecretary(req.user)) return res.status(403).json({ error: "The Secretariat is for secretaries and admins" });
  next();
}
const need = (req: Request, cap: string) => {
  if (!hasCap(req.user!, cap)) throw new HttpError(403, "Your Secretariat access doesn't include this. Ask an admin.");
};

const attachment = z.object({
  name: z.string().trim().min(1).max(160),
  url: z.string().url().refine((u) => u.startsWith("https://"), "Attachments must be https links"),
  mime: z.string().max(120).optional().nullable(),
  size: z.number().int().nonnegative().max(50 * 1024 * 1024).optional().nullable(),
});
const recordSchema = z.object({
  kind: z.enum(RECORD_KINDS).default("memo"),
  title: z.string().trim().min(3, "Give the record a title").max(160),
  summary: z.string().trim().max(400).optional().nullable(),
  body: z.string().max(60_000).default(""),
  status: z.enum(RECORD_STATUSES).default("draft"),
  confidential: z.boolean().default(false),
  tags: z.array(z.string().trim().min(1).max(32)).max(12).default([]),
  attachments: z.array(attachment).max(10).default([]),
  meetingDate: z.coerce.date().optional().nullable(),
});

async function nextRefNo() {
  const year = new Date().getFullYear();
  const prefix = `ACA/SEC/${year}/`;
  const last = await prisma.secretariatRecord.findFirst({ where: { refNo: { startsWith: prefix } }, orderBy: { refNo: "desc" }, select: { refNo: true } });
  const n = last ? Number(last.refNo.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(4, "0")}`;
}

const out = (r: any) => ({ ...r, createdBy: r.createdBy ? { id: r.createdBy.id, name: r.createdBy.name || r.createdBy.email } : null });
const authorSel = { createdBy: { select: { id: true, name: true, email: true } } } as const;

export const overview = handle(async (req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 86400_000);
  const seeConfidential = hasCap(req.user!, "secretariat.confidential");
  const recordWhere: Prisma.SecretariatRecordWhereInput = { deletedAt: null, ...(seeConfidential ? {} : { confidential: false }) };
  const [byKind, byStatus, recent, pendingRequests, pendingChanges, pendingMaterials, pendingClaims, newUsers, staff] = await Promise.all([
    prisma.secretariatRecord.groupBy({ by: ["kind"], where: recordWhere, _count: true }),
    prisma.secretariatRecord.groupBy({ by: ["status"], where: recordWhere, _count: true }),
    prisma.secretariatRecord.findMany({ where: recordWhere, orderBy: { updatedAt: "desc" }, take: 6, include: authorSel }),
    prisma.request.count({ where: { status: "pending" } }),
    prisma.profileChangeRequest.count({ where: { status: "pending" } }),
    prisma.document.count({ where: { status: "pending", deletedAt: null } }),
    prisma.paymentClaim.count({ where: { status: "pending" } }),
    prisma.user.count({ where: { createdAt: { gte: weekAgo }, status: { not: "deleted" } } }),
    prisma.user.findMany({
      where: { status: "active", OR: [{ role: { in: ["admin", "alphaAgent", "agent"] } }, { staffTags: { isEmpty: false } }] },
      select: { id: true, name: true, email: true, role: true, staffTags: true, lastActiveAt: true, photoUrl: true },
      orderBy: { lastActiveAt: { sort: "desc", nulls: "last" } },
      take: 12,
    }),
  ]);
  let activity = null;
  if (hasCap(req.user!, "secretariat.activity")) {
    const rows = await prisma.activityLog.findMany({ where: { createdAt: { gte: weekAgo } }, select: { action: true }, take: 5000 });
    const counts: Record<string, number> = {};
    for (const r of rows) { const k = r.action.split(".")[0]; counts[k] = (counts[k] || 0) + 1; }
    activity = { total: rows.length, byArea: counts };
  }
  res.json({
    records: {
      byKind: Object.fromEntries(byKind.map((x) => [x.kind, x._count])),
      byStatus: Object.fromEntries(byStatus.map((x) => [x.status, x._count])),
      recent: recent.map(out),
    },
    waiting: { requests: pendingRequests + pendingChanges, materials: pendingMaterials, payments: pendingClaims },
    week: { newUsers },
    staff,
    activity,
    can: {
      records: hasCap(req.user!, "secretariat.records"), confidential: seeConfidential,
      archive: hasCap(req.user!, "secretariat.archive"), activity: hasCap(req.user!, "secretariat.activity"),
    },
  });
});

export const listRecords = handle(async (req, res) => {
  need(req, "secretariat.records");
  const q = String(req.query.q || "").trim();
  const kind = String(req.query.kind || "");
  const status = String(req.query.status || "");
  const seeConfidential = hasCap(req.user!, "secretariat.confidential");
  const rows = await prisma.secretariatRecord.findMany({
    where: {
      deletedAt: null,
      ...(seeConfidential ? {} : { confidential: false }),
      ...(kind ? { kind } : {}),
      ...(status ? { status } : { status: { not: "archived" } }),
      ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { refNo: { contains: q, mode: "insensitive" } }, { summary: { contains: q, mode: "insensitive" } }, { tags: { has: q.toLowerCase() } }] } : {}),
    },
    include: authorSel,
    orderBy: { updatedAt: "desc" },
    take: Math.min(Math.max(Number(req.query.limit) || 100, 1), 300),
  });
  res.json({ records: rows.map(({ body, ...r }) => out({ ...r, words: (body.match(/\S+/g) || []).length })) });
});

async function findRecord(req: Request) {
  const r = await prisma.secretariatRecord.findUnique({ where: { id: String(req.params.id) }, include: authorSel });
  if (!r || r.deletedAt) throw new HttpError(404, "Record not found");
  if (r.confidential && !hasCap(req.user!, "secretariat.confidential")) throw new HttpError(404, "Record not found");
  return r;
}

export const getRecord = handle(async (req, res) => {
  need(req, "secretariat.records");
  res.json({ record: out(await findRecord(req)) });
});

export const createRecord = handle(async (req, res) => {
  need(req, "secretariat.records");
  const body = recordSchema.parse(req.body || {});
  if (body.confidential) need(req, "secretariat.confidential");
  if (body.status === "archived") need(req, "secretariat.archive");
  for (let i = 0; i < 4; i += 1) {
    try {
      const record = await prisma.secretariatRecord.create({
        data: { ...body, tags: body.tags.map((t) => t.toLowerCase()), attachments: body.attachments as any, refNo: await nextRefNo(), createdById: req.user!.id, updatedByName: req.user!.name || req.user!.email },
        include: authorSel,
      });
      await audit(req.user, "secretariat.record_create", { id: record.id, label: record.confidential ? `${record.refNo} (confidential)` : `${record.refNo} ${record.title}` }, { kind: record.kind });
      return res.status(201).json({ record: out(record) });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue; // ref number race
      throw err;
    }
  }
  throw new HttpError(409, "Couldn't number this record. Try again.");
});

export const updateRecord = handle(async (req, res) => {
  need(req, "secretariat.records");
  const r = await findRecord(req);
  const body = recordSchema.partial().parse(req.body || {});
  if (body.confidential !== undefined && body.confidential !== r.confidential) need(req, "secretariat.confidential");
  if (body.status === "archived" || (r.status === "archived" && body.status)) need(req, "secretariat.archive");
  const record = await prisma.secretariatRecord.update({
    where: { id: r.id },
    data: {
      ...body,
      ...(body.tags ? { tags: body.tags.map((t) => t.toLowerCase()) } : {}),
      ...(body.attachments ? { attachments: body.attachments as any } : {}),
      updatedByName: req.user!.name || req.user!.email,
    },
    include: authorSel,
  });
  await audit(req.user, body.status && body.status !== r.status ? `secretariat.record_${body.status}` : "secretariat.record_edit", { id: r.id, label: record.confidential ? `${r.refNo} (confidential)` : `${r.refNo} ${record.title}` });
  res.json({ record: out(record) });
});

export const deleteRecord = handle(async (req, res) => {
  need(req, "secretariat.archive");
  const r = await findRecord(req);
  await prisma.secretariatRecord.update({ where: { id: r.id }, data: { deletedAt: new Date(), updatedByName: req.user!.name || req.user!.email } });
  await audit(req.user, "secretariat.record_remove", { id: r.id, label: r.confidential ? `${r.refNo} (confidential)` : `${r.refNo} ${r.title}` });
  res.json({ ok: true });
});

/** The activity journal: everything the activity log holds, searchable. */
export const activityJournal = handle(async (req, res) => {
  need(req, "secretariat.activity");
  const q = String(req.query.q || "").trim();
  const area = String(req.query.area || "");
  const from = req.query.from ? new Date(String(req.query.from)) : undefined;
  const to = req.query.to ? new Date(String(req.query.to)) : undefined;
  const rows = await prisma.activityLog.findMany({
    where: {
      ...(area ? { action: { startsWith: `${area}.` } } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(q ? { OR: [{ userName: { contains: q, mode: "insensitive" } }, { action: { contains: q, mode: "insensitive" } }, { reference: { contains: q } }] } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Number(req.query.limit) || 150, 500),
  });
  res.json({
    entries: rows.map((a) => ({
      id: a.id, at: a.createdAt, actor: a.userName || "System", actorId: a.userId, action: a.action, status: a.status,
      target: (a.meta as any)?.targetName || null, meta: a.meta,
    })),
  });
});
