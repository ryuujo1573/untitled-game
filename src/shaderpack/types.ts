export type ShaderpackSource =
  | { kind: "folder"; path: string }
  | { kind: "zip"; path: string }
  | { kind: "browser-files"; files: File[]; name?: string }
  | { kind: "vfs"; name: string };

export const STAGE_NAMES = [
  // Shadow
  "shadow",
  "shadow_solid",
  "shadow_cutout",
  // GBuffers (14 programs)
  "gbuffers_basic",
  "gbuffers_textured",
  "gbuffers_textured_lit",
  "gbuffers_terrain",
  "gbuffers_water",
  "gbuffers_weather",
  "gbuffers_entities",
  "gbuffers_hand",
  "gbuffers_hand_water",
  "gbuffers_armor_glint",
  "gbuffers_damagedblock",
  "gbuffers_skybasic",
  "gbuffers_skytextured",
  "gbuffers_clouds",
  // Deferred (11 passes)
  "deferred",
  "deferred1",
  "deferred2",
  "deferred3",
  "deferred4",
  "deferred5",
  "deferred6",
  "deferred7",
  "deferred8",
  "deferred9",
  "deferred10",
  // Composite (9 passes)
  "composite",
  "composite1",
  "composite2",
  "composite3",
  "composite4",
  "composite5",
  "composite6",
  "composite7",
  "composite8",
  // Final
  "final",
] as const;

export type ShaderStageName = (typeof STAGE_NAMES)[number];

export interface ShaderpackProgram {
  stage: ShaderStageName;
  vertex?: string;
  fragment?: string;
  geometry?: string;
  compute?: string;
  drawBuffers?: number[];
  renderTargets?: number[];
}

export interface ParsedExpression {
  type: string;
  expr: string;
}

export interface ShadowConfig {
  enabled: boolean;
  mapResolution: number;
  distance: number;
  distanceRenderMul: number;
  intervalSize: number;
  terrain: boolean;
  translucent: boolean;
  entities: boolean;
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
  shadow: ShadowConfig;
  sunPathRotation: number;
  sun: boolean;
  moon: boolean;
  oldLighting: boolean;
  underwaterOverlay: boolean;
  vignette: boolean;
  wetnessHalflife: number;
  drynessHalflife: number;
  customTextures: Map<string, string>;
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
  binaryFiles: Map<string, Uint8Array>;
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
