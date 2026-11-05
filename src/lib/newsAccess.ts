import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export type NewsAccess = {
  mode: "open" | "soft" | "preview";
  previewChars: number;
  ogImage: "cover" | "card";
};

export const NEWS_ACCESS_DEFAULTS: NewsAccess = {
  mode: "preview",
  previewChars: 650,
  ogImage: "cover",
};
export const PREVIEW_CHARS_MIN = 150;
export const PREVIEW_CHARS_MAX = 6000;

const KEY = "newsAccess";
const TTL = 15_000;
let cache: { at: number; value: NewsAccess } | null = null;

export function normalizeNewsAccess(raw: unknown): NewsAccess {
  const value = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const chars = Number(value.previewChars);

  return {
    mode: value.mode === "open" || value.mode === "soft" || value.mode === "preview"
      ? value.mode
      : NEWS_ACCESS_DEFAULTS.mode,
    previewChars: Number.isFinite(chars)
      ? Math.min(PREVIEW_CHARS_MAX, Math.max(PREVIEW_CHARS_MIN, Math.round(chars)))
      : NEWS_ACCESS_DEFAULTS.previewChars,
    ogImage: value.ogImage === "card" || value.ogImage === "cover"
      ? value.ogImage
      : NEWS_ACCESS_DEFAULTS.ogImage,
  };
}

export async function getNewsAccess(fresh = false): Promise<NewsAccess> {
  if (!fresh && cache && Date.now() - cache.at < TTL) return cache.value;
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const value = normalizeNewsAccess(row?.value);
  cache = { at: Date.now(), value };
  return value;
}

export async function saveNewsAccess(input: Partial<NewsAccess>): Promise<NewsAccess> {
  const next = normalizeNewsAccess({ ...(await getNewsAccess(true)), ...input });
  await prisma.setting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: next as Prisma.InputJsonValue },
    update: { value: next as Prisma.InputJsonValue },
  });
  cache = { at: Date.now(), value: next };
  return next;
}
