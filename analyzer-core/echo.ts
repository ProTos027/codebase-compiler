console.log("TS execution check: OK");
import { z } from "zod";
console.log("Zod import check: OK");
const schema = z.object({ a: z.string() });
console.log("Schema creation check: OK");
