import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import {
  ReadTextFileParams,
  ReadTextFileResult,
  WriteTextFileParams,
} from "../acp/types.js";

function requireAbsolute(path: string) {
  if (!isAbsolute(path)) {
    const err = new Error(`Path must be absolute: ${path}`) as Error & {
      code: number;
    };
    err.code = -32602;
    throw err;
  }
}

export async function readTextFile(
  params: ReadTextFileParams,
): Promise<ReadTextFileResult> {
  requireAbsolute(params.path);
  const data = await readFile(params.path, "utf8");
  if (params.line == null && params.limit == null) return { content: data };
  const lines = data.split("\n");
  const start = Math.max(0, (params.line ?? 1) - 1);
  const end =
    params.limit != null ? Math.min(lines.length, start + params.limit) : lines.length;
  return { content: lines.slice(start, end).join("\n") };
}

export async function writeTextFile(params: WriteTextFileParams): Promise<null> {
  requireAbsolute(params.path);
  await mkdir(dirname(params.path), { recursive: true });
  await writeFile(params.path, params.content, "utf8");
  return null;
}
