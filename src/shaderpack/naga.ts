export interface NagaTranspileResult {
  ok: boolean;
  wgsl?: string;
  error?: string;
}

let initialised = false;

export async function initNaga(): Promise<void> {
  initialised = true;
}

export async function transpileGLSLToWGSL(_glsl: string, _stage: "vertex" | "fragment"): Promise<NagaTranspileResult> {
  if (!initialised) {
    await initNaga();
  }

  return {
    ok: false,
    error: "Naga WASM bridge is not wired in this build yet.",
  };
}
