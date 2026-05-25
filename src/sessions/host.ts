import { randomUUID } from "node:crypto";
import { AcpClient } from "../acp/client.js";
import {
  AuthenticateParams,
  CancelParams,
  ContentBlock,
  InitializeResult,
  NewSessionResult,
  PermissionOption,
  PromptResult,
  ReadTextFileParams,
  ReadTextFileResult,
  RequestPermissionParams,
  RequestPermissionResult,
  SessionNotification,
  SessionUpdate,
  TerminalCreateParams,
  TerminalKillParams,
  TerminalOutputParams,
  TerminalReleaseParams,
  TerminalWaitParams,
  WriteTextFileParams,
} from "../acp/types.js";
import { readTextFile, writeTextFile } from "../handlers/fs.js";
import { TerminalManager } from "../handlers/terminal.js";
import { logger } from "../util/log.js";
import * as store from "./store.js";

export type Sink = (msg: Record<string, unknown>) => void;

interface PendingPermission {
  requestId: string;
  toolCall: unknown;
  options: PermissionOption[];
  resolve: (r: RequestPermissionResult) => void;
}

export interface SessionHostOptions {
  id: string;
  agentId: string;
  cwd: string;
  acp: AcpClient;
  authMethods?: InitializeResult["authMethods"];
  agentCapabilities?: InitializeResult["agentCapabilities"];
  modes?: NewSessionResult["modes"];
  preamble: string;
  onDispose: () => void;
}

/**
 * A live agent session. Owns the ACP subprocess and the session-scoped
 * handlers (filesystem, terminals, permission relay). Lives independently of
 * any browser bridge — a bridge attaches as a transient "sink" for events and
 * detaches on disconnect, but the ACP keeps running. This is what lets an
 * iPhone lock for an hour without killing the agent: the bridge dies on idle
 * sweep, the host carries on, and the next bridge to attach picks up where
 * the previous one left off (including any in-flight prompt or pending
 * permission request).
 */
export class SessionHost {
  readonly id: string;
  readonly agentId: string;
  readonly cwd: string;
  readonly acp: AcpClient;
  readonly modes?: NewSessionResult["modes"];
  readonly authMethods?: InitializeResult["authMethods"];
  readonly agentCapabilities?: InitializeResult["agentCapabilities"];

  private terminals = new TerminalManager();
  private pendingPermissions = new Map<string, PendingPermission>();
  private attachedSink: Sink | null = null;
  private primed = false;
  private _busy = false;
  private preamble: string;
  private onDispose: () => void;
  private disposed = false;

  constructor(opts: SessionHostOptions) {
    this.id = opts.id;
    this.agentId = opts.agentId;
    this.cwd = opts.cwd;
    this.acp = opts.acp;
    this.modes = opts.modes;
    this.authMethods = opts.authMethods;
    this.agentCapabilities = opts.agentCapabilities;
    this.preamble = opts.preamble;
    this.onDispose = opts.onDispose;
    this.wireAcp();
  }

  get busy(): boolean {
    return this._busy;
  }

  isAttached(): boolean {
    return this.attachedSink !== null;
  }

  /**
   * Attach a bridge sink. Replays any permission requests that arrived while
   * detached so the user sees them as soon as a tab reconnects.
   */
  attach(sink: Sink): void {
    this.attachedSink = sink;
    for (const p of this.pendingPermissions.values()) {
      sink({
        type: "permission_request",
        sessionId: this.id,
        requestId: p.requestId,
        toolCall: p.toolCall,
        options: p.options,
      });
    }
  }

  /** Detach a specific sink; no-op if a different sink is currently attached. */
  detach(sink: Sink): void {
    if (this.attachedSink === sink) this.attachedSink = null;
  }

  private emit(msg: Record<string, unknown>): void {
    this.attachedSink?.(msg);
  }

  private wireAcp(): void {
    const acp = this.acp;

    acp.onNotification("session/update", (params) => {
      const n = params as SessionNotification;
      if (!n || n.sessionId !== this.id) return;
      this.emit({
        type: "session_update",
        sessionId: this.id,
        update: n.update,
      });
      void this.persistSessionUpdate(n.update);
    });

    acp.onRequest("session/request_permission", async (params) => {
      return this.handlePermissionRequest(params as RequestPermissionParams);
    });

    acp.onRequest("fs/read_text_file", async (params) => {
      return readTextFile(
        params as ReadTextFileParams,
      ) as Promise<ReadTextFileResult>;
    });
    acp.onRequest("fs/write_text_file", async (params) => {
      return writeTextFile(params as WriteTextFileParams);
    });

    acp.onRequest("terminal/create", async (params) => {
      return this.terminals.create(params as TerminalCreateParams);
    });
    acp.onRequest("terminal/output", async (params) => {
      return this.terminals.output(params as TerminalOutputParams);
    });
    acp.onRequest("terminal/wait_for_exit", async (params) => {
      return this.terminals.wait(params as TerminalWaitParams);
    });
    acp.onRequest("terminal/kill", async (params) => {
      return this.terminals.kill(params as TerminalKillParams);
    });
    acp.onRequest("terminal/release", async (params) => {
      return this.terminals.release(params as TerminalReleaseParams);
    });

    acp.on("close", () => this.handleAcpClose());
    acp.on("error", (err: Error) => {
      this.emit({
        type: "error",
        sessionId: this.id,
        message: `Agent process error: ${err.message}`,
      });
    });
  }

