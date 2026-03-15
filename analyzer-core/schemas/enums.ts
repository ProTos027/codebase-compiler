import { z } from "zod";

export const RoleSchema = z.enum([
  "source",
  "test",
  "config",
  "script",
  "build",
  "generated",
  "vendor",
  "asset",
  "binary",
  "unknown",
]);
export const visibilitySchema = z.enum([
    "normal",
    "hidden",
    "external",
    "blackbox",
  ])

export type Visibility = z.infer<typeof visibilitySchema>;
export type Role = z.infer<typeof RoleSchema>;