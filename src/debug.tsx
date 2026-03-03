import { Camera } from "~/camera";
import { World } from "~/world/world";
import { BlockType } from "~/world/block";
import { raycast } from "~/raycaster";
import Time from "~/time-manager";
import { render } from "solid-js/web";
import { createSignal, Show } from "solid-js";
import {
  IconBrandChrome,
  IconBrandSafari,
  IconBrandFirefox,
} from "@tabler/icons-solidjs";
import type { Component } from "solid-js";
import { getShaderpackStateSnapshot } from "~/shaderpack/runtime";

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
const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

function toCardinal(yaw: number): string {
  const a = ((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const i = Math.round((a / (Math.PI * 2)) * 8) % 8;
  return CARDINALS[i];
}

function faceLabel(nx: number, ny: number, nz: number): string {
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
type BrowserEngine = "chromium" | "firefox" | "safari" | "unknown";

function detectEngine(ua: string): BrowserEngine {
  if (/Firefox\//.test(ua)) return "firefox";
  // Safari but not Chrome-based
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return "safari";
  // Chrome, Edge, Opera, etc. (Blink-based)
  if (/Chrome\//.test(ua)) return "chromium";
  return "unknown";
}

// ── SolidJS badges rendered once into the debug panel ──────────
const ICON_STYLE = { width: "1em", height: "1em", "vertical-align": "middle" };

const BrowserIcon: Component<{ engine: BrowserEngine }> = (props) => {
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

const DebugBadges: Component<{ engine: BrowserEngine; isTauri: boolean }> = (
  props,
) => (
  <span
    style={{ display: "inline-flex", "align-items": "center", gap: "0.4em" }}
  >
    <Show when={props.isTauri}>
      <img
        src="/tauri.svg"
        alt="Tauri"
        style={{ width: "1em", height: "1em", "vertical-align": "middle" }}
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

const DebugUI: Component<{ state: DebugState; visible: boolean }> = (props) => {
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
            {props.state.drawCalls} / {props.state.totalChunks} (
            {props.state.totalChunks - props.state.drawCalls} culled)
          </dd>
          <dt>Verts</dt>
          <dd>
            {(props.state.drawnVertices / 1000).toFixed(1)}k /{" "}
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
            {props.state.pos[0].toFixed(2)}, {props.state.pos[1].toFixed(2)},{" "}
            {props.state.pos[2].toFixed(2)}
          </dd>
          <dt>Block</dt>
          <dd>
            {Math.floor(props.state.pos[0])}, {Math.floor(props.state.pos[1])},{" "}
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
                  {t().typeName} ({t().bx}, {t().by}, {t().bz})
                </dd>
                <dt>Chunk</dt>
                <dd>
                  ({t().cx}, {t().cz}) local ({t().lx}, {t().by}, {t().lz})
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
          <dd class="break-all">{props.state.sysInfo.gpu}</dd>
          <dt>Vendor</dt>
          <dd>{props.state.sysInfo.vendor}</dd>
          <dt>Texture</dt>
          <dd>
            {props.state.sysInfo.maxTex}px VP {props.state.sysInfo.maxViewport}
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
            <span class="truncate max-w-40" title={props.state.sysInfo.browser}>
              {props.state.sysInfo.browser}
            </span>
          </dd>
          <dt>OS</dt>
          <dd>{props.state.sysInfo.platform}</dd>
          <dt>Tauri</dt>
          <dd>{import.meta.isTauri ? "Yes" : "No"} {JSON.stringify(import.meta.isTauri)}</dd>

          {/* Shaderpack Section */}
          <header class="col-span-2 text-[#aaa] font-bold mt-3 mb-0.5 border-t border-white/10 pt-1.5">
            Shaderpack
          </header>
          <dt>Active</dt>
          <dd class="break-all">{props.state.shaderpack.active}</dd>
          <dt>Stages</dt>
          <dd>
            {props.state.shaderpack.overrides}/{props.state.shaderpack.totalStages} override
          </dd>
          <dt>Diag</dt>
          <dd>
            {props.state.shaderpack.warnings} warnings, {props.state.shaderpack.errors} errors
          </dd>
          <dt>Fallback</dt>
          <dd class="break-all">{props.state.shaderpack.latestFallback || "—"}</dd>
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
  private readonly root: HTMLDivElement;

  constructor(gl: WebGL2RenderingContext | null) {
    this.compass = document.getElementById(
      "debug-compass",
    ) as HTMLCanvasElement;
    this.crosshair = document.getElementById("crosshair")!;
    this.ctx = this.compass.getContext("2d")!;

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

    this.visible = visible;
    this.setVisible = setVisible;
    this.state = state;
    this.setState = setState;

    // Render the UI once
    this.root = document.createElement("div");
    this.root.id = "debug-root";
    document.body.appendChild(this.root);

    this.disposeUI = render(
      () => <DebugUI state={this.state()} visible={this.visible()} />,
      this.root,
    );

    // ── One-time system / environment snapshot ──────────────────
    // gl may be null when running on the WebGPU backend.
    const dbgExt = gl?.getExtension("WEBGL_debug_renderer_info") ?? null;
    const gpuRenderer = dbgExt
      ? (gl!.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL) as string)
      : (navigator as unknown as { gpu?: { wgslLanguageFeatures?: unknown } })
            .gpu
        ? "WebGPU"
        : "—";
    const gpuVendor = dbgExt
      ? (gl!.getParameter(dbgExt.UNMASKED_VENDOR_WEBGL) as string)
      : "—";
    const maxTex = gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : 0;
    const maxViewport = gl
      ? (gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array).join("×")
      : "—";

    const cpuCores = navigator.hardwareConcurrency ?? "—";
    const ramGB =
      (navigator as unknown as { deviceMemory?: number }).deviceMemory != null
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
        const v = !this.visible();
        this.setVisible(v);
        this.compass.style.display = v ? "block" : "none";
        this.crosshair.style.display = v ? "none" : "";
      }
    };
    window.addEventListener("keydown", this.onKeyDown);
  }

  update(camera: Camera, world: World, stats: RenderStats): void {
    if (!this.visible()) return;

    const [px, py, pz] = camera.position;
    const yaw = camera.yaw;
    const pitch = camera.pitch;
    const cardinal = toCardinal(yaw);

    // ── Time-of-day label ─────────────────────────────────────
    const t = stats.worldTime; // 0..1
    const totalMinutes = Math.floor(t * 24 * 60);
    const hh = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
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
    const overrides = shaderpack.stageStatuses.filter((s) => s.mode === "override").length;
    const latestFallback = [...shaderpack.stageStatuses]
      .reverse()
      .find((s) => s.mode === "builtin" && s.reason)?.reason ?? "";

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
      ctx.lineTo(cx - (ex - cx) * 0.55, cy - (ey - cy) * 0.55);
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
    this.disposeUI();
    this.root.remove();
  }
}
