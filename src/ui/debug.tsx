import {
  IconBrandChrome,
  IconBrandFirefox,
  IconBrandSafari,
} from "@tabler/icons-solidjs";
import type { Component } from "solid-js";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import type { Camera } from "~/engine/rendering/camera";
import { raycast } from "~/engine/physics/raycaster";
import { getShaderpackStateSnapshot } from "~/engine/shaderpack/runtime";
import Time from "~/environment/time/time-manager";
import { BlockType } from "~/environment/world/block";
import type { World } from "~/environment/world/world";

// ── Light debug helpers ─────────────────────────────────────────

/** Project a world-space point to canvas pixel coords.
 *  Returns null if the point is behind the camera or outside the frustum.
 *  viewMat / projMat are column-major Float32Array (gl-matrix convention). */
function worldToScreen(
  wx: number,
  wy: number,
  wz: number,
  view: Float32Array,
  proj: Float32Array,
  sw: number,
  sh: number,
): [number, number] | null {
  // view * [wx, wy, wz, 1]  (column-major: result.x = col0·v + col4·v + ...)
  const vx =
    view[0] * wx + view[4] * wy + view[8] * wz + view[12];
  const vy =
    view[1] * wx + view[5] * wy + view[9] * wz + view[13];
  const vz =
    view[2] * wx + view[6] * wy + view[10] * wz + view[14];
  const vw =
    view[3] * wx + view[7] * wy + view[11] * wz + view[15];

  if (vz >= -0.1) return null; // behind or on near plane

  // proj * [vx, vy, vz, vw]
  const cx =
    proj[0] * vx +
    proj[4] * vy +
    proj[8] * vz +
    proj[12] * vw;
  const cy =
    proj[1] * vx +
    proj[5] * vy +
    proj[9] * vz +
    proj[13] * vw;
  const cw =
    proj[3] * vx +
    proj[7] * vy +
    proj[11] * vz +
    proj[15] * vw;

  const ndcX = cx / cw;
  const ndcY = cy / cw;

  // Clip a generous margin (labels near edge can still be useful)
  if (
    ndcX < -1.1 ||
    ndcX > 1.1 ||
    ndcY < -1.1 ||
    ndcY > 1.1
  )
    return null;

  return [(ndcX + 1) * 0.5 * sw, (1 - ndcY) * 0.5 * sh];
}

/** Blue-tinted colour scale for sky light (0=dark, 15=bright cyan-white). */
function skyLightColor(level: number): string {
  if (level === 0) return "#444";
  const t = level / 15;
  // hsl: hue 210 (sky blue), 100% saturation, lightness 18%→95%
  const l = Math.round(18 + t * 77);
  return `hsl(210,100%,${l}%)`;
}

/** Amber-tinted colour scale for block light (0=dark, 15=bright yellow). */
function blockLightColor(level: number): string {
  if (level === 0) return "#444";
  const t = level / 15;
  // hsl: hue 35 (amber), 100% saturation, lightness 18%→90%
  const l = Math.round(18 + t * 72);
  return `hsl(35,100%,${l}%)`;
}

export interface RenderStats {
  drawCalls: number;
  totalChunks: number;
  drawnVertices: number;
  totalVertices: number;
  /** Normalised time-of-day in [0, 1). 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset. */
  worldTime: number;
}

// ── Cardinal direction table ────────────────────────────────────
// yaw=0 → looking -Z = North, yaw=π/2 → looking +X = East
const CARDINALS = [
  "N",
  "NE",
  "E",
  "SE",
  "S",
  "SW",
  "W",
  "NW",
] as const;

