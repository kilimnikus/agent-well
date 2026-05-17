import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { AcpClient } from "./acp/client.js";
import { ACP_PROTOCOL_VERSION, CLIENT_CAPABILITIES } from "./acp/constants.js";
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
} from "./acp/types.js";
import { BUILTIN_AGENTS, findAgent } from "./agents/registry.js";
import { readTextFile, writeTextFile } from "./handlers/fs.js";
import { TerminalManager } from "./handlers/terminal.js";
import * as store from "./sessions/store.js";
import { logger } from "./util/log.js";

interface ActiveSession {
  id: string;
  agentId: string;
  cwd: string;
  acp: AcpClient;
  terminals: TerminalManager;
  /** Map permissionRequestId -> waiter that resolves with the user's choice. */
  pendingPermissions: Map<string, (r: RequestPermissionResult) => void>;
  modes?: NewSessionResult["modes"];
  authMethods?: InitializeResult["authMethods"];
  title?: string;
  /** True once the embed-capable preamble has been delivered on this ACP process. */
  primed?: boolean;
}

/**
 * Preamble we attach to the first prompt of every ACP session so the agent
 * knows the client renders a small allowlist of HTML media tags and is
 * encouraged to emit them inline — for final results and intermediate updates.
 */
const EMBED_PREAMBLE: string = [
  "[agent-well client capabilities]",
  "Your output is rendered in a chat UI with these inline rendering features:",
  "",
  "1. Media tags (allowlisted HTML; all other HTML is escaped to text):",
  '     <audio controls src="…"></audio>',
  '     <video controls src="…"></video>',
  '     <img src="…" alt="…" />',
  "   Allowed src values: absolute https:// URLs, or paths starting with /.",
  "",
  "2. LaTeX math, rendered with KaTeX:",
  "     inline:  $E = mc^2$   or   \\(E = mc^2\\)",
  "     display: $$\\int_0^\\infty e^{-x^2}\\,dx = \\tfrac{\\sqrt{\\pi}}{2}$$",
  "              \\[ … \\]",
  "   Use LaTeX for any formula, equation, or math symbol. Do NOT use",
  "   rendered-image services or screenshots for math.",
  "",
  "3. Standard markdown: paragraphs, lists, headings, **bold**, *italic*,",
  "   `inline code`, fenced code blocks, [links](https://…).",
  "",
  "Whenever a result is naturally a media artifact (audio you just recorded,",
  "a screenshot you captured, a generated image, a video clip), emit the",
  "corresponding tag inline in your response. Do this for FINAL results AND",
  "for INTERMEDIATE progress updates as soon as the artifact exists — don't",
  "wait for the end. Write tags and math inline with your prose; do not wrap",
  "them in code fences (they render in place).",
].join("\n");

/**
 * Per-tab bridge instance. Manages a set of agent sessions for one browser
 * client, routing messages between the browser and ACP subprocesses. The
 * transport (long-poll, WS, etc.) is provided via a generic `send` sink so
 * this class doesn't know how its events reach the client.
 */
export class BrowserBridge {
  private sessions = new Map<string, ActiveSession>();
  private disposed = false;

  constructor(private sink: (msg: Record<string, unknown>) => void) {
    void this.sendInitial();
  }

  // ---- outbound: browser <- server ---------------------------------------

  private send(msg: Record<string, unknown>) {
    if (this.disposed) return;
    this.sink(msg);
  }

  /** Invoked by the transport for each command POSTed by the browser. */
  handleClientMessage(msg: { type: string; [k: string]: unknown }) {
    return this.handle(msg).catch((err) => {
      const e = err as Error;
      logger.error("handler error", msg.type, e);
      this.send({
        type: "error",
        message: e.message,
        context: msg.type,
        sessionId: msg.sessionId,
      });
    });
  }

