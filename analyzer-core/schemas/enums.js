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
]);
