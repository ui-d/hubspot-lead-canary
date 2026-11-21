import * as Sentry from "@sentry/cloudflare";
import type { AppEnv } from "./env";
import { handleReport } from "./report";
import { runScheduled } from "./runner";
import { lastRun } from "./store/d1";

async function handleHealth(env: AppEnv): Promise<Response> {
  const run = await lastRun(env.DB_INTERNAL);
  return Response.json({
    ok: true,
    lastRunAt: run?.started_at ?? null,
    lastRunStatus: run?.status ?? null,
  });
}

const app = {
  async fetch(request: Request, env: AppEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (url.pathname === "/health") return handleHealth(env);
    if (url.pathname === "/report") return handleReport(request, env);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(
    controller: ScheduledController,
    env: AppEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const summary = await runScheduled(env, controller.scheduledTime);
    if (summary.errors.length > 0) {
      // Surface failures to Cloudflare (and Sentry if enabled). Messages contain no PII.
      throw new Error(`run ${summary.runId} failed: ${summary.errors.join("; ")}`);
    }
  },
} satisfies ExportedHandler<AppEnv>;

/** Sentry wrapper is active only when SENTRY_DSN is set; otherwise the SDK gets no options. */
const withSentry = Sentry.withSentry<AppEnv, unknown, unknown, typeof app>(
  (env) =>
    env.SENTRY_DSN
      ? {
          dsn: env.SENTRY_DSN,
          tracesSampleRate: 0,
          sendDefaultPii: false,
          // Outbound URLs carry secrets (Healthchecks ping key) and CRM ids: never record them.
          beforeBreadcrumb: (crumb) =>
            crumb.category === "fetch" || crumb.category === "http" ? null : crumb,
        }
      : undefined,
  app,
);

export default {
  fetch: (request, env, ctx) =>
    env.SENTRY_DSN ? withSentry.fetch(request, env, ctx) : app.fetch(request, env, ctx),
  scheduled: (controller, env, ctx) =>
    env.SENTRY_DSN
      ? withSentry.scheduled(controller, env, ctx)
      : app.scheduled(controller, env, ctx),
} satisfies ExportedHandler<AppEnv>;
