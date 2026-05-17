import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  TerminalCreateParams,
  TerminalCreateResult,
  TerminalKillParams,
  TerminalOutputParams,
  TerminalOutputResult,
  TerminalReleaseParams,
  TerminalWaitParams,
  TerminalWaitResult,
} from "../acp/types.js";
import { logger } from "../util/log.js";

interface Term {
  id: string;
  proc: ChildProcessWithoutNullStreams;
  output: string;
  truncated: boolean;
  byteLimit: number;
  exit?: { exitCode: number | null; signal: string | null };
  waiters: Array<(r: TerminalWaitResult) => void>;
}

const DEFAULT_LIMIT = 256 * 1024;

export class TerminalManager {
  private terms = new Map<string, Term>();

  create(params: TerminalCreateParams): TerminalCreateResult {
    const id = randomUUID();
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const e of params.env ?? []) env[e.name] = e.value;
    const proc = spawn(params.command, params.args ?? [], {
      cwd: params.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const term: Term = {
      id,
      proc,
      output: "",
      truncated: false,
      byteLimit: params.outputByteLimit ?? DEFAULT_LIMIT,
      waiters: [],
    };
    const append = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      if (Buffer.byteLength(term.output) + chunk.length > term.byteLimit) {
        term.truncated = true;
        const remaining = term.byteLimit - Buffer.byteLength(term.output);
        if (remaining > 0) term.output += s.slice(0, remaining);
      } else {
        term.output += s;
      }
    };
    proc.stdout.on("data", append);
    proc.stderr.on("data", append);
    proc.on("exit", (code, signal) => {
      term.exit = { exitCode: code, signal: signal ?? null };
      for (const w of term.waiters) w({ exitCode: code, signal: signal ?? null });
      term.waiters.length = 0;
    });
    proc.on("error", (err) => {
      logger.warn("terminal proc error", err);
      term.exit = { exitCode: null, signal: null };
      for (const w of term.waiters) w({ exitCode: null, signal: null });
      term.waiters.length = 0;
    });
    this.terms.set(id, term);
    return { terminalId: id };
  }

  output(params: TerminalOutputParams): TerminalOutputResult {
    const term = this.require(params.terminalId);
    return {
      output: term.output,
      truncated: term.truncated,
      exitStatus: term.exit,
    };
  }

  wait(params: TerminalWaitParams): Promise<TerminalWaitResult> {
    const term = this.require(params.terminalId);
    if (term.exit) return Promise.resolve(term.exit);
    return new Promise((resolve) => term.waiters.push(resolve));
  }

  kill(params: TerminalKillParams): null {
    const term = this.require(params.terminalId);
    if (!term.exit) term.proc.kill("SIGTERM");
    return null;
  }

  release(params: TerminalReleaseParams): null {
    const term = this.terms.get(params.terminalId);
    if (term) {
      if (!term.exit) term.proc.kill("SIGTERM");
      this.terms.delete(params.terminalId);
    }
    return null;
  }

  killAll() {
    for (const t of this.terms.values()) {
      if (!t.exit) t.proc.kill("SIGTERM");
    }
    this.terms.clear();
  }

  private require(id: string): Term {
    const t = this.terms.get(id);
    if (!t) {
      const err = new Error(`Unknown terminal: ${id}`) as Error & { code: number };
      err.code = -32602;
      throw err;
    }
    return t;
  }
}
