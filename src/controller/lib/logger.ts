import { createWebLogger } from "@rabbit-company/web-middleware/logger";
import { config } from "../config.ts";

export const logger = createWebLogger({
	level: config.logging.level,
	console: true,
});
