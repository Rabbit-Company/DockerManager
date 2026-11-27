import type { Context, Middleware } from "@rabbit-company/web";

export interface AppState extends Record<string, unknown> {}

export type AppContext = Context<AppState>;
export type AppMiddleware = Middleware<AppState>;
