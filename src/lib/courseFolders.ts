/**
 * Automatic folders in a student's My materials / Documents page:
 *
 *   [Programme] [Level]            e.g. "Medicine 300 Level"
 *   ├── First Semester
 *   │   └── BIO 401 - Ecology in Biology        one per course the student offers that semester
 *   └── Second Semester
 *
 * They are ordinary MaterialFolder rows (so move / rename / delete / pin all keep working), marked with
 * `kind` + `autoKey` so they are never created twice. A folder the student deletes on purpose is remembered
 * (settings.dismissedFolders) and is not rebuilt; adding that course again brings its folder back.
 *
 * Course Rep materials that carry a course code are saved into every student's folder for that course.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export const normCode = (code?: string | null) => {
  const c = String(code || "").toUpperCase().replace(/\s+/g, " ").trim();
  const m = /^([A-Z]{2,5})\s*-?\s*(\d{3}[A-Z]?)$/.exec(c);
  return m ? `${m[1]} ${m[2]}` : c;
};
const scope = (v: unknown) => String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
const levelKey = (v: unknown) => scope(v).replace(/\s*level\s*/g, "");
const levelsMatch = (a: unknown, b: unknown) => Boolean(levelKey(a) && levelKey(a) === levelKey(b));

export const levelLabel = (level: string) => (/^\d{3}$/.test(level.trim()) ? `${level.trim()} Level` : level.trim());
export const semesterOf = (raw?: string | null): "first" | "second" => {
  const v = scope(raw);
  if (/^(2|ii|second|2nd|rain)/.test(v)) return "second";
  return "first"; // first, harmattan, or unknown
};
const clip = (text: string) => (text.length > 60 ? `${text.slice(0, 57).trimEnd()}...` : text);
const courseFolderName = (code: string, title: string) => clip(code && title ? `${code} - ${title}` : code || title || "Course");
const MAX_FOLDERS = 200;

type Settings = Record<string, any>;
const asSettings = (v: unknown): Settings => (v && typeof v === "object" && !Array.isArray(v) ? (v as Settings) : {});

async function academicScope(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, program: true, department: true, level: true, courseRepMeta: true, settings: true },
  });
  if (!user) return null;
  const meta = (user.courseRepMeta || {}) as { program?: string; level?: string };
  const isRep = user.role === "courseRep";
  const program = String((isRep ? meta.program : "") || user.program || user.department || "").trim();
  const level = String((isRep ? meta.level : "") || user.level || "").trim();
  return { program, level, settings: asSettings(user.settings) };
}

async function saveDismissed(userId: string, settings: Settings, list: string[]) {
  await prisma.user.update({ where: { id: userId }, data: { settings: { ...settings, dismissedFolders: list } as Prisma.InputJsonValue } });
}

/** Put one material into one student's folder, once. */
async function saveInto(userId: string, folderId: string, doc: { id: string; title: string; fileUrl: string | null; fileName: string | null; fileSize: number | null }, code: string) {
  const dup = await prisma.materialSave.findFirst({ where: { userId, materialId: doc.id }, select: { id: true } });
  if (dup) return;
  await prisma.materialSave.create({
    data: {
      userId, folderId, materialId: doc.id, title: doc.title, url: doc.fileUrl,
      meta: { fileName: doc.fileName, fileSize: doc.fileSize, courseCode: code, source: "courseRep", auto: true },
    },
  });
}

/** Approved Course Rep materials for this programme, level and course code. */
async function repMaterialsFor(program: string, level: string, code: string) {
  const docs = await prisma.document.findMany({
    where: {
      source: "courseRep", status: "approved", deletedAt: null,
      department: { equals: program, mode: "insensitive" },
      OR: [{ courseCode: { equals: code, mode: "insensitive" } }, { course: { code: { equals: code, mode: "insensitive" } } }],
    },
    select: { id: true, title: true, fileUrl: true, fileName: true, fileSize: true, level: true },
    orderBy: { createdAt: "asc" },
    take: 300,
  });
  return docs.filter((d) => levelsMatch(d.level, level));
}

/**
 * Make sure the student has their programme folder, both semester folders, and one folder for each course
 * they offer. Only creates what is missing. `restoreCodes` brings back folders for courses they just re-added.
 */
