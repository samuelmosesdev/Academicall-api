/**
 * My materials: a student's own library.
 *  - personal uploads (Document with source "personal")
 *  - materials saved from the Programme page (MaterialSave)
 *  - their own folders (MaterialFolder), up to 3 deep, that hold both
 *
 * Whether uploading is paid is decided in Admin → Billing (feature "materialUploads").
 */
import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { getBilling, premiumStatus } from "../lib/billing";

export const MY_MATERIALS_LIMITS = { maxFiles: 500, maxFileMb: 25, maxFolders: 200, maxDepth: 3 };
const COLORS = ["violet", "lemon", "aqua", "sand", "rose", "ink"] as const;

const STAFF = ["admin", "alphaAgent", "agent"];

/** Can this user upload personal materials right now? */
export async function personalUploadAccess(userId: string, role?: string) {
  if (role && STAFF.includes(role)) return { allowed: true, premiumRequired: false };
  const billing = await getBilling();
  const premiumRequired = !!billing.premium.materialUploads;
  if (!premiumRequired) return { allowed: true, premiumRequired };
  const status = await premiumStatus(userId);
  return { allowed: status.active, premiumRequired };
}

async function ownFolder(userId: string, id: string | null | undefined) {
  if (!id) return null;
  const folder = await prisma.materialFolder.findFirst({ where: { id, userId } });
  if (!folder) throw Object.assign(new Error("Folder not found"), { status: 404 });
  return folder;
}

/** Depth of a folder (top level = 1). */
async function depthOf(userId: string, id: string | null): Promise<number> {
  let depth = 0;
  let cur = id;
  while (cur && depth < 10) {
    const f: { parentId: string | null } | null = await prisma.materialFolder.findFirst({ where: { id: cur, userId }, select: { parentId: true } });
    if (!f) break;
    depth += 1;
    cur = f.parentId;
  }
  return depth;
}

/** Height of the subtree under a folder (a folder with no children = 1). */
async function heightOf(userId: string, id: string): Promise<number> {
  const kids = await prisma.materialFolder.findMany({ where: { userId, parentId: id }, select: { id: true } });
  if (!kids.length) return 1;
  const hs = await Promise.all(kids.map((k) => heightOf(userId, k.id)));
  return 1 + Math.max(...hs);
}

async function isDescendant(userId: string, folderId: string, maybeChildId: string) {
  let cur: string | null = maybeChildId;
  let guard = 0;
  while (cur && guard++ < 20) {
    if (cur === folderId) return true;
    const f: { parentId: string | null } | null = await prisma.materialFolder.findFirst({ where: { id: cur, userId }, select: { parentId: true } });
    cur = f?.parentId ?? null;
  }
  return false;
}

function fail(res: Response, err: any) {
  if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0]?.message || "Invalid input" });
  if (err?.status) return res.status(err.status).json({ error: err.message });
  console.error("[my-materials]", err);
  return res.status(500).json({ error: "Something went wrong. Try again." });
}

/** GET /my-materials */
export async function overview(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const userId = req.user.id;
    const [folders, uploads, saves, access] = await Promise.all([
      prisma.materialFolder.findMany({ where: { userId }, orderBy: [{ position: "asc" }, { name: "asc" }] }),
      prisma.document.findMany({
        where: { uploadedById: userId, source: "personal", deletedAt: null },
        select: { id: true, title: true, description: true, fileUrl: true, thumbnailUrl: true, fileName: true, fileSize: true, folderId: true, openCount: true, createdAt: true, updatedAt: true },
        orderBy: { createdAt: "desc" },
        take: MY_MATERIALS_LIMITS.maxFiles,
      }),
      prisma.materialSave.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
      personalUploadAccess(userId, req.user.role),
    ]);
    const usedBytes = uploads.reduce((n, d) => n + (d.fileSize || 0), 0);
    res.json({ folders, uploads, saves, upload: { ...access, used: uploads.length, usedBytes, ...MY_MATERIALS_LIMITS }, colors: COLORS });
  } catch (err) { fail(res, err); }
}

const folderSchema = z.object({
  name: z.string().trim().min(1, "Give the folder a name").max(60, "Keep folder names under 60 characters"),
  color: z.enum(COLORS).optional(),
  parentId: z.string().min(1).nullable().optional(),
});

/** POST /my-materials/folders */
export async function createFolder(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const userId = req.user.id;
    const body = folderSchema.parse(req.body);
    const count = await prisma.materialFolder.count({ where: { userId } });
    if (count >= MY_MATERIALS_LIMITS.maxFolders) return res.status(400).json({ error: `You can have up to ${MY_MATERIALS_LIMITS.maxFolders} folders.` });
    await ownFolder(userId, body.parentId);
    if (body.parentId && (await depthOf(userId, body.parentId)) >= MY_MATERIALS_LIMITS.maxDepth) {
      return res.status(400).json({ error: `Folders can go ${MY_MATERIALS_LIMITS.maxDepth} levels deep.` });
    }
    const position = await prisma.materialFolder.count({ where: { userId, parentId: body.parentId ?? null } });
    const folder = await prisma.materialFolder.create({ data: { userId, name: body.name, color: body.color || "violet", parentId: body.parentId ?? null, position } });
    res.status(201).json({ folder });
  } catch (err) { fail(res, err); }
}

