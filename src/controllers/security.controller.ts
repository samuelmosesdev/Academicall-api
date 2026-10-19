/**
 * Two-step sign-in setup, signed-in devices and sign-in history — for the
 * person themselves (/me/…) and for staff looking after accounts (/admin/security, /users/:id/…).
 */
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { handle, HttpError, pageParams } from "../lib/http";
import { audit } from "../lib/audit";
import { isStaffRole, outranks } from "../lib/access";
import { notifyMany } from "../lib/notify";
import {
  checkSecondFactor, emailCode, getSecuritySettings, hashBackupCodes, hashCode, newBackupCodes, newTotpSecret,
  openSecret, otpauthUri, revokeSessions, saveSecuritySettings, sealSecret, sixDigits, verifyTotp, twoFactorOn,
} from "../lib/security";

const me = (req: any) => req.user!.id as string;

const loadMe = async (req: any) => {
  const u = await prisma.user.findUnique({ where: { id: me(req) } });
  if (!u) throw new HttpError(404, "Account not found");
  return u;
};

function describeDevice(ua?: string | null, platform?: string | null) {
  const s = ua || "";
  const browser = /Edg\//.test(s) ? "Edge" : /OPR\//.test(s) ? "Opera" : /Chrome\//.test(s) ? "Chrome" : /Firefox\//.test(s) ? "Firefox" : /Safari\//.test(s) ? "Safari" : "";
  const os = /Android/.test(s) ? "Android" : /iPhone|iPad/.test(s) ? "iOS" : /Windows/.test(s) ? "Windows" : /Mac OS X/.test(s) ? "macOS" : /Linux/.test(s) ? "Linux" : "";
  if (platform === "android" && /wv\)/.test(s)) return `Academicall app · ${os || "Android"}`;
  return [browser, os].filter(Boolean).join(" on ") || "Unknown device";
}

// ── Two-step sign-in (self) ─────────────────────────────────────────────────

/** GET /me/2fa */
export const status = handle(async (req, res) => {
  const u = await loadMe(req);
  const settings = await getSecuritySettings();
  res.json({
    method: u.twoFactorMethod || null,
    enabledAt: u.twoFactorEnabledAt,
    backupCodesLeft: u.twoFactorBackupHashes.length,
    required: isStaffRole(u.role) && settings.requireStaff2fa,
  });
});

/** POST /me/2fa/totp/start — a fresh secret to scan; nothing changes until confirmed. */
export const totpStart = handle(async (req, res) => {
  const u = await loadMe(req);
  const secret = newTotpSecret();
  await prisma.authChallenge.deleteMany({ where: { userId: u.id, kind: "setup_totp", usedAt: null } });
  const ch = await prisma.authChallenge.create({
    data: { userId: u.id, kind: "setup_totp", meta: { sealed: sealSecret(secret) }, expiresAt: new Date(Date.now() + 15 * 60_000) },
  });
  res.json({ setupId: ch.id, secret, uri: otpauthUri(secret, u.email) });
});

/** POST /me/2fa/totp/confirm { setupId, code } */
export const totpConfirm = handle(async (req, res) => {
  const { setupId, code } = z.object({ setupId: z.string().uuid(), code: z.string().trim().min(6).max(8) }).parse(req.body);
  const u = await loadMe(req);
  const ch = await prisma.authChallenge.findUnique({ where: { id: setupId } });
  if (!ch || ch.userId !== u.id || ch.kind !== "setup_totp" || ch.usedAt || ch.expiresAt < new Date()) throw new HttpError(400, "Setup expired. Start again.");
  const secret = openSecret(String((ch.meta as any)?.sealed || ""));
  if (!verifyTotp(secret, code)) throw new HttpError(400, "That code doesn't match. Check the time on your phone and try the newest code.");
  const codes = newBackupCodes();
  await prisma.$transaction([
    prisma.authChallenge.update({ where: { id: ch.id }, data: { usedAt: new Date() } }),
    prisma.user.update({
      where: { id: u.id },
      data: { twoFactorMethod: "totp", twoFactorSecret: sealSecret(secret), twoFactorEnabledAt: new Date(), twoFactorBackupHashes: await hashBackupCodes(codes) },
    }),
  ]);
  await audit(req.user, "security.2fa_on", { id: u.id, label: u.name || u.email }, { method: "totp" });
  res.json({ ok: true, method: "totp", backupCodes: codes });
});

