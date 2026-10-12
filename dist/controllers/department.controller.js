"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestJoin = requestJoin;
exports.myMembership = myMembership;
exports.listMembers = listMembers;
exports.admitMember = admitMember;
exports.rejectMember = rejectMember;
exports.requestWithdraw = requestWithdraw;
exports.reviewWithdraw = reviewWithdraw;
const prisma_1 = require("../lib/prisma");
const staffRoles = ["admin", "alphaAgent", "agent"];
function isStaff(role) {
    return staffRoles.includes(role || "");
}
function isCourseRep(role) {
    return role === "courseRep";
}
async function currentUser(req) {
    if (!req.user)
        return null;
    return prisma_1.prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, role: true, department: true, program: true, faculty: true, level: true, courseRepMeta: true } });
}
function effectiveScope(user) {
    return String(user?.courseRepMeta?.program || user?.program || user?.courseRepMeta?.department || user?.department || "").trim();
}
async function requestJoin(req, res) {
    const user = await currentUser(req);
    if (!user)
        return res.status(401).json({ error: "Unauthenticated" });
    const scope = String(req.body?.program || req.body?.department || user.program || user.department || "").trim();
    if (!scope)
        return res.status(400).json({ error: "Program is required" });
    const membership = await prisma_1.prisma.departmentMembership.upsert({
        where: { userId_department: { userId: user.id, department: scope } },
        create: { userId: user.id, department: scope, faculty: req.body?.faculty || user.faculty || null, level: req.body?.level || user.level || null, status: "pending" },
        update: { status: "pending", withdrawStatus: null, withdrawReason: null, withdrawRequestedAt: null },
    });
    res.status(201).json({ membership, message: membership.status === "active" ? "Already a member" : "Request sent" });
}
async function myMembership(req, res) {
    const user = await currentUser(req);
    if (!user)
        return res.status(401).json({ error: "Unauthenticated" });
    const scope = String(req.query.program || req.query.department || user.program || user.department || "").trim();
    if (!scope)
        return res.json({ membership: null });
    const membership = await prisma_1.prisma.departmentMembership.findUnique({ where: { userId_department: { userId: user.id, department: scope } } });
    res.json({ membership });
}
async function listMembers(req, res) {
    const user = await currentUser(req);
    if (!user)
        return res.status(401).json({ error: "Unauthenticated" });
    const requestedScope = String(req.query.program ?? req.query.department ?? "").trim();
    const scope = requestedScope || effectiveScope(user);
    if (!scope)
        return res.status(400).json({ error: "Program required" });
    if (isCourseRep(user.role) && effectiveScope(user) !== scope)
        return res.status(403).json({ error: "Wrong program scope" });
    const status = req.query.status ? String(req.query.status) : undefined;
    const members = await prisma_1.prisma.departmentMembership.findMany({
        where: { department: scope, ...(status ? { status } : {}) },
        include: { user: { select: { id: true, name: true, email: true, uniqueId: true, program: true, level: true, matricNumber: true, photoUrl: true } } },
        orderBy: { requestedAt: "desc" },
    });
    res.json({ members });
}
async function membershipForAction(req, res) {
    const user = await currentUser(req);
    if (!user)
        return { user: null, membership: null };
    if (!isCourseRep(user.role) && !isStaff(user.role)) {
        res.status(403).json({ error: "Forbidden" });
        return { user, membership: null };
    }
    const membership = await prisma_1.prisma.departmentMembership.findUnique({ where: { id: String(req.params.id) } });
    if (!membership) {
        res.status(404).json({ error: "Not found" });
        return { user, membership: null };
    }
    if (isCourseRep(user.role) && membership.department !== effectiveScope(user)) {
        res.status(403).json({ error: "Wrong program scope" });
        return { user, membership: null };
    }
    return { user, membership };
}
async function admitMember(req, res) {
    const result = await membershipForAction(req, res);
    if (!result.membership || !result.user)
        return;
    const membership = await prisma_1.prisma.departmentMembership.update({ where: { id: result.membership.id }, data: { status: "active", admittedAt: new Date(), admittedById: result.user.id } });
    res.json({ membership });
}
async function rejectMember(req, res) {
    const result = await membershipForAction(req, res);
    if (!result.membership)
        return;
    const membership = await prisma_1.prisma.departmentMembership.update({ where: { id: result.membership.id }, data: { status: "rejected" } });
    res.json({ membership });
}
async function requestWithdraw(req, res) {
    const result = await membershipForAction(req, res);
    if (!result.membership)
        return;
    const reason = String(req.body?.reason || "").trim();
    if (!reason)
        return res.status(400).json({ error: "Reason is required" });
    if (result.membership.status !== "active")
        return res.status(400).json({ error: "Member is not active" });
    const membership = await prisma_1.prisma.departmentMembership.update({ where: { id: result.membership.id }, data: { withdrawRequestedAt: new Date(), withdrawReason: reason, withdrawStatus: "pending" } });
    res.json({ membership });
}
async function reviewWithdraw(req, res) {
    const user = await currentUser(req);
    if (!user)
        return res.status(401).json({ error: "Unauthenticated" });
    if (!isStaff(user.role))
        return res.status(403).json({ error: "Forbidden" });
    const action = req.body?.action;
    if (!["approve", "reject"].includes(action))
        return res.status(400).json({ error: "action must be approve or reject" });
    const existing = await prisma_1.prisma.departmentMembership.findUnique({ where: { id: String(req.params.id) } });
    if (!existing)
        return res.status(404).json({ error: "Not found" });
    if (existing.withdrawStatus !== "pending")
        return res.status(400).json({ error: "No pending withdrawal" });
    const membership = await prisma_1.prisma.departmentMembership.update({ where: { id: existing.id }, data: { withdrawStatus: action === "approve" ? "approved" : "rejected", withdrawReviewedAt: new Date(), withdrawReviewedBy: user.id, ...(action === "approve" ? { status: "withdrawn" } : {}) } });
    res.json({ membership });
}
//# sourceMappingURL=department.controller.js.map