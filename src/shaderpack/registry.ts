import type { ShaderStageName } from "~/shaderpack/types";

export type StageMode = "builtin" | "override";

export interface ShaderStageStatus {
  stage: ShaderStageName;
  mode: StageMode;
  reason?: string;
}

export class ShaderProgramRegistry {
  private readonly statuses = new Map<ShaderStageName, ShaderStageStatus>();

  setBuiltin(stage: ShaderStageName, reason?: string): void {
    this.statuses.set(stage, { stage, mode: "builtin", reason });
  }

  setOverride(stage: ShaderStageName): void {
    this.statuses.set(stage, { stage, mode: "override" });
  }

  sync(statuses: ShaderStageStatus[]): void {
    this.statuses.clear();
    for (const s of statuses) this.statuses.set(s.stage, s);
  }

  getStatuses(): ShaderStageStatus[] {
    return [...this.statuses.values()];
  }
}
