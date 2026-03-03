export interface WgslCompileIssue {
  type: "error" | "warning" | "info";
  message: string;
  lineNum: number;
  linePos: number;
}

export async function compileWgslModule(
  device: GPUDevice,
  label: string,
  wgsl: string,
): Promise<{ module: GPUShaderModule; issues: WgslCompileIssue[] }> {
  const module = device.createShaderModule({ label, code: wgsl });
  const info = await module.getCompilationInfo();
  const issues = info.messages.map((m) => ({
    type: m.type,
    message: m.message,
    lineNum: m.lineNum,
    linePos: m.linePos,
  }));
  return { module, issues };
}
