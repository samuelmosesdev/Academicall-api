/**
 * Sign-in security: device sessions, login history, two-step sign-in.
 *
 *  - Every sign-in creates a UserSession; the JWT carries its id ("sid"), so a
 *    person (or an admin) can sign one device out without touching the others.
 *  - Every attempt writes a LoginEvent (success, wrong password, code sent…).
 *  - Two-step sign-in works with an emailed 6-digit code or an authenticator
 *    app (TOTP, RFC 6238). Eight one-time backup codes come with the app method.
 *  - Admins can require two-step sign-in for every staff account
 *    (Setting "security" → { requireStaff2fa }). Staff without it set up are
 *    let in only as far as the setup screen.
 */
import { Request } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt } from "crypto";
import { Role } from "@prisma/client";
import { prisma } from "./prisma";
import { isStaffRole } from "./access";
import { sendEmail } from "./email";

const SECRET = () => process.env.JWT_SECRET || "dev-secret";

// ── Settings ────────────────────────────────────────────────────────────────
export type SecuritySettings = { requireStaff2fa: boolean; at?: string; by?: string | null; byName?: string | null };
let settingsCache: { at: number; value: SecuritySettings } | null = null;

export async function getSecuritySettings(fresh = false): Promise<SecuritySettings> {
  if (!fresh && settingsCache && Date.now() - settingsCache.at < 15_000) return settingsCache.value;
  const row = await prisma.setting.findUnique({ where: { key: "security" } }).catch(() => null);
  const raw = (row?.value as any) || {};
  const value: SecuritySettings = { requireStaff2fa: !!raw.requireStaff2fa, at: raw.at, by: raw.by, byName: raw.byName };
  settingsCache = { at: Date.now(), value };
  return value;
}

export async function saveSecuritySettings(value: SecuritySettings) {
  await prisma.setting.upsert({ where: { key: "security" }, create: { key: "security", value: value as any }, update: { value: value as any } });
  settingsCache = { at: Date.now(), value };
}

// ── Request details ─────────────────────────────────────────────────────────
export const clientIp = (req: Request) => String((req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.ip || "").trim().slice(0, 64) || null;
export const clientUa = (req: Request) => String(req.headers["user-agent"] || "").slice(0, 300) || null;
export function clientPlatform(req: Request) {
  const p = String(req.headers["x-client-platform"] || req.body?.platform || "").toLowerCase();
  if (["android", "ios", "web"].includes(p)) return p;
  const ua = clientUa(req) || "";
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad/i.test(ua)) return "ios";
  return "web";
}

// ── Sessions + tokens ───────────────────────────────────────────────────────
type TokenUser = { id: string; email: string; role: Role };

/** Create a device session and the JWT that carries its id. */
export async function issueSession(user: TokenUser, req: Request, method: "password" | "google" | "register") {
  const session = await prisma.userSession.create({
    data: { userId: user.id, ip: clientIp(req), userAgent: clientUa(req), platform: clientPlatform(req), method },
  });
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role, sid: session.id }, SECRET(), {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  } as jwt.SignOptions);
  return { token, sessionId: session.id };
}

/** Session check cache so authenticate() doesn't hit the DB on every call. */
const sessionCache = new Map<string, { at: number; ok: boolean; seen: number }>();
const SESSION_TTL = 30_000;
const TOUCH_EVERY = 5 * 60_000;

export async function sessionIsLive(sid: string) {
  const hit = sessionCache.get(sid);
  const now = Date.now();
  if (hit && now - hit.at < SESSION_TTL) return hit.ok;
  const s = await prisma.userSession.findUnique({ where: { id: sid }, select: { revokedAt: true, lastSeenAt: true } });
  const ok = !!s && !s.revokedAt;
  sessionCache.set(sid, { at: now, ok, seen: s?.lastSeenAt?.getTime() || 0 });
  if (ok && s && now - s.lastSeenAt.getTime() > TOUCH_EVERY) {
    prisma.userSession.update({ where: { id: sid }, data: { lastSeenAt: new Date() } }).catch(() => {});
  }
  if (sessionCache.size > 20_000) sessionCache.clear();
  return ok;
}

export function forgetSession(sid: string) {
  sessionCache.delete(sid);
}

export async function revokeSessions(userId: string, opts: { except?: string | null; only?: string | null } = {}) {
  const where: any = { userId, revokedAt: null };
  if (opts.only) where.id = opts.only;
  if (opts.except) where.id = { not: opts.except };
  const rows = await prisma.userSession.findMany({ where, select: { id: true } });
  await prisma.userSession.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { revokedAt: new Date() } });
  rows.forEach((r) => forgetSession(r.id));
  return rows.length;
}

// ── Login history ───────────────────────────────────────────────────────────
export async function logLogin(req: Request, entry: { userId?: string | null; email?: string | null; method: string; outcome: string }) {
  try {
    await prisma.loginEvent.create({
      data: { userId: entry.userId || null, email: entry.email || null, method: entry.method, outcome: entry.outcome, ip: clientIp(req), userAgent: clientUa(req) },
    });
  } catch (err) {
    console.error("[login-event]", err);
  }
}

