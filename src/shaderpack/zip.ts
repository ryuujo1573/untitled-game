import { unzipSync, strFromU8 } from "fflate";

export interface ZipExtractResult {
  files: Map<string, string>;
  warnings: string[];
}

/**
 * Extract a ZIP archive into a virtual file map.
 *
 * Keys are relative paths (e.g. "shaders/composite.fsh").
 * If the zip contains a single top-level directory that wraps everything,
 * that prefix is stripped so paths start at the shaderpack root.
 */
export async function extractZipToVirtualFiles(bytes: Uint8Array): Promise<ZipExtractResult> {
  const warnings: string[] = [];
  const raw = unzipSync(bytes);
  const files = new Map<string, string>();

  for (const [path, data] of Object.entries(raw)) {
    // Skip directories (entries ending with /) and empty entries.
    if (path.endsWith("/") || data.length === 0) continue;

    try {
      files.set(path, strFromU8(data));
    } catch {
      warnings.push(`Skipped non-text file: ${path}`);
    }
  }

  // If every path shares a common top-level directory prefix, strip it.
  // This handles zips like "SEUS-PTGI-E12/shaders/..." → "shaders/..."
  const keys = [...files.keys()];
  if (keys.length > 0) {
    const firstSegment = keys[0].split("/")[0];
    const allSharePrefix = keys.every((k) => k.startsWith(firstSegment + "/"));
    if (allSharePrefix) {
      const prefix = firstSegment + "/";
      const stripped = new Map<string, string>();
      for (const [k, v] of files) {
        stripped.set(k.slice(prefix.length), v);
      }
      return { files: stripped, warnings };
    }
  }

  return { files, warnings };
}
