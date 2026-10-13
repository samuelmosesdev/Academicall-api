/**
 * Real-time delivery over Server-Sent Events.
 *
 * Why SSE: the API is a plain Express app behind Render/Railway proxies. SSE is
 * one long-lived HTTP response per tab, needs no extra dependency, survives
 * proxies, and reconnects on its own. Writes still go through the normal REST
 * endpoints (which keep validation + auth in one place); the stream only pushes.
 *
 * Fan-out is in-process. With more than one API instance, put a broker between
 * them (Redis pub/sub or Postgres LISTEN/NOTIFY) and call `deliver()` from the
 * subscriber — the rest of the code does not change.
 */
import { Response } from "express";
import { prisma } from "./prisma";

export interface RealtimeEvent {
  type: string; // e.g. "group.message", "programme.post"
  data: unknown;
}

interface Client {
  id: number;
  userId: string;
  res: Response;
  scopes: Set<string>; // programme scope keys this connection listens to
}

const clients = new Map<number, Client>();
const byUser = new Map<string, Set<number>>();
let nextId = 1;
let eventSeq = 0;

const HEARTBEAT_MS = 25_000;

setInterval(() => {
  for (const client of clients.values()) {
    try {
      client.res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      removeClient(client.id);
    }
  }
}, HEARTBEAT_MS).unref?.();

function removeClient(id: number) {
  const client = clients.get(id);
  if (!client) return;
  clients.delete(id);
  const set = byUser.get(client.userId);
  set?.delete(id);
  if (set && set.size === 0) byUser.delete(client.userId);
}

export function addClient(userId: string, res: Response, scopes: string[]) {
  const id = nextId++;
  const client: Client = { id, userId, res, scopes: new Set(scopes) };
  clients.set(id, client);
  if (!byUser.has(userId)) byUser.set(userId, new Set());
  byUser.get(userId)!.add(id);
  res.on("close", () => removeClient(id));
  return id;
}

function write(client: Client, event: RealtimeEvent) {
  try {
    eventSeq += 1;
    client.res.write(`id: ${eventSeq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  } catch {
    removeClient(client.id);
  }
}

/** Push to every open connection of these users. */
export function publishToUsers(userIds: Iterable<string>, event: RealtimeEvent) {
  for (const userId of new Set(userIds)) {
    const ids = byUser.get(userId);
    if (!ids) continue;
    for (const id of ids) {
      const client = clients.get(id);
      if (client) write(client, event);
    }
  }
}

/** Push to connections whose user belongs to this programme scope (institution + programme). */
export function publishToScope(scopeKey: string, event: RealtimeEvent) {
  for (const client of clients.values()) {
    if (client.scopes.has(scopeKey)) write(client, event);
  }
}

/** Push to every active member of a study group (looked up fresh, so removals take effect at once). */
export async function publishToGroup(groupId: string, event: RealtimeEvent, extraUserIds: string[] = []) {
  const members = await prisma.studyGroupMember.findMany({
    where: { groupId, status: "active" },
    select: { userId: true },
  });
  const ids = members.map((m) => m.userId).filter((id) => byUser.has(id));
  publishToUsers([...ids, ...extraUserIds], event);
}

export function connectionCount() {
  return clients.size;
}
