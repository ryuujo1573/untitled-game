import { Camera } from "./camera";
import { World } from "./world/world";
import { BlockType } from "./world/block";
import { raycast } from "./raycaster";
import Time from "./time-manager";

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
  private readonly panel: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly compass: HTMLCanvasElement;
  private readonly crosshair: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly sysInfo: string;
  private visible = false;

  constructor(gl: WebGL2RenderingContext | null) {
    this.panel = document.getElementById("debug-panel")!;
    this.textEl = document.getElementById("debug-text")!;
    this.compass = document.getElementById(
      "debug-compass",
    ) as HTMLCanvasElement;
    this.crosshair = document.getElementById("crosshair")!;
    this.ctx = this.compass.getContext("2d")!;

    // ── One-time system / environment snapshot ──────────────────
    // gl may be null when running on the WebGPU backend.
    const dbgExt = gl?.getExtension("WEBGL_debug_renderer_info") ?? null;
    const gpuRenderer = dbgExt
      ? (gl!.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL) as string)
      : (navigator as unknown as { gpu?: { wgslLanguageFeatures?: unknown } }).gpu
        ? "WebGPU"
        : "—";
    const gpuVendor = dbgExt
      ? (gl!.getParameter(dbgExt.UNMASKED_VENDOR_WEBGL) as string)
      : "—";
    const maxTex      = gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : 0;
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
    const screenRes = `${screen.width}×${screen.height}`;
    const dpr = window.devicePixelRatio.toFixed(2);
    const colorDepth = `${screen.colorDepth}-bit`;

    this.sysInfo =
      `GPU     ${gpuRenderer}\n` +
      `Vendor  ${gpuVendor}\n` +
      `MaxTex  ${maxTex}px  VP ${maxViewport}\n` +
      `CPU     ${cpuCores} logical cores\n` +
      `RAM     ${ramGB}\n` +
      `Browser ${browser}\n` +
      `Screen  ${screenRes}  DPR ×${dpr}  ${colorDepth}\n` +
      `OS      ${platform}`;

    window.addEventListener("keydown", (e) => {
      if (e.code === "F3") {
        e.preventDefault();
        this.visible = !this.visible;
        this.panel.style.display = this.visible ? "flex" : "none";
        this.compass.style.display = this.visible ? "block" : "none";
        this.crosshair.style.display = this.visible ? "none" : "";
      }
    });
  }

  update(camera: Camera, world: World, stats: RenderStats): void {
    if (!this.visible) return;

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

    let targetLines: string;
    if (hit) {
      const btype = world.getBlock(hit.bx, hit.by, hit.bz);
      const typeName = BlockType[btype] ?? "Unknown";
      const chunkX = Math.floor(hit.bx / 16);
      const chunkZ = Math.floor(hit.bz / 16);
      const lx = ((hit.bx % 16) + 16) % 16;
      const lz = ((hit.bz % 16) + 16) % 16;
      targetLines =
        `${typeName}  (${hit.bx}, ${hit.by}, ${hit.bz})\n` +
        `chunk (${chunkX}, ${chunkZ})  local (${lx}, ${hit.by}, ${lz})\n` +
        `face  ${faceLabel(hit.nx, hit.ny, hit.nz)}`;
    } else {
      targetLines = "—";
    }

    // ── Update DOM text ────────────────────────────────────────
    this.textEl.innerHTML =
      `<span class="dbg-section">Renderer</span>\n` +
      `FPS    ${Time.GetFPS().toFixed(0)}\n` +
      `Chunks ${stats.drawCalls} / ${stats.totalChunks}  (${stats.totalChunks - stats.drawCalls} culled)\n` +
      `Verts  ${(stats.drawnVertices / 1000).toFixed(1)}k / ${(stats.totalVertices / 1000).toFixed(1)}k\n` +
      `Time   ${hh}:${mm}  ${phase}\n` +
      `\n` +
      `<span class="dbg-section">Position</span>\n` +
      `XYZ   ${px.toFixed(2)}, ${py.toFixed(2)}, ${pz.toFixed(2)}\n` +
      `Block  ${Math.floor(px)}, ${Math.floor(py)}, ${Math.floor(pz)}\n` +
      `\n` +
      `<span class="dbg-section">Facing</span>\n` +
      `${cardinal}   yaw ${((yaw * 180) / Math.PI).toFixed(1)}°   pitch ${((pitch * 180) / Math.PI).toFixed(1)}°\n` +
      `\n` +
      `<span class="dbg-section">Target block</span>\n` +
      targetLines +
      `\n\n` +
      `<span class="dbg-section">System</span>\n` +
      this.sysInfo;

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
}
