import { unzipSync, strFromU8 } from "fflate";

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".tga",
  ".bmp",
  ".gif",
  ".webp",
  ".hdr",
]);

function isBinaryPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return BINARY_EXTENSIONS.has(
    path.slice(dot).toLowerCase(),
  );
}

export interface ZipExtractResult {
  files: Map<string, string>;
  binaryFiles: Map<string, Uint8Array>;
  warnings: string[];
}

/**
 * Extract a ZIP archive into virtual file maps.
 *
 * Text files (shaders, properties, etc.) go into `files`.
 * Binary files (PNG, JPG, TGA textures) go into `binaryFiles`.
 *
 * Keys are relative paths (e.g. "shaders/composite.fsh").
 * If the zip contains a single top-level directory that wraps everything,
 * that prefix is stripped so paths start at the shaderpack root.
 */
export async function extractZipToVirtualFiles(
  bytes: Uint8Array,
): Promise<ZipExtractResult> {
  const warnings: string[] = [];
  const raw = unzipSync(bytes);
  const files = new Map<string, string>();
  const binaryFiles = new Map<string, Uint8Array>();

  for (const [path, data] of Object.entries(raw)) {
    if (path.endsWith("/") || data.length === 0) continue;

    if (isBinaryPath(path)) {
      binaryFiles.set(path, data);
      continue;
    }

    try {
      files.set(path, strFromU8(data));
    } catch {
      warnings.push(`Skipped non-text file: ${path}`);
    }
  }

  // If every path shares a common top-level directory prefix, strip it.
  // This handles zips like "SEUS-PTGI-E12/shaders/..." → "shaders/..."
  const allKeys = [...files.keys(), ...binaryFiles.keys()];
  if (allKeys.length > 0) {
    const firstSegment = allKeys[0].split("/")[0];
    const allSharePrefix = allKeys.every((k) =>
      k.startsWith(firstSegment + "/"),
    );
    if (allSharePrefix) {
      const prefix = firstSegment + "/";
      const strippedFiles = new Map<string, string>();
      for (const [k, v] of files) {
        strippedFiles.set(k.slice(prefix.length), v);
      }
      const strippedBinary = new Map<string, Uint8Array>();
      for (const [k, v] of binaryFiles) {
        strippedBinary.set(k.slice(prefix.length), v);
      }
      return {
        files: strippedFiles,
        binaryFiles: strippedBinary,
        warnings,
      };
    }
  }

  return { files, binaryFiles, warnings };
}
