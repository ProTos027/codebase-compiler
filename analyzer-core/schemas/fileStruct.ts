import {z} from "zod";
import { RoleSchema, visibilitySchema } from "./enums";
export const FileNodeSchema = z.object({
  path: z.string(),

  language: z.string(),

  role: RoleSchema,

  include: z.boolean().default(true),

  visibility: visibilitySchema.default("normal"),
})