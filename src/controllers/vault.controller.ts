/**
 * Academicall Vault — a PIN-locked private drawer for sensitive academic
 * documents (certificates, transcripts, admission letters, IDs, receipts).
 *
 *  - First visit: create a 6-digit PIN (bcrypt-hashed).
 *  - Each visit: POST /vault/unlock with the PIN → short-lived vault token
 *    (15 min, sent as `X-Vault-Token`). Changing/resetting the PIN revokes
 *    every outstanding vault token.
 *  - 5 wrong PINs lock the vault (15 min, doubling, max 24 h).
 *  - Forgot PIN: 6-digit code to the account email, then set a new PIN.
 *  - Folders hold images (JPG/PNG/WEBP) and PDFs only, ≤ 5 MB each,
 *    100 MB per student. Bytes are AES-256-GCM encrypted before they touch
 *    the database and are only served back to the owner with a vault token.
 */
import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from "crypto";
import { prisma } from "../lib/prisma";
import { sendEmail } from "../lib/email";

const MB = 1024 * 1024;
export const VAULT_LIMITS = {
  maxFileBytes: Number(process.env.VAULT_MAX_FILE_MB || 5) * MB,
  quotaBytes: Number(process.env.VAULT_QUOTA_MB || 100) * MB,
  maxFolders: 30,
  maxFiles: 500,
  maxAttempts: 5,
  tokenTtlSec: 15 * 60,
  otpTtlMs: 10 * 60 * 1000,
  otpCooldownMs: 60 * 1000,
  otpMaxAttempts: 5,
};
const FOLDER_COLORS = ["violet", "aqua", "lemon", "sand", "midnight", "rose"];

class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}
function fail(res: Response, err: unknown) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
  if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0]?.message || "Invalid input" });
  console.error("[vault]", err);
  const e = err as { status?: number; message?: string };
  return res.status(e.status || 500).json({ error: e.status ? e.message : "Something went wrong in the vault" });
}
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try { await fn(req, res); } catch (err) { fail(res, err); }
};

// ── crypto ────────────────────────────────────────────────────────────────────
let cachedKey: Buffer | null = null;
function vaultKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.VAULT_ENCRYPTION_KEY;
  if (raw) {
    const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (buf.length !== 32) throw new HttpError(503, "Vault encryption key must be 32 bytes (64 hex chars)");
    cachedKey = buf;
    return buf;
  }
  if (process.env.NODE_ENV === "production") {
    throw new HttpError(503, "The vault isn't configured yet. Set VAULT_ENCRYPTION_KEY on the API.", "vault_unconfigured");
  }
  cachedKey = createHash("sha256").update(`dev-vault:${process.env.JWT_SECRET || "dev-secret"}`).digest();
  return cachedKey;
}
export function encrypt(plain: Buffer, aad: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", vaultKey(), iv);
  c.setAAD(Buffer.from(aad));
  const data = Buffer.concat([c.update(plain), c.final()]);
  return { iv, data, authTag: c.getAuthTag() };
}
export function decrypt(f: { iv: Uint8Array; data: Uint8Array; authTag: Uint8Array }, aad: string) {
  const d = createDecipheriv("aes-256-gcm", vaultKey(), Buffer.from(f.iv));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(f.authTag));
  return Buffer.concat([d.update(Buffer.from(f.data)), d.final()]);
}

