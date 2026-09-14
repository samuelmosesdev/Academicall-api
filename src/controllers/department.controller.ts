import { Request, Response } from "express";
import { prisma } from "../lib/prisma";

const staffRoles = ["admin", "alphaAgent", "agent"];

function isStaff(role?: string) {
  return staffRoles.includes(role || "");
}

function isCourseRep(role?: string) {
  return role === "courseRep";
}

async function currentUser(req: Request) {
  if (!req.user) return null;
  return prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, role: true, department: true, faculty: true, level: true, courseRepMeta: true } });
}

function repDepartment(user: any) {
  return user?.courseRepMeta?.department || user?.department || "";
}

export async function requestJoin(req: Request, res: Response) {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: "Unauthenticated" });
  const department = String(req.body?.department || user.department || "").trim();
  if (!department) return res.status(400).json({ error: "Department is required" });

  const membership = await prisma.departmentMembership.upsert({
    where: { userId_department: { userId: user.id, department } },
    create: { userId: user.id, department, faculty: req.body?.faculty || user.faculty || null, level: req.body?.level || user.level || null, status: "pending" },
    update: { status: "pending", withdrawStatus: null, withdrawReason: null, withdrawRequestedAt: null },
  });
  res.status(201).json({ membership, message: membership.status === "active" ? "Already a member" : "Request sent" });
}

export async function myMembership(req: Request, res: Response) {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: "Unauthenticated" });
  const department = String(req.query.department || user.department || "").trim();
  if (!department) return res.json({ membership: null });
  const membership = await prisma.departmentMembership.findUnique({ where: { userId_department: { userId: user.id, department } } });
  res.json({ membership });
}

export async function listMembers(req: Request, res: Response) {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: "Unauthenticated" });
  const requestedDepartment = String(req.query.department || "").trim();
  const department = requestedDepartment || repDepartment(user);
  if (!department) return res.status(400).json({ error: "Department required" });
  if (isCourseRep(user.role) && repDepartment(user) !== department) return res.status(403).json({ error: "Wrong department" });

  const status = req.query.status ? String(req.query.status) : undefined;
  const members = await prisma.departmentMembership.findMany({
    where: { department, ...(status ? { status } : {}) },
    include: { user: { select: { id: true, name: true, email: true, uniqueId: true, level: true, matricNumber: true, photoUrl: true } } },
    orderBy: { requestedAt: "desc" },
  });
  res.json({ members });
}

async function membershipForAction(req: Request, res: Response) {
  const user = await currentUser(req);
  if (!user) return { user: null, membership: null };
  if (!isCourseRep(user.role) && !isStaff(user.role)) {
    res.status(403).json({ error: "Forbidden" });
    return { user, membership: null };
  }
  const membership = await prisma.departmentMembership.findUnique({ where: { id: String(req.params.id) } });
  if (!membership) {
    res.status(404).json({ error: "Not found" });
    return { user, membership: null };
  }
  if (isCourseRep(user.role) && membership.department !== repDepartment(user)) {
    res.status(403).json({ error: "Wrong department" });
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
  if (existing.withdrawStatus !== "pending") return res.status(400).json({ error: "No pending withdrawal" });
  const membership = await prisma.departmentMembership.update({ where: { id: existing.id }, data: { withdrawStatus: action === "approve" ? "approved" : "rejected", withdrawReviewedAt: new Date(), withdrawReviewedBy: user.id, ...(action === "approve" ? { status: "withdrawn" } : {}) } });
  res.json({ membership });
}
