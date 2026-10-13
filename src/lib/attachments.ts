/**
 * Server-side validation for files shared in study groups.
 *
 * Files are uploaded straight from the device to Cloudinary (so large files never
 * pass through, or slow down, this API). Before a message that references a file
 * is accepted, the API checks the file itself:
 *   1. the URL is on our own Cloudinary cloud (or an allowed origin),
 *   2. its real size (HEAD Content-Length) is within the limit for its kind,
 *   3. its first bytes match an allowed file signature (PDF, Office, image, video),
 *      so a renamed .exe or HTML page is rejected whatever its extension says.
 */

export type AttachmentKind = "image" | "video" | "document";

export const LIMITS: Record<AttachmentKind, number> = {
  image: Number(process.env.GROUP_MAX_IMAGE_MB || 10) * 1024 * 1024,
  video: Number(process.env.GROUP_MAX_VIDEO_MB || 25) * 1024 * 1024,
  document: Number(process.env.GROUP_MAX_DOCUMENT_MB || 20) * 1024 * 1024,
};
export const MAX_VIDEO_SECONDS = Number(process.env.GROUP_MAX_VIDEO_SECONDS || 180);
/** Attachments above this size are withheld from members who were granted older history. */
export const HISTORY_ATTACHMENT_LIMIT = 2 * 1024 * 1024;

const DOC_EXT = ["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "txt", "csv", "rtf", "odt", "odp"];
const IMG_EXT = ["jpg", "jpeg", "png", "webp", "gif"];
const VID_EXT = ["mp4", "webm", "mov", "m4v", "3gp"];

export const ALLOWED_EXTENSIONS: Record<AttachmentKind, string[]> = {
  image: IMG_EXT,
  video: VID_EXT,
  document: DOC_EXT,
};

function hex(buf: Uint8Array, start = 0, len = 4) {
  return Buffer.from(buf.slice(start, start + len)).toString("hex");
}

/** Identify a file from its first bytes. */
export function sniff(buf: Uint8Array): { kind: AttachmentKind | "text"; format: string } | null {
  if (buf.length < 4) return null;
  const h4 = hex(buf, 0, 4);
  const ascii = Buffer.from(buf.slice(0, 16)).toString("latin1");
  if (ascii.startsWith("%PDF")) return { kind: "document", format: "pdf" };
  if (h4 === "504b0304") return { kind: "document", format: "office-zip" }; // docx/pptx/xlsx/odt
  if (hex(buf, 0, 8) === "d0cf11e0a1b11ae1") return { kind: "document", format: "office-ole" }; // doc/ppt/xls
  if (ascii.startsWith("{\\rtf")) return { kind: "document", format: "rtf" };
  if (hex(buf, 0, 3) === "ffd8ff") return { kind: "image", format: "jpeg" };
  if (hex(buf, 0, 8) === "89504e470d0a1a0a") return { kind: "image", format: "png" };
  if (ascii.startsWith("GIF8")) return { kind: "image", format: "gif" };
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return { kind: "image", format: "webp" };
  if (ascii.slice(4, 8) === "ftyp") return { kind: "video", format: "mp4/mov" };
  if (h4 === "1a45dfa3") return { kind: "video", format: "webm" };
  // Plain text / CSV: printable bytes only, and not markup
  const sample = Buffer.from(buf).toString("utf8");
  if (!/[\x00-\x08\x0e-\x1f]/.test(sample) && !/^\s*</.test(sample)) return { kind: "text", format: "text" };
  return null;
}

export function extensionOf(name?: string | null) {
  const m = String(name || "").toLowerCase().split("?")[0].match(/\.([a-z0-9]{2,5})$/);
  return m ? m[1] : "";
}

function allowedOrigin(url: URL) {
  const custom = (process.env.ATTACHMENT_ALLOWED_ORIGINS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (custom.some((origin) => url.href.startsWith(origin))) return true;
  if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com") return false;
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloud) return true; // not configured: any Cloudinary cloud (documented; set it in production)
  return url.pathname.startsWith(`/${cloud}/`);
}

export interface AttachmentInput {
  url: string;
  name?: string | null;
  kind: AttachmentKind;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
}

export interface VerifiedAttachment {
  url: string;
  name: string;
  mime: string;
  bytes: number;
  kind: AttachmentKind;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
}

export class AttachmentError extends Error {
  status = 422;
}

const FETCH_TIMEOUT_MS = 12_000;

async function timed(input: string, init: RequestInit = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal, redirect: "follow" });
  } finally {
    clearTimeout(t);
  }
}

export async function verifyAttachment(input: AttachmentInput): Promise<VerifiedAttachment> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new AttachmentError("Attachment URL is not valid.");
  }
  if (!allowedOrigin(url)) throw new AttachmentError("Files must be uploaded through Academicall.");

  const kind = input.kind;
  if (!LIMITS[kind]) throw new AttachmentError("Unsupported attachment type.");
  const name = String(input.name || url.pathname.split("/").pop() || "file").slice(0, 180);
  const ext = extensionOf(name) || extensionOf(url.pathname);
  if (ext && !ALLOWED_EXTENSIONS[kind].includes(ext)) {
    throw new AttachmentError(`.${ext} files can't be shared as ${kind === "document" ? "documents" : `${kind}s`}.`);
  }

  // 1. Real size
  let bytes = 0;
  let mime = "";
  try {
    const head = await timed(url.href, { method: "HEAD" });
    if (!head.ok) throw new Error(String(head.status));
    bytes = Number(head.headers.get("content-length") || 0);
    mime = String(head.headers.get("content-type") || "").split(";")[0];
  } catch {
    throw new AttachmentError("We couldn't reach the uploaded file. Please upload it again.");
  }
  if (!bytes) throw new AttachmentError("The uploaded file is empty or its size is unknown.");
  if (bytes > LIMITS[kind]) {
    throw new AttachmentError(`That ${kind} is ${(bytes / 1048576).toFixed(1)} MB. The limit is ${Math.round(LIMITS[kind] / 1048576)} MB.`);
  }
  if (/text\/html|javascript|x-msdownload|x-sh/.test(mime)) throw new AttachmentError("That file type isn't allowed.");

  // 2. Real contents
  let first: Uint8Array;
  try {
    const part = await timed(url.href, { headers: { Range: "bytes=0-63" } });
    first = new Uint8Array(await part.arrayBuffer()).slice(0, 64);
  } catch {
    throw new AttachmentError("We couldn't read the uploaded file. Please try again.");
  }
  const found = sniff(first);
  const ok =
    found &&
    (found.kind === kind ||
      (kind === "document" && found.kind === "text" && ["txt", "csv"].includes(ext)));
  if (!ok) throw new AttachmentError(`That file doesn't look like a valid ${kind}.`);

  if (kind === "video" && input.duration && input.duration > MAX_VIDEO_SECONDS) {
    throw new AttachmentError(`Videos can be up to ${Math.round(MAX_VIDEO_SECONDS / 60)} minutes long.`);
  }

  return {
    url: url.href,
    name,
    mime: mime || "application/octet-stream",
    bytes,
    kind,
    width: input.width ?? null,
    height: input.height ?? null,
    duration: input.duration ?? null,
  };
}
