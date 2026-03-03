export type ShaderpackSource =
  | { kind: "folder"; path: string }
  | { kind: "zip"; path: string }
  | { kind: "browser-files"; files: File[] };

export const STAGE_NAMES = [
  "shadow",
  "shadow_solid",
  "shadow_cutout",
  "gbuffers_clouds",
  "gbuffers_terrain",
  "deferred",
  "deferred1",
  "deferred2",
  "deferred3",
  "composite",
  "composite1",
  "composite2",
  "composite3",
  "final",
] as const;

export type ShaderStageName = (typeof STAGE_NAMES)[number];

export interface ShaderpackProgram {
  stage: ShaderStageName;
  vertex?: string;
  fragment?: string;
  drawBuffers?: number[];
  renderTargets?: number[];
}

export interface ParsedExpression {
  type: string;
  expr: string;
}

export interface ParsedShaderProperties {
  alphaTests: Map<string, { func: string; ref: number }>;
  blends: Map<string, string[]>;
  flips: Map<string, boolean>;
  options: Map<string, string>;
  screen: string[];
  uniforms: Map<string, ParsedExpression>;
  variables: Map<string, ParsedExpression>;
  clouds?: "off" | "fast" | "fancy";
  warnings: string[];
}

export interface ParsedBlockMap {
  blocks: Map<string, number>;
  warnings: string[];
}

export interface ShaderpackManifest {
  packName: string;
  programs: Map<ShaderStageName, ShaderpackProgram>;
  properties: ParsedShaderProperties;
  blockMap: ParsedBlockMap;
  includes: Map<string, string>;
}

export interface StageDiagnostic {
  stage?: ShaderStageName;
  message: string;
}

export interface ShaderpackDiagnostics {
  errors: StageDiagnostic[];
  warnings: StageDiagnostic[];
}

export interface ActiveShaderpackInfo {
  name: string;
  source: ShaderpackSource;
  loadedAtMs: number;
}

export type PlatformMacro = "windows" | "mac" | "linux";