  /** Tear down all sessions; called when the client disconnects. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const session of this.sessions.values()) {
      session.terminals.killAll();
      session.acp.kill();
    }
    this.sessions.clear();
  }

  private async sendInitial() {
    const sessions = await store.list();
    this.send({
      type: "ready",
      agents: BUILTIN_AGENTS.map(({ id, name, description, installHint }) => ({
        id,
        name,
        description,
        installHint,
      })),
      sessions: sessions.map((s) => ({
        id: s.id,
        agentId: s.agentId,
        cwd: s.cwd,
        title: s.title,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
      })),
      defaultCwd: process.cwd(),
      home: homedir(),
    });
  }

  // ---- inbound: browser -> server ----------------------------------------

  private async handle(msg: { type: string; [k: string]: unknown }) {
    switch (msg.type) {
      case "list_sessions": {
        const sessions = await store.list();
        this.send({ type: "sessions", sessions });
        return;
      }
      case "new_session":
        return this.cmdNewSession(msg as never);
      case "load_session":
        return this.cmdLoadSession(msg as never);
      case "authenticate":
        return this.cmdAuthenticate(msg as never);
      case "prompt":
        return this.cmdPrompt(msg as never);
      case "cancel":
        return this.cmdCancel(msg as never);
      case "close_session":
        return this.cmdCloseSession(msg as never);
      case "delete_session":
        return this.cmdDeleteSession(msg as never);
      case "permission_response":
        return this.cmdPermissionResponse(msg as never);
      default:
        this.send({ type: "error", message: `Unknown command: ${msg.type}` });
    }
  }

  // ---- commands -----------------------------------------------------------

  private async cmdNewSession(msg: {
    agentId: string;
    cwd: string;
    mcpServers?: unknown[];
    clientSessionId?: string;
  }) {
    const def = findAgent(msg.agentId);
    if (!def) throw new Error(`Unknown agent: ${msg.agentId}`);
    const acp = this.spawnAgent(def.id, def.command, def.args, msg.cwd);

    const init = (await acp.call<InitializeResult>("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
    })) as InitializeResult;

    const newSession = (await acp.call<NewSessionResult>("session/new", {
      cwd: msg.cwd,
      mcpServers: msg.mcpServers ?? [],
    })) as NewSessionResult;

    const session = this.registerSession({
      id: newSession.sessionId,
      agentId: def.id,
      cwd: msg.cwd,
      acp,
      modes: newSession.modes,
      authMethods: init.authMethods,
    });

    await store.save({
      id: session.id,
      agentId: def.id,
      cwd: msg.cwd,
      mcpServers: (msg.mcpServers as unknown[]) ?? [],
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      transcript: [],
    });

    this.send({
      type: "session_created",
      clientSessionId: msg.clientSessionId,
      sessionId: session.id,
      agentId: def.id,
      cwd: msg.cwd,
      modes: newSession.modes,
      authMethods: init.authMethods ?? [],
      agentCapabilities: init.agentCapabilities ?? {},
    });
  }

  private async cmdLoadSession(msg: {
    sessionId: string;
    agentId?: string;
    cwd?: string;
  }) {
    const stored = await store.load(msg.sessionId);
    if (!stored) throw new Error(`Session not found: ${msg.sessionId}`);
    const agentId = msg.agentId ?? stored.agentId;
    const cwd = msg.cwd ?? stored.cwd;
    const def = findAgent(agentId);
    if (!def) throw new Error(`Unknown agent: ${agentId}`);

    const acp = this.spawnAgent(def.id, def.command, def.args, cwd);
    const init = (await acp.call<InitializeResult>("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
    })) as InitializeResult;
    if (init.agentCapabilities?.loadSession !== true) {
      acp.kill();
      throw new Error(`Agent ${agentId} does not support session resume`);
    }
    await acp.call("session/load", {
      sessionId: stored.id,
      cwd,
      mcpServers: stored.mcpServers ?? [],
    });

    const session = this.registerSession({
      id: stored.id,
      agentId,
      cwd,
      acp,
      authMethods: init.authMethods,
    });

    this.send({
      type: "session_loaded",
      sessionId: session.id,
      agentId,
      cwd,
      transcript: stored.transcript,
      agentCapabilities: init.agentCapabilities ?? {},
    });
  }

  private async cmdAuthenticate(msg: {
    sessionId: string;
    methodId: string;
  }) {
    const session = this.requireSession(msg.sessionId);
    const params: AuthenticateParams = { methodId: msg.methodId };
    await session.acp.call("authenticate", params);
    this.send({ type: "authenticated", sessionId: session.id });
  }

  private async cmdPrompt(msg: {
    sessionId: string;
    prompt: ContentBlock[];
  }) {
    const session = this.requireSession(msg.sessionId);
    void store
      .update(session.id, (s) => {
        s.transcript.push({
          kind: "user_prompt",
          at: new Date().toISOString(),
          content: msg.prompt,
        });
        s.lastActiveAt = new Date().toISOString();
        if (!s.title) s.title = derivePromptTitle(msg.prompt);
      })
      .catch((err) => logger.warn("persist prompt failed", err));

    const forwardedPrompt: ContentBlock[] = session.primed
      ? msg.prompt
      : [{ type: "text", text: EMBED_PREAMBLE }, ...msg.prompt];
    session.primed = true;

    try {
      const result = (await session.acp.call<PromptResult>("session/prompt", {
        sessionId: session.id,
        prompt: forwardedPrompt,
      })) as PromptResult;
      this.send({
        type: "prompt_complete",
        sessionId: session.id,
        stopReason: result.stopReason,
      });
      void this.persistPromptComplete(session.id, result.stopReason);
    } catch (err) {
      this.send({
        type: "prompt_error",
        sessionId: session.id,
        message: (err as Error).message,
      });
    }
  }

  private async cmdCancel(msg: { sessionId: string }) {
    const session = this.requireSession(msg.sessionId);
    const params: CancelParams = { sessionId: session.id };
    session.acp.notify("session/cancel", params);
  }

  private async cmdCloseSession(msg: { sessionId: string }) {
    const session = this.sessions.get(msg.sessionId);
    if (!session) return;
    session.terminals.killAll();
    session.acp.kill();
    this.sessions.delete(msg.sessionId);
    this.send({ type: "session_closed", sessionId: msg.sessionId });
  }

  private async cmdDeleteSession(msg: { sessionId: string }) {
    await this.cmdCloseSession(msg);
    await store.remove(msg.sessionId);
    this.send({ type: "session_deleted", sessionId: msg.sessionId });
  }

  private cmdPermissionResponse(msg: {
    sessionId: string;
    requestId: string;
    outcome: "cancelled" | "selected";
    optionId?: string;
  }) {
    const session = this.requireSession(msg.sessionId);
    const waiter = session.pendingPermissions.get(msg.requestId);
    if (!waiter) {
      logger.warn("permission response for unknown request", msg.requestId);
      return;
    }
    session.pendingPermissions.delete(msg.requestId);
    if (msg.outcome === "selected" && msg.optionId) {
      waiter({ outcome: { outcome: "selected", optionId: msg.optionId } });
    } else {
      waiter({ outcome: { outcome: "cancelled" } });
    }
  }

  // ---- session lifecycle --------------------------------------------------

  private spawnAgent(label: string, command: string, args: string[], cwd: string) {
    try {
      return new AcpClient({ label, command, args, cwd });
    } catch (err) {
      throw new Error(
        `Failed to spawn agent '${label}' (${command}): ${(err as Error).message}`,
      );
    }
  }

  private registerSession(s: Omit<ActiveSession, "terminals" | "pendingPermissions">) {
    const session: ActiveSession = {
      ...s,
      terminals: new TerminalManager(),
      pendingPermissions: new Map(),
    };
    this.sessions.set(session.id, session);
    this.wireAcpHandlers(session);
    return session;
  }

  private wireAcpHandlers(session: ActiveSession) {
    const { acp } = session;

    acp.onNotification("session/update", (params) => {
      const n = params as SessionNotification;
      if (!n || n.sessionId !== session.id) return;
      this.send({
        type: "session_update",
        sessionId: session.id,
        update: n.update,
      });
      void this.persistSessionUpdate(session.id, n.update);
    });

    acp.onRequest("session/request_permission", async (params) => {
      const p = params as RequestPermissionParams;
      return this.relayPermission(session, p);
    });

    acp.onRequest("fs/read_text_file", async (params) => {
      return readTextFile(params as ReadTextFileParams) as Promise<ReadTextFileResult>;
    });
    acp.onRequest("fs/write_text_file", async (params) => {
      return writeTextFile(params as WriteTextFileParams);
    });

    acp.onRequest("terminal/create", async (params) => {
      return session.terminals.create(params as TerminalCreateParams);
    });
    acp.onRequest("terminal/output", async (params) => {
      return session.terminals.output(params as TerminalOutputParams);
    });
    acp.onRequest("terminal/wait_for_exit", async (params) => {
      return session.terminals.wait(params as TerminalWaitParams);
    });
    acp.onRequest("terminal/kill", async (params) => {
      return session.terminals.kill(params as TerminalKillParams);
    });
    acp.onRequest("terminal/release", async (params) => {
      return session.terminals.release(params as TerminalReleaseParams);
    });

    acp.on("close", () => {
      this.sessions.delete(session.id);
      this.send({ type: "session_closed", sessionId: session.id });
    });
    acp.on("error", (err: Error) => {
      this.send({
        type: "error",
        sessionId: session.id,
        message: `Agent process error: ${err.message}`,
      });
    });
  }

  private relayPermission(
    session: ActiveSession,
    p: RequestPermissionParams,
  ): Promise<RequestPermissionResult> {
    const requestId = randomUUID();
    return new Promise<RequestPermissionResult>((resolve) => {
      session.pendingPermissions.set(requestId, resolve);
      this.send({
        type: "permission_request",
        sessionId: session.id,
        requestId,
        toolCall: p.toolCall,
        options: p.options as PermissionOption[],
      });
    });
  }

  // ---- persistence --------------------------------------------------------

  private persistSessionUpdate(id: string, update: SessionUpdate) {
    return store.update(id, (s) => {
      s.transcript.push({
        kind: "session_update",
        at: new Date().toISOString(),
        update,
      });
      s.lastActiveAt = new Date().toISOString();
    });
  }

  private persistPromptComplete(id: string, stopReason: string) {
    return store.update(id, (s) => {
      s.transcript.push({
        kind: "prompt_complete",
        at: new Date().toISOString(),
        stopReason,
      });
      s.lastActiveAt = new Date().toISOString();
    });
  }

  private requireSession(id: string): ActiveSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Unknown session: ${id}`);
    return s;
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