function toCardinal(yaw: number): string {
  const a =
    ((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const i = Math.round((a / (Math.PI * 2)) * 8) % 8;
  return CARDINALS[i];
}

function faceLabel(
  nx: number,
  ny: number,
  nz: number,
): string {
  if (nx !== 0) return nx > 0 ? "+X (East)" : "-X (West)";
  if (ny !== 0) return ny > 0 ? "+Y (Top)" : "-Y (Bottom)";
  return nz > 0 ? "+Z (South)" : "-Z (North)";
}

/** Extracts a human-readable browser name + version from the user-agent string. */
function getBrowserInfo(ua: string): string {
  if (/Edg\//.test(ua))
    return `Edge ${ua.match(/Edg\/([\d.]+)/)?.[1] ?? ""}`.trim();
  if (/OPR\//.test(ua))
    return `Opera ${ua.match(/OPR\/([\d.]+)/)?.[1] ?? ""}`.trim();
  if (/Chrome\//.test(ua))
    return `Chrome ${ua.match(/Chrome\/([\d.]+)/)?.[1] ?? ""}`.trim();
  if (/Firefox\//.test(ua))
    return `Firefox ${ua.match(/Firefox\/([\d.]+)/)?.[1] ?? ""}`.trim();
  if (/Safari\//.test(ua))
    return `Safari ${ua.match(/Version\/([\d.]+)/)?.[1] ?? ""}`.trim();
  return "Unknown";
}

// ── Browser engine detection ────────────────────────────────────
type BrowserEngine =
  | "chromium"
  | "firefox"
  | "safari"
  | "unknown";

function detectEngine(ua: string): BrowserEngine {
  if (/Firefox\//.test(ua)) return "firefox";
  // Safari but not Chrome-based
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua))
    return "safari";
  // Chrome, Edge, Opera, etc. (Blink-based)
  if (/Chrome\//.test(ua)) return "chromium";
  return "unknown";
}

// ── SolidJS badges rendered once into the debug panel ──────────
const ICON_STYLE = {
  width: "1em",
  height: "1em",
  "vertical-align": "middle",
};

const BrowserIcon: Component<{ engine: BrowserEngine }> = (
  props,
) => {
  switch (props.engine) {
    case "chromium":
      return <IconBrandChrome style={ICON_STYLE} />;
    case "safari":
      return <IconBrandSafari style={ICON_STYLE} />;
    case "firefox":
      return <IconBrandFirefox style={ICON_STYLE} />;
    default:
      return null;
  }
};

const DebugBadges: Component<{
  engine: BrowserEngine;
  isTauri: boolean;
}> = (props) => (
  <span
    style={{
      display: "inline-flex",
      "align-items": "center",
      gap: "0.4em",
    }}
  >
    <Show when={props.isTauri}>
      <img
        src="/tauri.svg"
        alt="Tauri"
        style={{
          width: "1em",
          height: "1em",
          "vertical-align": "middle",
        }}
      />
    </Show>
    <BrowserIcon engine={props.engine} />
  </span>
);

interface DebugState {
  fps: number;
  drawCalls: number;
  totalChunks: number;
  drawnVertices: number;
  totalVertices: number;
  timeStr: string;
  phase: string;
  pos: [number, number, number];
  facing: { cardinal: string; yaw: number; pitch: number };
  target: {
    typeName: string;
    bx: number;
    by: number;
    bz: number;
    cx: number;
    cz: number;
    lx: number;
    lz: number;
    face: string;
  } | null;
  sysInfo: {
    gpu: string;
    vendor: string;
    maxTex: number;
    maxViewport: string;
    cpu: string;
    ram: string;
    browser: string;
    platform: string;
    engine: BrowserEngine;
    isTauri: boolean;
  };
  shaderpack: {
    active: string;
    warnings: number;
    errors: number;
    overrides: number;
    totalStages: number;
    latestFallback: string;
  };
}

const DebugUI: Component<{
  state: DebugState;
  visible: boolean;
}> = (props) => {
  return (
    <Show when={props.visible}>
      <aside class="fixed top-2 left-2 flex flex-row items-start gap-2.5 pointer-events-none select-none z-20">
        <dl class="bg-black/60 text-[#e8e8e8] font-mono text-xs leading-[1.55] px-3 py-2 rounded-md min-w-64 grid grid-cols-[auto_1fr] gap-x-4 items-baseline">
          {/* Renderer Section */}
          <header class="col-span-2 text-[#aaa] font-bold mt-1 mb-0.5">
            Renderer
          </header>
          <dt>FPS</dt>
          <dd>{props.state.fps}</dd>
          <dt>Chunks</dt>
          <dd>
            {props.state.drawCalls} /{" "}
            {props.state.totalChunks} (
            {props.state.totalChunks -
              props.state.drawCalls}{" "}
            culled)
          </dd>
          <dt>Verts</dt>
          <dd>
            {(props.state.drawnVertices / 1000).toFixed(1)}k
            /{" "}
            {(props.state.totalVertices / 1000).toFixed(1)}k
          </dd>
          <dt>Time</dt>
          <dd>
            {props.state.timeStr} {props.state.phase}
          </dd>

          {/* Position Section */}
          <header class="col-span-2 text-[#aaa] font-bold mt-2 mb-0.5">
            Position
          </header>
          <dt>XYZ</dt>
          <dd>
            {props.state.pos[0].toFixed(2)},{" "}
            {props.state.pos[1].toFixed(2)},{" "}
            {props.state.pos[2].toFixed(2)}
          </dd>
          <dt>Block</dt>
          <dd>
            {Math.floor(props.state.pos[0])},{" "}
            {Math.floor(props.state.pos[1])},{" "}
            {Math.floor(props.state.pos[2])}
          </dd>

          {/* Facing Section */}
          <header class="col-span-2 text-[#aaa] font-bold mt-2 mb-0.5">
            Facing
          </header>
          <dt>Dir</dt>
          <dd>
            {props.state.facing.cardinal} (yaw{" "}
            {props.state.facing.yaw.toFixed(1)}°, pitch{" "}
            {props.state.facing.pitch.toFixed(1)}°)
          </dd>

          {/* Target Block Section */}
          <header class="col-span-2 text-[#aaa] font-bold mt-2 mb-0.5">
            Target block
          </header>
          <Show
            when={props.state.target}
            fallback={<span class="col-span-2">—</span>}
          >
            {(t) => (
              <>
                <dt>Type</dt>
                <dd>
                  {t().typeName} ({t().bx}, {t().by},{" "}
                  {t().bz})
                </dd>
                <dt>Chunk</dt>
                <dd>
                  ({t().cx}, {t().cz}) local ({t().lx},{" "}
                  {t().by}, {t().lz})
                </dd>
                <dt>Face</dt>
                <dd>{t().face}</dd>
              </>
            )}
          </Show>

          {/* System Section */}
          <header class="col-span-2 text-[#aaa] font-bold mt-3 mb-0.5 border-t border-white/10 pt-1.5">
            System
          </header>
          <dt>GPU</dt>
          <dd class="break-all">
            {props.state.sysInfo.gpu}
          </dd>
          <dt>Vendor</dt>
          <dd>{props.state.sysInfo.vendor}</dd>
          <dt>Texture</dt>
          <dd>
            {props.state.sysInfo.maxTex}px VP{" "}
            {props.state.sysInfo.maxViewport}
          </dd>
          <dt>CPU</dt>
          <dd>{props.state.sysInfo.cpu} logical cores</dd>
          <dt>RAM</dt>
          <dd>{props.state.sysInfo.ram}</dd>
          <dt>UA</dt>
          <dd class="flex items-center gap-1.5 line-clamp-1">
            <DebugBadges
              engine={props.state.sysInfo.engine}
              isTauri={props.state.sysInfo.isTauri}
            />
            <span
              class="truncate max-w-40"
              title={props.state.sysInfo.browser}
            >
              {props.state.sysInfo.browser}
            </span>
          </dd>
          <dt>OS</dt>
          <dd>{props.state.sysInfo.platform}</dd>
          <dt>Tauri</dt>
          <dd>
            {import.meta.isTauri ? "Yes" : "No"}{" "}
            {JSON.stringify(import.meta.isTauri)}
          </dd>

          {/* Shaderpack Section */}
          <header class="col-span-2 text-[#aaa] font-bold mt-3 mb-0.5 border-t border-white/10 pt-1.5">
            Shaderpack
          </header>
          <dt>Active</dt>
          <dd class="break-all">
            {props.state.shaderpack.active}
          </dd>
          <dt>Stages</dt>
          <dd>
            {props.state.shaderpack.overrides}/
            {props.state.shaderpack.totalStages} override
          </dd>
          <dt>Diag</dt>
          <dd>
            {props.state.shaderpack.warnings} warnings,{" "}
            {props.state.shaderpack.errors} errors
          </dd>
          <dt>Fallback</dt>
          <dd class="break-all">
            {props.state.shaderpack.latestFallback || "—"}
          </dd>
        </dl>
      </aside>
    </Show>
  );
};

// ── Axis definitions for the 3-D compass ───────────────────────
const AXES = [
  {
    dir: [1, 0, 0] as [number, number, number],
    color: "#f55",
    neg: "#722",
    label: "X",
  },
  {
    dir: [0, 1, 0] as [number, number, number],
    color: "#5f5",
    neg: "#272",
    label: "Y",
  },
  {
    dir: [0, 0, 1] as [number, number, number],
    color: "#55f",
    neg: "#227",
    label: "Z",
  },
];

/**
 * Projects a world-space direction vector onto the compass screen using
 * camera yaw + pitch, returning [screenX, screenY, depth].
 */
function project(
  wx: number,
  wy: number,
  wz: number,
  yaw: number,
  pitch: number,
): [number, number, number] {
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw);
  const cp = Math.cos(pitch),
    sp = Math.sin(pitch);
  // Right vector dot product → screen X
  const sx = cy * wx + sy * wz;
  // View-up vector dot product → screen Y (approximate camera-space up)
  const sUp = sy * sp * wx + cp * wy - cy * sp * wz;
  // Forward vector dot product → depth (for painter-sort)
  const depth = cp * sy * wx - sp * wy - cp * cy * wz;
  return [sx, sUp, depth];
}

// ── DebugOverlay ────────────────────────────────────────────────

export class DebugOverlay {
  private readonly compass: HTMLCanvasElement;
  private readonly crosshair: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly setVisible: (v: boolean) => void;
  private readonly visible: () => boolean;
  private readonly setState: (s: DebugState) => void;
  private readonly state: () => DebugState;
  private readonly disposeUI: () => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;
  private readonly root: HTMLDivElement;

  // ── Light debug overlay ───────────────────────────────────────
  private readonly lightCanvas: HTMLCanvasElement;
  private readonly lightCtx: CanvasRenderingContext2D;
  private readonly setLightDebug: (v: boolean) => void;
  private readonly lightDebugVisible: () => boolean;
  private f3Held = false;

  constructor(gl: WebGL2RenderingContext | null) {
    this.compass = document.getElementById(
      "debug-compass",
    ) as HTMLCanvasElement;
    this.crosshair = document.getElementById("crosshair")!;
    this.ctx = this.compass.getContext("2d")!;

    // ── Light debug canvas (fullscreen, pointer-events: none) ────
    const lightCanvas = document.createElement("canvas");
    lightCanvas.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:24;display:none";
    document.body.appendChild(lightCanvas);
    this.lightCanvas = lightCanvas;
    this.lightCtx = lightCanvas.getContext("2d")!;

    const [visible, setVisible] = createSignal(false);
    const [state, setState] = createSignal<DebugState>({
      fps: 0,
      drawCalls: 0,
      totalChunks: 0,
      drawnVertices: 0,
      totalVertices: 0,
      timeStr: "00:00",
      phase: "Day",
      pos: [0, 0, 0],
      facing: { cardinal: "N", yaw: 0, pitch: 0 },
      target: null,
      sysInfo: {
        gpu: "—",
        vendor: "—",
        maxTex: 0,
        maxViewport: "—",
        cpu: "—",
        ram: "—",
        browser: "—",
        platform: "—",
        engine: "unknown",
        isTauri: false,
      },
      shaderpack: {
        active: "None",
        warnings: 0,
        errors: 0,
        overrides: 0,
        totalStages: 0,
        latestFallback: "",
      },
    });

    const [lightDebugVisible, setLightDebug] =
      createSignal(false);
    this.visible = visible;
    this.setVisible = setVisible;
    this.state = state;
    this.setState = setState;
    this.lightDebugVisible = lightDebugVisible;
    this.setLightDebug = setLightDebug;

    // Render the UI once
    this.root = document.createElement("div");
    this.root.id = "debug-root";
    document.body.appendChild(this.root);

    this.disposeUI = render(
      () => (
        <DebugUI
          state={this.state()}
          visible={this.visible()}
        />
      ),
      this.root,
    );

    // ── One-time system / environment snapshot ──────────────────
    // gl may be null when running on the WebGPU backend.
    const dbgExt =
      gl?.getExtension("WEBGL_debug_renderer_info") ?? null;
    const gpuRenderer = dbgExt
      ? (gl!.getParameter(
          dbgExt.UNMASKED_RENDERER_WEBGL,
        ) as string)
      : (
            navigator as unknown as {
              gpu?: { wgslLanguageFeatures?: unknown };
            }
          ).gpu
        ? "WebGPU"
        : "—";
    const gpuVendor = dbgExt
      ? (gl!.getParameter(
          dbgExt.UNMASKED_VENDOR_WEBGL,
        ) as string)
      : "—";
    const maxTex = gl
      ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number)
      : 0;
    const maxViewport = gl
      ? (
          gl.getParameter(
            gl.MAX_VIEWPORT_DIMS,
          ) as Int32Array
        ).join("×")
      : "—";

    const cpuCores = navigator.hardwareConcurrency ?? "—";
    const ramGB =
      (navigator as unknown as { deviceMemory?: number })
        .deviceMemory != null
        ? `~${(navigator as unknown as { deviceMemory: number }).deviceMemory} GB`
        : "—";

    const browser = getBrowserInfo(navigator.userAgent);
    const platform = navigator.platform || "—";
    const isTauri = import.meta.isTauri;
    const engine = detectEngine(navigator.userAgent);

    this.setState({
      ...this.state(),
      sysInfo: {
        gpu: gpuRenderer,
        vendor: gpuVendor,
        maxTex,
        maxViewport,
        cpu: cpuCores.toString(),
        ram: ramGB,
        browser,
        platform,
        engine,
        isTauri,
      },
    });

    this.onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "F3") {
        e.preventDefault();
        this.f3Held = true;
        const v = !this.visible();
        this.setVisible(v);
        this.compass.style.display = v ? "block" : "none";
        this.crosshair.style.display = v ? "none" : "";
        // Hide light debug when panel is hidden
        if (!v && this.lightDebugVisible()) {
          this.setLightDebug(false);
          this.lightCanvas.style.display = "none";
        }
      } else if (e.code === "KeyL" && this.f3Held) {
        // F3+L toggles light-level overlay
        e.preventDefault();
        const ld = !this.lightDebugVisible();
        this.setLightDebug(ld);
        this.lightCanvas.style.display = ld
          ? "block"
          : "none";
      }
    };

    this.onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "F3") this.f3Held = false;
    };

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  update(
    camera: Camera,
    world: World,
    stats: RenderStats,
  ): void {
    if (!this.visible() && !this.lightDebugVisible())
      return;

    // ── Sync light-canvas pixel resolution to window ─────────────
    const sw = window.innerWidth;
    const sh = window.innerHeight;
    if (
      this.lightCanvas.width !== sw ||
      this.lightCanvas.height !== sh
    ) {
      this.lightCanvas.width = sw;
      this.lightCanvas.height = sh;
    }

    // Draw (or clear) the light-level overlay every frame
    if (this.lightDebugVisible()) {
      this.drawLightDebug(camera, world, sw, sh);
    } else {
      this.lightCtx.clearRect(0, 0, sw, sh);
    }

    if (!this.visible()) return;

    const [px, py, pz] = camera.position;
    const yaw = camera.yaw;
    const pitch = camera.pitch;
    const cardinal = toCardinal(yaw);

    // ── Time-of-day label ─────────────────────────────────────
    const t = stats.worldTime; // 0..1
    const totalMinutes = Math.floor(t * 24 * 60);
    const hh = String(
      Math.floor(totalMinutes / 60),
    ).padStart(2, "0");
    const mm = String(totalMinutes % 60).padStart(2, "0");
    const phase =
      t < 0.2
        ? "Night"
        : t < 0.27
          ? "Dawn"
          : t < 0.73
            ? "Day"
            : t < 0.8
              ? "Dusk"
              : "Night";

    const fwd = camera.getForward();
    const hit = raycast(camera.position, fwd, world);

    let target = null;
    if (hit) {
      const btype = world.getBlock(hit.bx, hit.by, hit.bz);
      const typeName = BlockType[btype] ?? "Unknown";
      const chunkX = Math.floor(hit.bx / 16);
      const chunkZ = Math.floor(hit.bz / 16);
      const lx = ((hit.bx % 16) + 16) % 16;
      const lz = ((hit.bz % 16) + 16) % 16;
      target = {
        typeName,
        bx: hit.bx,
        by: hit.by,
        bz: hit.bz,
        cx: chunkX,
        cz: chunkZ,
        lx,
        lz,
        face: faceLabel(hit.nx, hit.ny, hit.nz),
      };
    }

    const shaderpack = getShaderpackStateSnapshot();
    const overrides = shaderpack.stageStatuses.filter(
      (s) => s.mode === "override",
    ).length;
    const latestFallback =
      [...shaderpack.stageStatuses]
        .reverse()
        .find((s) => s.mode === "builtin" && s.reason)
        ?.reason ?? "";

    this.setState({
      ...this.state(),
      fps: Number(Time.GetFPS().toFixed(0)),
      drawCalls: stats.drawCalls,
      totalChunks: stats.totalChunks,
      drawnVertices: stats.drawnVertices,
      totalVertices: stats.totalVertices,
      timeStr: `${hh}:${mm}`,
      phase,
      pos: [px, py, pz],
      facing: {
        cardinal,
        yaw: (yaw * 180) / Math.PI,
        pitch: (pitch * 180) / Math.PI,
      },
      target,
      shaderpack: {
        active: shaderpack.active?.name ?? "None",
        warnings: shaderpack.diagnostics.warnings.length,
        errors: shaderpack.diagnostics.errors.length,
        overrides,
        totalStages: shaderpack.stageStatuses.length,
        latestFallback,
      },
    });

    // ── Draw 3-D compass ───────────────────────────────────────
    this.drawCompass(yaw, pitch);
  }

  private drawLightDebug(
    camera: Camera,
    world: World,
    sw: number,
    sh: number,
  ): void {
    const ctx = this.lightCtx;
    ctx.clearRect(0, 0, sw, sh);

    const [cpx, cpy, cpz] = camera.position;
    const aspect = sw / sh;
    const view = camera.getViewMatrix() as Float32Array;
    const proj = camera.getProjectionMatrixZO(
      aspect,
    ) as Float32Array;

    // Scan blocks in a 12-block radius XZ and ±5 Y around the player.
    const RADIUS = 12;
    const Y_RANGE = 5;
    const bpx = Math.floor(cpx);
    const bpy = Math.floor(cpy);
    const bpz = Math.floor(cpz);

    ctx.font = "bold 12px monospace";
    ctx.lineWidth = 3;

    for (let dy = -Y_RANGE; dy <= Y_RANGE; dy++) {
      const wy = bpy + dy;

      for (let dx = -RADIUS; dx <= RADIUS; dx++) {
        for (let dz = -RADIUS; dz <= RADIUS; dz++) {
          const wx = bpx + dx;
          const wz = bpz + dz;

          // Only draw label if there is a solid block here with air above
          const block = world.getBlock(wx, wy, wz);
          if (block === 0 /* Air */) continue;
          if (
            world.getBlock(wx, wy + 1, wz) !== 0 /* Air */
          )
            continue;

          // Sample the air block (wy+1) — this is what the face sees
          const skyL = world.getSkyLight(wx, wy + 1, wz);
          const blockL = world.getBlockLight(
            wx,
            wy + 1,
            wz,
          );

          // Project the top-face centre (block unit = 1 m, face at wy+1)
          const screen = worldToScreen(
            wx + 0.5,
            wy + 1.02,
            wz + 0.5,
            view,
            proj,
            sw,
            sh,
          );
          if (!screen) continue;

          const [scx, scy] = screen;

          // Distance-based fade
          const dist2 = dx * dx + dy * dy + dz * dz;
          if (dist2 > RADIUS * RADIUS) continue;
          const alpha = Math.max(
            0.35,
            1.0 - Math.sqrt(dist2) / RADIUS,
          );

          ctx.globalAlpha = alpha;

          const skyStr = skyL.toString();
          const blkStr = blockL.toString();
          const GAP = 3; // px gap between the two numbers

          const skyW = ctx.measureText(skyStr).width;
          const blkW = ctx.measureText(blkStr).width;
          const totalW = skyW + GAP + blkW;
          const padX = 3,
            padY = 2,
            h = 14;

          // Dark background pill behind both numbers
          ctx.globalAlpha = alpha * 0.55;
          ctx.fillStyle = "#000";
          ctx.beginPath();
          const rx = scx - totalW / 2 - padX;
          const ry = scy - h / 2 - padY;
          ctx.roundRect(
            rx,
            ry,
            totalW + padX * 2,
            h + padY * 2,
            3,
          );
          ctx.fill();
          ctx.globalAlpha = alpha;

          // Sky value — right half (blue palette), right-aligned at centre - gap/2
          const skyX = scx - GAP / 2;
          ctx.textAlign = "right";
          ctx.strokeStyle = "rgba(0,0,0,0.8)";
          ctx.fillStyle = skyLightColor(skyL);
          ctx.strokeText(skyStr, skyX, scy + 4);
          ctx.fillText(skyStr, skyX, scy + 4);

          // Block value — left half (amber palette), left-aligned at centre + gap/2
          const blkX = scx + GAP / 2;
          ctx.textAlign = "left";
          ctx.fillStyle = blockLightColor(blockL);
          ctx.strokeStyle = "rgba(0,0,0,0.8)";
          ctx.strokeText(blkStr, blkX, scy + 4);
          ctx.fillText(blkStr, blkX, scy + 4);
        }
      }
    }

    ctx.globalAlpha = 1.0;
  }

  private drawCompass(yaw: number, pitch: number): void {
    const size = this.compass.width; // 96 px
    const cx = size / 2;
    const cy = size / 2;
    const r = size * 0.36;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, size, size);

    // Background circle
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.46, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fill();

    // Project all axes and sort back→front (painter's algorithm)
    const projected = AXES.map((ax) => {
      const [sx, sUp, depth] = project(
        ax.dir[0],
        ax.dir[1],
        ax.dir[2],
        yaw,
        pitch,
      );
      return { ...ax, sx, sUp, depth };
    }).sort((a, b) => a.depth - b.depth);

    for (const ax of projected) {
      const ex = cx + ax.sx * r;
      const ey = cy - ax.sUp * r; // flip Y: up on screen = positive

      // Negative half-axis (dimmed)
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(
        cx - (ex - cx) * 0.55,
        cy - (ey - cy) * 0.55,
      );
      ctx.strokeStyle = ax.neg;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Positive axis
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = ax.color;
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Arrowhead dot
      ctx.beginPath();
      ctx.arc(ex, ey, 3, 0, Math.PI * 2);
      ctx.fillStyle = ax.color;
      ctx.fill();

      // Axis label
      ctx.font = "bold 10px monospace";
      ctx.fillStyle = ax.color;
      ctx.fillText(ax.label, ex + 4, ey + 4);
    }

    // Centre dot
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.disposeUI();
    this.root.remove();
    this.lightCanvas.remove();
  }
}
