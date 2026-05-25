import { randomUUID } from "node:crypto";
import { BrowserBridge } from "./bridge.js";
import { SessionRegistry } from "./sessions/registry.js";
import { logger } from "./util/log.js";

interface QueuedEvent {
  seq: number;
  msg: Record<string, unknown>;
}

/**
 * Bounded FIFO of events with a sequence number. Late pollers (e.g. after a
 * brief network blip) can resume by passing the last seq they saw, and we'll
 * replay everything still in the buffer. Older events are dropped when the
 * buffer exceeds CAP.
 */
class EventQueue {
  private events: QueuedEvent[] = [];
  private nextSeq = 0;
  private waiters: Array<(_: void) => void> = [];
  private static CAP = 2000;

  enqueue(msg: Record<string, unknown>): void {
    this.nextSeq += 1;
    this.events.push({ seq: this.nextSeq, msg });
    if (this.events.length > EventQueue.CAP) {
      this.events.splice(0, this.events.length - EventQueue.CAP);
    }
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  /**
   * Return events with seq > `since`. If none, wait up to `timeoutMs` for one
   * to arrive (long-poll). Always returns the current `next` cursor.
   */
  async drainSince(
    since: number,
    timeoutMs: number,
  ): Promise<{ events: Record<string, unknown>[]; next: number }> {
    const newer = () => this.events.filter((e) => e.seq > since);
    let batch = newer();
    if (batch.length === 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      batch = newer();
    }
    return {
      events: batch.map((e) => e.msg),
      next: batch.length > 0 ? batch[batch.length - 1].seq : Math.max(since, this.nextSeq),
    };
  }
}

interface Connection {
  id: string;
  bridge: BrowserBridge;
  queue: EventQueue;
  /** Wall-clock of the last poll OR command. */
  lastActivity: number;
  /** Active long-poll abort handle, if any. */
  cancelPoll?: () => void;
}

const IDLE_MS = 5 * 60 * 1000; // 5 minutes
const SWEEP_MS = 30 * 1000;

/**
 * Tracks open browser connections. Idle connections are reaped after IDLE_MS,
 * but reaping only releases the HTTP transport — agent sessions live in a
 * separate registry that survives transport loss, so a phone screen lock
 * doesn't kill in-flight work.
 */
export class TransportRegistry {
  private conns = new Map<string, Connection>();

  constructor(private sessions: SessionRegistry) {
    setInterval(() => this.sweepIdle(), SWEEP_MS).unref();
  }

  connect(): Connection {
    const id = randomUUID();
    const queue = new EventQueue();
    const bridge = new BrowserBridge(
      (msg) => queue.enqueue(msg),
      this.sessions,
    );
    const conn: Connection = { id, bridge, queue, lastActivity: Date.now() };
    this.conns.set(id, conn);
    logger.info(`transport: connected ${id} (${this.conns.size} active)`);
    return conn;
  }

  get(id: string): Connection | undefined {
    const c = this.conns.get(id);
    if (c) c.lastActivity = Date.now();
    return c;
  }

  disconnect(id: string): void {
    const c = this.conns.get(id);
    if (!c) return;
    c.cancelPoll?.();
    c.bridge.dispose();
    this.conns.delete(id);
    logger.info(`transport: disconnected ${id} (${this.conns.size} active)`);
  }

  private sweepIdle(): void {
    const cutoff = Date.now() - IDLE_MS;
    for (const [id, c] of this.conns) {
      if (c.lastActivity < cutoff) {
        logger.info(`transport: idle timeout for ${id}`);
        this.disconnect(id);
      }
    }
  }
}
