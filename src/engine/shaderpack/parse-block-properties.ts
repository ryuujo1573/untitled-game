import type { ParsedBlockMap } from "~/engine/shaderpack/types";

export function parseBlockProperties(
  source: string,
): ParsedBlockMap {
  const blocks = new Map<string, number>();
  const warnings: string[] = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq < 0) continue;

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (!key.startsWith("block.")) continue;

    const m = key.match(/^block\.(\d+)$/);
    if (!m) {
      warnings.push(`Invalid block.properties key: ${key}`);
      continue;
    }

    const id = Number.parseInt(m[1], 10);
    if (!Number.isFinite(id)) {
      warnings.push(`Invalid block id in key: ${key}`);
      continue;
    }

    for (const token of value
      .split(/\s+/)
      .filter(Boolean)) {
      blocks.set(token, id);
    }
  }

  return { blocks, warnings };
}
