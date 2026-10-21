/**
 * Material sharing.
 *
 * A student sends a file (an upload or a saved material) or a whole folder from
 * My materials to another user, found by that user's Unique ID, with an optional
 * comment. The recipient gets a notification and an inbox on the Materials page;
 * Accept copies the file or folder tree into their own library, Decline closes it.
 * The sender sees what they've sent and whether it was accepted.
 *
 * Feature key "materialSharing". Admin → Features can switch it off or limit it;
 * Admin → Features / Billing (or staff holding "features.pro") decide whether it
 * is Pro. When it's Pro only sending is paid: receiving and accepting stay free.
 *
 * Also here: the admin/staff read-only view of a user's material folders, and the
 * Pro-or-free switch for features (GET/PUT /admin/pro-features).
 */
import { Request } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { handle, HttpError } from "../lib/http";
import { audit } from "../lib/audit";
import { notifyMany } from "../lib/notify";
import { getBilling, premiumStatus, saveBilling } from "../lib/billing";
import { FEATURES, getFeatureState, offFor, viewerFrom } from "../lib/features";
import { isStaffRole } from "../lib/access";
import { MY_MATERIALS_LIMITS } from "./myMaterials.controller";

export const SHARE_FEATURE = "materialSharing";
const INBOX_LINK = "/dashboard/materials?f=shared";
const SENT_LINK = "/dashboard/materials?f=shared&box=sent";
const MAX_FOLDER_FILES = 200;

const displayName = (u: { nickname?: string | null; name?: string | null } | null | undefined) => u?.nickname || u?.name || "Someone";
const publicUser = (u: any) => (u ? { id: u.id, name: displayName(u), uniqueId: u.uniqueId || null, avatarUrl: u.photoUrl || u.avatarUrl || null } : null);
const USER_PUBLIC = { id: true, name: true, nickname: true, uniqueId: true, photoUrl: true, avatarUrl: true } as const;

/** Is sharing on for this caller, and do they need Pro to send? */
export async function shareAccess(req: Request) {
  const staff = isStaffRole(req.user?.role);
  const [state, billing] = await Promise.all([getFeatureState(), getBilling()]);
  const viewer = await viewerFrom(req);
  const enabled = staff || !offFor(state, viewer).includes(SHARE_FEATURE);
  const premiumRequired = !!billing.premium[SHARE_FEATURE];
  let canSend = enabled;
  if (enabled && premiumRequired && !staff) canSend = (await premiumStatus(req.user!.id)).active;
  return { enabled, premiumRequired, canSend };
}

async function requireOn(req: Request) {
  const access = await shareAccess(req);
  if (!access.enabled) throw new HttpError(403, "Material sharing isn't available right now.", "feature_off", { feature: SHARE_FEATURE });
  return access;
}

async function requireSend(req: Request) {
  const access = await requireOn(req);
  if (!access.canSend) {
    throw new HttpError(402, "Sharing materials is a Pro feature. Upgrade to send files and folders to classmates.", "premium_required", { feature: SHARE_FEATURE });
  }
  return access;
}

const normalizeId = (s: unknown) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, "");

/** Finds the recipient by Unique ID; friendly errors for self, unknown, blocked. */
async function findRecipient(senderId: string, rawId: unknown) {
  const uniqueId = normalizeId(rawId);
  if (uniqueId.length < 3) throw new HttpError(400, "Enter their Unique ID, e.g. UAR-24-8831.");
  const user = await prisma.user.findFirst({
    where: { uniqueId: { equals: uniqueId, mode: "insensitive" }, status: "active" },
    select: USER_PUBLIC,
  });
  if (!user) throw new HttpError(404, "No one has that Unique ID. Check it and try again.", "not_found");
  if (user.id === senderId) throw new HttpError(400, "That's your own Unique ID. Enter a classmate's.", "self");
  const blocked = await prisma.userBlock.findFirst({
    where: { OR: [{ blockerId: user.id, blockedId: senderId }, { blockerId: senderId, blockedId: user.id }] },
    select: { blockerId: true },
  });
  if (blocked) throw new HttpError(403, "You can't share with this person.", "blocked");
  return user;
}

/* ── folder tree helpers ─────────────────────────────── */
type Tree = { folders: { id: string; parentId: string | null; name: string; color: string; position: number }[]; uploads: any[]; saves: any[] };

