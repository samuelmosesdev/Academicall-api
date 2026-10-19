/**
 * Premium billing (Paystack).
 *
 * The admin controls everything from Admin → Billing, stored in one Setting row
 * (key "billing"):
 *   plans    which plans exist, their price (naira), length in days, perks, on/off
 *   premium  which features are paid ({ [featureKey]: true }); anything not listed is free
 *   page     the words on the upgrade page (headline, subheadline, note, FAQ, support email)
 *
 * Money only ever moves through Paystack. The API starts the checkout itself
 * (amount comes from the plan, never from the browser) and activates the plan
 * after Paystack confirms it, by webhook or by the verify call when the user
 * comes back from checkout. Both paths are idempotent on the payment reference.
 *
 * Env: PAYSTACK_SECRET_KEY (required), PUBLIC_APP_URL (checkout return address).
 */
import { NextFunction, Request, Response } from "express";
import { prisma } from "./prisma";
import { featureForPath, viewerFrom, FEATURES } from "./features";

export const BILLING_KEY = "billing";

export type BillingPlan = { id: string; name: string; amount: number; days: number; perks: string[]; active: boolean; highlight?: boolean };
export type BillingPage = { headline: string; subheadline: string; note: string; supportEmail: string; faq: { q: string; a: string }[] };
export type BillingState = { currency: "NGN"; plans: BillingPlan[]; premium: Record<string, boolean>; page: BillingPage };

export const DEFAULT_BILLING: BillingState = {
  currency: "NGN",
  plans: [
    { id: "monthly", name: "Monthly", amount: 1500, days: 30, perks: ["All premium features", "Cancel any time — it simply runs out"], active: false },
    { id: "annual", name: "Annual", amount: 4000, days: 365, perks: ["All premium features", "Best value for the session"], active: true, highlight: true },
  ],
  premium: {},
  page: {
    headline: "Academicall Premium",
    subheadline: "Unlock every study tool for your session.",
    note: "Payments are processed securely by Paystack. Your plan starts as soon as payment is confirmed.",
    supportEmail: "",
    faq: [{ q: "Does it renew automatically?", a: "No. When your plan ends you go back to the free features until you pay again." }],
  },
};

let cache: { at: number; state: BillingState } | null = null;

export async function getBilling(fresh = false): Promise<BillingState> {
  if (!fresh && cache && Date.now() - cache.at < 15_000) return cache.state;
  const row = await prisma.setting.findUnique({ where: { key: BILLING_KEY } });
  const v = (row?.value || {}) as Partial<BillingState>;
  const state: BillingState = {
    currency: "NGN",
    plans: Array.isArray(v.plans) ? v.plans : DEFAULT_BILLING.plans,
    premium: v.premium && typeof v.premium === "object"
      ? Object.fromEntries(Object.entries(v.premium).filter(([key, enabled]) => key !== "upgrade" && enabled === true && FEATURES.some((feature) => feature.key === key)))
      : {},
    page: { ...DEFAULT_BILLING.page, ...(v.page || {}) },
  };
  cache = { at: Date.now(), state };
  return state;
}

export async function saveBilling(state: BillingState) {
  await prisma.setting.upsert({ where: { key: BILLING_KEY }, create: { key: BILLING_KEY, value: state as any }, update: { value: state as any } });
  cache = null;
}

const clean = (s: unknown, max = 300) => String(s ?? "").trim().slice(0, max);

/** Validates an admin's edit. Throws a readable message on bad input. */
export function sanitizeBilling(input: any): BillingState {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Billing settings must be an object.");
  const keys = new Set(FEATURES.map((f) => f.key as string).filter((key) => key !== "upgrade"));
  const ids = new Set<string>();
  const sourcePlans = input.plans ?? [];
  if (!Array.isArray(sourcePlans) || sourcePlans.length > 8) throw new Error("Billing can have at most eight plans.");
  const plans: BillingPlan[] = sourcePlans.map((p: any) => {
    const id = clean(p.id, 24).toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!id || ids.has(id)) throw new Error("Each plan needs its own short id (letters, numbers, dashes).");
    ids.add(id);
    const amount = Math.round(Number(p.amount));
    const days = Math.round(Number(p.days));
    if (!(amount >= 100 && amount <= 5_000_000)) throw new Error(`${id}: price must be between ₦100 and ₦5,000,000.`);
    if (!(days >= 1 && days <= 730)) throw new Error(`${id}: length must be 1 to 730 days.`);
    return {
      id, amount, days,
      name: clean(p.name, 40) || id,
      perks: (Array.isArray(p.perks) ? p.perks : []).map((x: any) => clean(x, 120)).filter(Boolean).slice(0, 10),
      active: !!p.active,
      highlight: !!p.highlight,
    };
  });
  const premium: Record<string, boolean> = {};
  for (const [k, on] of Object.entries(input?.premium || {})) if (on && keys.has(k)) premium[k] = true;
  const pg = input?.page || {};
  const page: BillingPage = {
    headline: clean(pg.headline, 80) || DEFAULT_BILLING.page.headline,
    subheadline: clean(pg.subheadline, 200),
    note: clean(pg.note, 400),
    supportEmail: clean(pg.supportEmail, 120),
    faq: (Array.isArray(pg.faq) ? pg.faq : []).map((f: any) => ({ q: clean(f?.q, 160), a: clean(f?.a, 600) })).filter((f: any) => f.q && f.a).slice(0, 12),
  };
  return { currency: "NGN", plans, premium, page };
}

