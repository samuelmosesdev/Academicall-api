import admin from "firebase-admin";
import path from "path";
import fs from "fs";

let initialized = false;

export function initFirebaseAdmin() {
  if (initialized) return;

  try {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT;
    if (serviceAccountJson) {
      const serviceAccount = JSON.parse(serviceAccountJson);
      if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
      }
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
      : null;

    // Only try to load the file if it actually exists
    if (credPath && fs.existsSync(credPath)) {
      admin.initializeApp({
        credential: admin.credential.cert(credPath),
        projectId: process.env.FIREBASE_PROJECT_ID || undefined,
      });
      initialized = true;
      console.log("[firebase-admin] initialized from service account file");
      return;
    }

    // Optional: allow project-id-only in some environments
    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_ALLOW_PROJECT_ID_ONLY === "true") {
      admin.initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID,
      });
      initialized = true;
      console.log("[firebase-admin] initialized with project ID only");
      return;
    }

    // Clean silent skip
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