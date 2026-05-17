#!/usr/bin/env node
import { spawn, ChildProcess } from "node:child_process";
import QRCode from "qrcode";
import { startServer } from "./server.js";
import { logger } from "./util/log.js";

const PORT = Number(process.env.AGENT_WELL_PORT ?? "7777");
// Reserved ngrok hostname. Set to empty string to skip the tunnel.
const NGROK_URL = process.env.AGENT_WELL_NGROK_URL ?? "oleh.ngrok.io";

async function main() {
  const server = await startServer({
    port: PORT,
    host: process.env.AGENT_WELL_HOST,
  });

  const ngrokProc = NGROK_URL ? startNgrok(PORT, NGROK_URL) : null;
  const tunnelUrl =
    NGROK_URL && ngrokProc
      ? `https://${NGROK_URL}/?token=${server.token}`
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
    lines.push("  (ngrok takes a few seconds to establish the tunnel)");
  }
  lines.push(`  Local:  ${server.localUrl}`);
  if (server.lanUrl) lines.push(`  LAN:    ${server.lanUrl}`);
  lines.push("");
  lines.push("  Token rotates per launch. Anyone with the URL can drive the agent.");
  lines.push("");
  process.stdout.write(lines.join("\n") + "\n");

  const shutdown = (sig: NodeJS.Signals) => {
    logger.info(`Received ${sig}, shutting down...`);
    if (ngrokProc && !ngrokProc.killed) ngrokProc.kill("SIGTERM");
    server.http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function startNgrok(port: number, url: string): ChildProcess | null {
  try {
    const proc = spawn("ngrok", ["http", `--url=${url}`, String(port)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    proc.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        logger.warn(
          "ngrok binary not found on PATH. Install ngrok or set AGENT_WELL_NGROK_URL= to skip.",
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

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