/** Current premium status, expiring a lapsed plan on the way. */
export async function premiumStatus(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { plan: true } });
  if (!user) return { active: false, plan: "free", endsAt: null as Date | null, planId: null as string | null };
  const sub = await prisma.subscription.findFirst({ where: { userId, status: "active" }, orderBy: { endsAt: "desc" } });
  if (user.plan === "free") return { active: false, plan: "free", endsAt: null, planId: null };
  if (sub?.endsAt && sub.endsAt < new Date()) {
    await prisma.$transaction([
      prisma.subscription.updateMany({ where: { userId, status: "active", endsAt: { lt: new Date() } }, data: { status: "expired" } }),
      prisma.user.update({ where: { id: userId }, data: { plan: "free" } }),
    ]);
    return { active: false, plan: "free", endsAt: sub.endsAt, planId: sub.plan };
  }
  // A Pro set by hand (or an old payment) with no subscription row has no end date.
  return { active: true, plan: user.plan, endsAt: sub?.endsAt || null, planId: sub?.plan || null };
}

/**
 * Activates (or extends) a plan after Paystack confirmed payment.
 * Safe to call twice for the same reference.
 */
export async function activatePlan(opts: { userId: string; planId: string; reference: string | null; amountNaira: number | null; days?: number | null; source: string; email?: string | null }) {
  const { userId, reference } = opts;
  const billing = await getBilling(true);
  const plan = billing.plans.find((p) => p.id === opts.planId);
  const days = opts.days ?? plan?.days ?? (opts.planId === "weekly" ? 7 : opts.planId === "monthly" ? 30 : 365);
  if (!Number.isInteger(days) || days < 1 || days > 730) throw new Error("Invalid subscription length.");

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`user:${userId}`}))`;
    if (reference) {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment:${reference}`}))`;
      const done = await tx.payment.findUnique({ where: { reference }, select: { status: true } });
      if (done?.status === "success") return { ok: true, already: true };
    }

    const now = new Date();
    const current = await tx.subscription.findFirst({ where: { userId, status: "active" }, orderBy: { endsAt: "desc" } });
    const from = current?.endsAt && current.endsAt > now ? current.endsAt : now;
    const endsAt = new Date(from.getTime() + days * 86_400_000);
    const payData = { userId, plan: opts.planId, amount: opts.amountNaira, currency: "NGN", status: "success", meta: { source: opts.source, email: opts.email || null, days } };

    await tx.user.update({ where: { id: userId }, data: { plan: days >= 300 ? "annual" : "pro" } });
    if (current) {
      await tx.subscription.update({ where: { id: current.id }, data: { endsAt, plan: opts.planId, reference } });
    } else {
      await tx.subscription.create({ data: { userId, status: "active", plan: opts.planId, provider: "paystack", reference, startsAt: now, endsAt } });
    }
    if (reference) {
      await tx.payment.upsert({ where: { reference }, create: { ...payData, reference }, update: payData });
    } else if (opts.amountNaira != null && opts.amountNaira > 0) {
      await tx.payment.create({ data: payData });
    }
    await tx.paymentClaim.updateMany({ where: { userId, status: { not: "activated" } }, data: { status: "activated", reference: reference || undefined } });
    return { ok: true, endsAt };
  });
}

/** Mounted after featureGate: paid features answer 402 to free accounts. Staff always pass. */
export async function premiumGate(req: Request, res: Response, next: NextFunction) {
  try {
    const key = featureForPath(req.path);
    if (!key || key === "upgrade") return next();
    const billing = await getBilling();
    if (!billing.premium[key]) return next();
    const v = await viewerFrom(req);
    if (v?.staff) return next();
    if (v && (await premiumStatus(v.id)).active) return next();
    return res.status(402).json({ error: "This is a premium feature.", code: "premium_required", feature: key });
  } catch (error) {
    console.error("[premium-gate] Failed to verify paid feature access:", error);
    return res.status(503).json({ error: "Premium access could not be verified. Try again shortly.", code: "premium_check_unavailable" });
  }
}
