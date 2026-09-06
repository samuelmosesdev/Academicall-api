import { Request, Response } from "express";
export declare function listCourses(req: Request, res: Response): Promise<void>;
export declare function getCourse(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function createCourse(req: Request, res: Response): Promise<Response<any, Record<string, any>> | undefined>;
export declare function updateCourse(req: Request, res: Response): Promise<void>;
export declare function deleteCourse(req: Request, res: Response): Promise<void>;
//# sourceMappingURL=courses.controller.d.ts.map