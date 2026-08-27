import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import admin from "firebase-admin";
import { PrismaClient } from "@prisma/client";

const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!credentialPath) throw new Error("Set GOOGLE_APPLICATION_CREDENTIALS before migrating.");
const resolvedCredentialPath = path.resolve(credentialPath);
if (!fs.existsSync(resolvedCredentialPath)) throw new Error(`Service account not found: ${resolvedCredentialPath}`);

admin.initializeApp({ credential: admin.credential.cert(resolvedCredentialPath) });
const firestore = admin.firestore();
const prisma = new PrismaClient();

function field(data, key, fallback = null) {
  return data[key] === undefined ? fallback : data[key];
}

async function readCollection(name) {
  const snapshot = await firestore.collection(name).get();
  return snapshot.docs.map((item) => ({ id: item.id, data: item.data() }));
}

async function migrate() {
  const users = await readCollection("users");
  for (const item of users) {
    const data = item.data;
    if (!data.email) continue;
    await prisma.user.upsert({
      where: { email: data.email },
      create: {
        id: item.id,
        firebaseUid: item.id,
        email: data.email,
        name: field(data, "name", data.email.split("@")[0]),
        role: ["admin", "alphaAgent", "agent", "courseRep", "user"].includes(data.role) ? data.role : "user",
        plan: ["free", "pro", "annual"].includes(data.plan) ? data.plan : "free",
        status: data.status === "suspended" ? "suspended" : "active",
        uniqueId: field(data, "uniqueId"),
        emailVerified: Boolean(data.emailVerified),
        profileComplete: Boolean(data.profileComplete),
        department: field(data, "department"),
        faculty: field(data, "faculty"),
        level: field(data, "level"),
        matricNumber: field(data, "matricNumber"),
        phone: field(data, "phone"),
        bio: field(data, "bio"),
        interests: field(data, "interests"),
        dob: field(data, "dob"),
        gender: field(data, "gender"),
        nickname: field(data, "nickname", field(data, "nickName")),
      },
      update: {
        name: field(data, "name"),
        department: field(data, "department"),
        faculty: field(data, "faculty"),
        level: field(data, "level"),
        phone: field(data, "phone"),
        emailVerified: Boolean(data.emailVerified),
        profileComplete: Boolean(data.profileComplete),
      },
    });
  }

  const courses = await readCollection("courses");
  for (const item of courses) {
    const data = item.data;
    await prisma.course.upsert({
      where: { id: item.id },
      create: { id: item.id, title: data.title || "Untitled course", code: field(data, "code"), faculty: field(data, "faculty"), department: field(data, "department"), level: field(data, "level"), semester: field(data, "semester"), description: field(data, "description"), thumbnailUrl: field(data, "thumbnailUrl"), source: field(data, "source") },
      update: { title: data.title || "Untitled course", code: field(data, "code"), faculty: field(data, "faculty"), department: field(data, "department"), level: field(data, "level"), semester: field(data, "semester"), description: field(data, "description"), thumbnailUrl: field(data, "thumbnailUrl"), source: field(data, "source") },
    });
  }

  const documents = await readCollection("documents");
  let migratedDocuments = 0;
  for (const item of documents) {
    const data = item.data;
    const uploadedById = data.uploadedById || data.uploadedBy || data.createdBy;
    const owner = uploadedById ? await prisma.user.findUnique({ where: { id: uploadedById } }) : null;
    if (!data.title || !owner) continue;
    await prisma.document.upsert({
      where: { id: item.id },
      create: { id: item.id, title: data.title, description: field(data, "description"), fileUrl: field(data, "fileUrl"), thumbnailUrl: field(data, "thumbnailUrl"), source: field(data, "source"), uploadedById: owner.id, courseId: field(data, "courseId") },
      update: { title: data.title, description: field(data, "description"), fileUrl: field(data, "fileUrl"), thumbnailUrl: field(data, "thumbnailUrl"), source: field(data, "source"), courseId: field(data, "courseId") },
    });
    migratedDocuments += 1;
  }

  console.log(`Migrated ${users.length} users, ${courses.length} courses, and ${migratedDocuments} documents.`);
}

try {
  await migrate();
} finally {
  await prisma.$disconnect();
  await admin.app().delete();
}
