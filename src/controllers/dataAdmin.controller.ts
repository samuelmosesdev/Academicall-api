/**
 * Data requests and backups (admin, "settings.manage").
 *
 *  - Data requests: every "download my data" (self-service, logged) and every
 *    deletion request a person sends staff. Admins can export any account.
 *  - Backups: the dashboard shows the last backup run. Runs are reported by
 *    the backup job (scripts/backup.sh → POST /admin/backups/report with
 *    BACKUP_REPORT_TOKEN), or started from the admin page when pg_dump and
 *    BACKUP_DIR are available on the API host.
 */
import { spawn } from "child_process";
import { statSync, mkdirSync } from "fs";
import path from "path";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { handle, HttpError, pageParams } from "../lib/http";
import { audit } from "../lib/audit";
import { exportUserData } from "../lib/dataExport";
import { notifyMany } from "../lib/notify";

/** GET /admin/data-requests?status=&kind= */
export const listRequests = handle(async (req, res) => {
  const where: any = {};
  if (["pending", "done", "rejected", "cancelled"].includes(String(req.query.status))) where.status = String(req.query.status);
  if (["export", "delete"].includes(String(req.query.kind))) where.kind = String(req.query.kind);
  const { take, skip, page, pageSize } = pageParams(req.query, { def: 30, max: 100 });
  const [items, total, pending] = await Promise.all([
    prisma.dataRequest.findMany({ where, orderBy: { createdAt: "desc" }, take, skip }),
    prisma.dataRequest.count({ where }),
    prisma.dataRequest.count({ where: { status: "pending" } }),
  ]);
  res.json({ items, total, page, pageSize, pending });
});

/** PATCH /admin/data-requests/:id { status, note } */
export const updateRequest = handle(async (req, res) => {
  const b = z.object({ status: z.enum(["done", "rejected", "cancelled"]), note: z.string().trim().max(500).optional().nullable() }).parse(req.body);
  const r = await prisma.dataRequest.update({
    where: { id: String(req.params.id) },
    data: { status: b.status, note: b.note ?? undefined, handledById: req.user!.id, handledByName: req.user!.name || req.user!.email, handledAt: new Date() },
  });
  if (r.userId) {
    await notifyMany([r.userId], {
      type: "system",
      title: r.kind === "delete" ? (b.status === "done" ? "Your deletion request is complete" : "About your deletion request") : "About your data request",
      body: b.note || (b.status === "done" ? "Staff have finished your request." : "Staff closed your request. Reply in Settings if you need more help."),
      createdById: req.user!.id,
    }).catch(() => {});
  }
  await audit(req.user, `data.request_${b.status}`, { id: r.userId, label: r.userName || r.userEmail }, { kind: r.kind, note: b.note || null });
  res.json({ request: r });
});

