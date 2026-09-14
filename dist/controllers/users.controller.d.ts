import { Request, Response } from "express";
export declare function listUsers(req: Request, res: Response): Promise<void>;
/** Any authenticated user can check whether a department-level Course Rep exists. */
export declare function courseRepStatus(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function getUser(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function updateMe(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function adminUpdateUser(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
/**
 * Admin-triggered password reset for a user who lost access to their email.
 *
 * IMPORTANT: this does NOT expose the user's existing password or its hash —
 * bcrypt hashes are one-way, so there is no way to "recover" a lost password
 * from its hash even if you could see it. Showing hashes to admins would add
 * real security risk (offline cracking, leak surface) without solving the
 * actual problem. Instead this issues a brand-new temporary password, shown
 * to the admin exactly once in this response, and forces the user to change
 * it on next login. Verify the user's identity through another channel
 * (student ID, phone call, etc.) before handing over the temp password.
 */
export declare function adminResetPassword(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function createAgent(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function deleteUser(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
//# sourceMappingURL=users.controller.d.ts.map