/**
 * Staff access control.
 *
 *  - Roles set the rank: admin > alphaAgent > agent > everyone else.
 *  - Duties ("staffTags") are add-ons any user can hold on top of their role:
 *      news       → writes and publishes Academicall News
 *      secretary  → runs the Secretariat
 *      newsChief  → Chief News Agent: oversees every story and every News Agent (admin assigns)
 *      houseLeader→ runs one or more Aspirant Houses (admin picks the houses)
 *  - Capabilities are the switches the admin flips per person. A person with
 *    no saved list gets the defaults for their role and duties. Admins always
 *    hold every capability and can't be restricted.
 *  - A few capabilities are reserved for admins and can never be granted.
 */
import { Request, Response, NextFunction } from "express";

export type Cap = (typeof CAPABILITIES)[number]["key"];
export type Scope = "staff" | "secretary";

export const CAPABILITIES = [
  // People
  { key: "users.view", group: "People", scope: "staff", label: "View users", hint: "Browse students and open their profiles" },
  { key: "users.edit", group: "People", scope: "staff", label: "Edit profiles", hint: "Change names, academic details and plans" },
  { key: "users.suspend", group: "People", scope: "staff", label: "Suspend accounts", hint: "Suspend and reactivate accounts below their rank" },
  { key: "users.password", group: "People", scope: "staff", label: "Force password change", hint: "Force a new password, issue a temporary one, sign them out everywhere" },
  { key: "users.courseRep", group: "People", scope: "staff", label: "Assign Course Reps", hint: "Make or remove Course Reps" },
  { key: "users.news", group: "People", scope: "staff", label: "Assign News duty", hint: "Give or remove the News Agent duty" },
  { key: "users.secretary", group: "People", scope: "staff", label: "Assign Secretary duty", hint: "Give or remove the Secretary duty" },
  { key: "users.houseLeader", group: "People", scope: "staff", label: "Assign House Leaders", hint: "Make people House Leaders and choose the houses they run" },
  { key: "users.delete", group: "People", scope: "staff", label: "Delete accounts", hint: "Close accounts below their rank" },
  // Aspirants
  { key: "aspirants.view", group: "Aspirants", scope: "staff", label: "View aspirants", hint: "See aspirants, their institutions of choice and details" },
  { key: "aspirants.manage", group: "Aspirants", scope: "staff", label: "Manage aspirants", hint: "Edit choices, suspend or reactivate aspirant accounts" },
  { key: "houses.manage", group: "Aspirants", scope: "staff", label: "Manage houses", hint: "Edit Aspirant Houses and moderate any house" },
  { key: "board.manage", group: "Content", scope: "staff", label: "Dashboard board", hint: "Choose the messages, images and slides on the student dashboard" },
  // Content
  { key: "documents.review", group: "Content", scope: "staff", label: "Review materials", hint: "Approve or reject uploaded materials" },
  { key: "documents.manage", group: "Content", scope: "staff", label: "Manage materials", hint: "Edit, remove and restore materials" },
  { key: "files.center", group: "Content", scope: "staff", label: "Document Center", hint: "See every upload, including deleted ones, and restore them" },
  { key: "courses.manage", group: "Content", scope: "staff", label: "Manage courses", hint: "Create and edit courses" },
  { key: "academics.manage", group: "Content", scope: "staff", label: "Academic structure", hint: "Edit institutions, faculties, departments and the course catalogue" },
  { key: "cbt.manage", group: "Content", scope: "staff", label: "CBT Builder", hint: "Write and edit practice questions" },
  { key: "utme.manage", group: "Content", scope: "staff", label: "UTME question bank", hint: "Upload, edit, remove and restore UTME CBT questions and pictures" },
  { key: "announcements.publish", group: "Content", scope: "staff", label: "Announcements", hint: "Publish platform announcements" },
  { key: "feeds.moderate", group: "Content", scope: "staff", label: "Moderate feeds", hint: "Remove posts from department feeds" },
  { key: "moderation.manage", group: "Content", scope: "staff", label: "Moderation queue", hint: "Handle reports from groups, houses and news comments: hide, warn or mute" },
  { key: "tests.manage", group: "Content", scope: "staff", label: "General tests", hint: "Set timed tests for chosen students or aspirants and see results" },
  // Operations
  { key: "requests.review", group: "Operations", scope: "staff", label: "Review requests", hint: "Approve profile-change and other requests" },
  { key: "payments.review", group: "Operations", scope: "staff", label: "Payments", hint: "Review and approve payment claims" },
  { key: "activity.view", group: "Operations", scope: "staff", label: "Activity & audit", hint: "Read the activity log and audit trail" },
  { key: "notifications.send", group: "Operations", scope: "staff", label: "Send notifications", hint: "Send notifications to users" },
  { key: "features.pro", group: "Operations", scope: "staff", label: "Pro or free features", hint: "Decide which features are Pro (paid) and which are free for everyone" },
  // Secretariat
  { key: "secretariat.records", group: "Secretariat", scope: "secretary", label: "Keep records", hint: "Write and file memos, minutes, letters and reports" },
  { key: "secretariat.confidential", group: "Secretariat", scope: "secretary", label: "Confidential records", hint: "Open records marked confidential" },
  { key: "secretariat.archive", group: "Secretariat", scope: "secretary", label: "Archive & remove", hint: "Archive or remove records" },
  { key: "secretariat.activity", group: "Secretariat", scope: "secretary", label: "Activity journal", hint: "Read the platform activity journal" },
] as const;

