"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.paystackWebhook = paystackWebhook;
const node_crypto_1 = __importDefault(require("node:crypto"));
const prisma_1 = require("../lib/prisma");
/**
 * Paystack webhook — ported from the old Firebase Cloud Function
 * (functions/index.js:paystackWebhook) to write straight to Postgres
 * instead of Firestore, since Postgres is now the single source of truth
 * for users, payments, and payment claims.
 *
 * Configure in the Paystack dashboard as:
 *   https://<your-railway-domain>/api/v1/payments/webhook/paystack
 *
 * Requires PAYSTACK_SECRET_KEY to be set in the API's environment.
 */
function getPaystackSecret() {
    return process.env.PAYSTACK_SECRET_KEY || "";
}
function verifyPaystackSignature(rawBody, signature, secret) {
    if (!secret || !signature || !rawBody)
        return false;
    const hash = node_crypto_1.default.createHmac("sha512", secret).update(rawBody).digest("hex");
    try {
        const a = Buffer.from(hash, "utf8");
        const b = Buffer.from(String(signature), "utf8");
        if (a.length !== b.length)
            return false;
        return node_crypto_1.default.timingSafeEqual(a, b);
    }
    catch {
        return false;
    }
}
function extractEmail(eventData) {
    const d = eventData || {};
    return (d.customer?.email ||
        d.email ||
        d.authorization?.email ||
        d.metadata?.email ||
        d.metadata?.customer_email ||
        "")
        .toString()
        .trim()
        .toLowerCase();
}
function extractUserId(eventData) {
    const m = eventData?.metadata || {};
    return (m.userId || m.user_id || m.uid || "").toString().trim();
}
function extractPlanId(eventData) {
    const m = eventData?.metadata || {};
    const ref = (eventData?.reference || "").toString().toLowerCase();
    if (m.planId || m.plan_id)
        return String(m.planId || m.plan_id);
    if (ref.includes("weekly"))
        return "weekly";
    if (ref.includes("monthly"))
        return "monthly";
    if (ref.includes("annual") || ref.includes("year"))
        return "annual";
    return "annual";
}
async function activatePro({ userId, email, planId, reference, amount, }) {
    let uid = userId;
    if (!uid && email) {
        const user = await prisma_1.prisma.user.findFirst({ where: { email } });
        if (!user) {
            await prisma_1.prisma.paymentOrphan.create({
                data: { reference, reason: "no_user_for_email", data: { email, planId, amount } },
            });
            return { ok: false, reason: "no_user_for_email", email };
        }
        uid = user.id;
    }
    if (!uid) {
        await prisma_1.prisma.paymentOrphan.create({
            data: { reference, reason: "missing_user", data: { email, planId, amount } },
        });
        return { ok: false, reason: "missing_user" };
    }
    await prisma_1.prisma.$transaction([
        prisma_1.prisma.user.update({
            where: { id: uid },
            data: { plan: "pro" },
        }),
        prisma_1.prisma.payment.create({
            data: {
                userId: uid,
                plan: planId || "annual",
                reference: reference || null,
                amount: amount != null ? Math.round(amount) : null,
                status: "success",
                meta: { source: "paystack_webhook", email: email || null },
            },
        }),
        prisma_1.prisma.paymentClaim.updateMany({
            where: { userId: uid, status: { not: "activated" } },
            data: { status: "activated", reference: reference || undefined },
        }),
    ]);
    return { ok: true, userId: uid, email, planId };
}
async function paystackWebhook(req, res) {
    if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return;
    }
    const secret = getPaystackSecret();
    if (!secret) {
        console.error("PAYSTACK_SECRET_KEY not configured");
        res.status(500).send("Server misconfigured");
        return;
    }
    const signature = req.headers["x-paystack-signature"];
    const rawBody = req.rawBody;
    if (!verifyPaystackSignature(rawBody, signature, secret)) {
        console.warn("Invalid Paystack signature");
        res.status(401).send("Invalid signature");
        return;
    }
    const event = req.body || {};
    const eventType = event.event;
    const data = event.data || {};
    if (eventType !== "charge.success" && eventType !== "subscription.create") {
        res.status(200).json({ received: true, handled: false, event: eventType });
        return;
    }
    const reference = data.reference || data.subscription_code || null;
    if (reference) {
        const existing = await prisma_1.prisma.payment.findFirst({ where: { reference } });
        if (existing) {
            res.status(200).json({ received: true, duplicate: true, reference });
            return;
        }
    }
    const email = extractEmail(data);
    const userId = extractUserId(data);
    const planId = extractPlanId(data);
    const amount = typeof data.amount === "number" ? data.amount / 100 : null;
    try {
        const result = await activatePro({ userId, email, planId, reference, amount });
        res.status(200).json({ received: true, ...result });
    }
    catch (err) {
        console.error("Paystack webhook processing failed:", err);
        res.status(500).json({ received: true, error: "Processing failed" });
    }
}
//# sourceMappingURL=payments.controller.js.map