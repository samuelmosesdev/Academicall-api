import { Request, Response, NextFunction } from "express";
import { Role } from "@prisma/client";
export declare function authenticate(req: Request, res: Response, next: NextFunction): Promise<void | Response<any, Record<string, any>>>;
export declare function requireRole(...roles: Role[]): (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
export declare const requireAdmin: (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
export declare const requireStaff: (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
export declare const requireAdminOrAlpha: (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
//# sourceMappingURL=auth.d.ts.map