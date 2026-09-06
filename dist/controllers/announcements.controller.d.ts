import { Request, Response } from "express";
export declare function listAnnouncements(req: Request, res: Response): Promise<void>;
export declare function createAnnouncement(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function updateAnnouncement(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function deleteAnnouncement(req: Request, res: Response): Promise<void>;
export declare function listAnnouncementReads(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function markAnnouncementRead(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
//# sourceMappingURL=announcements.controller.d.ts.map