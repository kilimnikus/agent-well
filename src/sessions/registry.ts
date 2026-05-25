import { AcpClient } from "../acp/client.js";
import { ACP_PROTOCOL_VERSION, CLIENT_CAPABILITIES } from "../acp/constants.js";
import { InitializeResult, NewSessionResult } from "../acp/types.js";
import { findAgent } from "../agents/registry.js";
import { logger } from "../util/log.js";
import { SessionHost } from "./host.js";
import * as store from "./store.js";

/**
 * Process-level registry of live agent sessions. Lifetime is the server's,
 * not any single browser tab's — a session keeps running across browser
 * reconnects, page reloads, and idle-swept transport connections, until it's
 * explicitly closed/deleted or the agent process exits.
 */
export class SessionRegistry {
  private hosts = new Map<string, SessionHost>();
  private preamble: string;

  constructor(preamble: string) {
    this.preamble = preamble;
  }

  get(id: string): SessionHost | undefined {
    return this.hosts.get(id);
  }

  async createNew(opts: {
    agentId: string;
    cwd: string;
    mcpServers?: unknown[];
  }): Promise<SessionHost> {
    const def = findAgent(opts.agentId);
    if (!def) throw new Error(`Unknown agent: ${opts.agentId}`);

    const acp = new AcpClient({
      label: def.id,
      command: def.command,
      args: def.args,
      cwd: opts.cwd,
    });

    let init: InitializeResult;
    let newSession: NewSessionResult;
    try {
      init = (await acp.call<InitializeResult>("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: CLIENT_CAPABILITIES,
      })) as InitializeResult;
      newSession = (await acp.call<NewSessionResult>("session/new", {
        cwd: opts.cwd,
        mcpServers: opts.mcpServers ?? [],
      })) as NewSessionResult;
    } catch (err) {
      acp.kill();
      throw err;
    }

    const host = new SessionHost({
      id: newSession.sessionId,
      agentId: def.id,
      cwd: opts.cwd,
      acp,
      authMethods: init.authMethods,
      agentCapabilities: init.agentCapabilities,
      modes: newSession.modes,
      preamble: this.preamble,
      onDispose: () => this.hosts.delete(newSession.sessionId),
    });
    this.hosts.set(newSession.sessionId, host);

    await store.save({
      id: host.id,
      agentId: def.id,
      cwd: opts.cwd,
      mcpServers: opts.mcpServers ?? [],
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      transcript: [],
    });

    return host;
  }

  /**
   * Return the live host for `sessionId` if one exists, otherwise spawn a
   * fresh ACP and call `session/load` to resume from the persisted transcript.
   * Caller is responsible for the "already attached elsewhere" check; this
   * registry only owns the agent process, not the attachment policy.
   */
  async resume(opts: {
    sessionId: string;
    agentId?: string;
    cwd?: string;
  }): Promise<SessionHost> {
    const existing = this.hosts.get(opts.sessionId);
    if (existing) return existing;

    const stored = await store.load(opts.sessionId);
    if (!stored) throw new Error(`Session not found: ${opts.sessionId}`);

    const agentId = opts.agentId ?? stored.agentId;
    const cwd = opts.cwd ?? stored.cwd;
    const def = findAgent(agentId);
    if (!def) throw new Error(`Unknown agent: ${agentId}`);

    const acp = new AcpClient({
      label: def.id,
      command: def.command,
      args: def.args,
      cwd,
    });

    let init: InitializeResult;
    try {
      init = (await acp.call<InitializeResult>("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: CLIENT_CAPABILITIES,
      })) as InitializeResult;
      if (init.agentCapabilities?.loadSession !== true) {
        throw new Error(`Agent ${agentId} does not support session resume`);
      }
      await acp.call("session/load", {
        sessionId: stored.id,
        cwd,
        mcpServers: stored.mcpServers ?? [],
      });
    } catch (err) {
      acp.kill();
      throw err;
    }

    const host = new SessionHost({
      id: stored.id,
      agentId,
      cwd,
      acp,
      authMethods: init.authMethods,
      agentCapabilities: init.agentCapabilities,
      preamble: this.preamble,
      onDispose: () => this.hosts.delete(stored.id),
    });
    this.hosts.set(stored.id, host);
    return host;
  }

  closeAll(): void {
    for (const host of this.hosts.values()) {
      try {
        host.close();
      } catch (err) {
        logger.warn("host close failed", err);
      }
    }
  }
}
