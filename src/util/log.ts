type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const envLevel = (process.env.AGENT_WELL_LOG ?? "info").toLowerCase() as Level;
const threshold = LEVELS[envLevel] ?? LEVELS.info;

function emit(level: Level, args: unknown[]) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const fn = level === "error" ? console.error
    : level === "warn" ? console.warn
    : console.log;
  fn(`[${ts}] [${level}]`, ...args);
}

export const logger = {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};
