import { NextFunction, Request, RequestHandler, Response } from "express";

export const defaultCachePolicy: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (req.method === "GET" || req.method === "HEAD") {
    res.setHeader("Cache-Control", "private, no-cache");
    res.vary("Authorization");
  }
  next();
};

export function cacheForGuests(seconds: number, staleWhileRevalidate = seconds * 10): RequestHandler {
  return (req, res, next) => {
    res.vary("Authorization");
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      !req.headers.authorization
    ) {
      res.setHeader(
        "Cache-Control",
        `public, max-age=${seconds}, stale-while-revalidate=${staleWhileRevalidate}`,
      );
    }
    next();
  };
}
