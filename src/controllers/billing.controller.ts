import { Request } from "express";
import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { FEATURES, viewerFrom } from "../lib/features";
import { activatePlan, getBilling, premiumStatus, sanitizeBilling, saveBilling, type BillingState } from "../lib/billing";
import { audit } from "../lib/audit";
import { handle } from "../lib/http";

const secret = () => process.env.PAYSTACK_SECRET_KEY || "";
const appUrl = () => (process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || "https://academicall.pages.dev").replace(/\/$/, "");
const uid = (req: Request) => req.user?.id;

async function paystack(path: string, init?: RequestInit) {
  const r = await fetch(`https://api.paystack.co${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${secret()}`, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok || body?.status === false) throw new Error(body?.message || `Paystack ${r.status}`);
  return body.data;
}

/** GET /billing — the upgrade page: active plans, paid features, page words, and my status. */
export const publicBilling = handle(async (req, res) => {
  const b = await getBilling();
  const v = await viewerFrom(req);
  const me = v ? { ...(await premiumStatus(v.id)), staff: v.staff } : null;
  res.json({
    currency: b.currency,
    plans: b.plans.filter((p) => p.active),
    premium: Object.keys(b.premium),
    features: FEATURES.filter((f) => b.premium[f.key]).map((f) => ({ key: f.key, label: f.label, hint: f.hint })),
    page: b.page,
    ready: !!secret(),
    me,
  });
});

/** GET /admin/billing */
export const adminBilling = handle(async (_req, res) => {
  const [b, payments, totals] = await Promise.all([
    getBilling(true),
    prisma.payment.findMany({ orderBy: { createdAt: "desc" }, take: 40 }),
    prisma.payment.aggregate({ where: { status: "success" }, _sum: { amount: true }, _count: true }),
  ]);
  const users = await prisma.user.findMany({ where: { id: { in: payments.map((p) => p.userId).filter(Boolean) as string[] } }, select: { id: true, name: true, email: true } });
  const byId = new Map(users.map((u) => [u.id, u]));
  const activeSubs = await prisma.subscription.count({ where: { status: "active", endsAt: { gt: new Date() } } });
  res.json({
    billing: b,
    features: FEATURES.map((f) => ({ key: f.key, label: f.label, group: f.group, hint: f.hint })),
    paystackReady: !!secret(),
    webhookUrl: "/api/v1/payments/webhook/paystack",
    stats: { revenueNaira: totals._sum.amount || 0, paidCount: totals._count, activeSubs },
    payments: payments.map((p) => ({ ...p, user: p.userId ? byId.get(p.userId) || null : null })),
  });
});

/** PUT /admin/billing — the whole config in one save. */
export const saveAdminBilling = handle(async (req, res) => {
  let state: BillingState;
  try {
    state = sanitizeBilling(req.body);
  } catch (e: any) {
    if (!(e instanceof Error)) throw e;
    return res.status(400).json({ error: e.message || "Couldn't save billing." });
  }
  await saveBilling(state);
  res.json({ billing: state });
});

/** POST /billing/checkout { planId } → { url, reference } */
export const checkout = handle(async (req, res) => {
  if (!secret()) return res.status(503).json({ error: "Payments aren't set up yet." });
  const b = await getBilling(true);
  const plan = b.plans.find((p) => p.id === String(req.body?.planId || "") && p.active);
  if (!plan) return res.status(404).json({ error: "That plan isn't available." });
  const userId = uid(req);
  if (!userId) return res.status(401).json({ error: "Unauthenticated" });
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!user?.email) return res.status(400).json({ error: "Your account needs an email address to pay." });
  const reference = `ac_${plan.id}_${crypto.randomBytes(8).toString("hex")}`;
  await prisma.payment.create({ data: { userId: user.id, reference, plan: plan.id, amount: plan.amount, currency: "NGN", status: "pending", meta: { source: "checkout", days: plan.days } } });
  try {
    const data = await paystack("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email: user.email,
        amount: plan.amount * 100,
        currency: "NGN",
        reference,
        callback_url: `${appUrl()}/dashboard/upgrade?reference=${reference}`,
        metadata: { userId: user.id, planId: plan.id, days: plan.days },
      }),
    });
    res.json({ url: data.authorization_url, reference });
  } catch (e: any) {
    console.error("[billing] Paystack checkout initialization failed:", e);
    try {
      await prisma.payment.update({ where: { reference }, data: { status: "failed" } });
    } catch (updateError) {
      console.error("[billing] Failed to record the unsuccessful checkout:", updateError);
    }
    res.status(502).json({ error: e.message || "Couldn't start checkout." });
  }
});

/** GET /billing/verify/:reference — called when the user returns from Paystack. */
export const verify = handle(async (req, res) => {
  if (!secret()) return res.status(503).json({ error: "Payments aren't set up yet." });
  const reference = String(req.params.reference || "");
  const userId = uid(req);
  if (!userId) return res.status(401).json({ error: "Unauthenticated" });
  const pay = await prisma.payment.findUnique({ where: { reference } });
  if (!pay || pay.userId !== userId) return res.status(404).json({ error: "Payment not found." });
  if (pay.status === "success") return res.json({ status: "success", me: await premiumStatus(userId) });
  try {
    const data = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
    if (data.status !== "success") {
      await prisma.payment.update({ where: { reference }, data: { status: data.status || "failed" } });
      return res.json({ status: data.status || "failed" });
    }
    if (data.reference !== reference || data.currency !== pay.currency || Number(data.amount) !== Number(pay.amount || 0) * 100) {
      return res.status(400).json({ error: "Payment details don't match the checkout." });
    }
    const meta = pay.meta as { days?: number } | null;
    await activatePlan({ userId: pay.userId!, planId: pay.plan || "annual", reference, amountNaira: Number(data.amount) / 100, days: meta?.days, source: "verify" });
    res.json({ status: "success", me: await premiumStatus(userId) });
  } catch (e: any) {
    console.error("[billing] Paystack verification failed:", e);
    res.status(502).json({ error: e.message || "Couldn't confirm the payment." });
  }
});

/** PUT /admin/billing/users/:id { planId } or { revoke: true } — manual grant/revoke. */
export const grant = handle(async (req, res) => {
  const userId = String(req.params.id);
  if (req.body?.revoke) {
    await prisma.$transaction([
      prisma.subscription.updateMany({ where: { userId, status: "active" }, data: { status: "revoked" } }),
      prisma.user.update({ where: { id: userId }, data: { plan: "free" } }),
    ]);
    await audit(req.user, "billing.premium_revoked", { id: userId });
    return res.json({ ok: true });
  }
  const planId = String(req.body?.planId || "");
  const billing = await getBilling(true);
  const plan = billing.plans.find((item) => item.id === planId);
  if (!plan) return res.status(400).json({ error: "Choose a plan that exists in billing settings." });
  const r = await activatePlan({ userId, planId, reference: null, amountNaira: 0, days: plan.days, source: `manual:${uid(req)}` });
  await audit(req.user, "billing.premium_granted", { id: userId, label: plan.name });
  res.json(r);
});
