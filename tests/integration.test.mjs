/**
 * End-to-end API tests against a real PostgreSQL database.
 *
 *   DATABASE_URL=postgresql://... npm run build && node tests/integration.test.mjs
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
    console.log(`  ✗ ${name}\n      ${err.message}`);
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
    env: { ...process.env, PORT: "4100", JWT_SECRET: SECRET, AUTO_SEED_INSTITUTIONS: "false", ATTACHMENT_ALLOWED_ORIGINS: FILES + "/", NODE_ENV: "test" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(API + "/health")).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }

  try {
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
      const a = await makeUser(); const b = await makeUser();
      const outsider = await makeUser({ institutionId: other.id });
      const post = await call(a.token, "POST", "/feed/course", { title: "Test", body: "Hello", department: "Computer Science", level: "300 Level" });
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
        title: "Foreign institution post", department: "Computer Science", level: "300 Level", institutionId: other.id,
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
        title: "Wrong tenant", department: "Computer Science", institutionId: other.id,
      })).status, 403);
      assert.equal((await call(agent.token, "PATCH", `/feed/course/${foreignPost.data.post.id}`, { title: "Changed" })).status, 403);
      assert.equal((await call(agent.token, "DELETE", `/feed/course/${foreignPost.data.post.id}`)).status, 403);
      assert.equal((await call(agent.token, "PATCH", `/class-events/${foreignEvent.data.event.id}`, { title: "Changed" })).status, 403);
      assert.equal((await call(agent.token, "DELETE", `/class-events/${foreignEvent.data.event.id}`)).status, 403);

      const ownPost = await call(globalStaff.token, "POST", "/feed/course", {
        title: "Local institution post", department: "Computer Science", level: "300 Level", institutionId: "uofa",
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
      const a = await makeUser();
      const post = await call(a.token, "POST", "/feed/course", { title: "Race", department: "Computer Science", level: "300 Level" });
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
  } finally {
    api.kill();
    fileServer.close();
    await prisma.$executeRawUnsafe(`DELETE FROM "notifications" WHERE "createdById" IN (SELECT "id" FROM "users" WHERE "email" LIKE '%@test.academicall')`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM "users" WHERE "email" LIKE '%@test.academicall'`).catch((e) => console.error("cleanup", e.message));
    await prisma.$disconnect();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
