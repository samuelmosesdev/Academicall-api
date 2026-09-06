import { Request, Response } from "express";
export declare function listDocuments(req: Request, res: Response): Promise<void>;
export declare function getDocument(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function createDocument(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function updateDocument(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function deleteDocument(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
//# sourceMappingURL=documents.controller.d.ts.map