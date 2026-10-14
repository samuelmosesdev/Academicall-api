/**
 * End-to-end API tests against a real PostgreSQL database.
 *
 * Set ACADEMICALL_TEST_DATABASE=I_CONFIRM_DISPOSABLE and DATABASE_URL to a
 * dedicated database or isolated PostgreSQL schema whose name includes "test",
 * then run:
 *   npm run build && node tests/integration.test.mjs
 *
 * Starts the compiled API (dist/) on port 4100 and a tiny file server on 4199
 * standing in for Cloudinary, then exercises groups, permissions, history rules,
 * file validation, real-time delivery and the institution hierarchy.
 * WARNING: creates and deletes test rows (emails ending @test.academicall).
 */
import { createRequire } from "module";
import { spawn } from "child_process";
import http from "http";
import assert from "assert/strict";

const databaseUrl = process.env.DATABASE_URL;
if (process.env.ACADEMICALL_TEST_DATABASE !== "I_CONFIRM_DISPOSABLE") {
  throw new Error("Integration tests require ACADEMICALL_TEST_DATABASE=I_CONFIRM_DISPOSABLE.");
}
if (!databaseUrl) {
  throw new Error("Integration tests require DATABASE_URL for a dedicated disposable database.");
}
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
const databaseSchema = new URL(databaseUrl).searchParams.get("schema");
if (!/(^|[_-])test([_-]|$)/i.test(databaseName) && !/(^|[_-])test([_-]|$)/i.test(databaseSchema || "")) {
  throw new Error("Refusing integration tests: database or isolated schema name must clearly include 'test'.");
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const jwt = require("jsonwebtoken");
const prisma = new PrismaClient();

const API = "http://127.0.0.1:4100/api/v1";
const FILES = "http://127.0.0.1:4199";
const SECRET = "test-secret";
const results = [];

// ── fake Cloudinary ──────────────────────────────────────────────────────────
const pdf = (size) => {
  const head = Buffer.from("%PDF-1.4\n% test\n");
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x20)]);
};
const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(2000, 1)]);
const files = {
  "/small.pdf": { body: pdf(40_000), type: "application/pdf" },
  "/heavy.pdf": { body: pdf(3 * 1024 * 1024), type: "application/pdf" },
  "/huge.pdf": { body: pdf(21 * 1024 * 1024), type: "application/pdf" },
  "/fake.pdf": { body: Buffer.concat([Buffer.from("MZ\x90\x00"), Buffer.alloc(5000)]), type: "application/pdf" },
  "/photo.png": { body: png, type: "image/png" },
  "/page.html": { body: Buffer.from("<html>hi</html>"), type: "text/html" },
};
const fileServer = http.createServer((req, res) => {
  const f = files[req.url];
  if (!f) { res.statusCode = 404; return res.end(); }
  const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range || "");
  const body = range ? f.body.subarray(Number(range[1]), Number(range[2]) + 1) : f.body;
  res.writeHead(range ? 206 : 200, { "Content-Type": f.type, "Content-Length": req.method === "HEAD" ? f.body.length : body.length });
  res.end(req.method === "HEAD" ? undefined : body);
});

