function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

export async function buildVirtualFilesFromBrowserFiles(files: File[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const file of files) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    const key = normalize(relative && relative.length > 0 ? relative : file.name);
    const text = await file.text();
    out.set(key, text);
  }
  return out;
}
