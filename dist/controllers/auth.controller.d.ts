import { Request, Response } from "express";
export declare function register(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function login(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function changePassword(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function googleLogin(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function requestPasswordReset(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function confirmPasswordReset(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function sendVerification(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function verifyEmail(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function me(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
//# sourceMappingURL=auth.controller.d.ts.map