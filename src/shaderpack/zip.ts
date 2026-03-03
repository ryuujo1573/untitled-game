export interface ZipExtractResult {
  files: Map<string, string>;
  warnings: string[];
}

/**
 * Placeholder ZIP extraction entrypoint.
 *
 * The runtime keeps this as a dedicated module so a real ZIP backend
 * (fflate/wasm/rust IPC) can be dropped in without changing callers.
 */
export async function extractZipToVirtualFiles(_bytes: Uint8Array): Promise<ZipExtractResult> {
  return {
    files: new Map(),
    warnings: [
      "ZIP shaderpack extraction is not available in this build yet; use folder loading for now.",
    ],
  };
}
