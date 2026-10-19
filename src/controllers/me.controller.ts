/**
 * The signed-in person's own controls: push devices and notification
 * preferences, privacy, blocked people, CGPA results, UTME goals and a copy of
 * their data.
 */
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { handle, HttpError } from "../lib/http";
import { PUSH_TYPES, pushConfigured } from "../lib/push";
import { exportUserData } from "../lib/dataExport";
import { audit } from "../lib/audit";

const me = (req: any) => req.user!.id as string;

// ── Push devices ────────────────────────────────────────────────────────────

/** POST /me/devices { token, platform, appVersion } */
export const registerDevice = handle(async (req, res) => {
  const b = z.object({ token: z.string().min(20).max(4096), platform: z.enum(["android", "ios", "web"]), appVersion: z.string().max(40).optional() }).parse(req.body);
  await prisma.deviceToken.upsert({
    where: { token: b.token },
    create: { token: b.token, platform: b.platform, appVersion: b.appVersion || null, userId: me(req) },
    update: { userId: me(req), platform: b.platform, appVersion: b.appVersion || null, lastSeenAt: new Date() },
  });
  // Keep the legacy single-token fields in step for older code paths.
  await prisma.user.update({ where: { id: me(req) }, data: { fcmToken: b.token, deviceToken: b.token } });
  res.json({ ok: true, pushReady: pushConfigured() });
});

/** DELETE /me/devices { token } — on sign-out, so the next person on this phone doesn't get your alerts. */
export const removeDevice = handle(async (req, res) => {
  const token = String(req.body?.token || req.query.token || "");
  if (token) await prisma.deviceToken.deleteMany({ where: { token, userId: me(req) } });
  res.json({ ok: true });
});

// ── Notification preferences ────────────────────────────────────────────────
const prefsSchema = z.object({
  push: z.boolean().default(true),
  types: z.record(z.boolean()).default({}),
  quietStart: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
  quietEnd: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
});

/** GET /me/notification-prefs */
export const getPrefs = handle(async (req, res) => {
  const u = await prisma.user.findUnique({ where: { id: me(req) }, select: { notificationPrefs: true } });
  const devices = await prisma.deviceToken.count({ where: { userId: me(req) } });
  res.json({
    prefs: { push: true, types: {}, quietStart: null, quietEnd: null, ...((u?.notificationPrefs as any) || {}) },
    groups: PUSH_TYPES.map((g) => ({ key: g.key, label: g.label })),
    devices,
    pushReady: pushConfigured(),
  });
});

/** PUT /me/notification-prefs */
export const savePrefs = handle(async (req, res) => {
  const prefs = prefsSchema.parse(req.body);
  const keys = new Set(PUSH_TYPES.map((g) => g.key as string));
  prefs.types = Object.fromEntries(Object.entries(prefs.types).filter(([k]) => keys.has(k)));
  await prisma.user.update({ where: { id: me(req) }, data: { notificationPrefs: prefs } });
  res.json({ prefs });
});

// ── Privacy ─────────────────────────────────────────────────────────────────
const privacySchema = z.object({
  profileVisibility: z.enum(["everyone", "classmates", "nobody"]).default("everyone"),
  showCourses: z.boolean().default(true),
  showDepartment: z.boolean().optional(),
  showPhone: z.boolean().optional(),
});

/** GET /me/privacy */
export const getPrivacy = handle(async (req, res) => {
  const u = await prisma.user.findUnique({ where: { id: me(req) }, select: { privacy: true, showDepartment: true, showPhone: true } });
  res.json({ privacy: { profileVisibility: "everyone", showCourses: true, ...((u?.privacy as any) || {}), showDepartment: u?.showDepartment ?? true, showPhone: u?.showPhone ?? false } });
});