/** GET /admin/users/:id/export — download any account's data (logged). */
export const exportUser = handle(async (req, res) => {
  const id = String(req.params.id);
  const reason = String(req.query.reason || "").trim().slice(0, 300);
  if (reason.length < 4) throw new HttpError(400, "Say why you're exporting this account (it's recorded).");
  const data = await exportUserData(id);
  const u = data.account as any;
  await prisma.dataRequest.create({
    data: { userId: id, userEmail: u?.email, userName: u?.name, kind: "export", status: "done", source: "staff", note: reason, handledById: req.user!.id, handledByName: req.user!.name || req.user!.email, handledAt: new Date() },
  });
  await audit(req.user, "data.export", { id, label: u?.name || u?.email }, { source: "staff", reason });
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="academicall-${(u?.uniqueId || id).toString().toLowerCase()}-data.json"`);
  res.send(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 2));
});

// ── Backups ─────────────────────────────────────────────────────────────────
const view = (b: any) => ({ ...b, sizeBytes: b.sizeBytes != null ? Number(b.sizeBytes) : null });

/** GET /admin/backups */
export const listBackups = handle(async (_req, res) => {
  const rows = await prisma.backupRun.findMany({ orderBy: { startedAt: "desc" }, take: 30 });
  const lastOk = rows.find((r) => r.status === "ok") || (await prisma.backupRun.findFirst({ where: { status: "ok" }, orderBy: { startedAt: "desc" } }));
  const hoursSince = lastOk ? Math.round((Date.now() - (lastOk.finishedAt || lastOk.startedAt).getTime()) / 3600_000) : null;
  res.json({
    items: rows.map(view),
    lastOk: lastOk ? view(lastOk) : null,
    hoursSinceLastOk: hoursSince,
    health: hoursSince == null ? "none" : hoursSince <= 26 ? "ok" : hoursSince <= 72 ? "late" : "stale",
    canRunHere: !!process.env.BACKUP_DIR && !!process.env.DATABASE_URL,
    reportConfigured: !!process.env.BACKUP_REPORT_TOKEN,
  });
});

/** POST /admin/backups/report — called by the scheduled backup job. Auth: Bearer BACKUP_REPORT_TOKEN. */
export const reportBackup = handle(async (req, res) => {
  const token = process.env.BACKUP_REPORT_TOKEN;
  const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token || given !== token) throw new HttpError(401, "Bad backup token");
  const b = z.object({
    status: z.enum(["ok", "failed"]),
    sizeBytes: z.number().int().min(0).optional(),
    location: z.string().max(500).optional(),
    note: z.string().max(1000).optional(),
    startedAt: z.string().datetime().optional(),
  }).parse(req.body);
  const row = await prisma.backupRun.create({
    data: { status: b.status, kind: "scheduled", sizeBytes: b.sizeBytes != null ? BigInt(b.sizeBytes) : null, location: b.location || null, note: b.note || null, startedAt: b.startedAt ? new Date(b.startedAt) : new Date(), finishedAt: new Date() },
  });
  if (b.status === "failed") {
    const admins = await prisma.user.findMany({ where: { role: "admin", status: "active" }, select: { id: true } });
    await notifyMany(admins.map((a) => a.id), { type: "system", title: "Database backup failed", body: b.note || "The scheduled backup didn't finish. Check the backup job.", data: { link: "/admin/data" } });
  }
  res.status(201).json({ id: row.id });
});

let backupRunning = false;

/** POST /admin/backups/run — pg_dump to BACKUP_DIR on this host. */
export const runBackup = handle(async (req, res) => {
  const dir = process.env.BACKUP_DIR;
  const url = process.env.DATABASE_URL;
  if (!dir || !url) throw new HttpError(400, "Backups can't run from here. Set BACKUP_DIR on the API (and install pg_dump), or use the scheduled backup job.");
  if (backupRunning) throw new HttpError(409, "A backup is already running.");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `academicall-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`);
  const row = await prisma.backupRun.create({ data: { status: "running", kind: "manual", location: file, createdById: req.user!.id } });
  backupRunning = true;
  await audit(req.user, "backup.run", { id: row.id, label: path.basename(file) });
  const child = spawn("pg_dump", ["--format=custom", "--no-owner", "--file", file, url], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += String(d)).slice(-2000));
  child.on("error", async (e) => {
    backupRunning = false;
    await prisma.backupRun.update({ where: { id: row.id }, data: { status: "failed", note: `pg_dump not available: ${e.message}`.slice(0, 1000), finishedAt: new Date() } }).catch(() => {});
  });
  child.on("close", async (code) => {
    backupRunning = false;
    let size: bigint | null = null;
    try { size = BigInt(statSync(file).size); } catch { /* no file */ }
    await prisma.backupRun.update({
      where: { id: row.id },
      data: code === 0 ? { status: "ok", sizeBytes: size, finishedAt: new Date() } : { status: "failed", note: err.slice(-1000) || `pg_dump exited with ${code}`, finishedAt: new Date() },
    }).catch(() => {});
  });
  res.status(202).json({ run: view(row) });
});
