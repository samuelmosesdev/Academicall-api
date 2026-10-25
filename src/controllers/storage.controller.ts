import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Request, Response } from "express";
import { z } from "zod";

const uploadSchema = z.object({
  name: z.string().trim().min(1).max(180),
  contentType: z.string().trim().max(120).default(""),
  size: z.number().int().positive(),
  kind: z.enum(["image", "video", "document", "audio"]),
});

const extensions: Record<string, { kind: "image" | "video" | "document" | "audio"; contentType: string }> = {
  jpg: { kind: "image", contentType: "image/jpeg" },
  jpeg: { kind: "image", contentType: "image/jpeg" },
  png: { kind: "image", contentType: "image/png" },
  webp: { kind: "image", contentType: "image/webp" },
  gif: { kind: "image", contentType: "image/gif" },
  pdf: { kind: "document", contentType: "application/pdf" },
  doc: { kind: "document", contentType: "application/msword" },
  docx: { kind: "document", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  ppt: { kind: "document", contentType: "application/vnd.ms-powerpoint" },
  pptx: { kind: "document", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  xls: { kind: "document", contentType: "application/vnd.ms-excel" },
  xlsx: { kind: "document", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  txt: { kind: "document", contentType: "text/plain" },
  csv: { kind: "document", contentType: "text/csv" },
  rtf: { kind: "document", contentType: "application/rtf" },
  odt: { kind: "document", contentType: "application/vnd.oasis.opendocument.text" },
  odp: { kind: "document", contentType: "application/vnd.oasis.opendocument.presentation" },
  mp4: { kind: "video", contentType: "video/mp4" },
  webm: { kind: "video", contentType: "video/webm" },
  mov: { kind: "video", contentType: "video/quicktime" },
  m4v: { kind: "video", contentType: "video/x-m4v" },
  "3gp": { kind: "video", contentType: "video/3gpp" },
  m4a: { kind: "audio", contentType: "audio/mp4" },
  ogg: { kind: "audio", contentType: "audio/ogg" },
  mp3: { kind: "audio", contentType: "audio/mpeg" },
  wav: { kind: "audio", contentType: "audio/wav" },
  aac: { kind: "audio", contentType: "audio/aac" },
};

const allowedMimeAliases: Record<string, string[]> = {
  "image/jpeg": ["image/jpg"],
  "application/rtf": ["text/rtf"],
  "application/vnd.ms-excel": ["application/x-msexcel"],
  "video/x-m4v": ["video/mp4"],
};

const MAX_BYTES: Record<z.infer<typeof uploadSchema>["kind"], number> = {
  image: 10 * 1024 * 1024,
  video: 25 * 1024 * 1024,
  document: 25 * 1024 * 1024,
  audio: 10 * 1024 * 1024,
};

type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
};

let r2Client: S3Client | undefined;

function getR2Config(): R2Config | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_PUBLIC_BASE_URL) {
    return null;
  }

  let publicUrl: URL;
  try {
    publicUrl = new URL(R2_PUBLIC_BASE_URL);
  } catch {
    return null;
  }
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.pathname !== "/") {
    return null;
  }

  return {
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucket: R2_BUCKET,
    publicBaseUrl: publicUrl.origin,
  };
}

function getClient(config: R2Config) {
  if (!r2Client) {
    r2Client = new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }
  return r2Client;
}

function canonicalMime(type: string, expected: string) {
  const normalized = type.toLowerCase().split(";")[0].trim();
  return !normalized || normalized === "application/octet-stream" || normalized === expected ||
    (allowedMimeAliases[expected] || []).includes(normalized);
}

export async function presignUpload(req: Request, res: Response) {
  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Provide a valid file name, type, size, and upload kind." });
  }

  const config = getR2Config();
  if (!config) {
    return res.status(503).json({ error: "File uploads are not configured yet." });
  }

  const { name, contentType, size, kind } = parsed.data;
  const extension = name.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1] || "";
  const fileType = kind === "audio" && extension === "webm"
    ? { kind: "audio" as const, contentType: "audio/webm" }
    : extensions[extension];
  if (!fileType || fileType.kind !== kind || !canonicalMime(contentType, fileType.contentType)) {
    return res.status(415).json({ error: "That file type is not supported for this upload." });
  }
  if (size > MAX_BYTES[kind]) {
    return res.status(413).json({ error: `Files of this type can be up to ${Math.floor(MAX_BYTES[kind] / 1048576)} MB.` });
  }

  const key = `uploads/${kind}/${randomUUID()}.${extension}`;
  const disposition = kind === "document"
    ? `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
    : "inline";

  try {
    const command = new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ContentType: fileType.contentType,
      ContentDisposition: disposition,
      ContentLength: size,
    });
    const uploadUrl = await getSignedUrl(getClient(config), command, {
      expiresIn: 120,
      signableHeaders: new Set(["content-length", "content-type", "content-disposition"]),
    });
    return res.json({
      uploadUrl,
      publicUrl: `${config.publicBaseUrl}/${key}`,
      key,
      size,
      contentType: fileType.contentType,
      headers: {
        "Content-Type": fileType.contentType,
        "Content-Disposition": disposition,
      },
    });
  } catch (error) {
    console.error("[storage] Could not create R2 upload URL.", error);
    return res.status(503).json({ error: "Could not prepare the file upload. Please try again." });
  }
}
