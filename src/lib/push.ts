/**
 * Push notifications (Firebase Cloud Messaging, HTTP v1).
 *
 * Every in-app notification row is also a push candidate. A small dispatcher
 * picks up new rows every few seconds (pushedAt IS NULL), checks the person's
 * preferences and quiet hours, sends to their registered devices and stamps
 * pushedAt. Because it reads the table, every notification in the app gets
 * pushed without each feature having to remember to call it.
 *
 * Configure with FIREBASE_SERVICE_ACCOUNT (the service-account JSON, raw or
 * base64). Without it the dispatcher stays off and the app works as before.
 */
import { GoogleAuth } from "google-auth-library";
import { prisma } from "./prisma";

type ServiceAccount = { project_id: string; client_email: string; private_key: string };

let account: ServiceAccount | null | undefined;
function serviceAccount(): ServiceAccount | null {
  if (account !== undefined) return account;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || "";
  if (!raw) return (account = null);
  try {
    const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const json = JSON.parse(text);
    account = json.project_id && json.client_email && json.private_key ? json : null;
  } catch {
    console.error("[push] FIREBASE_SERVICE_ACCOUNT is not valid JSON");
    account = null;
  }
  return account ?? null;
}

export const pushConfigured = () => !!serviceAccount();

let auth: GoogleAuth | null = null;
async function accessToken() {
  const sa = serviceAccount();
  if (!sa) throw new Error("push not configured");
  if (!auth) auth = new GoogleAuth({ credentials: { client_email: sa.client_email, private_key: sa.private_key }, scopes: ["https://www.googleapis.com/auth/firebase.messaging"] });
  const t = await auth.getAccessToken();
  if (!t) throw new Error("no access token");
  return t;
}

/** Preference groups people can switch off one by one (Settings → Notifications). */
export const PUSH_TYPES = [
  { key: "classes", label: "Class changes and lecture updates", types: ["class_event", "lecture_update"] },
  { key: "announcements", label: "Announcements", types: ["announcement", "announcement_published"] },
  { key: "groups", label: "Study groups and mentions", types: ["general"] },
  { key: "house", label: "Aspirant House", types: ["house"] },
  { key: "news", label: "News you follow", types: ["news"] },
  { key: "tests", label: "Tests set for you", types: ["test"] },
  { key: "account", label: "Account and payments", types: ["payment_claim", "system", "new_student", "moderation"] },
] as const;
/** Security notices always go through. */
const ALWAYS = new Set(["security"]);

export type PushPrefs = { push?: boolean; types?: Record<string, boolean>; quietStart?: string | null; quietEnd?: string | null };

const groupOf = (type: string) => PUSH_TYPES.find((g) => (g.types as readonly string[]).includes(type))?.key || "account";

/** Minutes past midnight in Lagos (the app's home time zone, no DST). */
function lagosMinutes(d = new Date()) {
  const m = (d.getUTCHours() + 1) * 60 + d.getUTCMinutes();
  return m % 1440;
}
const toMin = (s?: string | null) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export function inQuietHours(p: PushPrefs, d = new Date()) {
  const a = toMin(p.quietStart), b = toMin(p.quietEnd);
  if (a == null || b == null || a === b) return false;
  const now = lagosMinutes(d);
  return a < b ? now >= a && now < b : now >= a || now < b;
}

export function wantsPush(p: PushPrefs | null | undefined, type: string, d = new Date()) {
  if (ALWAYS.has(type)) return true;
  const prefs = p || {};
  if (prefs.push === false) return false;
  if (prefs.types && prefs.types[groupOf(type)] === false) return false;
  if (inQuietHours(prefs, d)) return false;
  return true;
}

type Row = { id: string; userId: string; type: string; title: string; body: string | null; data: any };

async function sendOne(token: string, n: Row, projectId: string, bearer: string) {
  const link = typeof n.data?.link === "string" ? n.data.link : "/dashboard/notifications";
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification: { title: n.title.slice(0, 120), body: (n.body || "").slice(0, 300) },
        data: { link, notificationId: n.id, type: n.type },
        android: { priority: "high", notification: { channel_id: "academicall", click_action: "FCM_PLUGIN_ACTIVITY", color: "#454ADE" } },
        webpush: { fcm_options: { link } },
      },
    }),
  });
  if (res.ok) return "ok";
  const body: any = await res.json().catch(() => ({}));
  const status = body?.error?.status || "";
  const detail = JSON.stringify(body?.error?.details || "");
  if (res.status === 404 || status === "NOT_FOUND" || /UNREGISTERED|INVALID_ARGUMENT/.test(detail + status)) return "dead";
  return "error";
}

let running = false;

/** One dispatcher pass. Exported for tests. */
export async function dispatchPushes(limit = 200) {
  const sa = serviceAccount();
  // Claim a batch atomically so two API instances never push the same row twice.
  const claimed = await prisma.$queryRaw<Row[]>`
    UPDATE notifications SET "pushedAt" = NOW()
    WHERE id IN (
      SELECT id FROM notifications
      WHERE "pushedAt" IS NULL AND "createdAt" > NOW() - INTERVAL '30 minutes'
      ORDER BY "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, "userId", type::text AS type, title, body, data`;
  if (!claimed.length || !sa) return { claimed: claimed.length, sent: 0 };

  const userIds = [...new Set(claimed.map((r) => r.userId))];
  const [users, devices] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, notificationPrefs: true, status: true } }),
    prisma.deviceToken.findMany({ where: { userId: { in: userIds } } }),
  ]);
  const prefs = new Map(users.map((u) => [u.id, u]));
  const byUser = new Map<string, typeof devices>();
  for (const d of devices) byUser.set(d.userId, [...(byUser.get(d.userId) || []), d]);

  const bearer = await accessToken();
  let sent = 0;
  const dead = new Set<string>();
  for (const n of claimed) {
    const u = prefs.get(n.userId);
    if (!u || u.status !== "active" || !wantsPush(u.notificationPrefs as PushPrefs, n.type)) continue;
    for (const d of byUser.get(n.userId) || []) {
      if (dead.has(d.token)) continue;
      try {
        const r = await sendOne(d.token, n, sa.project_id, bearer);
        if (r === "ok") sent++;
        if (r === "dead") dead.add(d.token);
      } catch (err) {
        console.error("[push] send failed", err);
      }
    }
  }
  if (dead.size) await prisma.deviceToken.deleteMany({ where: { token: { in: [...dead] } } });
  return { claimed: claimed.length, sent };
}

/** Start the background dispatcher (no-op when push isn't configured). */
export function startPushDispatcher(everyMs = 5000) {
  if (!pushConfigured()) {
    console.log("[push] FIREBASE_SERVICE_ACCOUNT not set — push notifications are off");
    return null;
  }
  console.log("[push] dispatcher on");
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await dispatchPushes();
    } catch (err) {
      console.error("[push] dispatcher", err);
    } finally {
      running = false;
    }
  }, everyMs);
}