/** PATCH /my-materials/folders/:id  { name?, color?, parentId?, position? } */
export async function updateFolder(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const userId = req.user.id;
    const folder = await ownFolder(userId, String(req.params.id));
    const body = folderSchema.partial().extend({ position: z.number().int().min(0).max(10_000).optional() }).parse(req.body);
    if (body.parentId !== undefined && body.parentId !== folder!.parentId) {
      if (body.parentId) {
        await ownFolder(userId, body.parentId);
        if (await isDescendant(userId, folder!.id, body.parentId)) return res.status(400).json({ error: "A folder can't go inside itself." });
        const depth = (await depthOf(userId, body.parentId)) + (await heightOf(userId, folder!.id));
        if (depth > MY_MATERIALS_LIMITS.maxDepth) return res.status(400).json({ error: `Folders can go ${MY_MATERIALS_LIMITS.maxDepth} levels deep.` });
      }
    }
    const updated = await prisma.materialFolder.update({ where: { id: folder!.id }, data: body });
    res.json({ folder: updated });
  } catch (err) { fail(res, err); }
}

/** DELETE /my-materials/folders/:id  — files and sub-folders move up to the parent; nothing is lost. */
export async function deleteFolder(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const userId = req.user.id;
    const folder = await ownFolder(userId, String(req.params.id));
    const parentId = folder!.parentId;
    await prisma.$transaction([
      prisma.document.updateMany({ where: { folderId: folder!.id, uploadedById: userId }, data: { folderId: parentId } }),
      prisma.materialSave.updateMany({ where: { folderId: folder!.id, userId }, data: { folderId: parentId } }),
      prisma.materialFolder.updateMany({ where: { parentId: folder!.id, userId }, data: { parentId } }),
      prisma.materialFolder.delete({ where: { id: folder!.id } }),
    ]);
    res.status(204).send();
  } catch (err) { fail(res, err); }
}

const idList = z.array(z.string().min(1)).max(500).optional().default([]);
const moveSchema = z.object({ uploads: idList, saves: idList, folders: idList, folderId: z.string().min(1).nullable() });

/** POST /my-materials/move  { uploads[], saves[], folders[], folderId|null } */
export async function moveItems(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const userId = req.user.id;
    const body = moveSchema.parse(req.body);
    await ownFolder(userId, body.folderId);
    for (const id of body.folders) {
      if (body.folderId && (await isDescendant(userId, id, body.folderId))) return res.status(400).json({ error: "A folder can't go inside itself." });
      if (body.folderId && (await depthOf(userId, body.folderId)) + (await heightOf(userId, id)) > MY_MATERIALS_LIMITS.maxDepth) {
        return res.status(400).json({ error: `Folders can go ${MY_MATERIALS_LIMITS.maxDepth} levels deep.` });
      }
    }
    const [u, s, f] = await prisma.$transaction([
      prisma.document.updateMany({ where: { id: { in: body.uploads }, uploadedById: userId, source: "personal", deletedAt: null }, data: { folderId: body.folderId } }),
      prisma.materialSave.updateMany({ where: { id: { in: body.saves }, userId }, data: { folderId: body.folderId } }),
      prisma.materialFolder.updateMany({ where: { id: { in: body.folders }, userId }, data: { parentId: body.folderId } }),
    ]);
    res.json({ moved: u.count + s.count + f.count });
  } catch (err) { fail(res, err); }
}

const removeSchema = z.object({ uploads: idList, saves: idList });

/** POST /my-materials/remove  { uploads[], saves[] } — uploads go to the bin (soft delete), saves are unsaved. */
export async function removeItems(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const userId = req.user.id;
    const body = removeSchema.parse(req.body);
    const [u, s] = await prisma.$transaction([
      prisma.document.updateMany({ where: { id: { in: body.uploads }, uploadedById: userId, source: "personal", deletedAt: null }, data: { deletedAt: new Date(), deletedById: userId } }),
      prisma.materialSave.deleteMany({ where: { id: { in: body.saves }, userId } }),
    ]);
    res.json({ removed: u.count + s.count });
  } catch (err) { fail(res, err); }
}

/** PATCH /my-materials/uploads/:id  { title?, description? } */
export async function renameUpload(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const body = z.object({ title: z.string().trim().min(1).max(160).optional(), description: z.string().trim().max(500).nullable().optional() }).parse(req.body);
    const r = await prisma.document.updateMany({ where: { id: String(req.params.id), uploadedById: req.user.id, source: "personal", deletedAt: null }, data: body });
    if (!r.count) return res.status(404).json({ error: "Material not found" });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
}

/** PATCH /my-materials/saves/:id  { title } — rename a saved material in your own library. */
export async function renameSave(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const body = z.object({ title: z.string().trim().min(1).max(160) }).parse(req.body);
    const r = await prisma.materialSave.updateMany({ where: { id: String(req.params.id), userId: req.user.id }, data: body });
    if (!r.count) return res.status(404).json({ error: "Material not found" });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
}
