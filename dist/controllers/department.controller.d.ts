import { Request, Response } from "express";
export declare function requestJoin(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function myMembership(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function listMembers(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function admitMember(req: Request, res: Response): Promise<void>;
export declare function rejectMember(req: Request, res: Response): Promise<void>;
export declare function requestWithdraw(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function reviewWithdraw(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
//# sourceMappingURL=department.controller.d.ts.map