/**
 * Cloudflare Worker entry point.
 */
import { RedirectService } from "./service.js";
import type { Env, ExecutionContextLike } from "./types.js";

const service = new RedirectService();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    return service.fetch(request, env, ctx);
  },
};

export { RedirectService } from "./service.js";
export { Router } from "./router.js";
export { validateRules, formatReport } from "./validate.js";
export { parseCsv, parseJson, parseRules, toCsv, toKvBulk, diffRules } from "./io.js";
export { normalizeRule } from "./rules.js";
export type * from "./types.js";
