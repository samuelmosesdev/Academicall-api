import type { NextFunction, Request, RequestHandler, Response } from "express";

type RateLimitOptions = {
  name: string;
  windowMs: number;
  max: number;
  key?: (request: Request) => string;
  failuresOnly?: boolean;
  message?: string;
};

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();
let lastSweepAt = 0;

export function rateLimit(options: RateLimitOptions): RequestHandler {
  if (!options.name || options.windowMs <= 0 || options.max <= 0) {
    throw new Error("Rate-limit name, window, and maximum must be positive.");
  }

  return (request: Request, response: Response, next: NextFunction) => {
    const now = Date.now();
    if (now - lastSweepAt >= 60_000) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
      lastSweepAt = now;
    }

    const key = `${options.name}:${options.key?.(request) || request.ip || "unknown"}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }

    if (bucket.count >= options.max) {
      response.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return response.status(429).json({ error: options.message || "Too many requests. Try again later." });
    }

    bucket.count += 1;
    if (options.failuresOnly) {
      response.once("finish", () => {
        if (response.statusCode < 400 && buckets.get(key) === bucket) {
          bucket!.count = Math.max(0, bucket!.count - 1);
        }
      });
    }

    return next();
  };
}

const ipKey = (request: Request) => request.ip || "unknown";
const accountKey = (request: Request) => {
  const email = request.body?.email;
  return typeof email === "string" && email.trim() ? email.trim().toLowerCase() : ipKey(request);
};
const userKey = (request: Request) => {
  const userId = (request as Request & { user?: { id?: string } }).user?.id;
  return userId || ipKey(request);
};

export const authLimits = {
  register: rateLimit({ name: "auth-register", windowMs: 60 * 60_000, max: 10, key: ipKey }),
  loginPerIp: rateLimit({ name: "auth-login-ip", windowMs: 15 * 60_000, max: 100, key: ipKey, failuresOnly: true }),
  loginPerAccount: rateLimit({ name: "auth-login-account", windowMs: 15 * 60_000, max: 8, key: accountKey, failuresOnly: true }),
  passwordChange: rateLimit({ name: "auth-password-change", windowMs: 15 * 60_000, max: 8, key: userKey }),
  resetRequestPerIp: rateLimit({ name: "auth-reset-ip", windowMs: 60 * 60_000, max: 20, key: ipKey }),
  resetRequestPerEmail: rateLimit({ name: "auth-reset-email", windowMs: 60 * 60_000, max: 3, key: accountKey }),
  resetConfirm: rateLimit({ name: "auth-reset-confirm", windowMs: 60 * 60_000, max: 10, key: accountKey, failuresOnly: true }),
  google: rateLimit({ name: "auth-google", windowMs: 15 * 60_000, max: 30, key: ipKey, failuresOnly: true }),
  verifySend: rateLimit({ name: "auth-verify-send", windowMs: 60 * 60_000, max: 5, key: userKey }),
  verifyCheck: rateLimit({ name: "auth-verify-check", windowMs: 15 * 60_000, max: 8, key: userKey, failuresOnly: true }),
};