/** POST /me/2fa/email/start — email a code to prove the inbox works. */
export const emailStart = handle(async (req, res) => {
  const u = await loadMe(req);
  const code = sixDigits();
  await prisma.authChallenge.deleteMany({ where: { userId: u.id, kind: "setup_email", usedAt: null } });
  const ch = await prisma.authChallenge.create({
    data: { userId: u.id, kind: "setup_email", codeHash: hashCode(code), expiresAt: new Date(Date.now() + 10 * 60_000) },
  });
  const r = await emailCode(u, code, "set-up");
  if (!r.delivered && process.env.NODE_ENV !== "production") console.log(`[2fa:dev] setup code for ${u.email}: ${code}`);
  res.json({ setupId: ch.id, delivered: r.delivered, ...(process.env.NODE_ENV === "test" ? { devCode: code } : {}) });
});

/** POST /me/2fa/email/confirm { setupId, code } */
export const emailConfirm = handle(async (req, res) => {
  const { setupId, code } = z.object({ setupId: z.string().uuid(), code: z.string().trim().min(6).max(6) }).parse(req.body);
  const u = await loadMe(req);
  const ch = await prisma.authChallenge.findUnique({ where: { id: setupId } });
  if (!ch || ch.userId !== u.id || ch.kind !== "setup_email" || ch.usedAt || ch.expiresAt < new Date()) throw new HttpError(400, "Setup expired. Start again.");
  if (ch.attempts >= 5) throw new HttpError(429, "Too many wrong codes. Start again.");
  if (hashCode(code) !== ch.codeHash) {
    await prisma.authChallenge.update({ where: { id: ch.id }, data: { attempts: { increment: 1 } } });
    throw new HttpError(400, "That code isn't right.");
  }
  await prisma.$transaction([
    prisma.authChallenge.update({ where: { id: ch.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: u.id }, data: { twoFactorMethod: "email", twoFactorSecret: null, twoFactorEnabledAt: new Date(), twoFactorBackupHashes: [] } }),
  ]);
  await audit(req.user, "security.2fa_on", { id: u.id, label: u.name || u.email }, { method: "email" });
  res.json({ ok: true, method: "email" });
});

/** POST /me/2fa/backup-codes { password } — replace backup codes (authenticator method). */
export const regenerateBackupCodes = handle(async (req, res) => {
  const u = await loadMe(req);
  if (u.twoFactorMethod !== "totp") throw new HttpError(400, "Backup codes come with the authenticator app method.");
  await confirmIdentity(u, req.body);
  const codes = newBackupCodes();
  await prisma.user.update({ where: { id: u.id }, data: { twoFactorBackupHashes: await hashBackupCodes(codes) } });
  res.json({ backupCodes: codes });
});

/** DELETE /me/2fa { password | code } */
export const disable = handle(async (req, res) => {
  const u = await loadMe(req);
  if (!twoFactorOn(u)) return res.json({ ok: true });
  if (isStaffRole(u.role) && (await getSecuritySettings()).requireStaff2fa) throw new HttpError(403, "Two-step sign-in is required for staff accounts.");
  await confirmIdentity(u, req.body);
  await prisma.user.update({ where: { id: u.id }, data: { twoFactorMethod: null, twoFactorSecret: null, twoFactorEnabledAt: null, twoFactorBackupHashes: [] } });
  await audit(req.user, "security.2fa_off", { id: u.id, label: u.name || u.email });
  res.json({ ok: true });
});

