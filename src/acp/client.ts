import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { logger } from "../util/log.js";
import {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export interface AcpClientOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  label: string;
}

/**
 * Reverse-call handler installed by the bridge. Returns the JSON-RPC `result`
 * or throws to surface an error.
 */
export type RequestHandler = (params: unknown) => Promise<unknown>;

/** Notification handler. Errors are logged and swallowed. */
export type NotificationHandler = (params: unknown) => void | Promise<void>;

/**
 * Stdio JSON-RPC client for ACP agents. Spawns the agent as a subprocess,
 * speaks line-delimited JSON over stdin/stdout, and exposes:
 *  - call(method, params): outbound request -> agent
 *  - notify(method, params): outbound notification -> agent
 *  - on('request:<method>', handler): inbound request from agent
 *  - on('notification:<method>', handler): inbound notification from agent
 */
export class AcpClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private stdoutBuf = "";
  private stderrBuf = "";
  private closed = false;
  readonly label: string;

  constructor(opts: AcpClientOptions) {
    super();
    this.label = opts.label;
    this.proc = spawn(opts.command, opts.args, {
      env: { ...process.env, ...(opts.env ?? {}) },
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk: string) => this.onStderr(chunk));
    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      logger.info(`[acp:${this.label}] exited code=${code} signal=${signal}`);
      const err = new Error(
         `Agent process exited (code=${code}, signal=${signal})`,
      );
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.emit("close", { code, signal });
    });
    this.proc.on("error", (err) => {
      logger.error(`[acp:${this.label}] process error`, err);
      this.emit("error", err);
    });
  }

  private onStdout(chunk: string) {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        logger.error(`[acp:${this.label}] bad JSON from agent`, line);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private onStderr(chunk: string) {
    this.stderrBuf += chunk;
    let idx: number;
    while ((idx = this.stderrBuf.indexOf("\n")) >= 0) {
      const line = this.stderrBuf.slice(0, idx);
      this.stderrBuf = this.stderrBuf.slice(idx + 1);
      if (line) logger.warn(`[acp:${this.label}:stderr] ${line}`);
    }
  }

  private dispatch(msg: JsonRpcMessage) {
    if ("id" in msg && msg.id !== undefined && "method" in msg) {
      this.handleIncomingRequest(msg as JsonRpcRequest);
    } else if ("id" in msg && msg.id !== undefined) {
      this.handleResponse(msg as JsonRpcResponse);
    } else if ("method" in msg) {
      this.handleNotification(msg as JsonRpcNotification);
    } else {
      logger.warn(`[acp:${this.label}] unrecognized message`, msg);
    }
  }

  private async handleIncomingRequest(req: JsonRpcRequest) {
    const evt = `request:${req.method}`;
    if (this.listenerCount(evt) === 0) {
      this.writeMessage({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      });
      return;
    }
    try {
      // Single-handler convention: first listener resolves the request.
      const handler = this.listeners(evt)[0] as RequestHandler;
      const result = await handler(req.params);
      this.writeMessage({ jsonrpc: "2.0", id: req.id, result });
    } catch (err) {
      const e = err as Error & { code?: number; data?: unknown };
      this.writeMessage({
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: typeof e.code === "number" ? e.code : -32000,
          message: e.message ?? "Internal error",
          data: e.data,
        },
      });
    }
  }

  private handleResponse(res: JsonRpcResponse) {
    const pending = this.pending.get(res.id);
    if (!pending) {
      logger.warn(`[acp:${this.label}] response without pending id`, res.id);
      return;
    }
    this.pending.delete(res.id);
    if (res.error) {
      const err = new Error(res.error.message) as Error & {
        code?: number;
        data?: unknown;
      };
      err.code = res.error.code;
      err.data = res.error.data;
      pending.reject(err);
    } else {
      pending.resolve(res.result);
    }
  }

  private handleNotification(n: JsonRpcNotification) {
    this.emit(`notification:${n.method}`, n.params);
  }

  private writeMessage(msg: JsonRpcMessage) {
    if (this.closed) return;
    try {
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      logger.error(`[acp:${this.label}] write failed`, err);
    }
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("Agent process is not running"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.writeMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  onRequest(method: string, handler: RequestHandler) {
    this.removeAllListeners(`request:${method}`);
    this.on(`request:${method}`, handler);
  }

  onNotification(method: string, handler: NotificationHandler) {
    this.on(`notification:${method}`, handler);
  }

  kill(signal: NodeJS.Signals = "SIGTERM") {
    if (!this.closed) this.proc.kill(signal);
  }

  get isClosed() {
    return this.closed;
  }
}
