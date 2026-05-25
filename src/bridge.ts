import { homedir } from "node:os";
import { ContentBlock } from "./acp/types.js";
import { BUILTIN_AGENTS } from "./agents/registry.js";
import { SessionHost, Sink } from "./sessions/host.js";
import { SessionRegistry } from "./sessions/registry.js";
import * as store from "./sessions/store.js";
import { logger } from "./util/log.js";

/**
 * Preamble we attach to the first prompt of every ACP session so the agent
 * knows the client renders a small allowlist of HTML media tags and is
 * encouraged to emit them inline — for final results and intermediate updates.
 */
export const EMBED_PREAMBLE: string = [
  "[agent-well client capabilities]",
  "Your output is rendered in a chat UI with these inline rendering features:",
  "",
  "1. Media tags (allowlisted HTML; all other HTML is escaped to text):",
  '     <audio controls src="…"></audio>',
  '     <video controls src="…"></video>',
  '     <img src="…" alt="…" />',
  "   Allowed src values: absolute https:// URLs, or paths starting with /.",
  "",
  "2. Expandable sections (collapsed by default; add `open` to start expanded):",
  "     <details>",
  "       <summary>Short label of what's inside</summary>",
  "",
  "       Full markdown content here — code blocks, lists, paragraphs.",
  "     </details>",
  "   Use this to embed change summaries, diffs, long output, or any",
  "   verbose detail INLINE in your message — so the user can read your prose",
  "   without scrolling past blocks of code, then expand individual sections",
  "   on demand. ALWAYS prefer wrapping a code block in <details> over a bare",
  "   fenced block when the code is incidental support (a diff of an edit you",
  "   made, the full body of a file you wrote, tool output you're explaining).",
  "",
  "3. LaTeX math, rendered with KaTeX:",
  "     inline:  $E = mc^2$   or   \\(E = mc^2\\)",
  "     display: $$\\int_0^\\infty e^{-x^2}\\,dx = \\tfrac{\\sqrt{\\pi}}{2}$$",
  "              \\[ … \\]",
  "   Use LaTeX for any formula, equation, or math symbol. Do NOT use",
  "   rendered-image services or screenshots for math.",
  "",
  "4. Standard markdown: paragraphs, lists, headings, **bold**, *italic*,",
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
 * Per-tab bridge: routes browser commands to the process-level SessionRegistry
 * and forwards host events back over the bridge's sink. Holds no agent state
 * of its own — `dispose()` only detaches from hosts; the hosts (and their
 * ACP subprocesses) survive an idle-swept transport connection.
 */
export class BrowserBridge {
  private attached = new Map<string, SessionHost>();
  private disposed = false;
  private sink: Sink;

  constructor(
    sink: Sink,
    private registry: SessionRegistry,
  ) {
    this.sink = (msg) => {
      if (this.disposed) return;
      sink(msg);
    };
    void this.sendInitial();
  }

  private send(msg: Record<string, unknown>) {
    this.sink(msg);
  }

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

  /**
   * Tear down the bridge. Detaches from any attached hosts but does NOT close
   * them — agents keep running and a future bridge can re-attach.
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const host of this.attached.values()) {
      host.detach(this.sink);
    }
    this.attached.clear();
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

  private attachHost(host: SessionHost): void {
    host.attach(this.sink);
    this.attached.set(host.id, host);
  }

  private async cmdNewSession(msg: {
    agentId: string;
    cwd: string;
    mcpServers?: unknown[];
    clientSessionId?: string;
  }) {
    const host = await this.registry.createNew({
      agentId: msg.agentId,
      cwd: msg.cwd,
      mcpServers: msg.mcpServers,
    });
    this.attachHost(host);
    this.send({
      type: "session_created",
      clientSessionId: msg.clientSessionId,
      sessionId: host.id,
      agentId: host.agentId,
      cwd: host.cwd,
      modes: host.modes,
      authMethods: host.authMethods ?? [],
      agentCapabilities: host.agentCapabilities ?? {},
    });
  }

  private async cmdLoadSession(msg: {
    sessionId: string;
    agentId?: string;
    cwd?: string;
  }) {
    const existing = this.registry.get(msg.sessionId);
    // Only one bridge may write to a session at a time. If another tab is
    // attached, show this tab the persisted transcript read-only.
    if (existing && existing.isAttached() && !this.attached.has(existing.id)) {
      const stored = await store.load(msg.sessionId);
      this.send({
        type: "session_busy",
        sessionId: existing.id,
        agentId: existing.agentId,
        cwd: existing.cwd,
        transcript: stored?.transcript ?? [],
      });
      return;
    }

    const stored = await store.load(msg.sessionId);
    if (!stored) {
      this.send({
        type: "error",
        context: "load_session",
        sessionId: msg.sessionId,
        message: `Session not found: ${msg.sessionId}`,
      });
      return;
    }

    const host = await this.registry.resume({
      sessionId: msg.sessionId,
      agentId: msg.agentId,
      cwd: msg.cwd,
    });
    // If we're already attached (e.g. duplicate load_session), don't re-attach.
    if (!this.attached.has(host.id)) this.attachHost(host);

    this.send({
      type: "session_loaded",
      sessionId: host.id,
      agentId: host.agentId,
      cwd: host.cwd,
      transcript: stored.transcript,
      busy: host.busy,
      agentCapabilities: host.agentCapabilities ?? {},
    });
  }

  private async cmdAuthenticate(msg: {
    sessionId: string;
    methodId: string;
  }) {
    const host = this.requireAttached(msg.sessionId);
    await host.authenticate(msg.methodId);
  }

  private async cmdPrompt(msg: {
    sessionId: string;
    prompt: ContentBlock[];
  }) {
    const host = this.requireAttached(msg.sessionId);
    await host.prompt(msg.prompt);
  }

  private async cmdCancel(msg: { sessionId: string }) {
    const host = this.requireAttached(msg.sessionId);
    host.cancel();
  }

  private async cmdCloseSession(msg: { sessionId: string }) {
    const host = this.attached.get(msg.sessionId);
    this.attached.delete(msg.sessionId);
    if (host) {
      host.detach(this.sink);
      host.close();
    }
  }

  private async cmdDeleteSession(msg: { sessionId: string }) {
    const host = this.registry.get(msg.sessionId);
    this.attached.delete(msg.sessionId);
    if (host) {
      host.detach(this.sink);
      host.close();
    }
    await store.remove(msg.sessionId);
    this.send({ type: "session_deleted", sessionId: msg.sessionId });
  }

  private cmdPermissionResponse(msg: {
    sessionId: string;
    requestId: string;
    outcome: "cancelled" | "selected";
    optionId?: string;
  }) {
    const host = this.requireAttached(msg.sessionId);
    host.permissionResponse(msg.requestId, msg.outcome, msg.optionId);
  }

  private requireAttached(id: string): SessionHost {
    const host = this.attached.get(id);
    if (!host) throw new Error(`Session not attached: ${id}`);
    return host;
  }
}