// ── file sniffing ─────────────────────────────────────────────────────────────
export function sniff(buf: Buffer): { kind: "image" | "pdf"; mime: string; ext: string } | null {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return { kind: "pdf", mime: "application/pdf", ext: "pdf" };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  if (buf.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return { kind: "image", mime: "image/png", ext: "png" };
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP")
    return { kind: "image", mime: "image/webp", ext: "webp" };
  return null;
}
function cleanName(name: string, ext: string) {
  let n = decodeURIComponent(name || "").replace(/[\\/\u0000-\u001f<>:"|?*]+/g, " ").replace(/\s+/g, " ").trim();
  if (!n) n = `Document ${new Date().toISOString().slice(0, 10)}`;
  n = n.slice(0, 120);
  if (!new RegExp(`\\.${ext}$`, "i").test(n) && !(ext === "jpg" && /\.jpe?g$/i.test(n))) n = `${n.replace(/\.[a-z0-9]{2,5}$/i, "")}.${ext}`;
  return n;
}

// ── PIN rules ─────────────────────────────────────────────────────────────────
const pinSchema = z.string().regex(/^\d{6}$/, "Your PIN must be exactly 6 digits");
function assertStrongPin(pin: string) {
  pinSchema.parse(pin);
  const weak = new Set(["000000", "111111", "222222", "333333", "444444", "555555", "666666", "777777", "888888", "999999", "123456", "654321", "123123", "121212", "112233", "012345", "543210"]);
  if (weak.has(pin)) throw new HttpError(400, "That PIN is too easy to guess. Pick 6 digits that aren't a pattern.");
}
const tokenSecret = () => `${process.env.JWT_SECRET || "dev-secret"}:vault`;
function issueToken(userId: string, pinSetAt: Date) {
  const token = jwt.sign({ sub: userId, typ: "vault", pv: pinSetAt.getTime() }, tokenSecret(), { expiresIn: VAULT_LIMITS.tokenTtlSec });
  return { vaultToken: token, expiresIn: VAULT_LIMITS.tokenTtlSec };
}
function lockMs(failed: number) {
  const tier = Math.floor(failed / VAULT_LIMITS.maxAttempts); // 1, 2, 3…
  return Math.min(24 * 60, 15 * 2 ** Math.max(0, tier - 1)) * 60 * 1000;
}
const otp = () => String(randomInt(100000, 1000000));

/** Requires an unlocked vault (X-Vault-Token issued for this user and current PIN). */
export async function requireVault(req: Request, res: Response, next: NextFunction) {
  try {
    const raw = String(req.headers["x-vault-token"] || "");
    if (!raw) throw new HttpError(401, "Unlock your vault first", "vault_locked");
    let payload: { sub: string; typ: string; pv: number };
    try { payload = jwt.verify(raw, tokenSecret()) as any; } catch { throw new HttpError(401, "Your vault locked itself. Enter your PIN again.", "vault_locked"); }
    if (payload.typ !== "vault" || payload.sub !== req.user?.id) throw new HttpError(401, "Unlock your vault first", "vault_locked");
    const acct = await prisma.vaultAccount.findUnique({ where: { userId: req.user!.id }, select: { pinSetAt: true } });
    if (!acct || acct.pinSetAt.getTime() !== payload.pv) throw new HttpError(401, "Your PIN changed. Unlock again.", "vault_locked");
    next();
  } catch (err) { fail(res, err); }
}

async function usage(userId: string) {
  const agg = await prisma.vaultFile.aggregate({ where: { userId }, _sum: { size: true }, _count: true });
  return { bytes: agg._sum.size || 0, files: agg._count, quotaBytes: VAULT_LIMITS.quotaBytes, maxFileBytes: VAULT_LIMITS.maxFileBytes };
}

// ── PIN lifecycle ─────────────────────────────────────────────────────────────
export const status = handle(async (req, res) => {
  const acct = await prisma.vaultAccount.findUnique({ where: { userId: req.user!.id } });
  const locked = !!(acct?.lockedUntil && acct.lockedUntil > new Date());
  res.json({
    hasPin: !!acct,
    locked,
    lockedUntil: locked ? acct!.lockedUntil : null,
    attemptsLeft: acct ? VAULT_LIMITS.maxAttempts - (acct.failedAttempts % VAULT_LIMITS.maxAttempts) : VAULT_LIMITS.maxAttempts,
    limits: { maxFileBytes: VAULT_LIMITS.maxFileBytes, quotaBytes: VAULT_LIMITS.quotaBytes, types: ["image/jpeg", "image/png", "image/webp", "application/pdf"] },
  });
});

export const createPin = handle(async (req, res) => {
  const pin = String(req.body?.pin || "");
  assertStrongPin(pin);
  vaultKey(); // fail early if the server can't encrypt
  const existing = await prisma.vaultAccount.findUnique({ where: { userId: req.user!.id } });
  if (existing) throw new HttpError(409, "You already have a vault PIN. Use Forgot PIN to reset it.");
  const acct = await prisma.vaultAccount.create({ data: { userId: req.user!.id, pinHash: await bcrypt.hash(pin, 11) } });
  res.status(201).json({ ok: true, ...issueToken(acct.userId, acct.pinSetAt) });
});

export const unlock = handle(async (req, res) => {
  const pin = String(req.body?.pin || "");
  const acct = await prisma.vaultAccount.findUnique({ where: { userId: req.user!.id } });
  if (!acct) throw new HttpError(404, "Create your vault PIN first", "no_pin");
  if (acct.lockedUntil && acct.lockedUntil > new Date()) {
    throw new HttpError(423, "Too many wrong PINs. Your vault is locked for now. Reset your PIN with an email code.", "vault_lockout", { lockedUntil: acct.lockedUntil });
  }
  if (!/^\d{6}$/.test(pin) || !(await bcrypt.compare(pin, acct.pinHash))) {
    const failed = acct.failedAttempts + 1;
    const lock = failed % VAULT_LIMITS.maxAttempts === 0 ? new Date(Date.now() + lockMs(failed)) : null;
    await prisma.vaultAccount.update({ where: { userId: acct.userId }, data: { failedAttempts: failed, ...(lock ? { lockedUntil: lock } : {}) } });
    if (lock) throw new HttpError(423, "Too many wrong PINs. Your vault is locked for now. Reset your PIN with an email code.", "vault_lockout", { lockedUntil: lock });
    const left = VAULT_LIMITS.maxAttempts - (failed % VAULT_LIMITS.maxAttempts);
    throw new HttpError(401, `Wrong PIN. ${left} attempt${left === 1 ? "" : "s"} left.`, "wrong_pin", { attemptsLeft: left });
  }
  await prisma.vaultAccount.update({ where: { userId: acct.userId }, data: { failedAttempts: 0, lockedUntil: null } });
  res.json({ ok: true, ...issueToken(acct.userId, acct.pinSetAt) });
});

export const changePin = handle(async (req, res) => {
  const current = String(req.body?.currentPin || "");
  const next = String(req.body?.newPin || "");
  const acct = await prisma.vaultAccount.findUnique({ where: { userId: req.user!.id } });
  if (!acct) throw new HttpError(404, "Create your vault PIN first", "no_pin");
  if (acct.lockedUntil && acct.lockedUntil > new Date()) {
    throw new HttpError(423, "Too many wrong PINs. Your vault is locked for now. Reset your PIN with an email code.", "vault_lockout", { lockedUntil: acct.lockedUntil });
  }
  if (!(await bcrypt.compare(current, acct.pinHash))) {
    const failed = acct.failedAttempts + 1;
    const lock = failed % VAULT_LIMITS.maxAttempts === 0 ? new Date(Date.now() + lockMs(failed)) : null;
    await prisma.vaultAccount.update({ where: { userId: acct.userId }, data: { failedAttempts: failed, ...(lock ? { lockedUntil: lock } : {}) } });
    if (lock) throw new HttpError(423, "Too many wrong PINs. Your vault is locked for now. Reset your PIN with an email code.", "vault_lockout", { lockedUntil: lock });
    const left = VAULT_LIMITS.maxAttempts - (failed % VAULT_LIMITS.maxAttempts);
    throw new HttpError(401, `Your current PIN is wrong. ${left} attempt${left === 1 ? "" : "s"} left.`, "wrong_pin", { attemptsLeft: left });
  }
  assertStrongPin(next);
  if (current === next) throw new HttpError(400, "Pick a PIN you haven't used just now");
  const updated = await prisma.vaultAccount.update({ where: { userId: acct.userId }, data: { pinHash: await bcrypt.hash(next, 11), pinSetAt: new Date(), failedAttempts: 0, lockedUntil: null } });
  res.json({ ok: true, ...issueToken(updated.userId, updated.pinSetAt) });
});

export const sendRecovery = handle(async (req, res) => {
  const acct = await prisma.vaultAccount.findUnique({ where: { userId: req.user!.id }, include: { user: { select: { email: true, name: true } } } });
  if (!acct) throw new HttpError(404, "You haven't created a vault PIN yet", "no_pin");
  if (acct.recoverySentAt && Date.now() - acct.recoverySentAt.getTime() < VAULT_LIMITS.otpCooldownMs) {
    throw new HttpError(429, "We just sent a code. Wait a minute before asking for another.");
  }
  const code = otp();
  await prisma.vaultAccount.update({
    where: { userId: acct.userId },
    data: { recoveryHash: await bcrypt.hash(code, 10), recoveryExpiresAt: new Date(Date.now() + VAULT_LIMITS.otpTtlMs), recoverySentAt: new Date(), recoveryAttempts: 0 },
  });
  await sendEmail({
    to: acct.user.email,
    toName: acct.user.name,
    subject: "Your Academicall Vault reset code",
    text: `Hi ${acct.user.name || "there"},\n\nYour Academicall Vault reset code is ${code}.\nIt expires in 10 minutes.\n\nIf you didn't ask to reset your vault PIN, ignore this email. Your files stay locked.`,
    html: `<div style="font-family:Arial,sans-serif;color:#0F0326"><p>Hi ${escapeHtml(acct.user.name || "there")},</p><p>Your Academicall Vault reset code is</p><p style="font-size:30px;letter-spacing:8px;font-weight:700;background:#F8F32B;display:inline-block;padding:10px 18px;border-radius:12px">${code}</p><p>It expires in 10 minutes.</p><p style="color:#7b7490">If you didn't ask to reset your vault PIN, ignore this email. Your files stay locked.</p></div>`,
  });
  const masked = acct.user.email.replace(/^(.{2})[^@]*(@.*)$/, "$1•••$2");
  res.json({ ok: true, sentTo: masked, ...(process.env.NODE_ENV === "test" ? { devCode: code } : {}) });
});

export const resetWithCode = handle(async (req, res) => {
  const code = String(req.body?.code || "").trim();
  const newPin = String(req.body?.newPin || "");
  const acct = await prisma.vaultAccount.findUnique({ where: { userId: req.user!.id } });
  if (!acct?.recoveryHash || !acct.recoveryExpiresAt || acct.recoveryExpiresAt < new Date()) {
    throw new HttpError(400, "That code has expired. Request a new one.", "code_expired");
  }
  if (acct.recoveryAttempts >= VAULT_LIMITS.otpMaxAttempts) throw new HttpError(429, "Too many wrong codes. Request a new one.", "code_expired");
  if (!(await bcrypt.compare(code, acct.recoveryHash))) {
    await prisma.vaultAccount.update({ where: { userId: acct.userId }, data: { recoveryAttempts: { increment: 1 } } });
    throw new HttpError(400, "That code isn't right. Check your email and try again.", "wrong_code");
  }
  assertStrongPin(newPin);
  const updated = await prisma.vaultAccount.update({
    where: { userId: acct.userId },
    data: { pinHash: await bcrypt.hash(newPin, 11), pinSetAt: new Date(), failedAttempts: 0, lockedUntil: null, recoveryHash: null, recoveryExpiresAt: null, recoveryAttempts: 0 },
  });
  res.json({ ok: true, ...issueToken(updated.userId, updated.pinSetAt) });
});

// ── folders ───────────────────────────────────────────────────────────────────
const folderSchema = z.object({
  name: z.string().trim().min(1, "Give the folder a name").max(48, "Keep the folder name under 48 characters"),
  color: z.enum(FOLDER_COLORS as [string, ...string[]]).optional(),
});

async function ownFolder(userId: string, id: string) {
  const f = await prisma.vaultFolder.findFirst({ where: { id, userId } });
  if (!f) throw new HttpError(404, "Folder not found");
  return f;
}

export const listFolders = handle(async (req, res) => {
  const userId = req.user!.id;
  const folders = await prisma.vaultFolder.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
  const stats = await prisma.vaultFile.groupBy({ by: ["folderId", "kind"], where: { userId }, _count: true, _sum: { size: true }, _max: { createdAt: true } });
  const recent = await prisma.vaultFile.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 8, select: fileSelect });
  res.json({
    folders: folders.map((f) => {
      const s = stats.filter((x) => x.folderId === f.id);
      return {
        ...f,
        fileCount: s.reduce((a, x) => a + x._count, 0),
        imageCount: s.find((x) => x.kind === "image")?._count || 0,
        pdfCount: s.find((x) => x.kind === "pdf")?._count || 0,
        bytes: s.reduce((a, x) => a + (x._sum.size || 0), 0),
        lastAddedAt: s.reduce<Date | null>((a, x) => (x._max.createdAt && (!a || x._max.createdAt > a) ? x._max.createdAt : a), null),
      };
    }),
    recent,
    usage: await usage(userId),
  });
});

export const createFolder = handle(async (req, res) => {
  const body = folderSchema.parse(req.body || {});
  const userId = req.user!.id;
  if ((await prisma.vaultFolder.count({ where: { userId } })) >= VAULT_LIMITS.maxFolders) throw new HttpError(400, `You can have up to ${VAULT_LIMITS.maxFolders} folders`);
  if (await prisma.vaultFolder.findFirst({ where: { userId, name: { equals: body.name, mode: "insensitive" } } })) throw new HttpError(409, "You already have a folder with that name");
  const folder = await prisma.vaultFolder.create({ data: { userId, name: body.name, color: body.color || "violet" } });
  res.status(201).json({ folder: { ...folder, fileCount: 0, imageCount: 0, pdfCount: 0, bytes: 0, lastAddedAt: null } });
});

export const updateFolder = handle(async (req, res) => {
  const body = folderSchema.partial().parse(req.body || {});
  const f = await ownFolder(req.user!.id, String(req.params.id));
  if (body.name && body.name.toLowerCase() !== f.name.toLowerCase()) {
    if (await prisma.vaultFolder.findFirst({ where: { userId: f.userId, name: { equals: body.name, mode: "insensitive" }, NOT: { id: f.id } } })) throw new HttpError(409, "You already have a folder with that name");
  }
  const folder = await prisma.vaultFolder.update({ where: { id: f.id }, data: body });
  res.json({ folder });
});

export const deleteFolder = handle(async (req, res) => {
  const f = await ownFolder(req.user!.id, String(req.params.id));
  await prisma.vaultFolder.delete({ where: { id: f.id } });
  res.json({ ok: true, usage: await usage(f.userId) });
});

// ── files ─────────────────────────────────────────────────────────────────────
const fileSelect = { id: true, folderId: true, name: true, kind: true, mimeType: true, size: true, createdAt: true, updatedAt: true } as const;

export const listFiles = handle(async (req, res) => {
  const f = await ownFolder(req.user!.id, String(req.params.id));
  const files = await prisma.vaultFile.findMany({ where: { folderId: f.id, userId: f.userId }, orderBy: { createdAt: "desc" }, select: fileSelect });
  res.json({ folder: f, files });
});

/** Raw upload: body = file bytes, header X-File-Name = original name. */
export const uploadFile = handle(async (req, res) => {
  const userId = req.user!.id;
  const f = await ownFolder(userId, String(req.params.id));
  const buf = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);
  if (!buf.length) throw new HttpError(400, "That file is empty");
  if (buf.length > VAULT_LIMITS.maxFileBytes) throw new HttpError(413, `Files must be ${Math.round(VAULT_LIMITS.maxFileBytes / MB)} MB or smaller`, "too_large");
  const type = sniff(buf);
  if (!type) throw new HttpError(415, "Only photos (JPG, PNG, WEBP) and PDFs can go in the vault", "bad_type");
  const u = await usage(userId);
  if (u.files >= VAULT_LIMITS.maxFiles) throw new HttpError(400, `Your vault holds up to ${VAULT_LIMITS.maxFiles} files`);
  if (u.bytes + buf.length > VAULT_LIMITS.quotaBytes) throw new HttpError(413, `Your vault is full (${Math.round(VAULT_LIMITS.quotaBytes / MB)} MB). Delete something to make room.`, "quota");
  const name = cleanName(String(req.headers["x-file-name"] || ""), type.ext);
  const id = randomUUIDv4();
  const enc = encrypt(buf, `${userId}:${id}`);
  const file = await prisma.vaultFile.create({
    data: { id, userId, folderId: f.id, name, kind: type.kind, mimeType: type.mime, size: buf.length, iv: enc.iv, authTag: enc.authTag, data: enc.data },
    select: fileSelect,
  });
  await prisma.vaultFolder.update({ where: { id: f.id }, data: { updatedAt: new Date() } });
  res.status(201).json({ file, usage: { ...u, bytes: u.bytes + buf.length, files: u.files + 1 } });
});