  private handlePermissionRequest(
    p: RequestPermissionParams,
  ): Promise<RequestPermissionResult> {
    const requestId = randomUUID();
    return new Promise<RequestPermissionResult>((resolve) => {
      const pending: PendingPermission = {
        requestId,
        toolCall: p.toolCall,
        options: p.options as PermissionOption[],
        resolve: (r) => {
          this.pendingPermissions.delete(requestId);
          resolve(r);
        },
      };
      this.pendingPermissions.set(requestId, pending);
      this.emit({
        type: "permission_request",
        sessionId: this.id,
        requestId,
        toolCall: p.toolCall,
        options: p.options,
      });
    });
  }

  permissionResponse(
    requestId: string,
    outcome: "selected" | "cancelled",
    optionId?: string,
  ): void {
    const p = this.pendingPermissions.get(requestId);
    if (!p) {
      logger.warn("permission response for unknown request", requestId);
      return;
    }
    if (outcome === "selected" && optionId) {
      p.resolve({ outcome: { outcome: "selected", optionId } });
    } else {
      p.resolve({ outcome: { outcome: "cancelled" } });
    }
  }

  async authenticate(methodId: string): Promise<void> {
    const params: AuthenticateParams = { methodId };
    await this.acp.call("authenticate", params);
    this.emit({ type: "authenticated", sessionId: this.id });
  }

  async prompt(prompt: ContentBlock[]): Promise<void> {
    void store
      .update(this.id, (s) => {
        s.transcript.push({
          kind: "user_prompt",
          at: new Date().toISOString(),
          content: prompt,
        });
        s.lastActiveAt = new Date().toISOString();
        if (!s.title) s.title = derivePromptTitle(prompt);
      })
      .catch((err) => logger.warn("persist prompt failed", err));

    const forwardedPrompt: ContentBlock[] = this.primed
      ? prompt
      : [{ type: "text", text: this.preamble }, ...prompt];
    this.primed = true;
    this._busy = true;

    try {
      const result = (await this.acp.call<PromptResult>("session/prompt", {
        sessionId: this.id,
        prompt: forwardedPrompt,
      })) as PromptResult;
      this._busy = false;
      this.emit({
        type: "prompt_complete",
        sessionId: this.id,
        stopReason: result.stopReason,
      });
      void this.persistPromptComplete(result.stopReason);
    } catch (err) {
      this._busy = false;
      this.emit({
        type: "prompt_error",
        sessionId: this.id,
        message: (err as Error).message,
      });
    }
  }

  cancel(): void {
    const params: CancelParams = { sessionId: this.id };
    this.acp.notify("session/cancel", params);
  }

  close(): void {
    if (this.disposed) return;
    this.terminals.killAll();
    this.acp.kill();
  }

  private handleAcpClose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminals.killAll();
    for (const p of this.pendingPermissions.values()) {
      p.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();
    this.emit({ type: "session_closed", sessionId: this.id });
    this.onDispose();
  }

  private persistSessionUpdate(update: SessionUpdate) {
    return store
      .update(this.id, (s) => {
        s.transcript.push({
          kind: "session_update",
          at: new Date().toISOString(),
          update,
        });
        s.lastActiveAt = new Date().toISOString();
      })
      .catch((err) => logger.warn("persist update failed", err));
  }

  private persistPromptComplete(stopReason: string) {
    return store
      .update(this.id, (s) => {
        s.transcript.push({
          kind: "prompt_complete",
          at: new Date().toISOString(),
          stopReason,
        });
        s.lastActiveAt = new Date().toISOString();
      })
      .catch((err) => logger.warn("persist complete failed", err));
  }
}

function derivePromptTitle(prompt: ContentBlock[]): string {
  for (const b of prompt) {
    if (b.type === "text" && b.text.trim()) {
      return b.text.trim().slice(0, 80);
    }
  }
  return "Untitled session";
}
