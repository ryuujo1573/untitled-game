import {
  readDir,
  readFile,
  readTextFile,
} from "@tauri-apps/plugin-fs";

const TEXT_EXTENSIONS = new Set([
  ".vsh",
  ".fsh",
  ".gsh",
  ".csh",
  ".glsl",
  ".inc",
  ".properties",
]);
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

function normalize(path: string): string {
  return path.replace(/\\/g, "/");
}

function getExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot).toLowerCase() : "";
}

async function walkDirRecursive(
  root: string,
): Promise<string[]> {
  const stack: string[] = [root];
  const files: string[] = [];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = (await readDir(dir)) as Array<{
      name?: string;
      isDirectory?: boolean;
      isFile?: boolean;
    }>;

    for (const e of entries) {
      if (!e.name) continue;
      const full = `${dir}/${e.name}`;
      if (e.isDirectory) stack.push(full);
      else if (e.isFile ?? !e.isDirectory) files.push(full);
    }
  }

  return files;
}

export interface FolderLoadResult {
  textFiles: Map<string, string>;
  binaryFiles: Map<string, Uint8Array>;
}

export async function buildVirtualFilesFromFolder(
  folderPath: string,
): Promise<FolderLoadResult> {
  const normalizedRoot = normalize(folderPath).replace(
    /\/+$/,
    "",
  );
  const allFiles = await walkDirRecursive(normalizedRoot);
  const textFiles = new Map<string, string>();
  const binaryFiles = new Map<string, Uint8Array>();

  for (const abs of allFiles) {
    const rel = normalize(abs)
      .slice(normalizedRoot.length)
      .replace(/^\/+/, "");
    const ext = getExtension(rel);

    if (TEXT_EXTENSIONS.has(ext)) {
      const text = await readTextFile(abs);
      textFiles.set(rel, text);
    } else if (BINARY_EXTENSIONS.has(ext)) {
      const bytes = await readFile(abs);
      binaryFiles.set(
        rel,
        bytes instanceof Uint8Array
          ? bytes
          : new Uint8Array(bytes as ArrayBuffer),
      );
    }
  }

  return { textFiles, binaryFiles };
}

export async function readZipFileBytes(
  path: string,
): Promise<Uint8Array> {
  const bytes = await readFile(path);
  return bytes instanceof Uint8Array
    ? bytes
    : new Uint8Array(bytes as ArrayBuffer);
}