/** Every folder under (and including) rootId, with the files inside. */
async function folderTree(userId: string, rootId: string): Promise<Tree> {
  const all = await prisma.materialFolder.findMany({ where: { userId }, select: { id: true, parentId: true, name: true, color: true, position: true } });
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of all) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true; }
  }
  const folders = all.filter((f) => ids.has(f.id));
  const [uploads, saves] = await Promise.all([
    prisma.document.findMany({ where: { uploadedById: userId, source: "personal", deletedAt: null, folderId: { in: [...ids] } } }),
    prisma.materialSave.findMany({ where: { userId, folderId: { in: [...ids] } } }),
  ]);
  return { folders, uploads, saves };
}

/* ── sending ─────────────────────────────────────────── */

/** GET /material-shares/recipient?uniqueId=… — preview who you're sending to (name + picture, never email). */
export const lookupRecipient = handle(async (req, res) => {
  await requireSend(req);
  const user = await findRecipient(req.user!.id, req.query.uniqueId);
  res.json({ recipient: publicUser(user) });
});

const sendSchema = z.object({
  uniqueId: z.string().trim().min(1, "Enter their Unique ID").max(40),
  itemType: z.enum(["upload", "save", "folder"]),
  itemId: z.string().min(1).max(64),
  comment: z.string().trim().max(500, "Keep the note under 500 characters").optional().nullable(),
});

/** POST /material-shares { uniqueId, itemType, itemId, comment? } */
export const sendShare = handle(async (req, res) => {
  await requireSend(req);
  const me = req.user!;
  const body = sendSchema.parse(req.body);
  const recipient = await findRecipient(me.id, body.uniqueId);

  let title = "";
  let fileCount = 0;
  let folderCount = 0;
  if (body.itemType === "upload") {
    const d = await prisma.document.findFirst({ where: { id: body.itemId, uploadedById: me.id, source: "personal", deletedAt: null }, select: { title: true, fileName: true } });
    if (!d) throw new HttpError(404, "That file isn't in your materials any more.");
    title = d.title || d.fileName || "Untitled";
    fileCount = 1;
  } else if (body.itemType === "save") {
    const s = await prisma.materialSave.findFirst({ where: { id: body.itemId, userId: me.id } });
    if (!s) throw new HttpError(404, "That material isn't in your library any more.");
    title = s.title || (s.meta as any)?.title || "Saved material";
    fileCount = 1;
  } else {
    const f = await prisma.materialFolder.findFirst({ where: { id: body.itemId, userId: me.id } });
    if (!f) throw new HttpError(404, "That folder isn't in your materials any more.");
    const tree = await folderTree(me.id, f.id);
    fileCount = tree.uploads.length + tree.saves.length;
    folderCount = tree.folders.length - 1;
    if (!fileCount && !folderCount) throw new HttpError(400, "That folder is empty. Add something to it first.");
    if (fileCount > MAX_FOLDER_FILES) throw new HttpError(400, `Folders can be shared with up to ${MAX_FOLDER_FILES} files.`);
    title = f.name;
  }

  const dup = await prisma.materialShare.findFirst({ where: { senderId: me.id, recipientId: recipient.id, itemType: body.itemType, itemId: body.itemId, status: "pending" }, select: { id: true } });
  if (dup) throw new HttpError(409, `You've already sent this to ${displayName(recipient)}. It's waiting for them to accept.`);

  const recent = await prisma.materialShare.count({ where: { senderId: me.id, createdAt: { gt: new Date(Date.now() - 3600_000) } } });
  if (recent >= 60) throw new HttpError(429, "You've shared a lot in the last hour. Try again a little later.");

  const kind = body.itemType === "folder" ? "folder" : "file";
  const share = await prisma.materialShare.create({
    data: { senderId: me.id, recipientId: recipient.id, kind, itemType: body.itemType, itemId: body.itemId, title: title.slice(0, 160), fileCount, folderCount, comment: body.comment || null },
  });

  const sender = await prisma.user.findUnique({ where: { id: me.id }, select: USER_PUBLIC });
  await notifyMany([recipient.id], {
    type: "general",
    title: `${displayName(sender)} shared a ${kind === "folder" ? "folder" : "material"} with you`,
    body: body.comment ? `“${body.comment}” · ${title}` : title,
    data: { link: INBOX_LINK, kind: "material_share", shareId: share.id },
    createdById: me.id,
  });
  res.status(201).json({ share: { ...share, recipient: publicUser(recipient) } });
});