/** Password if they have one, otherwise a current authenticator / backup code. */
async function confirmIdentity(u: any, body: any) {
  const password = String(body?.password || "");
  const code = String(body?.code || "");
  if (u.passwordHash && password) {
    if (await bcrypt.compare(password, u.passwordHash)) return;
    throw new HttpError(401, "Password is incorrect");
  }
  if (code && (await checkSecondFactor(u, code)).ok) return;
  throw new HttpError(401, u.passwordHash ? "Enter your password to confirm" : "Enter a code from your authenticator app");
}

// ── Devices + history (self) ────────────────────────────────────────────────

/** GET /me/sessions */
export const mySessions = handle(async (req, res) => {
  const rows = await prisma.userSession.findMany({ where: { userId: me(req), revokedAt: null }, orderBy: { lastSeenAt: "desc" }, take: 50 });
  res.json({
    items: rows.map((s) => ({
      id: s.id, device: describeDevice(s.userAgent, s.platform), platform: s.platform, ip: s.ip, method: s.method,
      createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.id === req.user!.sid,
    })),
    legacy: !req.user!.sid,
  });
});

/** DELETE /me/sessions/:id */
export const endMySession = handle(async (req, res) => {
  const id = String(req.params.id);
  const s = await prisma.userSession.findUnique({ where: { id } });
  if (!s || s.userId !== me(req)) throw new HttpError(404, "Device not found");
  await revokeSessions(me(req), { only: id });
  res.json({ ok: true });
});

/** POST /me/sessions/sign-out-others */
export const endOtherSessions = handle(async (req, res) => {
  const n = await revokeSessions(me(req), { except: req.user!.sid || null });
  if (!req.user!.sid) {
    // Signed in before device tracking: fall back to revoking every older token.
    await prisma.user.update({ where: { id: me(req) }, data: { sessionsRevokedAt: new Date(Date.now() - 2000) } });
  }
  res.json({ ok: true, signedOut: n });
});

/** GET /me/logins */
export const myLogins = handle(async (req, res) => {
  const rows = await prisma.loginEvent.findMany({ where: { userId: me(req) }, orderBy: { createdAt: "desc" }, take: 30 });
  res.json({ items: rows.map((r) => ({ id: r.id, outcome: r.outcome, method: r.method, ip: r.ip, device: describeDevice(r.userAgent), createdAt: r.createdAt })) });
});

// ── Staff ───────────────────────────────────────────────────────────────────

/** GET /admin/security — the requirement switch, staff 2FA coverage and recent staff sign-ins. */
export const adminOverview = handle(async (req, res) => {
  const settings = await getSecuritySettings(true);
  const staff = await prisma.user.findMany({
    where: { role: { in: ["admin", "alphaAgent", "agent"] }, status: "active" },
    select: { id: true, name: true, email: true, role: true, twoFactorMethod: true, twoFactorEnabledAt: true, lastActiveAt: true },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
  const staffIds = staff.map((s) => s.id);
  const [logins, failed24h] = await Promise.all([
    prisma.loginEvent.findMany({ where: { userId: { in: staffIds } }, orderBy: { createdAt: "desc" }, take: 60 }),
    prisma.loginEvent.count({ where: { userId: { in: staffIds }, outcome: { in: ["bad_password", "code_failed"] }, createdAt: { gt: new Date(Date.now() - 86_400_000) } } }),
  ]);
  const names = new Map(staff.map((s) => [s.id, s.name || s.email]));
  res.json({
    settings,
    staff: staff.map((s) => ({ ...s, twoFactorOn: twoFactorOn(s) })),
    coverage: { total: staff.length, on: staff.filter((s) => twoFactorOn(s)).length },
    failed24h,
    logins: logins.map((l) => ({ id: l.id, userId: l.userId, name: names.get(l.userId || "") || l.email, outcome: l.outcome, method: l.method, ip: l.ip, device: describeDevice(l.userAgent), createdAt: l.createdAt })),
  });
});

/** PUT /admin/security { requireStaff2fa } */
export const adminSaveSettings = handle(async (req, res) => {
  const { requireStaff2fa } = z.object({ requireStaff2fa: z.boolean() }).parse(req.body);
  if (requireStaff2fa) {
    const self = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { twoFactorMethod: true } });
    if (!self || !twoFactorOn(self)) throw new HttpError(400, "Turn on two-step sign-in for your own account first, so you don't lock yourself out.", "self_2fa_needed");
  }
  const value = { requireStaff2fa, at: new Date().toISOString(), by: req.user!.id, byName: req.user!.name || req.user!.email };
  await saveSecuritySettings(value);
  await audit(req.user, requireStaff2fa ? "security.require_2fa_on" : "security.require_2fa_off", null);
  if (requireStaff2fa) {
    const pending = await prisma.user.findMany({ where: { role: { in: ["admin", "alphaAgent", "agent"] }, status: "active", twoFactorMethod: null }, select: { id: true } });
    await notifyMany(pending.map((p) => p.id), {
      type: "security", title: "Turn on two-step sign-in",
      body: "Staff accounts now need two-step sign-in. You'll be asked to set it up the next time you open Academicall.",
      data: { link: "/security-setup" }, createdById: req.user!.id,
    });
  }
  res.json({ settings: value });
});

