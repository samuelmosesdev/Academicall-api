import { Request, Response } from "express";
export declare function listMyNotifications(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function listAdminNotifications(_req: Request, res: Response): Promise<void>;
export declare function markRead(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function archiveNotification(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function createNotification(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function registerDeviceToken(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function removeDeviceToken(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare const registerFcmToken: typeof registerDeviceToken;
export declare const removeFcmToken: typeof removeDeviceToken;
//# sourceMappingURL=notifications.controller.d.ts.map