/** GET /material-shares — what's waiting for me, what I've sent, and whether I can send. */
export const listShares = handle(async (req, res) => {
  const access = await requireOn(req);
  const me = req.user!.id;
  const [incoming, sent] = await Promise.all([
    prisma.materialShare.findMany({ where: { recipientId: me, status: { in: ["pending", "accepted"] } }, include: { sender: { select: USER_PUBLIC } }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.materialShare.findMany({ where: { senderId: me }, include: { recipient: { select: USER_PUBLIC } }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  res.json({
    incoming: incoming.map(({ sender, ...s }) => ({ ...s, sender: publicUser(sender) })),
    sent: sent.map(({ recipient, ...s }) => ({ ...s, recipient: publicUser(recipient) })),
    pending: incoming.filter((s) => s.status === "pending").length,
    access,
  });
});

async function pendingFor(req: Request, field: "recipientId" | "senderId") {
  const share = await prisma.materialShare.findFirst({ where: { id: String(req.params.id), [field]: req.user!.id } });
  if (!share) throw new HttpError(404, "That share isn't here any more.");
  if (share.status !== "pending") throw new HttpError(409, share.status === "cancelled" ? "The sender took this back." : `This was already ${share.status}.`);
  return share;
}

/** Pick a top-level folder name the recipient doesn't already have. */
async function freeName(userId: string, name: string) {
  const taken = new Set((await prisma.materialFolder.findMany({ where: { userId, parentId: null }, select: { name: true } })).map((f) => f.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; i < 100; i += 1) {
    const n = `${name.slice(0, 54)} (${i})`;
    if (!taken.has(n.toLowerCase())) return n;
  }
  return `${name.slice(0, 50)} (shared)`;
}

/** POST /material-shares/:id/accept — copy it into my library. */
export const acceptShare = handle(async (req, res) => {
  await requireOn(req);
  const me = req.user!;
  const share = await pendingFor(req, "recipientId");
  const recipient = await prisma.user.findUnique({ where: { id: me.id }, select: { institutionId: true, ...USER_PUBLIC } });
  const [myFiles, myFolders] = await Promise.all([
    prisma.document.count({ where: { uploadedById: me.id, source: "personal", deletedAt: null } }),
    prisma.materialFolder.count({ where: { userId: me.id } }),
  ]);
  const gone = () => {
    throw new HttpError(410, `${share.kind === "folder" ? "This folder" : "This file"} was removed by the sender, so it can't be added.`);
  };
  const now = new Date();
  const docCopy = (d: any, folderId: string | null) => ({
    title: d.title, description: d.description, fileUrl: d.fileUrl, thumbnailUrl: d.thumbnailUrl, fileName: d.fileName, fileSize: d.fileSize,
    source: "personal", status: "approved", approvedAt: now, uploadedById: me.id, institutionId: recipient?.institutionId || null, folderId,
  });
  const saveCopy = (s: any, folderId: string | null) => ({ userId: me.id, materialId: s.materialId, title: s.title, url: s.url, meta: s.meta ?? undefined, folderId });

  let copiedFolderId: string | null = null;
  if (share.itemType === "upload") {
    const d = await prisma.document.findFirst({ where: { id: share.itemId, uploadedById: share.senderId, source: "personal", deletedAt: null } });
    if (!d) gone();
    if (myFiles + 1 > MY_MATERIALS_LIMITS.maxFiles) throw new HttpError(400, `Your library is full (${MY_MATERIALS_LIMITS.maxFiles} files). Delete something first.`);
    await prisma.document.create({ data: docCopy(d, null) });
  } else if (share.itemType === "save") {
    const s = await prisma.materialSave.findFirst({ where: { id: share.itemId, userId: share.senderId } });
    if (!s) gone();
    await prisma.materialSave.create({ data: saveCopy(s, null) });
  } else {
    const root = await prisma.materialFolder.findFirst({ where: { id: share.itemId, userId: share.senderId } });
    if (!root) gone();
    const tree = await folderTree(share.senderId, root!.id);
    if (myFolders + tree.folders.length > MY_MATERIALS_LIMITS.maxFolders) throw new HttpError(400, `You can have up to ${MY_MATERIALS_LIMITS.maxFolders} folders. Delete a few first.`);
    if (myFiles + tree.uploads.length > MY_MATERIALS_LIMITS.maxFiles) throw new HttpError(400, `Your library would go over ${MY_MATERIALS_LIMITS.maxFiles} files. Delete something first.`);
    const rootName = await freeName(me.id, root!.name);
    copiedFolderId = await prisma.$transaction(async (tx) => {
      const map = new Map<string, string>();
      const topPos = await tx.materialFolder.count({ where: { userId: me.id, parentId: null } });
      // Parents before children: walk the tree level by level from the root.
      let level = [root!.id];
      while (level.length) {
        const next: string[] = [];
        for (const id of level) {
          const f = tree.folders.find((x) => x.id === id)!;
          const created = await tx.materialFolder.create({
            data: { userId: me.id, name: id === root!.id ? rootName : f.name, color: f.color, position: id === root!.id ? topPos : f.position, parentId: id === root!.id ? null : map.get(f.parentId!)! },
          });
          map.set(id, created.id);
          next.push(...tree.folders.filter((x) => x.parentId === id).map((x) => x.id));
        }
        level = next;
      }
      if (tree.uploads.length) await tx.document.createMany({ data: tree.uploads.map((d) => docCopy(d, map.get(d.folderId)!)) });
      if (tree.saves.length) await tx.materialSave.createMany({ data: tree.saves.map((s) => saveCopy(s, map.get(s.folderId)!)) });
      return map.get(root!.id)!;
    });
  }

  const done = await prisma.materialShare.update({ where: { id: share.id }, data: { status: "accepted", respondedAt: now, copiedFolderId } });
  await notifyMany([share.senderId], {
    type: "general",
    title: `${displayName(recipient)} added your ${share.kind === "folder" ? "folder" : "material"}`,
    body: share.title,
    data: { link: SENT_LINK, kind: "material_share_reply", shareId: share.id },
    createdById: me.id,
  });
  res.json({ share: done, folderId: copiedFolderId });
});

/** POST /material-shares/:id/decline */
export const declineShare = handle(async (req, res) => {
  await requireOn(req);
  const share = await pendingFor(req, "recipientId");
  const done = await prisma.materialShare.update({ where: { id: share.id }, data: { status: "declined", respondedAt: new Date() } });
  res.json({ share: done });
});

/** DELETE /material-shares/:id — the sender takes back a share that hasn't been answered. */
export const cancelShare = handle(async (req, res) => {
  const share = await pendingFor(req, "senderId");
  const done = await prisma.materialShare.update({ where: { id: share.id }, data: { status: "cancelled", respondedAt: new Date() } });
  res.json({ share: done });
});

/* ── staff: a user's material folders (read-only) ────── */

/** GET /users/:id/materials */
export const userMaterials = handle(async (req, res) => {
  const userId = String(req.params.id);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new HttpError(404, "User not found");
  const [folders, uploads, saves] = await Promise.all([
    prisma.materialFolder.findMany({ where: { userId }, select: { id: true, parentId: true, name: true, color: true, position: true, createdAt: true }, orderBy: [{ position: "asc" }, { name: "asc" }] }),
    prisma.document.findMany({
      where: { uploadedById: userId, source: "personal", deletedAt: null },
      select: { id: true, title: true, fileName: true, fileUrl: true, fileSize: true, folderId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: MY_MATERIALS_LIMITS.maxFiles,
    }),
    prisma.materialSave.findMany({ where: { userId }, select: { id: true, title: true, url: true, meta: true, folderId: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 1000 }),
  ]);
  res.json({
    folders,
    files: [
      ...uploads.map((d) => ({ id: d.id, type: "upload", title: d.title || d.fileName || "Untitled", fileName: d.fileName, url: d.fileUrl, size: d.fileSize || 0, folderId: d.folderId, createdAt: d.createdAt })),
      ...saves.map((s) => {
        const m = (s.meta || {}) as any;
        return { id: s.id, type: "save", title: s.title || m.title || "Saved material", fileName: m.fileName || null, url: s.url || m.fileUrl || m.url || null, size: m.fileSize || 0, folderId: s.folderId, createdAt: s.createdAt, course: m.course?.code || m.courseCode || null };
      }),
    ],
  });
});

/* ── Pro or free, per feature ────────────────────────── */

/** GET /admin/pro-features */
export const proFeatures = handle(async (_req, res) => {
  const billing = await getBilling(true);
  res.json({
    features: FEATURES.filter((f) => f.key !== "upgrade").map((f) => ({ key: f.key, label: f.label, group: f.group, pro: !!billing.premium[f.key] })),
  });
});

/** PUT /admin/pro-features/:key { pro } */
export const setProFeature = handle(async (req, res) => {
  const key = String(req.params.key);
  const f = FEATURES.find((x) => x.key === key);
  if (!f || key === "upgrade") throw new HttpError(404, "Unknown feature");
  const { pro } = z.object({ pro: z.boolean() }).parse(req.body);
  const billing = await getBilling(true);
  const premium = { ...billing.premium };
  if (pro) premium[key] = true;
  else delete premium[key];
  await saveBilling({ ...billing, premium });
  await audit(req.user as any, pro ? "feature.pro" : "feature.free", { id: key, label: f.label });
  res.json({ key, pro });
});