async function ownFile(userId: string, id: string) {
  const file = await prisma.vaultFile.findFirst({ where: { id, userId } });
  if (!file) throw new HttpError(404, "File not found");
  return file;
}

export const fileContent = handle(async (req, res) => {
  const file = await ownFile(req.user!.id, String(req.params.id));
  const plain = decrypt(file, `${file.userId}:${file.id}`);
  res.setHeader("Content-Type", file.mimeType);
  res.setHeader("Content-Length", String(plain.length));
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  res.end(plain);
});

export const updateFile = handle(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1).max(120).optional(), folderId: z.string().optional() }).parse(req.body || {});
  const file = await ownFile(req.user!.id, String(req.params.id));
  const data: Record<string, unknown> = {};
  if (body.name) {
    const ext = file.mimeType === "application/pdf" ? "pdf" : file.mimeType.split("/")[1].replace("jpeg", "jpg");
    data.name = cleanName(body.name, ext);
  }
  if (body.folderId && body.folderId !== file.folderId) {
    await ownFolder(file.userId, body.folderId);
    data.folderId = body.folderId;
  }
  const updated = await prisma.vaultFile.update({ where: { id: file.id }, data, select: fileSelect });
  res.json({ file: updated });
});

export const deleteFile = handle(async (req, res) => {
  const file = await ownFile(req.user!.id, String(req.params.id));
  await prisma.vaultFile.delete({ where: { id: file.id } });
  res.json({ ok: true, usage: await usage(file.userId) });
});

function randomUUIDv4() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