/** PUT /me/privacy */
export const savePrivacy = handle(async (req, res) => {
  const p = privacySchema.parse(req.body);
  const { showDepartment, showPhone, ...rest } = p;
  await prisma.user.update({
    where: { id: me(req) },
    data: { privacy: rest, ...(showDepartment !== undefined ? { showDepartment } : {}), ...(showPhone !== undefined ? { showPhone } : {}) },
  });
  res.json({ privacy: p });
});

// ── Blocked people ──────────────────────────────────────────────────────────

/** GET /me/blocks */
export const listBlocks = handle(async (req, res) => {
  const rows = await prisma.userBlock.findMany({
    where: { blockerId: me(req) },
    include: { blocked: { select: { id: true, name: true, nickname: true, photoUrl: true, uniqueId: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json({ ids: rows.map((r) => r.blockedId), items: rows.map((r) => ({ ...r.blocked, blockedAt: r.createdAt })) });
});

/** POST /me/blocks/:userId */
export const block = handle(async (req, res) => {
  const id = String(req.params.userId);
  if (id === me(req)) throw new HttpError(400, "You can't block yourself.");
  const t = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
  if (!t) throw new HttpError(404, "Person not found");
  if (["admin", "alphaAgent", "agent"].includes(t.role)) throw new HttpError(400, "Staff accounts can't be blocked. Report the message instead.");
  await prisma.userBlock.upsert({ where: { blockerId_blockedId: { blockerId: me(req), blockedId: id } }, create: { blockerId: me(req), blockedId: id }, update: {} });
  res.json({ ok: true });
});

/** DELETE /me/blocks/:userId */
export const unblock = handle(async (req, res) => {
  await prisma.userBlock.deleteMany({ where: { blockerId: me(req), blockedId: String(req.params.userId) } });
  res.json({ ok: true });
});

// ── CGPA / results ──────────────────────────────────────────────────────────
const GRADES = ["A", "B", "C", "D", "E", "F"] as const;
const resultRow = z.object({
  id: z.string().uuid().optional(),
  courseCode: z.string().trim().min(2).max(20).transform((s) => s.toUpperCase().replace(/\s+/g, " ")),
  courseTitle: z.string().trim().max(160).optional().nullable(),
  units: z.number().int().min(0).max(30),
  grade: z.enum(GRADES),
});
const semesterBody = z.object({
  session: z.string().trim().regex(/^\d{4}\/\d{4}$/, "Session looks like 2025/2026"),
  semester: z.enum(["first", "second", "third"]),
  rows: z.array(resultRow).max(40),
});

/** GET /me/results — every semester, plus the grading scale they picked. */
export const listResults = handle(async (req, res) => {
  const [rows, u] = await Promise.all([
    prisma.academicResult.findMany({ where: { userId: me(req) }, orderBy: [{ session: "asc" }, { semester: "asc" }, { courseCode: "asc" }] }),
    prisma.user.findUnique({ where: { id: me(req) }, select: { settings: true } }),
  ]);
  const s = (u?.settings as any) || {};
  res.json({ items: rows, scale: s.gradeScale === 4 ? 4 : 5, target: typeof s.cgpaTarget === "number" ? s.cgpaTarget : null, plannedUnits: s.cgpaPlannedUnits ?? null });
});

/** PUT /me/results/semester — replace one semester's courses. */
export const saveSemester = handle(async (req, res) => {
  const b = semesterBody.parse(req.body);
  const seen = new Set<string>();
  for (const r of b.rows) {
    if (seen.has(r.courseCode)) throw new HttpError(400, `${r.courseCode} is listed twice in this semester.`);
    seen.add(r.courseCode);
  }
  await prisma.$transaction([
    prisma.academicResult.deleteMany({ where: { userId: me(req), session: b.session, semester: b.semester } }),
    prisma.academicResult.createMany({
      data: b.rows.map((r) => ({ userId: me(req), session: b.session, semester: b.semester, courseCode: r.courseCode, courseTitle: r.courseTitle || null, units: r.units, grade: r.grade })),
    }),
  ]);
  const items = await prisma.academicResult.findMany({ where: { userId: me(req), session: b.session, semester: b.semester }, orderBy: { courseCode: "asc" } });
  res.json({ items });
});

/** DELETE /me/results/semester?session=&semester= */
export const deleteSemester = handle(async (req, res) => {
  const session = String(req.query.session || ""), semester = String(req.query.semester || "");
  await prisma.academicResult.deleteMany({ where: { userId: me(req), session, semester } });
  res.json({ ok: true });
});

/** PUT /me/results/settings { scale, target, plannedUnits } */
export const saveResultSettings = handle(async (req, res) => {
  const b = z.object({ scale: z.union([z.literal(4), z.literal(5)]), target: z.number().min(0).max(5).nullable().optional(), plannedUnits: z.number().int().min(0).max(400).nullable().optional() }).parse(req.body);
  const u = await prisma.user.findUnique({ where: { id: me(req) }, select: { settings: true } });
  const settings = { ...((u?.settings as any) || {}), gradeScale: b.scale, cgpaTarget: b.target ?? null, cgpaPlannedUnits: b.plannedUnits ?? null };
  await prisma.user.update({ where: { id: me(req) }, data: { settings } });
  res.json({ scale: b.scale, target: b.target ?? null, plannedUnits: b.plannedUnits ?? null });
});

// ── Data ────────────────────────────────────────────────────────────────────

/** GET /me/data-export — a JSON copy of what Academicall holds about you. */
export const downloadMyData = handle(async (req, res) => {
  const recent = await prisma.dataRequest.count({ where: { userId: me(req), kind: "export", createdAt: { gt: new Date(Date.now() - 10 * 60_000) } } });
  if (recent >= 3) throw new HttpError(429, "You just downloaded your data. Try again in a few minutes.");
  const data = await exportUserData(me(req));
  const u = data.account as any;
  await prisma.dataRequest.create({ data: { userId: me(req), userEmail: u?.email, userName: u?.name, kind: "export", status: "done", source: "self", handledAt: new Date() } });
  await audit(req.user, "data.export", { id: me(req), label: u?.name || u?.email }, { source: "self" });
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="academicall-my-data-${new Date().toISOString().slice(0, 10)}.json"`);
  res.send(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 2));
});

/** GET /me/data-requests */
export const myDataRequests = handle(async (req, res) => {
  const items = await prisma.dataRequest.findMany({ where: { userId: me(req) }, orderBy: { createdAt: "desc" }, take: 20 });
  res.json({ items });
});

/** POST /me/data-requests { kind: "delete", note } — ask staff to erase the account (for people who can't do it themselves). */
export const createDataRequest = handle(async (req, res) => {
  const b = z.object({ kind: z.enum(["delete"]), note: z.string().trim().max(1000).optional() }).parse(req.body);
  const open = await prisma.dataRequest.findFirst({ where: { userId: me(req), kind: b.kind, status: "pending" } });
  if (open) throw new HttpError(409, "You already have a request waiting. Staff will get back to you.");
  const u = await prisma.user.findUnique({ where: { id: me(req) }, select: { email: true, name: true } });
  const row = await prisma.dataRequest.create({ data: { userId: me(req), userEmail: u?.email, userName: u?.name, kind: b.kind, note: b.note || null } });
  res.status(201).json({ request: row });
});

// ── UTME goals ──────────────────────────────────────────────────────────────

/** PUT /utme/goals { examDate, dailyTarget } */
export const saveUtmeGoals = handle(async (req, res) => {
  const b = z.object({
    examDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    dailyTarget: z.number().int().min(0).max(1000).nullable().optional(),
  }).parse(req.body);
  await prisma.user.update({ where: { id: me(req) }, data: { utmeExamDate: b.examDate ?? null, utmeDailyTarget: b.dailyTarget ?? null } });
  res.json({ examDate: b.examDate ?? null, dailyTarget: b.dailyTarget ?? null });
});