/** Never grantable: these stay with admins. */
export const ADMIN_ONLY = ["staff.manage", "settings.manage", "vault.recover"] as const;

const ALL_STAFF = CAPABILITIES.filter((c) => c.scope === "staff").map((c) => c.key);
const ALL_SECRETARY = CAPABILITIES.filter((c) => c.scope === "secretary").map((c) => c.key);

export const ROLE_DEFAULTS: Record<string, string[]> = {
  alphaAgent: ALL_STAFF.filter((k) => !["users.delete", "users.secretary", "academics.manage", "users.houseLeader", "houses.manage", "board.manage", "features.pro"].includes(k)),
  agent: ["users.view", "documents.review", "documents.manage", "courses.manage", "cbt.manage", "utme.manage", "announcements.publish", "feeds.moderate", "moderation.manage", "tests.manage", "requests.review"],
};
export const TAG_DEFAULTS: Record<string, string[]> = {
  secretary: ["secretariat.records", "secretariat.activity"],
};
export const TAGS = ["news", "secretary", "newsChief", "houseLeader"] as const;

const RANK: Record<string, number> = { admin: 4, alphaAgent: 3, agent: 2 };
export const rank = (role?: string | null) => RANK[role || ""] || 1;
export const isStaffRole = (role?: string | null) => rank(role) >= 2;

type Who = { role?: string | null; staffTags?: string[] | null; permissions?: unknown };

/** The capabilities a person can hold at all, given their role and duties. */
export function grantable(who: Who): string[] {
  const out: string[] = [];
  if (isStaffRole(who.role)) out.push(...ALL_STAFF);
  if ((who.staffTags || []).includes("secretary")) out.push(...ALL_SECRETARY);
  return out;
}

export function defaultCaps(who: Who): string[] {
  const out = new Set<string>(ROLE_DEFAULTS[who.role || ""] || []);
  for (const t of who.staffTags || []) for (const c of TAG_DEFAULTS[t] || []) out.add(c);
  return [...out];
}

export function effectiveCaps(who: Who): string[] {
  if (who.role === "admin") return [...CAPABILITIES.map((c) => c.key), ...ADMIN_ONLY];
  const allowed = new Set(grantable(who));
  const custom = Array.isArray(who.permissions) ? (who.permissions as unknown[]).map(String) : null;
  return (custom ?? defaultCaps(who)).filter((c) => allowed.has(c));
}

export const hasCap = (who: Who & { caps?: string[] }, cap: string) =>
  who.role === "admin" || (who.caps || effectiveCaps(who)).includes(cap);

/** Can `actor` manage `target`? Admins manage anyone; others only people below their rank. */
export function outranks(actor: { id?: string; role?: string | null }, target: { id?: string; role?: string | null }) {
  if (actor.role === "admin") return true;
  if (actor.id && actor.id === target.id) return false;
  return rank(actor.role) > rank(target.role);
}

export function requireCap(...caps: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
    if (caps.some((c) => hasCap(req.user as any, c))) return next();
    return res.status(403).json({ error: "You don't have access to this. Ask an admin to grant it.", code: "missing_capability", need: caps });
  };
}

type Tagged = { role?: string | null; staffTags?: string[] | null } | null | undefined;
export const canWriteNews = (who?: Tagged) =>
  !!who && (who.role === "admin" || (who.staffTags || []).includes("news") || (who.staffTags || []).includes("newsChief"));

/** Chief News Agent (or admin): oversees every story and every News Agent. */
export const isNewsChief = (who?: Tagged) => !!who && (who.role === "admin" || (who.staffTags || []).includes("newsChief"));

/** Holds the House Leader duty (which houses they lead is in aspirant_house_leaders). */
export const isHouseLeader = (who?: Tagged) => !!who && (who.staffTags || []).includes("houseLeader");

export const isSecretary = (who?: { role?: string | null; staffTags?: string[] | null } | null) =>
  !!who && (who.role === "admin" || (who.staffTags || []).includes("secretary"));

/** Validate a permission list an admin submits for one person. */
export function cleanPermissionList(who: Who, list: unknown): string[] {
  if (!Array.isArray(list)) throw Object.assign(new Error("permissions must be a list"), { status: 400 });
  const allowed = new Set(grantable(who));
  const out = [...new Set(list.map(String))];
  const bad = out.filter((c) => !allowed.has(c));
  if (bad.length) throw Object.assign(new Error(`Not grantable to this person: ${bad.join(", ")}`), { status: 400 });
  return out;
}