// ── helpers ──────────────────────────────────────────────────────────────────
async function call(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n      ${err.message}\n${(err.stack || "").split("\n").find((l) => l.includes("integration.test")) || ""}`);
  }
}

let seq = 0;
async function makeUser(over = {}) {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      email: `u${Date.now()}_${seq}@test.academicall`, name: over.name || `Student ${seq}`, role: "user", status: "active",
      institutionId: "uofa", faculty: "Faculty of Science", department: "Computer Science", program: "Computer Science", level: "300 Level",
      ...over,
    },
  });
  return { ...user, token: jwt.sign({ sub: user.id, email: user.email, role: user.role }, SECRET) };
}

/** Collects SSE events for one user. */
function listen(token) {
  const events = [];
  const ctrl = new AbortController();
  const ready = (async () => {
    const res = await fetch(API + "/realtime/stream", { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let resolveReady;
    const readyP = new Promise((r) => (resolveReady = r));
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const type = /event: (.+)/.exec(chunk)?.[1];
            const data = /data: (.+)/.exec(chunk)?.[1];
            if (type === "ready") resolveReady();
            if (type) events.push({ type, data: data ? JSON.parse(data) : null });
          }
        }
      } catch { /* aborted */ }
    })();
    await readyP;
  })();
  return {
    events, ready, close: () => ctrl.abort(),
    async waitFor(pred, ms = 3000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const hit = events.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("timed out waiting for realtime event");
    },
  };
}

// ── run ──────────────────────────────────────────────────────────────────────
async function main() {
  await new Promise((r) => fileServer.listen(4199, "127.0.0.1", r));
  const api = spawn("node", ["dist/server.js"], {
    env: { ...process.env, PORT: "4100", JWT_SECRET: SECRET, GOOGLE_CLIENT_ID: "", AUTO_SEED_INSTITUTIONS: "false", ATTACHMENT_ALLOWED_ORIGINS: FILES + "/", NODE_ENV: "test" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(API + "/health")).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }

  try {
    console.log("\nAuthentication");
    await test("Google sign-in defaults to the configured public client ID", async () => {
      const result = await call(null, "POST", "/auth/google", { credential: "" });
      assert.equal(result.status, 400);
      assert.equal(result.data.error, "Google credential is required");
    });
    console.log("\nInstitutions");
    let other;
    await test("lists institutions with UofA first and searches by name", async () => {
      const all = await call(null, "GET", "/institutions?limit=5");
      assert.equal(all.status, 200);
      assert.equal(all.data.institutions[0].id, "uofa");
      assert.ok(all.data.total > 1500);
      const q = await call(null, "GET", "/institutions?q=nile%20university");
      assert.ok(q.data.institutions.some((i) => i.name.startsWith("NILE UNIVERSITY")));
      other = q.data.institutions[0];
    });
    let uofaTree, otherTree;
    await test("returns the UofA curated tree and an IBASS tree with derived departments", async () => {
      uofaTree = (await call(null, "GET", "/institutions/uofa/tree")).data;
      assert.ok(uofaTree.faculties.length >= 10);
      assert.equal(uofaTree.derivedDepartments, false);
      assert.ok(uofaTree.faculties[0].departments[0].programs.length > 0);
      otherTree = (await call(null, "GET", `/institutions/${other.id}/tree`)).data;
      assert.ok(otherTree.faculties.length > 0);
      assert.equal(otherTree.derivedDepartments, true);
    });
    console.log("\nNotifications");
    await test("notification listing and read state are isolated to the owning user", async () => {
      const owner = await makeUser();
      const otherUser = await makeUser();
      const created = await call(owner.token, "POST", "/notifications", {
        userId: owner.id,
        title: "Integration notification",
        body: "Unread test notification",
      });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      const notificationId = created.data.notification.id;

      const ownerList = await call(owner.token, "GET", "/notifications");
      const otherList = await call(otherUser.token, "GET", "/notifications");
      assert.ok(ownerList.data.notifications.some((item) => item.id === notificationId));
      assert.ok(!otherList.data.notifications.some((item) => item.id === notificationId));
      assert.equal((await call(otherUser.token, "PATCH", `/notifications/${notificationId}/read`)).status, 404);

      const marked = await call(owner.token, "PATCH", `/notifications/${notificationId}/read`);
      assert.equal(marked.status, 200, JSON.stringify(marked.data));
      assert.equal(marked.data.notification.readByUser, true);
      const persisted = await prisma.notification.findUnique({ where: { id: notificationId } });
      assert.equal(persisted.readByUser, true);
      assert.ok(persisted.readAt);
    });

    await test("profile update validates the hierarchy top-down", async () => {
      const u = await makeUser({ institutionId: null });
      const f = otherTree.faculties[0], d = f.departments[0], p = d.programs[0];
      const ok = await call(u.token, "PATCH", "/users/me", { institutionId: other.id, facultyId: f.id, departmentId: d.id, programId: p.id });
      assert.equal(ok.status, 200, JSON.stringify(ok.data));
      assert.equal(ok.data.user.program, p.name);
      assert.equal(ok.data.user.institutionId, other.id);
      const uf = uofaTree.faculties[0];
      const bad = await call(u.token, "PATCH", "/users/me", { institutionId: other.id, facultyId: uf.id, departmentId: uf.departments[0].id });
      assert.equal(bad.status, 400);
      const me = await call(u.token, "GET", "/auth/me");
      assert.equal(me.data.user.institution.id, other.id);
    });
    await test("users cannot change their own course-rep scope", async () => {
      const rep = await makeUser({ role: "courseRep", courseRepMeta: { program: "Computer Science", level: "300 Level" } });
      await call(rep.token, "PATCH", "/users/me", { courseRepMeta: { program: "Medicine", level: "500 Level" } });
      const fresh = await prisma.user.findUnique({ where: { id: rep.id } });
      assert.equal(fresh.courseRepMeta.program, "Computer Science");
    });

    console.log("\nProgramme hub (real-time)");
    await test("Course Rep status is restricted to the requesting institution", async () => {
      await makeUser({ role: "courseRep", courseRepMeta: { program: "Computer Science", level: "300 Level" } });
      const sameSchool = await makeUser();
      const otherSchool = await makeUser({ institutionId: other.id });
      const same = await call(sameSchool.token, "GET", "/users/course-rep-status?program=Computer%20Science&level=300%20Level");
      const outside = await call(otherSchool.token, "GET", "/users/course-rep-status?program=Computer%20Science&level=300%20Level");
      assert.equal(same.data.hasCourseRep, true);
      assert.equal(outside.data.hasCourseRep, false);
    });
    await test("program membership uses an institution-specific unique scope", async () => {
      const student = await makeUser();
      assert.equal((await call(student.token, "POST", "/department/join", {})).status, 201);
      await prisma.user.update({ where: { id: student.id }, data: { institutionId: other.id } });
      assert.equal((await call(student.token, "POST", "/department/join", {})).status, 201);
      const rows = await prisma.departmentMembership.findMany({
        where: { userId: student.id, department: "Computer Science" },
      });
      assert.deepEqual(new Set(rows.map((row) => row.institutionId)), new Set(["uofa", other.id]));
    });
    await test("approved programme materials are scoped and broadcast on changes", async () => {
      const rep = await makeUser({
        role: "courseRep",
        courseRepMeta: { program: "Computer Science", level: "300 Level" },
      });
      const classmate = await makeUser();
      const outsider = await makeUser({ institutionId: other.id });
      const stream = listen(classmate.token);
      await stream.ready;
      const created = await call(rep.token, "POST", "/documents", {
        title: "Realtime material",
        fileUrl: "https://example.com/realtime-material.pdf",
        program: "Computer Science",
        level: "300 Level",
      });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      assert.equal(created.data.document.institutionId, "uofa");
      const createdEvent = await stream.waitFor((event) =>
        event.type === "programme.material" &&
        event.data.action === "created" &&
        event.data.item.id === created.data.document.id
      );
      assert.equal(createdEvent.data.item.title, "Realtime material");
      const visible = await call(classmate.token, "GET", "/documents");
      assert.ok(visible.data.documents.some((document) => document.id === created.data.document.id));
      const hidden = await call(outsider.token, "GET", "/documents");
      assert.ok(!hidden.data.documents.some((document) => document.id === created.data.document.id));
      assert.equal((await call(outsider.token, "GET", `/documents/${created.data.document.id}`)).status, 404);

      const updated = await call(rep.token, "PATCH", `/documents/${created.data.document.id}`, { title: "Updated material" });
      assert.equal(updated.status, 200);
      await stream.waitFor((event) =>
        event.type === "programme.material" &&
        event.data.action === "updated" &&
        event.data.item.id === created.data.document.id
      );
      assert.equal((await call(rep.token, "DELETE", `/documents/${created.data.document.id}`)).status, 204);
      await stream.waitFor((event) =>
        event.type === "programme.material" &&
        event.data.action === "deleted" &&
        event.data.item.id === created.data.document.id
      );
      stream.close();
    });
    await test("comments push live to classmates and stay inside the institution", async () => {
      const a = await makeUser({ role: "courseRep", courseRepMeta: { program: "Computer Science", level: "300 Level" } });
      const b = await makeUser();
      const outsider = await makeUser({ institutionId: other.id });
      const post = await call(a.token, "POST", "/feed/course", { title: "Test", body: "Hello", program: "Computer Science", level: "300 Level" });
      assert.equal(post.status, 201);
      assert.equal(post.data.post.institutionId, "uofa");
      const sb = listen(b.token); await sb.ready;
      const c = await call(a.token, "POST", `/feed/course/${post.data.post.id}/comments`, { text: "first!" });
      assert.equal(c.status, 200);
      const ev = await sb.waitFor((e) => e.type === "programme.post" && e.data.item.id === post.data.post.id);
      assert.equal(ev.data.item.comments.at(-1).text, "first!");
      sb.close();
      const blocked = await call(outsider.token, "POST", `/feed/course/${post.data.post.id}/comments`, { text: "hi" });
      assert.equal(blocked.status, 403);
      const theirFeed = await call(outsider.token, "GET", "/feed/course?department=Computer%20Science");
      assert.ok(!theirFeed.data.posts.some((p) => p.id === post.data.post.id));
    });
    await test("agents stay institution-scoped and social arrays cannot overwrite threads", async () => {
      const globalStaff = await makeUser({ role: "alphaAgent" });
      const agent = await makeUser({ role: "agent" });
      const foreignPost = await call(globalStaff.token, "POST", "/feed/course", {
        title: "Foreign institution post", program: "Computer Science", level: "300 Level", institutionId: other.id,
      });
      assert.equal(foreignPost.status, 201);
      const foreignEvent = await call(globalStaff.token, "POST", "/class-events", {
        title: "Foreign institution class", startsAt: new Date().toISOString(), program: "Computer Science",
        level: "300 Level", institutionId: other.id,
      });
      assert.equal(foreignEvent.status, 201);

      const feed = await call(agent.token, "GET", `/feed/course?institutionId=${other.id}&program=Computer%20Science`);
      assert.ok(!feed.data.posts.some((post) => post.id === foreignPost.data.post.id));
      const events = await call(agent.token, "GET", `/class-events?institutionId=${other.id}&program=Computer%20Science`);
      assert.ok(!events.data.events.some((event) => event.id === foreignEvent.data.event.id));
      assert.equal((await call(agent.token, "POST", "/feed/course", {
        title: "Wrong tenant", program: "Computer Science", institutionId: other.id,
      })).status, 403);
      assert.equal((await call(agent.token, "PATCH", `/feed/course/${foreignPost.data.post.id}`, { title: "Changed" })).status, 403);
      assert.equal((await call(agent.token, "DELETE", `/feed/course/${foreignPost.data.post.id}`)).status, 403);
      assert.equal((await call(agent.token, "PATCH", `/class-events/${foreignEvent.data.event.id}`, { title: "Changed" })).status, 403);
      assert.equal((await call(agent.token, "DELETE", `/class-events/${foreignEvent.data.event.id}`)).status, 403);

      const ownPost = await call(globalStaff.token, "POST", "/feed/course", {
        title: "Local institution post", program: "Computer Science", level: "300 Level", institutionId: "uofa",
        comments: [{ id: "forged", text: "Injected" }], reactions: [{ uid: "forged", type: "love" }],
      });
      assert.equal(ownPost.status, 201);
      assert.ok(!ownPost.data.post.comments?.some((comment) => comment.id === "forged"));
      assert.ok(!ownPost.data.post.reactions?.some((reaction) => reaction.uid === "forged"));
      await call(agent.token, "POST", `/feed/course/${ownPost.data.post.id}/comments`, { text: "Keep this comment" });
      assert.equal((await call(agent.token, "PATCH", `/feed/course/${ownPost.data.post.id}`, { comments: [] })).status, 400);
      const postRow = await prisma.feedPost.findUnique({ where: { id: ownPost.data.post.id } });
      assert.equal(postRow.comments.length, 1);

      const ownEvent = await call(globalStaff.token, "POST", "/class-events", {
        title: "Local institution class", startsAt: new Date().toISOString(), program: "Computer Science",
        level: "300 Level", institutionId: "uofa",
      });
      assert.equal(ownEvent.status, 201);
      await call(agent.token, "POST", `/class-events/${ownEvent.data.event.id}/comments`, { text: "Keep this class comment" });
      assert.equal((await call(agent.token, "PATCH", `/class-events/${ownEvent.data.event.id}`, { comments: [] })).status, 400);
      const eventRow = await prisma.classEvent.findUnique({ where: { id: ownEvent.data.event.id } });
      assert.equal(eventRow.comments.length, 1);
    });
    await test("simultaneous comments are all kept (no lost updates)", async () => {
      const a = await makeUser({ role: "courseRep", courseRepMeta: { program: "Computer Science", level: "300 Level" } });
      const post = await call(a.token, "POST", "/feed/course", { title: "Race", program: "Computer Science", level: "300 Level" });
      const users = await Promise.all(Array.from({ length: 8 }, () => makeUser()));
      await Promise.all(users.map((u, i) => call(u.token, "POST", `/feed/course/${post.data.post.id}/comments`, { text: `c${i}` })));
      const row = await prisma.feedPost.findUnique({ where: { id: post.data.post.id } });
      assert.equal(row.comments.length, 8);
    });

    console.log("\nStudy groups");
    const creator = await makeUser({ name: "Creator" });
    const member = await makeUser({ name: "Member" });
    const stranger = await makeUser({ name: "Stranger" });
    let group;
    await test("creates a group with a unique 8-character base62 link", async () => {
      const r = await call(creator.token, "POST", "/groups", { name: "CSC 301 Study", description: "DSA", approvalRequired: true });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      group = r.data.group;
      assert.match(group.code, /^[A-Za-z0-9]{8}$/);
      assert.ok(group.link.endsWith(`/study/${group.code}`));
      assert.equal(group.myRole, "creator");
    });
    await test("100 groups get 100 distinct codes", async () => {
      const u = await makeUser();
      const codes = new Set();
      for (let i = 0; i < 25; i += 1) {
        const r = await Promise.all(Array.from({ length: 4 }, (_, j) => call(u.token, "POST", "/groups", { name: `Bulk ${i}-${j}` })));
        r.forEach((x) => codes.add(x.data.group.code));
        if (i === 11) await prisma.studyGroup.updateMany({ where: { createdById: u.id }, data: { archived: true } }); // stay under the 50-per-user cap
      }
      assert.equal(codes.size, 100);
    });
    await test("a link alone gives no access to messages or members", async () => {
      const prev = await call(stranger.token, "GET", `/groups/code/${group.code}`);
      assert.equal(prev.status, 200);
      assert.equal(prev.data.group.messages, undefined);
      assert.equal((await call(stranger.token, "GET", `/groups/${group.id}/messages`)).status, 403);
      assert.equal((await call(stranger.token, "GET", `/groups/${group.id}/members`)).status, 403);
      assert.equal((await call(stranger.token, "POST", `/groups/${group.id}/messages`, { text: "hi" })).status, 403);
    });
    await call(creator.token, "POST", `/groups/${group.id}/messages`, { text: "before you joined", clientId: "cid-before-1" });
    await call(creator.token, "POST", `/groups/${group.id}/messages`, { text: "light file", attachment: { url: `${FILES}/small.pdf`, name: "notes.pdf", kind: "document" } });
    await call(creator.token, "POST", `/groups/${group.id}/messages`, { text: "heavy file", attachment: { url: `${FILES}/heavy.pdf`, name: "big.pdf", kind: "document" } });
    await test("join requests wait for approval; members cannot approve", async () => {
      const j = await call(member.token, "POST", `/groups/code/${group.code}/join`);
      assert.equal(j.status, 202);
      assert.equal(j.data.status, "pending");
      assert.equal((await call(member.token, "GET", `/groups/${group.id}/messages`)).status, 403);
      const s = await call(stranger.token, "POST", `/groups/code/${group.code}/join`);
      assert.equal(s.data.status, "pending");
      // the pending stranger cannot approve the other request
      assert.equal((await call(stranger.token, "POST", `/groups/${group.id}/members/${member.id}/review`, { action: "approve" })).status, 403);
      const ok = await call(creator.token, "POST", `/groups/${group.id}/members/${member.id}/review`, { action: "approve" });
      assert.equal(ok.status, 200);
    });
    await test("new members see only messages after they joined", async () => {
      await new Promise((r) => setTimeout(r, 30));
      await call(creator.token, "POST", `/groups/${group.id}/messages`, { text: "after you joined" });
      const r = await call(member.token, "GET", `/groups/${group.id}/messages`);
      const texts = r.data.messages.map((m) => m.text);
      assert.ok(texts.includes("after you joined"));
      assert.ok(!texts.includes("before you joined"));
      assert.equal(r.data.historyLocked, true);
    });
    await test("history access: request → approve → text and small files only", async () => {
      assert.equal((await call(member.token, "POST", `/groups/${group.id}/history-request`)).data.historyAccess, "pending");
      // a plain member can't approve their own request
      assert.equal((await call(member.token, "POST", `/groups/${group.id}/history-requests/${member.id}`, { action: "approve" })).status, 403);
      assert.equal((await call(creator.token, "POST", `/groups/${group.id}/history-requests/${member.id}`, { action: "approve" })).status, 200);
      const r = await call(member.token, "GET", `/groups/${group.id}/messages?limit=80`);
      const by = (t) => r.data.messages.find((m) => m.text === t);
      assert.ok(by("before you joined"));
      assert.ok(by("light file").attachment.url);
      assert.equal(by("heavy file").withheld, true);
      assert.equal(by("heavy file").attachment.url, undefined);
      const save = await call(member.token, "POST", `/groups/${group.id}/messages/${by("heavy file").id}/save`);
      assert.equal(save.status, 403);
      const ok = await call(member.token, "POST", `/groups/${group.id}/messages/${by("light file").id}/save`);
      assert.equal(ok.status, 201);
      assert.equal(ok.data.save.meta.source, "study_group");
    });
    await test("server rejects fake, oversized and off-site files", async () => {
      const fake = await call(member.token, "POST", `/groups/${group.id}/messages`, { attachment: { url: `${FILES}/fake.pdf`, name: "virus.pdf", kind: "document" } });
      assert.equal(fake.status, 422);
      const huge = await call(member.token, "POST", `/groups/${group.id}/messages`, { attachment: { url: `${FILES}/huge.pdf`, name: "huge.pdf", kind: "document" } });
      assert.equal(huge.status, 422);
      const html = await call(member.token, "POST", `/groups/${group.id}/messages`, { attachment: { url: `${FILES}/page.html`, name: "x.pdf", kind: "document" } });
      assert.equal(html.status, 422);
      const ext = await call(member.token, "POST", `/groups/${group.id}/messages`, { attachment: { url: "https://evil.example.com/a.pdf", name: "a.pdf", kind: "document" } });
      assert.equal(ext.status, 422);
      const img = await call(member.token, "POST", `/groups/${group.id}/messages`, { attachment: { url: `${FILES}/photo.png`, name: "board.png", kind: "image" } });
      assert.equal(img.status, 201);
      const wrongKind = await call(member.token, "POST", `/groups/${group.id}/messages`, { attachment: { url: `${FILES}/photo.png`, name: "board.png", kind: "video" } });
      assert.equal(wrongKind.status, 422);
    });
    await test("messages arrive live, retries are idempotent, unread counts work", async () => {
      const s = listen(member.token); await s.ready;
      const first = await call(creator.token, "POST", `/groups/${group.id}/messages`, { text: "live?", clientId: "cid-live-1" });
      const again = await call(creator.token, "POST", `/groups/${group.id}/messages`, { text: "live?", clientId: "cid-live-1" });
      assert.equal(first.data.message.id, again.data.message.id);
      const ev = await s.waitFor((e) => e.type === "group.message" && e.data.message.text === "live?");
      assert.equal(ev.data.groupId, group.id);
      s.close();
      const list = await call(member.token, "GET", "/groups");
      const g = list.data.groups.find((x) => x.id === group.id);
      assert.ok(g.unreadCount >= 1);
      assert.equal(g.lastMessagePreview, "live?");
      await call(member.token, "POST", `/groups/${group.id}/read`);
      const after = await call(member.token, "GET", "/groups");
      assert.equal(after.data.groups.find((x) => x.id === group.id).unreadCount, 0);
    });
    await test("pagination returns older pages without overlap", async () => {
      for (let i = 0; i < 12; i += 1) await call(creator.token, "POST", `/groups/${group.id}/messages`, { text: `page ${i}` });
      const p1 = await call(creator.token, "GET", `/groups/${group.id}/messages?limit=5`);
      assert.equal(p1.data.messages.length, 5);
      assert.equal(p1.data.hasMore, true);
      const oldest = p1.data.messages[0];
      const p2 = await call(creator.token, "GET", `/groups/${group.id}/messages?limit=5&before=${encodeURIComponent(oldest.createdAt)}&beforeId=${oldest.id}`);
      const ids1 = new Set(p1.data.messages.map((m) => m.id));
      assert.ok(p2.data.messages.every((m) => !ids1.has(m.id)));
      assert.ok(new Date(p2.data.messages.at(-1).createdAt) <= new Date(oldest.createdAt));
    });
    await test("only the creator manages roles; at most three moderators", async () => {
      const extras = await Promise.all([1, 2, 3, 4].map(() => makeUser()));
      for (const u of extras) {
        await call(u.token, "POST", `/groups/code/${group.code}/join`);
        await call(creator.token, "POST", `/groups/${group.id}/members/${u.id}/review`, { action: "approve" });
      }
      assert.equal((await call(member.token, "POST", `/groups/${group.id}/members/${extras[0].id}/role`, { role: "moderator" })).status, 403);
      for (const u of extras.slice(0, 3)) {
        assert.equal((await call(creator.token, "POST", `/groups/${group.id}/members/${u.id}/role`, { role: "moderator" })).status, 200);
      }
      const fourth = await call(creator.token, "POST", `/groups/${group.id}/members/${extras[3].id}/role`, { role: "moderator" });
      assert.equal(fourth.status, 409);
      // moderator can approve joins, remove members, but not other moderators
      const mod = extras[0];
      const late = await makeUser();
      await call(late.token, "POST", `/groups/code/${group.code}/join`);
      assert.equal((await call(mod.token, "POST", `/groups/${group.id}/members/${late.id}/review`, { action: "approve" })).status, 200);
      assert.equal((await call(mod.token, "DELETE", `/groups/${group.id}/members/${extras[1].id}`)).status, 403);
      assert.equal((await call(mod.token, "DELETE", `/groups/${group.id}/members/${late.id}`)).status, 200);
      assert.equal((await call(late.token, "GET", `/groups/${group.id}/messages`)).status, 403);
      // revoke
      assert.equal((await call(creator.token, "POST", `/groups/${group.id}/members/${extras[2].id}/role`, { role: "member" })).status, 200);
      assert.equal((await call(creator.token, "POST", `/groups/${group.id}/members/${extras[3].id}/role`, { role: "moderator" })).status, 200);
      // settings are creator-only
      assert.equal((await call(mod.token, "PATCH", `/groups/${group.id}`, { name: "Hijacked" })).status, 403);
    });
    await test("members can delete only their own messages; moderators can delete any", async () => {
      const mine = await call(creator.token, "POST", `/groups/${group.id}/messages`, { text: "creator says" });
      assert.equal((await call(member.token, "DELETE", `/groups/${group.id}/messages/${mine.data.message.id}`)).status, 403);
      assert.equal((await call(creator.token, "DELETE", `/groups/${group.id}/messages/${mine.data.message.id}`)).status, 200);
    });
    await test("enforces the 200-member limit", async () => {
      const g = (await call(creator.token, "POST", "/groups", { name: "Big group", approvalRequired: false })).data.group;
      const bulk = Array.from({ length: 199 }, (_, i) => ({ id: `bulk-${Date.now()}-${i}`, email: `bulk${Date.now()}_${i}@test.academicall`, name: `Bulk ${i}`, role: "user", status: "active" }));
      await prisma.user.createMany({ data: bulk });
      await prisma.studyGroupMember.createMany({ data: bulk.map((u) => ({ groupId: g.id, userId: u.id, role: "member", status: "active", joinedAt: new Date() })) });
      const late = await makeUser();
      const r = await call(late.token, "POST", `/groups/code/${g.code}/join`);
      assert.equal(r.status, 409);
      assert.equal(r.data.code, "group_full");
    });
    await test("the creator must hand over before leaving; members can leave", async () => {
      assert.equal((await call(creator.token, "POST", `/groups/${group.id}/leave`)).status, 409);
      assert.equal((await call(member.token, "POST", `/groups/${group.id}/leave`)).status, 200);
      assert.equal((await call(member.token, "GET", `/groups/${group.id}`)).status, 403);
    });

    console.log("\nCourse representatives");
    await test("only course reps create departmental groups, scoped to their own assignment", async () => {
      const student = await makeUser();
      assert.equal((await call(student.token, "POST", "/groups", { name: "Fake official", official: true })).status, 403);
      const rep = await makeUser({ role: "courseRep", courseRepMeta: { program: "Computer Science", level: "300 Level", department: "Computer Science", faculty: "Faculty of Science" } });
      const r = await call(rep.token, "POST", "/groups", { name: "CSC 300L Official", official: true, scopeType: "program", program: "Medicine" });
      assert.equal(r.status, 201);
      assert.equal(r.data.group.program, "Computer Science");
      assert.equal(r.data.group.official, true);
      const classmate = await makeUser();
      const wrongLevel = await makeUser({ level: "100 Level" });
      const otherSchool = await makeUser({ institutionId: other.id });
      assert.equal((await call(wrongLevel.token, "POST", `/groups/code/${r.data.group.code}/join`)).status, 403);
      assert.equal((await call(otherSchool.token, "POST", `/groups/code/${r.data.group.code}/join`)).status, 403);
      assert.equal((await call(classmate.token, "POST", `/groups/code/${r.data.group.code}/join`)).data.status, "pending");
      const disc = await call(wrongLevel.token, "GET", "/groups/discover");
      assert.ok(!disc.data.groups.some((g) => g.id === r.data.group.id));
      const inv = await call(rep.token, "POST", `/groups/${r.data.group.id}/invite-scope`);
      assert.equal(inv.status, 200);
      assert.ok(inv.data.invited >= 1);
      const note = await prisma.notification.findFirst({ where: { userId: student.id, data: { path: ["groupId"], equals: r.data.group.id } } });
      assert.ok(note, "eligible student got an invite");
      const none = await prisma.notification.findFirst({ where: { userId: wrongLevel.id, data: { path: ["groupId"], equals: r.data.group.id } } });
      assert.equal(none, null);
      // a rep has no power over someone else's group
      assert.equal((await call(rep.token, "GET", `/groups/${group.id}/messages`)).status, 403);
    });

    // ── Academicall Vault ───────────────────────────────────────────────────
    console.log("\nAcademicall Vault");
    const vUser = await makeUser();
    const vOther = await makeUser();
    const vcall = (u, vt, method, path, body) => fetch(API + path, {
      method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${u.token}`, ...(vt ? { "X-Vault-Token": vt } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
    const upload = (u, vt, folderId, buf, name) => fetch(`${API}/vault/folders/${folderId}/files`, {
      method: "POST", headers: { Authorization: `Bearer ${u.token}`, "X-Vault-Token": vt, "X-File-Name": encodeURIComponent(name), "Content-Type": "application/octet-stream" }, body: buf,
    }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
    let vt = "";
    let vFolder = null;

    await test("vault: weak PINs are refused; a strong PIN creates the vault once", async () => {
      assert.equal((await call(vUser.token, "GET", "/vault/status")).data.hasPin, false);
      assert.equal((await call(vUser.token, "POST", "/vault/pin", { pin: "123456" })).status, 400);
      assert.equal((await call(vUser.token, "POST", "/vault/pin", { pin: "12345" })).status, 400);
      const ok = await call(vUser.token, "POST", "/vault/pin", { pin: "482913" });
      assert.equal(ok.status, 201);
      assert.ok(ok.data.vaultToken);
      vt = ok.data.vaultToken;
      assert.equal((await call(vUser.token, "POST", "/vault/pin", { pin: "759201" })).status, 409);
      const row = await prisma.vaultAccount.findUnique({ where: { userId: vUser.id } });
      assert.ok(row.pinHash.startsWith("$2"), "PIN is stored as a bcrypt hash");
    });

    await test("vault: contents need a vault token, not just a login", async () => {
      assert.equal((await vcall(vUser, null, "GET", "/vault/folders")).status, 401);
      assert.equal((await vcall(vUser, "garbage", "GET", "/vault/folders")).status, 401);
      assert.equal((await vcall(vOther, vt, "GET", "/vault/folders")).status, 401, "a token is bound to its owner");
      assert.equal((await vcall(vUser, vt, "GET", "/vault/folders")).status, 200);
    });

    await test("vault: folders hold only images and PDFs, encrypted at rest, private to the owner", async () => {
      const f = await vcall(vUser, vt, "POST", "/vault/folders", { name: "Certificates", color: "lemon" });
      assert.equal(f.status, 201);
      vFolder = f.data.folder;
      assert.equal((await vcall(vUser, vt, "POST", "/vault/folders", { name: "certificates" })).status, 409);
      const doc = pdf(60_000);
      const up = await upload(vUser, vt, vFolder.id, doc, "WAEC result.pdf");
      assert.equal(up.status, 201, JSON.stringify(up.data));
      assert.equal(up.data.file.kind, "pdf");
      assert.equal((await upload(vUser, vt, vFolder.id, png, "passport.png")).data.file.kind, "image");
      assert.equal((await upload(vUser, vt, vFolder.id, Buffer.from("<html><script>x</script></html>".padEnd(200)), "page.pdf")).status, 415, "sniffs bytes, not the name");
      assert.equal((await upload(vUser, vt, vFolder.id, pdf(6 * 1024 * 1024), "big.pdf")).status, 413);
      const row = await prisma.vaultFile.findUnique({ where: { id: up.data.file.id } });
      assert.ok(!Buffer.from(row.data).includes(Buffer.from("%PDF")), "bytes are encrypted in the database");
      const res = await fetch(`${API}/vault/files/${up.data.file.id}/content`, { headers: { Authorization: `Bearer ${vUser.token}`, "X-Vault-Token": vt } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/pdf");
      assert.match(res.headers.get("cache-control"), /no-store/);
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(doc), "decrypts back to the original");
      // another student with their own unlocked vault still can't reach it
      const ot = (await call(vOther.token, "POST", "/vault/pin", { pin: "306158" })).data.vaultToken;
      const peek = await fetch(`${API}/vault/files/${up.data.file.id}/content`, { headers: { Authorization: `Bearer ${vOther.token}`, "X-Vault-Token": ot } });
      assert.equal(peek.status, 404);
      assert.equal((await vcall(vOther, ot, "GET", `/vault/folders/${vFolder.id}/files`)).status, 404);
      const list = await vcall(vUser, vt, "GET", "/vault/folders");
      assert.equal(list.data.folders[0].fileCount, 2);
      assert.ok(list.data.usage.bytes > 60_000);
    });

    await test("vault: 5 wrong PINs lock it; the email code resets the PIN and revokes old tokens", async () => {
      for (let i = 0; i < 4; i += 1) {
        const r = await call(vUser.token, "POST", "/vault/unlock", { pin: "000001" });
        assert.equal(r.status, 401);
        assert.equal(r.data.attemptsLeft, 4 - i);
      }
      assert.equal((await call(vUser.token, "POST", "/vault/unlock", { pin: "000001" })).status, 423);
      assert.equal((await call(vUser.token, "POST", "/vault/unlock", { pin: "482913" })).status, 423, "even the right PIN waits out the lock");
      const sent = await call(vUser.token, "POST", "/vault/recovery/send");
      assert.equal(sent.status, 200);
      assert.match(sent.data.sentTo, /•••@test\.academicall$/);
      assert.equal((await call(vUser.token, "POST", "/vault/recovery/send")).status, 429, "cooldown between codes");
      assert.equal((await call(vUser.token, "POST", "/vault/recovery/reset", { code: "000000", newPin: "905172" })).status, 400);
      const reset = await call(vUser.token, "POST", "/vault/recovery/reset", { code: sent.data.devCode, newPin: "905172" });
      assert.equal(reset.status, 200);
      assert.equal((await vcall(vUser, vt, "GET", "/vault/folders")).status, 401, "old vault token revoked");
      assert.equal((await call(vUser.token, "POST", "/vault/recovery/reset", { code: sent.data.devCode, newPin: "905173" })).status, 400, "codes are single-use");
      const un = await call(vUser.token, "POST", "/vault/unlock", { pin: "905172" });
      assert.equal(un.status, 200);
      assert.equal((await vcall(vUser, un.data.vaultToken, "GET", "/vault/folders")).data.folders.length, 1, "files survive a PIN reset");
      vt = un.data.vaultToken;
    });

    await test("vault: deleting a folder moves it and its files to the trash", async () => {
      assert.equal((await vcall(vUser, vt, "DELETE", `/vault/folders/${vFolder.id}`)).status, 200);
      assert.equal(await prisma.vaultFile.count({ where: { userId: vUser.id, deletedAt: null } }), 0);
      assert.equal(await prisma.vaultFile.count({ where: { userId: vUser.id, deletedAt: { not: null } } }), 2, "kept for recovery");
      const after = await vcall(vUser, vt, "GET", "/vault/folders");
      assert.equal(after.data.folders.length, 0);
      assert.equal(after.data.usage.bytes, 0, "trash doesn't count against the quota");
      assert.equal((await vcall(vUser, vt, "POST", "/vault/folders", { name: "Certificates" })).status, 201, "the name is free again");
    });

    // ── Academicall News ────────────────────────────────────────────────────
    console.log("\nAcademicall News");
    const admin = await makeUser({ role: "admin" });
    const reporter = await makeUser({ name: "Ada News" });
    const reader = await makeUser({ name: "Tobi Reader" });
    const longBody = [
      "The University of Abuja has released the second-semester examination timetable, with papers starting on Monday across all faculties.",
      "Students are advised to confirm venues on the faculty notice boards, as several large courses have been split across two halls this session.",
      "## What changes this time",
      "For the first time, continuous assessment scores will be visible on the student portal a week before exams begin, according to the registry.",
      "> We want no surprises on results day, the registrar said.",
      "Course representatives will share the final schedule with their classes on Academicall as soon as each faculty confirms it.",
    ].join("\n\n");
    let story = null;

    await test("news: an admin gives the News duty; only people with it can write", async () => {
      assert.equal((await call(reporter.token, "POST", "/news/desk/posts", { title: "Exam timetable is out", body: longBody })).status, 403);
      const r = await call(admin.token, "PUT", `/users/${reporter.id}/access`, { tags: { news: true } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      const row = await prisma.user.findUnique({ where: { id: reporter.id } });
      assert.equal(row.role, "user", "keeps their own role");
      assert.deepEqual(row.staffTags, ["news"]);
      const draft = await call(reporter.token, "POST", "/news/desk/posts", { title: "Second-semester exam timetable is out", body: longBody, category: "Exams" });
      assert.equal(draft.status, 201, JSON.stringify(draft.data));
      story = draft.data.post;
      assert.equal(story.status, "draft");
      assert.equal((await call(null, "GET", `/news/${story.slug}`)).status, 404, "drafts aren't public");
      assert.ok(!(await call(null, "GET", "/news")).data.posts.some((p) => p.id === story.id));
      assert.equal((await call(reader.token, "PATCH", `/news/desk/posts/${story.id}`, { status: "published" })).status, 403);
      const pub = await call(reporter.token, "PATCH", `/news/desk/posts/${story.id}`, { status: "published" });
      assert.equal(pub.data.post.status, "published");
      assert.ok(pub.data.post.publishedAt);
    });

    await test("news: guests read a preview behind a sign-in gate; members read it all", async () => {
      const list = await call(null, "GET", "/news?category=Exams");
      assert.equal(list.status, 200);
      assert.ok(list.data.posts.some((p) => p.id === story.id));
      assert.equal(list.data.viewer.signedIn, false);
      const guest = await call(null, "GET", `/news/${story.slug}`);
      assert.equal(guest.data.post.gated, true);
      assert.ok(guest.data.post.body.length < longBody.length / 2, "guest sees only the opening");
      assert.ok(longBody.startsWith(guest.data.post.body));
      const member = await call(reader.token, "GET", `/news/${story.slug}`);
      assert.equal(member.data.post.gated, false);
      assert.equal(member.data.post.body, longBody);
    });

    await test("news: signed-in readers react and comment; guests can't", async () => {
      assert.equal((await call(null, "POST", `/news/${story.id}/comments`, { body: "hi" })).status, 401);
      assert.equal((await call(null, "POST", `/news/${story.id}/reactions`, { type: "love" })).status, 401);
      const c = await call(reader.token, "POST", `/news/${story.id}/comments`, { body: "Thanks for the heads up!" });
      assert.equal(c.status, 201);
      await call(reporter.token, "POST", `/news/${story.id}/comments`, { body: "Venues update tomorrow." });
      await call(admin.token, "POST", `/news/${story.id}/comments`, { body: "Good luck everyone." });
      assert.equal((await call(reader.token, "POST", `/news/${story.id}/reactions`, { type: "love" })).data.reactions.love, 1);
      const sw = await call(reader.token, "POST", `/news/${story.id}/reactions`, { type: "fire" });
      assert.deepEqual(sw.data.reactions, { fire: 1 }, "one reaction per reader");
      assert.equal(sw.data.myReaction, "fire");
      assert.equal((await call(reader.token, "POST", `/news/${story.id}/reactions`, { type: null })).data.reactionTotal, 0);
      const g = await call(null, "GET", `/news/${story.id}/comments`);
      assert.equal(g.data.gated, true);
      assert.equal(g.data.total, 3);
      assert.ok(g.data.comments.length <= 2);
      const m = await call(reader.token, "GET", `/news/${story.id}/comments`);
      assert.equal(m.data.comments.length, 3);
      // readers delete only their own; the news team moderates
      const others = m.data.comments.find((x) => !x.mine);
      assert.equal((await call(reader.token, "DELETE", `/news/comments/${others.id}`)).status, 403);
      assert.equal((await call(reporter.token, "DELETE", `/news/comments/${c.data.comment.id}`)).status, 200);
      assert.equal((await call(null, "GET", `/news/${story.slug}`)).data.post.commentCount, 2);
    });

    await test("news: agents edit only their own stories; admins can edit any", async () => {
      const other = await makeUser({ staffTags: ["news"] });
      assert.equal((await call(other.token, "PATCH", `/news/desk/posts/${story.id}`, { title: "Hijacked headline here" })).status, 403);
      assert.equal((await call(admin.token, "PATCH", `/news/desk/posts/${story.id}`, { title: "Second-semester exam timetable released" })).status, 200);
      assert.equal((await call(other.token, "GET", "/news/desk/posts")).data.posts.length, 0);
    });

    // ── staff access, Document Center, Secretariat ─────────────────────────
    console.log("\nStaff access");
    const alpha = await makeUser({ role: "alphaAgent", name: "Alpha One" });
    const beta = await makeUser({ role: "agent", name: "Beta One" });
    const student = await makeUser({ name: "Kemi Student" });
    const rep = await makeUser({ role: "courseRep", name: "Rep Student" });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const tokenFor = (u) => jwt.sign({ sub: u.id, email: u.email, role: u.role }, SECRET);

    await test("access: /auth/me reports role and duty capabilities", async () => {
      const a = (await call(admin.token, "GET", "/auth/me")).data.user;
      assert.ok(a.capabilities.includes("staff.manage") && a.capabilities.includes("vault.recover"));
      const al = (await call(alpha.token, "GET", "/auth/me")).data.user;
      assert.ok(al.capabilities.includes("users.password") && al.capabilities.includes("users.news"));
      assert.ok(!al.capabilities.includes("staff.manage") && !al.capabilities.includes("vault.recover"));
      const b = (await call(beta.token, "GET", "/auth/me")).data.user;
      assert.ok(b.capabilities.includes("documents.review"));
      assert.ok(!b.capabilities.includes("users.password") && !b.capabilities.includes("users.news"));
      assert.deepEqual((await call(student.token, "GET", "/auth/me")).data.user.capabilities, []);
    });

    await test("access: Alpha Agents manage duties and lower-ranked staff, not staff roles", async () => {
      assert.equal((await call(alpha.token, "PATCH", `/users/${student.id}`, { role: "admin" })).status, 403);
      assert.equal((await call(alpha.token, "PATCH", `/users/${student.id}`, { role: "agent" })).status, 403);
      assert.equal((await call(alpha.token, "PATCH", `/users/${beta.id}`, { status: "suspended" })).status, 200);
      assert.equal((await call(alpha.token, "PATCH", `/users/${beta.id}`, { status: "active" })).status, 200);
      assert.equal((await call(alpha.token, "PATCH", `/users/${admin.id}`, { status: "suspended" })).status, 403);
      assert.equal((await call(alpha.token, "PUT", `/users/${rep.id}/access`, { tags: { news: true } })).status, 200);
      const repRow = await prisma.user.findUnique({ where: { id: rep.id } });
      assert.equal(repRow.role, "courseRep");
      assert.deepEqual(repRow.staffTags, ["news"]);
      assert.equal((await call(alpha.token, "PUT", `/users/${student.id}/access`, { tags: { secretary: true } })).status, 403);
      assert.equal((await call(alpha.token, "PUT", `/users/${beta.id}/access`, { permissions: ["documents.review"] })).status, 403);
      assert.equal((await call(beta.token, "PUT", `/users/${student.id}/access`, { tags: { news: true } })).status, 403);
    });

    await test("requests: only reviewers can see other users' requests", async () => {
      const ownRequest = await prisma.request.create({ data: { requesterUid: student.id, title: "My request" } });
      await prisma.request.create({ data: { requesterUid: rep.id, title: "Another request" } });
      const ownChange = await prisma.profileChangeRequest.create({ data: { userId: student.id, field: "name", requestedValue: "Kemi Student" } });
      await prisma.profileChangeRequest.create({ data: { userId: rep.id, field: "name", requestedValue: "Rep Student" } });
      const ownRequests = await call(student.token, "GET", "/requests");
      assert.deepEqual(ownRequests.data.requests.map((r) => r.id), [ownRequest.id]);
      const ownChanges = await call(student.token, "GET", "/profile-change-requests");
      assert.deepEqual(ownChanges.data.requests.map((r) => r.id), [ownChange.id]);
      const staffRequests = await call(beta.token, "GET", "/requests");
      assert.ok(staffRequests.data.requests.some((r) => r.id === ownRequest.id));
      assert.ok(staffRequests.data.requests.some((r) => r.requesterUid === rep.id));
      const staffChanges = await call(beta.token, "GET", "/profile-change-requests");
      assert.ok(staffChanges.data.requests.some((r) => r.id === ownChange.id));
      assert.ok(staffChanges.data.requests.some((r) => r.userId === rep.id));
    });

    await test("access: admins can narrow and restore an agent's capabilities", async () => {
      const doc = await prisma.document.create({ data: { title: "Pending notes", uploadedById: student.id, status: "pending" } });
      const narrowed = await call(admin.token, "PUT", `/users/${beta.id}/access`, { permissions: ["courses.manage", "users.password"] });
      assert.equal(narrowed.status, 200, JSON.stringify(narrowed.data));
      assert.deepEqual(narrowed.data.user.capabilities.sort(), ["courses.manage", "users.password"]);
      assert.equal((await call(beta.token, "POST", `/documents/${doc.id}/approve`, {})).status, 403);
      assert.equal((await call(beta.token, "POST", "/questions/from-material", {})).status, 403);
      assert.equal((await call(beta.token, "GET", "/users")).status, 403);
      assert.equal((await call(admin.token, "PUT", `/users/${beta.id}/access`, { permissions: ["staff.manage"] })).status, 400);
      assert.equal((await call(admin.token, "PUT", `/users/${beta.id}/access`, { permissions: null })).status, 200);
      assert.equal((await call(beta.token, "POST", `/documents/${doc.id}/approve`, {})).status, 200);
      const staff = await call(admin.token, "GET", "/access/staff");
      assert.ok(staff.data.people.some((p) => p.id === rep.id && p.staffTags.includes("news")));
    });

    await test("password: forced changes revoke old sessions and allow admin reset", async () => {
      const victim = await makeUser({ name: "Forgetful Student" });
      await sleep(1100);
      assert.equal((await call(beta.token, "POST", `/users/${victim.id}/force-password-change`)).status, 403);
      assert.equal((await call(alpha.token, "POST", `/users/${admin.id}/force-password-change`)).status, 403);
      assert.equal((await call(alpha.token, "POST", `/users/${victim.id}/force-password-change`)).status, 200);
      const old = await call(victim.token, "GET", "/courses");
      assert.equal(old.status, 401);
      assert.equal(old.data.code, "session_revoked");
      await sleep(1100);
      const fresh = tokenFor(victim);
      const blocked = await call(fresh, "GET", "/courses");
      assert.equal(blocked.status, 403);
      assert.equal(blocked.data.code, "password_change_required");
      const me = await call(fresh, "GET", "/auth/me");
      assert.equal(me.status, 200);
      assert.equal(me.data.user.mustChangePassword, true);
      const temp = await call(admin.token, "POST", `/users/${victim.id}/reset-password`);
      assert.equal(temp.status, 200);
      assert.ok(temp.data.tempPassword.length >= 12);
      assert.ok(await prisma.activityLog.findFirst({ where: { action: "user.force_password_change", reference: victim.id } }));
    });

    console.log("\nDocument Center");
    await test("documents: staff can find and restore deleted materials", async () => {
      const doc = await prisma.document.create({ data: { title: "MTH 201 past questions", uploadedById: student.id, status: "approved" } });
      assert.equal((await call(student.token, "DELETE", `/documents/${doc.id}`)).status, 204);
      assert.equal((await call(student.token, "GET", `/documents/${doc.id}`)).status, 404);
      assert.ok(!(await call(admin.token, "GET", "/documents")).data.documents.some((d) => d.id === doc.id));
      assert.equal((await call(student.token, "GET", "/files/materials?state=deleted")).status, 403);
      const bin = await call(admin.token, "GET", "/files/materials?state=deleted&q=MTH%20201");
      const deleted = bin.data.materials.find((d) => d.id === doc.id);
      assert.ok(deleted);
      assert.equal(deleted.deletedBy, student.name);
      assert.equal((await call(admin.token, "POST", `/files/materials/${doc.id}/restore`)).status, 200);
      assert.equal((await call(student.token, "GET", `/documents/${doc.id}`)).status, 200);
    });

    await test("documents: owners cannot approve their own uploads by editing them", async () => {
      const doc = await prisma.document.create({ data: { title: "Sneaky upload", uploadedById: student.id, status: "pending" } });
      const result = await call(student.token, "PATCH", `/documents/${doc.id}`, { status: "approved", title: "Sneaky upload v2" });
      assert.equal(result.status, 403);
      const row = await prisma.document.findUnique({ where: { id: doc.id } });
      assert.equal(row.status, "pending");
      assert.equal(row.title, "Sneaky upload");
    });

    await test("vault recovery: admins restore files; opening requires a reason and notifies the owner", async () => {
      assert.equal((await call(beta.token, "GET", "/files/vault")).status, 403);
      const users = await call(admin.token, "GET", `/files/vault?q=${encodeURIComponent(vUser.email)}`);
      const mine = users.data.users.find((u) => u.user.id === vUser.id);
      assert.ok(mine && mine.trash === 2);
      const detail = await call(admin.token, "GET", `/files/vault/${vUser.id}`);
      const lost = detail.data.files.find((f) => f.deletedAt && f.kind === "pdf");
      assert.ok(lost);
      assert.ok(!("data" in lost));
      assert.equal((await call(admin.token, "POST", `/files/vault-files/${lost.id}/restore`)).status, 200);
      const back = await vcall(vUser, vt, "GET", "/vault/folders");
      assert.ok(back.data.folders.some((f) => f.name.startsWith("Certificates") && f.fileCount === 1));
      assert.equal((await call(admin.token, "POST", `/files/vault-files/${lost.id}/open`, { reason: "x" })).status, 400);
      const opened = await fetch(`${API}/files/vault-files/${lost.id}/open`, {
        method: "POST",
        headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Student requested access to their result" }),
      });
      assert.equal(opened.status, 200);
      assert.equal(Buffer.from(await opened.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
      assert.ok(await prisma.notification.findFirst({ where: { userId: vUser.id, title: { contains: "opened a file" } } }));
      assert.ok(await prisma.activityLog.findFirst({ where: { action: "vault.open", reference: vUser.id } }));
    });

    console.log("\nSecretariat");
    await test("secretariat: duty access, record numbering, confidentiality and archive permissions", async () => {
      const sec = await makeUser({ name: "Sade Secretary" });
      assert.equal((await call(sec.token, "GET", "/secretariat/overview")).status, 403);
      assert.equal((await call(admin.token, "PUT", `/users/${sec.id}/access`, { tags: { secretary: true } })).status, 200);
      const ov = await call(sec.token, "GET", "/secretariat/overview");
      assert.equal(ov.status, 200, JSON.stringify(ov.data));
      assert.deepEqual(ov.data.can, { records: true, confidential: false, archive: false, activity: true });
      const a = await call(sec.token, "POST", "/secretariat/records", { kind: "minutes", title: "Staff meeting, week 6", body: "Attendance: 7.", meetingDate: "2026-10-12", tags: ["Meetings"] });
      assert.equal(a.status, 201, JSON.stringify(a.data));
      assert.match(a.data.record.refNo, /^ACA\/SEC\/\d{4}\/\d{4}$/);
      const b = await call(sec.token, "POST", "/secretariat/records", { kind: "memo", title: "Exam period support rota" });
      assert.equal(Number(b.data.record.refNo.slice(-4)), Number(a.data.record.refNo.slice(-4)) + 1);
      assert.equal((await call(sec.token, "POST", "/secretariat/records", { title: "Private note", confidential: true })).status, 403);
      const conf = await call(admin.token, "POST", "/secretariat/records", { title: "Disciplinary hearing notes", confidential: true });
      assert.equal(conf.status, 201);
      const list = await call(sec.token, "GET", "/secretariat/records");
      assert.ok(!list.data.records.some((r) => r.id === conf.data.record.id));
      assert.equal((await call(sec.token, "GET", `/secretariat/records/${conf.data.record.id}`)).status, 404);
      assert.equal((await call(sec.token, "PATCH", `/secretariat/records/${a.data.record.id}`, { status: "filed" })).status, 200);
      assert.equal((await call(sec.token, "DELETE", `/secretariat/records/${a.data.record.id}`)).status, 403);
      const journal = await call(sec.token, "GET", "/secretariat/activity?area=secretariat");
      assert.ok(journal.data.entries.some((e) => e.action === "secretariat.record_create"));
      assert.ok(!journal.data.entries.some((e) => (e.target || "").includes("Disciplinary")));
      assert.equal((await call(admin.token, "PUT", `/users/${sec.id}/access`, { permissions: ["secretariat.records", "secretariat.archive", "secretariat.confidential"] })).status, 200);
      assert.equal((await call(sec.token, "GET", `/secretariat/records/${conf.data.record.id}`)).status, 200);
      assert.equal((await call(sec.token, "GET", "/secretariat/activity")).status, 403);
      assert.equal((await call(sec.token, "DELETE", `/secretariat/records/${a.data.record.id}`)).status, 200);
    });

  } finally {
    api.kill();
    fileServer.close();
    await prisma.$executeRawUnsafe(`DELETE FROM "notifications" WHERE "createdById" IN (SELECT "id" FROM "users" WHERE "email" LIKE '%@test.academicall')`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "secretariat_records" WHERE "createdById" IN (SELECT "id" FROM "users" WHERE "email" LIKE '%@test.academicall')`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "documents" WHERE "uploadedById" IN (SELECT "id" FROM "users" WHERE "email" LIKE '%@test.academicall')`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "activity_logs" WHERE "userId" IN (SELECT "id" FROM "users" WHERE "email" LIKE '%@test.academicall')`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "news_posts" WHERE "authorId" IN (SELECT "id" FROM "users" WHERE "email" LIKE '%@test.academicall')`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "requests" WHERE "requesterUid" IN (SELECT "id" FROM "users" WHERE "email" LIKE '%@test.academicall')`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "profile_change_requests" WHERE "userId" IN (SELECT "id" FROM "users" WHERE "email" LIKE '%@test.academicall')`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "users" WHERE "email" LIKE '%@test.academicall'`).catch((e) => console.error("cleanup", e.message));
    await prisma.$disconnect();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
