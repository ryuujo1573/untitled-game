import { readDir, readTextFile, readFile } from "@tauri-apps/plugin-fs";

function normalize(path: string): string {
  return path.replace(/\\/g, "/");
}

async function walkDirRecursive(root: string): Promise<string[]> {
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

export async function buildVirtualFilesFromFolder(folderPath: string): Promise<Map<string, string>> {
  const normalizedRoot = normalize(folderPath).replace(/\/+$/, "");
  const allFiles = await walkDirRecursive(normalizedRoot);
  const out = new Map<string, string>();

  for (const abs of allFiles) {
    const rel = normalize(abs).slice(normalizedRoot.length).replace(/^\/+/, "");
    if (!(rel.endsWith(".vsh") || rel.endsWith(".fsh") || rel.endsWith(".glsl") || rel.endsWith(".properties"))) {
      continue;
    }
    const text = await readTextFile(abs);
    out.set(rel, text);
  }

  return out;
}

export async function readZipFileBytes(path: string): Promise<Uint8Array> {
  const bytes = await readFile(path);
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
}
