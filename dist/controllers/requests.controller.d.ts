import { Request, Response } from "express";
export declare function listRequests(req: Request, res: Response): Promise<void>;
export declare function createRequest(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function updateRequest(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function listProfileChangeRequests(req: Request, res: Response): Promise<void>;
export declare function createProfileChangeRequest(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function updateProfileChangeRequest(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function deleteProfileChangeRequest(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
//# sourceMappingURL=requests.controller.d.ts.map