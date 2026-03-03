export interface VFSEntry {
  name: string;
  isDir: boolean;
}

export interface VFS {
  /** List entries in a directory. */
  readDir(path: string): Promise<VFSEntry[]>;

  /** Read a file as UTF-8 text. */
  readTextFile(path: string): Promise<string>;

  /** Read a file as raw bytes. */
  readFile(path: string): Promise<Uint8Array>;

  /** Write UTF-8 text to a file, creating parent directories as needed. */
  writeTextFile(
    path: string,
    content: string,
  ): Promise<void>;

  /** Write raw bytes to a file, creating parent directories as needed. */
  writeFile(path: string, data: Uint8Array): Promise<void>;

  /** Create a directory (and parents). No-op if it already exists. */
  mkdir(path: string): Promise<void>;

  /** Check whether a file or directory exists at the given path. */
  exists(path: string): Promise<boolean>;

  /** Remove a file or directory. */
  remove(
    path: string,
    opts?: { recursive?: boolean },
  ): Promise<void>;
}
