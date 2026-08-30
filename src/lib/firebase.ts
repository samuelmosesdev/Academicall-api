import admin from "firebase-admin";
import path from "path";
import fs from "fs";

let initialized = false;

function parseServiceAccount(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  const serviceAccount = JSON.parse(trimmed);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  return serviceAccount;
}

export function initFirebaseAdmin() {
  if (initialized) return;

  try {
    const serviceAccountRaw =
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT;
    const serviceAccount = serviceAccountRaw ? parseServiceAccount(serviceAccountRaw) : null;
    if (serviceAccount) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id,
      });
      initialized = true;
      console.log("[firebase-admin] initialized from service account environment variable");
      return;
    }

    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
      ? path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS)
      : serviceAccountRaw && !serviceAccountRaw.trim().startsWith("{")
        ? path.resolve(serviceAccountRaw)
        : null;

    if (credPath && fs.existsSync(credPath)) {
      admin.initializeApp({
        credential: admin.credential.cert(credPath),
        projectId: process.env.FIREBASE_PROJECT_ID || undefined,
      });
      initialized = true;
      console.log("[firebase-admin] initialized from service account file");
      return;
    }

    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_ALLOW_PROJECT_ID_ONLY === "true") {
      admin.initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID,
      });
      initialized = true;
      console.log("[firebase-admin] initialized with project ID only");
      return;
    }

    console.log("[firebase-admin] skipped - no service account credentials found (JWT-only mode)");
  } catch (err) {
    console.warn("[firebase-admin] failed to initialize:", (err as Error).message);
  }
}

export async function verifyFirebaseIdToken(idToken: string) {
  if (!initialized) {
    throw new Error("Firebase Admin not initialized – hybrid auth disabled");
  }
  return admin.auth().verifyIdToken(idToken);
}

export function isFirebaseEnabled() {
  return initialized;
}

export { admin };
