#!/usr/bin/env node
import { spawn, ChildProcess } from "node:child_process";
import QRCode from "qrcode";
import { startServer } from "./server.js";
import { logger } from "./util/log.js";

const PORT = Number(process.env.AGENT_WELL_PORT ?? "7777");
// Optional reserved ngrok hostname. Configure in .env via AGENT_WELL_NGROK_URL.
// If unset, agent-well still starts ngrok and discovers the assigned ephemeral
// hostname from the local API; set AGENT_WELL_NGROK_DISABLE=1 to skip ngrok
// entirely.
const NGROK_URL = process.env.AGENT_WELL_NGROK_URL ?? "";
const NGROK_DISABLED = !!process.env.AGENT_WELL_NGROK_DISABLE;
/** ngrok's local inspector / API; default port 4040, override with NGROK_API_PORT. */
const NGROK_API_PORT = Number(process.env.NGROK_API_PORT ?? "4040");

async function main() {
  const server = await startServer({
    port: PORT,
    host: process.env.AGENT_WELL_HOST,
  });

  const ngrok = NGROK_DISABLED ? null : startNgrok(PORT, NGROK_URL);
  const publicHost = ngrok
    ? NGROK_URL || (await discoverNgrokHost(NGROK_API_PORT))
    : null;
  const tunnelUrl = publicHost
    ? `https://${publicHost}/?token=${server.token}`
    : undefined;
  const scanUrl = tunnelUrl ?? server.lanUrl ?? server.localUrl;

  const qr = await QRCode.toString(scanUrl, {
    type: "terminal",
    small: false,
    errorCorrectionLevel: "M",
    margin: 2,
  });

  const lines = [
    "",
    "  agent-well",
    "  ----------",
    "  Scan with your phone (or open on this machine):",
    "",
    qr,
  ];
  if (tunnelUrl) {
    lines.push(`  Tunnel: ${tunnelUrl}`);
    if (!NGROK_URL) {
      lines.push("  (ephemeral ngrok hostname — changes on each launch)");
    }
  } else if (ngrok && !NGROK_DISABLED) {
    lines.push("  Tunnel: (ngrok started but no public URL discovered yet)");
  }
  lines.push(`  Local:  ${server.localUrl}`);
  if (server.lanUrl) lines.push(`  LAN:    ${server.lanUrl}`);
  lines.push("");
  lines.push("  Token rotates per launch. Anyone with the URL can drive the agent.");
  lines.push("");
  process.stdout.write(lines.join("\n") + "\n");

  const shutdown = (sig: NodeJS.Signals) => {
    logger.info(`Received ${sig}, shutting down...`);
    if (ngrok && !ngrok.killed) ngrok.kill("SIGTERM");
    server.http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function startNgrok(port: number, reservedUrl: string): ChildProcess | null {
  // With a reserved hostname we pin the tunnel to it; without one we let
  // ngrok assign an ephemeral hostname (looked up via the local API below).
  const args = reservedUrl
    ? ["http", `--url=${reservedUrl}`, String(port)]
    : ["http", String(port)];
  try {
    const proc = spawn("ngrok", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    proc.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        logger.warn(
          "ngrok binary not found on PATH. Install ngrok or set AGENT_WELL_NGROK_DISABLE=1 to skip.",
        );
      } else {
        logger.warn(`ngrok failed to start: ${err.message}`);
      }
    });
    proc.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        logger.warn(`ngrok exited (code=${code}, signal=${signal})`);
      }
    });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) logger.warn(`[ngrok] ${line}`);
      }
    });
    return proc;
  } catch (err) {
    logger.warn("ngrok spawn failed", err);
    return null;
  }
}

/**
 * Poll ngrok's local inspector API to learn the ephemeral public hostname
 * assigned to our tunnel. Returns the bare host (e.g. `abc123.ngrok-free.app`)
 * with the protocol stripped, or null if ngrok never came up within the
 * deadline.
 */
async function discoverNgrokHost(apiPort: number): Promise<string | null> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/api/tunnels`);
      if (res.ok) {
        const data = (await res.json()) as {
          tunnels?: Array<{ public_url?: string; proto?: string }>;
        };
        const https = data.tunnels?.find(
          (t) => t.proto === "https" && t.public_url,
        );
        if (https?.public_url) {
          return https.public_url.replace(/^https?:\/\//, "");
        }
      }
    } catch {
      // ngrok API not ready yet; keep polling.
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  logger.warn(
    `ngrok did not expose a public URL via http://127.0.0.1:${apiPort}/api/tunnels within 15s.`,
  );
  return null;
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
