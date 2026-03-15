import { Router, Request, Response } from "express";
import { KindleCalendarConfig } from "../config/types";
import { RenderOrchestrator, ProviderSet } from "../renderer/orchestrator";

export interface ServeHandlerOptions {
  config: KindleCalendarConfig;
  providers: ProviderSet;
}

/**
 * Builds an Express router with all HTTP endpoints:
 *
 * GET /screen.png  - Renders and returns the display image as PNG
 * GET /screen.jpg  - Renders and returns the display image as JPG
 * GET /preview     - Returns the rendered HTML for browser preview
 * GET /health      - Returns 200 OK with service status
 *
 * Optional token auth: if config.server.secret is set, all endpoints
 * (except /health) require ?token=<secret> query parameter.
 */
export function createServeRouter(options: ServeHandlerOptions): Router {
  const router = Router();
  const { config, providers } = options;

  function checkToken(req: Request, res: Response): boolean {
    if (!config.server.secret) return true;
    if (req.query["token"] === config.server.secret) return true;
    res.status(401).json({ error: "Unauthorized: missing or invalid token" });
    return false;
  }

  router.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      service: "kindle-calendar",
      timestamp: new Date().toISOString(),
    });
  });

  router.get("/screen.png", async (req: Request, res: Response) => {
    if (!checkToken(req, res)) return;
    try {
      const orchestrator = new RenderOrchestrator(config, providers);
      const result = await orchestrator.render({ htmlOnly: false });
      if (!result.png) {
        res.status(500).json({ error: "Render did not produce PNG output" });
        return;
      }
      res.set("Content-Type", "image/png");
      res.set("Cache-Control", `public, max-age=${config.cache.renderTTLSeconds}`);
      res.send(result.png);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[serve.handler] /screen.png error:", message);
      res.status(500).json({ error: message });
    }
  });

  router.get("/screen.jpg", async (req: Request, res: Response) => {
    if (!checkToken(req, res)) return;
    try {
      const orchestrator = new RenderOrchestrator(config, providers);
      const result = await orchestrator.render({ htmlOnly: false });
      if (!result.jpg) {
        res.status(500).json({ error: "Render did not produce JPG output" });
        return;
      }
      res.set("Content-Type", "image/jpeg");
      res.set("Cache-Control", `public, max-age=${config.cache.renderTTLSeconds}`);
      res.send(result.jpg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[serve.handler] /screen.jpg error:", message);
      res.status(500).json({ error: message });
    }
  });

  router.get("/preview", async (req: Request, res: Response) => {
    if (!checkToken(req, res)) return;
    try {
      const orchestrator = new RenderOrchestrator(config, providers);
      const result = await orchestrator.render({ htmlOnly: true });
      res.set("Content-Type", "text/html; charset=utf-8");
      res.send(result.html);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[serve.handler] /preview error:", message);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
