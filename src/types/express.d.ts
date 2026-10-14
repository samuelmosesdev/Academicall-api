import { Role } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: Role;
        name?: string | null;
        staffTags?: string[];
        caps?: string[];
      };
    }
  }
}

export {};
