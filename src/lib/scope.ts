import { prisma } from "./prisma";

/** Every record created before multi-institution support belongs to the University of Abuja. */
export const DEFAULT_INSTITUTION_ID = "uofa";

export function norm(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function normLevel(value: unknown) {
  return norm(value).replace(/\s*level\s*/g, "").replace(/\s+/g, "");
}

export interface ScopedUser {
  id: string;
  role: string;
  name: string | null;
  email: string;
  photoUrl: string | null;
  avatarUrl: string | null;
  institutionId: string | null;
  faculty: string | null;
  department: string | null;
  program: string | null;
  level: string | null;
  courseRepMeta: any;
}

export async function loadScopedUser(userId: string): Promise<ScopedUser | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, role: true, name: true, email: true, photoUrl: true, avatarUrl: true,
      institutionId: true, faculty: true, department: true, program: true, level: true, courseRepMeta: true,
    },
  }) as Promise<ScopedUser | null>;
}

export function institutionOf(user: { institutionId?: string | null } | null | undefined) {
  return user?.institutionId || DEFAULT_INSTITUTION_ID;
}

/** Programme-hub scope string (kept identical to the existing UofA behaviour: programme first). */
export function programmeScope(user: any) {
  const meta = (user?.courseRepMeta || {}) as Record<string, any>;
  return String(meta.program || user?.program || meta.department || user?.department || "").trim();
}

export function programmeScopeKey(institutionId: string | null | undefined, scope: string) {
  return `programme:${institutionId || DEFAULT_INSTITUTION_ID}:${norm(scope)}`;
}

export function isStaffRole(role?: string | null) {
  return ["admin", "alphaAgent", "agent"].includes(String(role || ""));
}

export function displayName(user: { name?: string | null; email?: string | null } | null | undefined) {
  return user?.name || (user?.email ? user.email.split("@")[0] : "Student");
}
