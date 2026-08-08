import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { exchange } from "../interface.ts";
import type { Graph } from "../model.ts";
import { renderExchange } from "../render/exchange.ts";
import { shell } from "./html.ts";

const HERE = dirname(new URL(import.meta.url).pathname);

/**
 * The client bundle: built on the fly with esbuild during development, taken
 * pre-built from dist in a published package.
 */
async function clientBundle(): Promise<string> {
  const prebuilt = join(HERE, "client.js");
  const { existsSync, readFileSync } = await import("node:fs");
  if (existsSync(prebuilt)) return readFileSync(prebuilt, "utf8");

  const esbuild = await import("esbuild");
  const r = await esbuild.build({
    entryPoints: [join(HERE, "client.ts")],
    bundle: true,
    format: "iife",
    target: "es2022",
    minify: true,
    write: false,
    logLevel: "silent",
  });
  return r.outputFiles?.[0]?.text ?? "";
}

export interface ServeOptions {
  port: number;
  /** Supplies the current graph per request, so a reload is enough to see changes. */
  graph: () => Graph;
}

export async function serveHttp(opt: ServeOptions): Promise<string> {
  const client = await clientBundle();

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(shell());
      return;
    }
    if (url === "/client.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(client);
      return;
    }
    if (url === "/api/graph") {
      const g = opt.graph();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(g));
      return;
    }
    if (url.startsWith("/api/interface")) {
      // Rendered here rather than in the browser: the same function draws the image
      // the CLI writes, so the tab and the file a PR gets cannot drift apart.
      const q = new URL(url, "http://localhost").searchParams;
      const provider = q.get("provider") ?? "";
      const consumer = q.get("consumer") ?? "";
      const g = opt.graph();
      const domains = new Set(g.nodes.map((n) => n.domain));
      if (!domains.has(provider) || !domains.has(consumer) || provider === consumer) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("pick two different domains that exist");
        return;
      }
      res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8" });
      res.end(renderExchange(exchange(g, provider, consumer)));
      return;
    }
    res.writeHead(404).end("not found");
  });

  await new Promise<void>((ok) => server.listen(opt.port, ok));
  // Report where it actually listens, not what was asked for. Port 0 means "any
  // free one", and answering with the request would name a port nothing is on.
  const bound = server.address();
  const port = typeof bound === "object" && bound ? bound.port : opt.port;
  return `http://localhost:${port}`;
}
