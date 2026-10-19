/**
 * Audiences: "which students or aspirants is this for?"
 *
 * Used by General tests (and anything else aimed at a slice of people).
 * Every list is optional; an empty list means "no limit on this axis", and
 * the axes combine with AND. Student-only axes (faculty, department, level…)
 * never exclude aspirants, and aspirant-only axes (house, choice, UTME year)
 * never exclude students, so "UNILAG 100L students + aspirants in House Kano"
 * reads the way staff expect.
 */
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./prisma";

export const STUDENT_ROLES = ["user", "courseRep"] as const;

export const audienceSchema = z.object({
  roles: z.array(z.enum(["student", "aspirant"])).max(2).default([]),
  // students
  institutionIds: z.array(z.string()).max(200).default([]),
  facultyIds: z.array(z.string()).max(200).default([]),
  departmentIds: z.array(z.string()).max(400).default([]),
  programIds: z.array(z.string()).max(400).default([]),
  levels: z.array(z.string().max(20)).max(20).default([]),
  // aspirants
  houseIds: z.array(z.string()).max(200).default([]),
  choiceInstitutionIds: z.array(z.string()).max(200).default([]),
  utmeYears: z.array(z.string().max(8)).max(10).default([]),
  // everyone
  plans: z.array(z.enum(["free", "pro", "annual"])).max(3).default([]),
  userIds: z.array(z.string()).max(2000).default([]),
  /** Only the hand-picked people (userIds), nobody else */
  onlyPeople: z.boolean().default(false),
});
export type Audience = z.infer<typeof audienceSchema>;

/** Prisma filter for the people inside an audience. */
export function audienceWhere(a: Audience): Prisma.UserWhereInput {
  // Hand-picked people only.
  if (a.onlyPeople) return { id: { in: a.userIds }, status: "active" };

  const roles = a.roles.length ? a.roles : ["student", "aspirant"];
  const branches: Prisma.UserWhereInput[] = [];

  if (roles.includes("student")) {
    const s: Prisma.UserWhereInput[] = [{ role: { in: [...STUDENT_ROLES] } }];
    if (a.institutionIds.length) s.push({ institutionId: { in: a.institutionIds } });
    if (a.facultyIds.length) s.push({ facultyId: { in: a.facultyIds } });
    if (a.departmentIds.length) s.push({ departmentId: { in: a.departmentIds } });
    if (a.programIds.length) s.push({ programId: { in: a.programIds } });
    if (a.levels.length) s.push({ level: { in: a.levels } });
    branches.push({ AND: s });
  }
  if (roles.includes("aspirant")) {
    const s: Prisma.UserWhereInput[] = [{ role: "aspirant" }];
    if (a.houseIds.length) s.push({ houseMemberships: { some: { houseId: { in: a.houseIds }, status: { not: "removed" } } } });
    if (a.choiceInstitutionIds.length) s.push({ aspirations: { some: { institutionId: { in: a.choiceInstitutionIds } } } });
    if (a.utmeYears.length) s.push({ OR: a.utmeYears.map((y) => ({ aspirantMeta: { path: ["utmeYear"], equals: y } })) });
    branches.push({ AND: s });
  }

  const where: Prisma.UserWhereInput = { status: "active", OR: branches };
  const and: Prisma.UserWhereInput[] = [];
  if (a.plans.length) and.push({ plan: { in: a.plans } });
  if (and.length) where.AND = and;
  // Extra hand-picked people on top of the groups.
  if (a.userIds.length) return { OR: [where, { id: { in: a.userIds }, status: "active" }] };
  return where;
}

export const audienceCount = (a: Audience) => prisma.user.count({ where: audienceWhere(a) });

export async function inTestAudience(userId: string, a: Audience) {
  const n = await prisma.user.count({ where: { AND: [{ id: userId }, audienceWhere(a)] } });
  return n > 0;
}

/** A short human summary, e.g. "Aspirants in 2 houses · Students at 1 institution, 100L". */
export function audienceSummary(a: Audience) {
  if (a.onlyPeople) return `${a.userIds.length} chosen ${a.userIds.length === 1 ? "person" : "people"}`;
  const roles = a.roles.length ? a.roles : ["student", "aspirant"];
  const parts: string[] = [];
  if (roles.includes("student")) {
    const bits = [
      a.institutionIds.length && `${a.institutionIds.length} institution${a.institutionIds.length > 1 ? "s" : ""}`,
      a.facultyIds.length && `${a.facultyIds.length} facult${a.facultyIds.length > 1 ? "ies" : "y"}`,
      a.departmentIds.length && `${a.departmentIds.length} department${a.departmentIds.length > 1 ? "s" : ""}`,
      a.programIds.length && `${a.programIds.length} programme${a.programIds.length > 1 ? "s" : ""}`,
      a.levels.length && a.levels.join(", "),
    ].filter(Boolean);
    parts.push(bits.length ? `Students · ${bits.join(" · ")}` : "All students");
  }
  if (roles.includes("aspirant")) {
    const bits = [
      a.houseIds.length && `${a.houseIds.length} house${a.houseIds.length > 1 ? "s" : ""}`,
      a.choiceInstitutionIds.length && `choosing ${a.choiceInstitutionIds.length} institution${a.choiceInstitutionIds.length > 1 ? "s" : ""}`,
      a.utmeYears.length && `UTME ${a.utmeYears.join(", ")}`,
    ].filter(Boolean);
    parts.push(bits.length ? `Aspirants · ${bits.join(" · ")}` : "All aspirants");
  }
  if (a.plans.length) parts.push(a.plans.join("/") + " plan");
  if (a.userIds.length) parts.push(`+${a.userIds.length} chosen`);
  return parts.join(" + ");
}
