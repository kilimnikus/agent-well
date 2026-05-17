import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  unlink,
  rename,
} from "node:fs/promises";
import { ContentBlock, SessionUpdate } from "../acp/types.js";
import { logger } from "../util/log.js";

const ROOT = join(homedir(), ".agent-well");
const SESSIONS_DIR = join(ROOT, "sessions");

export interface StoredSession {
  id: string;
  agentId: string;
  cwd: string;
  mcpServers: unknown[];
  createdAt: string;
  lastActiveAt: string;
  title?: string;
  /** Linear record of everything the bridge has observed for replay/resume UI. */
  transcript: TranscriptEntry[];
}

export type TranscriptEntry =
  | { kind: "user_prompt"; at: string; content: ContentBlock[] }
  | { kind: "session_update"; at: string; update: SessionUpdate }
  | { kind: "prompt_complete"; at: string; stopReason: string };

async function ensureDir() {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

function filePath(id: string) {
  return join(SESSIONS_DIR, `${encodeURIComponent(id)}.json`);
}

/**
 * Per-id mutex. Every mutation goes through `update(id, mutator)` which
 * serializes load -> mutate -> save against itself, preventing both rename
 * races and lost updates from interleaved load+save sequences.
 */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep chain alive but clear when this run is the tail.
  locks.set(id, next);
  void next.finally(() => {
    if (locks.get(id) === next) locks.delete(id);
  });
  return next;
}

async function writeAtomic(session: StoredSession): Promise<void> {
  await ensureDir();
  const final = filePath(session.id);
  // Unique tmp name so a stale or concurrent run can't steal ours.
  const tmp = `${final}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(session, null, 2), "utf8");
  try {
    await rename(tmp, final);
  } catch (err) {
    void unlink(tmp).catch(() => {});
    throw err;
  }
}

export function save(session: StoredSession): Promise<void> {
  return withLock(session.id, () => writeAtomic(session));
}

export async function load(id: string): Promise<StoredSession | null> {
  try {
    const raw = await readFile(filePath(id), "utf8");
    return JSON.parse(raw) as StoredSession;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    logger.error("session load failed", err);
    return null;
  }
}

/**
 * Load, mutate, save — serialized per session id. Use this for any
 * read-modify-write so concurrent notifications can't clobber each other.
 * Returns the saved session, or null if the file is missing.
 */
export function update(
  id: string,
  mutator: (s: StoredSession) => void | Promise<void>,
): Promise<StoredSession | null> {
  return withLock(id, async () => {
    const s = await load(id);
    if (!s) return null;
    await mutator(s);
    await writeAtomic(s);
    return s;
  });
}

export async function list(): Promise<StoredSession[]> {
  await ensureDir();
  const entries = await readdir(SESSIONS_DIR);
  const out: StoredSession[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(SESSIONS_DIR, name), "utf8");
      out.push(JSON.parse(raw) as StoredSession);
    } catch (err) {
      logger.warn("skipped corrupt session", name, err);
    }
  }
  out.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  return out;
}

export function remove(id: string): Promise<void> {
  return withLock(id, async () => {
    try {
      await unlink(filePath(id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  });
}
