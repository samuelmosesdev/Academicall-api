import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { DEFAULT_INSTITUTION_ID, institutionOf } from "../lib/scope";

const staffRoles = ["admin", "alphaAgent", "agent"];

function isStaff(role?: string) {
  return staffRoles.includes(role || "");
}

function hasGlobalInstitutionAccess(role?: string) {
  return role === "admin" || role === "alphaAgent";
}

function isCourseRep(role?: string) {
  return role === "courseRep";
}

function normalizeLevel(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/\s*level\s*/g, "");
}

async function currentUser(req: Request) {
  if (!req.user) return null;
  return prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, role: true, department: true, program: true, faculty: true, level: true, institutionId: true, courseRepMeta: true } });
}

function effectiveScope(user: any) {
  return String(user?.role === "courseRep" ? user?.courseRepMeta?.program : user?.program || "").trim();
}

export async function requestJoin(req: Request, res: Response) {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: "Unauthenticated" });
  if (user.role !== "user") return res.status(403).json({ error: "Only students can request program membership" });
  const scope = String(user.program || "").trim();
  if (!scope) return res.status(400).json({ error: "Program is required" });

  const membership = await prisma.departmentMembership.upsert({
    where: { userId_institutionId_department: { userId: user.id, institutionId: institutionOf(user), department: scope } },
    create: { userId: user.id, institutionId: institutionOf(user), department: scope, faculty: user.faculty || null, level: user.level || null, status: "pending" },
    update: { status: "pending", withdrawStatus: null, withdrawReason: null, withdrawRequestedAt: null },
  });
  res.status(201).json({ membership, message: membership.status === "active" ? "Already a member" : "Request sent" });
}

export async function myMembership(req: Request, res: Response) {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: "Unauthenticated" });
  const scope = String(user.program || "").trim();
  if (!scope) return res.json({ membership: null });
  const membership = await prisma.departmentMembership.findUnique({ where: { userId_institutionId_department: { userId: user.id, institutionId: institutionOf(user), department: scope } } });
  res.json({ membership });
}

export async function listMembers(req: Request, res: Response) {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: "Unauthenticated" });
  if (!isStaff(user.role) && !isCourseRep(user.role)) return res.status(403).json({ error: "Forbidden" });
  const requestedScope = String(req.query.program || "").trim();
  const requestedInstitution = String(req.query.institutionId || "").trim();
  if (
    isStaff(user.role) &&
    !hasGlobalInstitutionAccess(user.role) &&
    requestedInstitution &&
    requestedInstitution !== institutionOf(user)
  ) {
    return res.status(403).json({ error: "Wrong institution scope" });
  }
  if (
    isCourseRep(user.role) &&
    requestedScope &&
    requestedScope.toLowerCase() !== effectiveScope(user).toLowerCase()
  ) {
    return res.status(403).json({ error: "Wrong program scope" });
  }
  const scope = isCourseRep(user.role) ? effectiveScope(user) : requestedScope || effectiveScope(user);
  const institutionId = hasGlobalInstitutionAccess(user.role) && requestedInstitution
    ? requestedInstitution
    : institutionOf(user) || DEFAULT_INSTITUTION_ID;
  if (!scope) return res.status(400).json({ error: "Program required" });
  const repMeta = user.courseRepMeta as { level?: string } | null;
  const assignedLevel = isCourseRep(user.role) ? String(repMeta?.level || "").trim() : "";
  if (isCourseRep(user.role) && !assignedLevel) return res.status(400).json({ error: "Course Rep level assignment required" });
  if (isCourseRep(user.role) && effectiveScope(user).toLowerCase() !== scope.toLowerCase()) return res.status(403).json({ error: "Wrong program scope" });

  const status = req.query.status ? String(req.query.status) : undefined;
  const members = await prisma.departmentMembership.findMany({
    where: {
      department: scope,
      institutionId,
      ...(isCourseRep(user.role) ? { level: assignedLevel } : {}),
      ...(status ? { status } : {}),
    },
    include: { user: { select: { id: true, name: true, email: true, uniqueId: true, program: true, level: true, matricNumber: true, photoUrl: true } } },
    orderBy: { requestedAt: "desc" },
  });
  res.json({ members });
}

async function membershipForAction(req: Request, res: Response) {
  const user = await currentUser(req);
  if (!user) return { user: null, membership: null };
  const repMeta = user.courseRepMeta as { level?: string } | null;
  if (!isCourseRep(user.role) && !isStaff(user.role)) {
    res.status(403).json({ error: "Forbidden" });
    return { user, membership: null };
  }
  const membership = await prisma.departmentMembership.findUnique({ where: { id: String(req.params.id) } });
  if (!membership) {
    res.status(404).json({ error: "Not found" });
    return { user, membership: null };
  }
  if (
    isCourseRep(user.role) &&
    (membership.institutionId !== institutionOf(user) ||
      membership.department.toLowerCase() !== effectiveScope(user).toLowerCase() ||
      !normalizeLevel(repMeta?.level) ||
      normalizeLevel(membership.level) !== normalizeLevel(repMeta?.level))
  ) {
    res.status(403).json({ error: "Wrong program scope" });
    return { user, membership: null };
  }
  if (
    isStaff(user.role) &&
    !hasGlobalInstitutionAccess(user.role) &&
    membership.institutionId !== institutionOf(user)
  ) {
    res.status(403).json({ error: "Wrong institution scope" });
    return { user, membership: null };
  }
  return { user, membership };
}

export async function admitMember(req: Request, res: Response) {
  const result = await membershipForAction(req, res);
  if (!result.membership || !result.user) return;
  const membership = await prisma.departmentMembership.update({ where: { id: result.membership.id }, data: { status: "active", admittedAt: new Date(), admittedById: result.user.id } });
  res.json({ membership });
}

export async function rejectMember(req: Request, res: Response) {
  const result = await membershipForAction(req, res);
  if (!result.membership) return;
  const membership = await prisma.departmentMembership.update({ where: { id: result.membership.id }, data: { status: "rejected" } });
  res.json({ membership });
}

export async function requestWithdraw(req: Request, res: Response) {
  const result = await membershipForAction(req, res);
  if (!result.membership) return;
  const reason = String(req.body?.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "Reason is required" });
  if (result.membership.status !== "active") return res.status(400).json({ error: "Member is not active" });
  const membership = await prisma.departmentMembership.update({ where: { id: result.membership.id }, data: { withdrawRequestedAt: new Date(), withdrawReason: reason, withdrawStatus: "pending" } });
  res.json({ membership });
}

export async function reviewWithdraw(req: Request, res: Response) {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: "Unauthenticated" });
  if (!isStaff(user.role)) return res.status(403).json({ error: "Forbidden" });
  const action = req.body?.action;
  if (!["approve", "reject"].includes(action)) return res.status(400).json({ error: "action must be approve or reject" });
  const existing = await prisma.departmentMembership.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!hasGlobalInstitutionAccess(user.role) && existing.institutionId !== institutionOf(user)) {
    return res.status(403).json({ error: "Wrong institution scope" });
  }
  if (existing.withdrawStatus !== "pending") return res.status(400).json({ error: "No pending withdrawal" });
  const membership = await prisma.departmentMembership.update({ where: { id: existing.id }, data: { withdrawStatus: action === "approve" ? "approved" : "rejected", withdrawReviewedAt: new Date(), withdrawReviewedBy: user.id, ...(action === "approve" ? { status: "withdrawn" } : {}) } });
  res.json({ membership });
}