async function targetFor(req: any) {
  const t = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
  if (!t) throw new HttpError(404, "User not found");
  return t;
}

/** GET /users/:id/security — their devices, 2FA state and sign-in history. */
export const userSecurity = handle(async (req, res) => {
  const t = await targetFor(req);
  const [sessions, logins] = await Promise.all([
    prisma.userSession.findMany({ where: { userId: t.id, revokedAt: null }, orderBy: { lastSeenAt: "desc" }, take: 30 }),
    prisma.loginEvent.findMany({ where: { userId: t.id }, orderBy: { createdAt: "desc" }, take: 40 }),
  ]);
  res.json({
    twoFactor: { method: t.twoFactorMethod, enabledAt: t.twoFactorEnabledAt, backupCodesLeft: t.twoFactorBackupHashes.length },
    sessions: sessions.map((s) => ({ id: s.id, device: describeDevice(s.userAgent, s.platform), ip: s.ip, platform: s.platform, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt })),
    logins: logins.map((l) => ({ id: l.id, outcome: l.outcome, method: l.method, ip: l.ip, device: describeDevice(l.userAgent), createdAt: l.createdAt })),
  });
});

/** POST /users/:id/2fa/reset — for someone who lost their phone. They set it up again. */
export const resetUserTwoFactor = handle(async (req, res) => {
  const t = await targetFor(req);
  if (!outranks(req.user!, t)) throw new HttpError(403, "You can only reset accounts below your rank.");
  await prisma.user.update({ where: { id: t.id }, data: { twoFactorMethod: null, twoFactorSecret: null, twoFactorEnabledAt: null, twoFactorBackupHashes: [] } });
  await revokeSessions(t.id);
  await audit(req.user, "security.2fa_reset", { id: t.id, label: t.name || t.email }, { reason: String(req.body?.reason || "").slice(0, 300) || null });
  await notifyMany([t.id], { type: "security", title: "Two-step sign-in was reset", body: "Staff reset your two-step sign-in. Sign in again and set it up.", createdById: req.user!.id });
  res.json({ ok: true });
});

/** DELETE /users/:id/sessions/:sid */
export const endUserSession = handle(async (req, res) => {
  const t = await targetFor(req);
  if (!outranks(req.user!, t)) throw new HttpError(403, "You can only manage accounts below your rank.");
  await revokeSessions(t.id, { only: String(req.params.sid) });
  await audit(req.user, "security.session_end", { id: t.id, label: t.name || t.email });
  res.json({ ok: true });
});