// ── Secrets at rest ─────────────────────────────────────────────────────────
function key() {
  return createHash("sha256").update(`2fa:${process.env.TWO_FACTOR_KEY || SECRET()}`).digest();
}
export function sealSecret(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}
export function openSecret(sealed: string) {
  const [iv, tag, enc] = sealed.split(".");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf8");
}

// ── TOTP (authenticator apps) ───────────────────────────────────────────────
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf: Buffer) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string) {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export function totpCode(secretB32: string, counter: number) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secretB32)).update(buf).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}
export function verifyTotp(secretB32: string, code: string, at = Date.now()) {
  const c = String(code || "").replace(/\D/g, "");
  if (c.length !== 6) return false;
  const step = Math.floor(at / 30_000);
  for (const w of [0, -1, 1]) if (totpCode(secretB32, step + w) === c) return true;
  return false;
}
export const newTotpSecret = () => base32Encode(randomBytes(20));
export const otpauthUri = (secret: string, email: string) =>
  `otpauth://totp/${encodeURIComponent(`Academicall:${email}`)}?secret=${secret}&issuer=Academicall&algorithm=SHA1&digits=6&period=30`;

// ── Codes ───────────────────────────────────────────────────────────────────
export const sixDigits = () => String(randomInt(0, 1_000_000)).padStart(6, "0");
export const hashCode = (code: string) => createHash("sha256").update(`${SECRET()}:${code}`).digest("hex");

export function newBackupCodes() {
  return Array.from({ length: 8 }, () => {
    const raw = base32Encode(randomBytes(5)).slice(0, 8).toLowerCase();
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}
export async function hashBackupCodes(codes: string[]) {
  return Promise.all(codes.map((c) => bcrypt.hash(c.replace(/-/g, ""), 8)));
}

export const maskEmail = (email: string) => {
  const [name, domain] = email.split("@");
  if (!domain) return email;
  return `${name.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(6, name.length - 2)))}@${domain}`;
};

export async function emailCode(to: { email: string; name?: string | null }, code: string, purpose: string) {
  return sendEmail({
    to: to.email,
    toName: to.name,
    subject: `${code} is your Academicall code`,
    text: `Your Academicall ${purpose} code is ${code}.\n\nIt expires in 10 minutes. If you didn't try to sign in, change your password now.`,
  });
}

// ── Two-step sign-in ────────────────────────────────────────────────────────
type TwoFactorUser = { id: string; email: string; name?: string | null; role: Role | string; twoFactorMethod?: string | null };

/** Does this person need a second step right now? */
export const twoFactorOn = (u: { twoFactorMethod?: string | null }) => u.twoFactorMethod === "email" || u.twoFactorMethod === "totp";

/** Staff must set up two-step sign-in before doing anything else when an admin requires it. */
export async function needsTwoFactorSetup(u: { role: string; twoFactorMethod?: string | null }) {
  if (!isStaffRole(u.role) || twoFactorOn(u)) return false;
  return (await getSecuritySettings()).requireStaff2fa;
}

/** Start the second step of a sign-in: email a code (email method) and hand back a challenge id. */
export async function startLoginChallenge(user: TwoFactorUser, method: string) {
  const code = user.twoFactorMethod === "email" ? sixDigits() : null;
  const ch = await prisma.authChallenge.create({
    data: {
      userId: user.id,
      kind: "login",
      codeHash: code ? hashCode(code) : null,
      meta: { method },
      expiresAt: new Date(Date.now() + 10 * 60_000),
    },
  });
  let delivered = true;
  if (code) {
    try {
      const r = await emailCode(user, code, "sign-in");
      delivered = r.delivered;
      if (!r.delivered && process.env.NODE_ENV !== "production") console.log(`[2fa:dev] sign-in code for ${user.email}: ${code}`);
    } catch (err) {
      console.error("[2fa] email failed", err);
      delivered = false;
    }
  }
  return {
    twoFactorRequired: true,
    challengeId: ch.id,
    method: user.twoFactorMethod,
    emailHint: maskEmail(user.email),
    delivered,
    ...(process.env.NODE_ENV === "test" && code ? { devCode: code } : {}),
  };
}

/** Check a code against a stored challenge or the person's authenticator / backup codes. */
export async function checkSecondFactor(
  user: { id: string; twoFactorMethod?: string | null; twoFactorSecret?: string | null; twoFactorBackupHashes?: string[] },
  code: string,
  challenge?: { codeHash: string | null } | null,
): Promise<{ ok: boolean; usedBackup?: boolean }> {
  const c = String(code || "").trim();
  if (user.twoFactorMethod === "email" && challenge?.codeHash) {
    if (hashCode(c.replace(/\D/g, "")) === challenge.codeHash) return { ok: true };
  }
  if (user.twoFactorMethod === "totp" && user.twoFactorSecret) {
    try {
      if (verifyTotp(openSecret(user.twoFactorSecret), c)) return { ok: true };
    } catch {
      /* fall through to backup codes */
    }
  }
  const flat = c.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (flat.length === 8) {
    const hashes = user.twoFactorBackupHashes || [];
    for (let i = 0; i < hashes.length; i++) {
      if (await bcrypt.compare(flat, hashes[i])) {
        const rest = hashes.filter((_, j) => j !== i);
        await prisma.user.update({ where: { id: user.id }, data: { twoFactorBackupHashes: rest } });
        return { ok: true, usedBackup: true };
      }
    }
  }
  return { ok: false };
}