export async function syncCourseFolders(userId: string, opts: { restoreCodes?: string[] } = {}) {
  const sc = await academicScope(userId);
  if (!sc || !sc.program || !sc.level) return;
  let dismissed: string[] = Array.isArray(sc.settings.dismissedFolders) ? sc.settings.dismissedFolders : [];
  const restore = (opts.restoreCodes || []).map((c) => `course:${normCode(c)}`);
  if (restore.some((k) => dismissed.includes(k))) {
    dismissed = dismissed.filter((k) => !restore.includes(k));
    await saveDismissed(userId, sc.settings, dismissed);
  }

  const [enrollments, existing] = await Promise.all([
    prisma.enrollment.findMany({ where: { userId }, include: { course: true }, orderBy: { createdAt: "asc" } }),
    prisma.materialFolder.findMany({ where: { userId, autoKey: { not: null } } }),
  ]);
  const byKey = new Map(existing.map((f) => [f.autoKey as string, f]));
  let total = await prisma.materialFolder.count({ where: { userId } });

  async function ensure(key: string, data: Omit<Prisma.MaterialFolderUncheckedCreateInput, "userId" | "autoKey">) {
    const hit = byKey.get(key);
    if (hit) return { folder: hit, created: false };
    if (dismissed.includes(key) || total >= MAX_FOLDERS) return null;
    try {
      const folder = await prisma.materialFolder.create({ data: { ...data, userId, autoKey: key } });
      byKey.set(key, folder);
      total += 1;
      return { folder, created: true };
    } catch (err: any) {
      if (err?.code !== "P2002") throw err;
      const folder = await prisma.materialFolder.findFirst({ where: { userId, autoKey: key } });
      return folder ? { folder, created: false } : null;
    }
  }

  const lk = levelKey(sc.level);
  const root = await ensure(`programme:${lk}`, { name: clip(`${sc.program} ${levelLabel(sc.level)}`), kind: "programme", color: "violet", parentId: null, position: 0 });
  if (!root) return;
  const semesters = {
    first: await ensure(`sem:${lk}:first`, { name: "First Semester", kind: "semester", semester: "first", color: "aqua", parentId: root.folder.id, position: 0 }),
    second: await ensure(`sem:${lk}:second`, { name: "Second Semester", kind: "semester", semester: "second", color: "lemon", parentId: root.folder.id, position: 1 }),
  };

  const fresh: { folderId: string; code: string }[] = [];
  for (const e of enrollments) {
    if (e.course?.archivedAt) continue;
    const code = normCode(e.course?.code || e.courseCode);
    const title = String(e.course?.title || e.courseTitle || "").trim();
    if (!code && !title) continue;
    const key = `course:${code || title.toUpperCase()}`;
    const sem = semesters[semesterOf(e.course?.semester)];
    if (!sem && !byKey.has(key)) continue;
    const made = await ensure(key, {
      name: courseFolderName(code, title), kind: "course", courseCode: code || null,
      semester: semesterOf(e.course?.semester), color: "violet", parentId: sem!.folder.id,
      position: byKey.size,
    });
    if (made?.created && code) fresh.push({ folderId: made.folder.id, code });
  }

  // New course folder: drop in the materials the Course Rep already posted for that course.
  for (const f of fresh) {
    for (const doc of await repMaterialsFor(sc.program, sc.level, f.code)) await saveInto(userId, f.folderId, doc, f.code);
  }
}

/** A Course Rep just posted a material with a course code: save it into each student's folder for that course. */
export async function fanOutMaterial(docId: string) {
  const doc = await prisma.document.findUnique({ where: { id: docId }, include: { course: { select: { code: true } } } });
  if (!doc || doc.source !== "courseRep" || doc.status !== "approved" || doc.deletedAt || !doc.department) return;
  const code = normCode(doc.courseCode || doc.course?.code);
  if (!code) return;
  const rows = await prisma.enrollment.findMany({
    where: {
      OR: [
        { courseCode: { equals: code, mode: "insensitive" } },
        { course: { code: { equals: code, mode: "insensitive" } } },
        ...(doc.courseId ? [{ courseId: doc.courseId }] : []),
      ],
      user: { OR: [{ program: { equals: doc.department, mode: "insensitive" } }, { department: { equals: doc.department, mode: "insensitive" } }] },
    },
    select: { userId: true, user: { select: { level: true } } },
    take: 5000,
  });
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.userId) || (doc.level && r.user?.level && !levelsMatch(doc.level, r.user.level))) continue;
    seen.add(r.userId);
    try {
      let folder = await prisma.materialFolder.findFirst({ where: { userId: r.userId, autoKey: `course:${code}` } });
      if (!folder) {
        await syncCourseFolders(r.userId);
        folder = await prisma.materialFolder.findFirst({ where: { userId: r.userId, autoKey: `course:${code}` } });
      }
      if (folder) await saveInto(r.userId, folder.id, doc, code);
    } catch (err) {
      console.error("[course-folders] fan-out failed for", r.userId, err);
    }
  }
}

/** Remove a course folder the student asked to delete. Its files move up to the semester folder; nothing is lost. */
export async function deleteCourseFolder(userId: string, rawCode: string) {
  const key = `course:${normCode(rawCode)}`;
  const folder = await prisma.materialFolder.findFirst({ where: { userId, autoKey: key } });
  if (!folder) return;
  await prisma.$transaction([
    prisma.document.updateMany({ where: { folderId: folder.id, uploadedById: userId }, data: { folderId: folder.parentId } }),
    prisma.materialSave.updateMany({ where: { folderId: folder.id, userId }, data: { folderId: folder.parentId } }),
    prisma.materialFolder.updateMany({ where: { parentId: folder.id, userId }, data: { parentId: folder.parentId } }),
    prisma.materialFolder.delete({ where: { id: folder.id } }),
  ]);
  await rememberDismissed(userId, key);
}

/** The student deleted an automatic folder themselves: don't rebuild it. */
export async function rememberDismissed(userId: string, key: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
  const settings = asSettings(user?.settings);
  const list: string[] = Array.isArray(settings.dismissedFolders) ? settings.dismissedFolders : [];
  if (!list.includes(key)) await saveDismissed(userId, settings, [...list, key].slice(-300));
}
