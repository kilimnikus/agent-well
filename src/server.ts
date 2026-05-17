import http from "node:http";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TransportRegistry } from "./transport.js";
import { logger } from "./util/log.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

/** Long-poll cap. Many proxies kill idle connections around 30-60s. */
const LONG_POLL_TIMEOUT_MS = 25_000;
/** Cap on the size of a single command payload. */
const MAX_BODY_BYTES = 1_000_000;

export interface ServerOptions {
  port: number;
  host?: string;
}

export interface RunningServer {
  http: http.Server;
  registry: TransportRegistry;
  token: string;
  localUrl: string;
  lanUrl?: string;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const host = opts.host ?? "0.0.0.0";
  const token = randomBytes(24).toString("hex");
  const registry = new TransportRegistry();

  const httpServer = http.createServer(async (req, res) => {
    try {
      await route(req, res, token, registry);
    } catch (err) {
      logger.error("http handler error", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, host, () => {
      httpServer.off("error", reject);
      resolveListen();
    });
  });

  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  const lanIp = getLanIp();
  const localUrl = `http://127.0.0.1:${port}/?token=${token}`;
  const lanUrl = lanIp ? `http://${lanIp}:${port}/?token=${token}` : undefined;

  return { http: httpServer, registry, token, localUrl, lanUrl };
}

export function getLanIp(): string | undefined {
  const nets = networkInterfaces();
  const candidates: string[] = [];
  for (const [, ifaces] of Object.entries(nets)) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        candidates.push(iface.address);
      }
    }
  }
  const lan = candidates.find((ip) =>
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip),
  );
  return lan ?? candidates[0];
}

// ---- request routing -----------------------------------------------------

async function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
  registry: TransportRegistry,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (!checkAuth(req, url, token, res)) return;

  const path = url.pathname;
  if (path.startsWith("/api/")) {
    return handleApi(req, res, url, registry);
  }
  return serveStatic(req, res, url, token);
}

function checkAuth(
  req: http.IncomingMessage,
  url: URL,
  token: string,
  res: http.ServerResponse,
): boolean {
  const cookieToken = parseCookie(req.headers.cookie ?? "")["agent-well-token"];
  const queryToken = url.searchParams.get("token");
  if (cookieToken === token) return true;
  if (queryToken === token) {
    res.setHeader(
      "set-cookie",
      `agent-well-token=${token}; Path=/; HttpOnly; SameSite=Strict`,
    );
    return true;
  }
  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "Unauthorized" }));
  return false;
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  registry: TransportRegistry,
): Promise<void> {
  const path = url.pathname;

  if (req.method === "POST" && path === "/api/connect") {
    const conn = registry.connect();
    return sendJson(res, 200, { clientId: conn.id });
  }

  const clientId =
    (req.headers["x-client-id"] as string | undefined) ??
    url.searchParams.get("clientId") ??
    "";
  const conn = clientId ? registry.get(clientId) : undefined;
  if (!conn) {
    return sendJson(res, 410, { error: "Unknown clientId. Reconnect." });
  }

  if (req.method === "GET" && path === "/api/events") {
    const since = Number(url.searchParams.get("since") ?? "0") || 0;
    // Make a long-poll cancellable so a sweep can release it cleanly.
    let cancel: (() => void) | null = null;
    const cancellable = new Promise<void>((resolveCancel) => {
      cancel = resolveCancel;
    });
    conn.cancelPoll = cancel ?? undefined;
    req.on("close", () => cancel?.());

    const result = await Promise.race([
      conn.queue.drainSince(since, LONG_POLL_TIMEOUT_MS),
      cancellable.then(() => null),
    ]);
    conn.cancelPoll = undefined;
    if (result == null) {
      return sendJson(res, 200, { events: [], next: since });
    }
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && path === "/api/command") {
    const body = await readBody(req);
    let cmd: { type: string; [k: string]: unknown };
    try {
      cmd = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON" });
    }
    void conn.bridge.handleClientMessage(cmd);
    return sendJson(res, 202, { ok: true });
  }

  if (req.method === "POST" && path === "/api/disconnect") {
    registry.disconnect(clientId);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "Not Found" });
}

async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  _token: string,
): Promise<void> {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/" || pathname === "") pathname = "/index.html";
  const safe = normalize(pathname).replace(/^\/+/, "");
  const filePath = join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
    const body = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader(
      "content-type",
      MIME[extname(filePath)] ?? "application/octet-stream",
    );
    res.setHeader("cache-control", "no-cache");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Not Found");
  }
}

// ---- helpers --------------------------------------------------------------

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}
