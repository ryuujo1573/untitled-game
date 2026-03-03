/**
 * WebGPU rendering backend — deferred PBR pipeline.
 *
 * Render order per frame:
 *   Pass 1 – GBuffer terrain: fills 3 MRT textures + depth.
 *   Pass 2 – Deferred lighting: Cook-Torrance BRDF, sun + ambient, fog.
 *   Pass 3 – Outline (optional): wireframe drawn on top with GBuffer depth.
 *   Pass 4 – Tonemap (HDR path only): ACES tone-map to swapchain.
 *
 * Bind group layouts:
 *   GBuffer pass  – Group 0: GFrameUBO + 3 atlas textures + sampler
 *                   Group 1: per-chunk model matrix UBO
 *   Deferred pass – Group 0: GFrameUBO + 3 GBuffer textures + depth texture
 *   Outline pass  – Group 0: GFrameUBO (view+proj reused)
 *                   Group 1: OutlineUBO (model + alpha)
 *   Tonemap pass  – Group 0: HDR texture + linear sampler + exposure UBO
 */

import type { IRenderer } from "../renderer-interface";
import { mat4 } from "gl-matrix";
import { Camera } from "../camera";
import { InputManager } from "../input";
import { Physics } from "../physics";
import { World } from "../world/world";
import { Chunk, CHUNK_SIZE } from "../world/chunk";
import { DebugOverlay } from "../debug";
import { Frustum } from "../frustum";
import { buildAllAtlases } from "../atlas";
import { buildAllAtlasesFromManifest } from "../atlas";
import { ResourcePackManager } from "../resource-pack";
import { raycast, type RayHit } from "../raycaster";
import { Settings } from "../settings";
import { PauseMenu } from "../pause-menu.tsx";
import Time from "../time-manager";

import gbufTerrainWGSL from "./shaders/gbuffers_terrain.wgsl?raw";
import deferredWGSL    from "./shaders/deferred_lighting.wgsl?raw";
import outlineWGSL     from "./shaders/outline.wgsl?raw";
import tonemapWGSL     from "./shaders/tonemap.wgsl?raw";

// ── Wire-cube geometry (12 edges = 24 vertices) ────────────────────────────
const WIRE_CUBE: Float32Array = (() => {
  const e = 0.002;
  const lo = -e, hi = 1.0 + e;
  // prettier-ignore
  return new Float32Array([
    lo,lo,lo, hi,lo,lo,   hi,lo,lo, hi,lo,hi,
    hi,lo,hi, lo,lo,hi,   lo,lo,hi, lo,lo,lo,
    lo,hi,lo, hi,hi,lo,   hi,hi,lo, hi,hi,hi,
    hi,hi,hi, lo,hi,hi,   lo,hi,hi, lo,hi,lo,
    lo,lo,lo, lo,hi,lo,   hi,lo,lo, hi,hi,lo,
    hi,lo,hi, hi,hi,hi,   lo,lo,hi, lo,hi,hi,
  ]);
})();
const WIRE_CUBE_VCOUNT = WIRE_CUBE.length / 3; // 24

// ── Per-chunk GPU resources ────────────────────────────────────────────────
interface ChunkGPUData {
  posBuffer:   GPUBuffer;
  uvlBuffer:   GPUBuffer;
  norBuffer:   GPUBuffer;  // normals  (vec3f, stride 12)
  tanBuffer:   GPUBuffer;  // tangents (vec4f, stride 16, w = bitangent sign)
  modelBuffer: GPUBuffer;
  bindGroup:   GPUBindGroup; // group 1 for GBuffer terrain pipeline
  vertexCount: number;
}

// ── GFrameUBO layout (336 bytes = 84 × f32) ───────────────────────────────
// Matches GFrameUniforms in gbuffers_terrain.wgsl and deferred_lighting.wgsl.
// Float32 index map:
//   [0..15]   view matrix
//   [16..31]  projection matrix (perspectiveZO, z ∈ [0,1])
//   [32..47]  viewInverse matrix
//   [48..63]  projInverse matrix
//   [64..67]  sunDirStrength  (xyz = view-space sun dir, w = strength)
//   [68..71]  sunColor        (xyz = RGB, w = 0)
//   [72..75]  ambientColor    (xyz = RGB, w = scale)
//   [76..79]  fogColorNear    (xyz = fog RGB, w = fogNear)
//   [80..83]  fogFar          (x = fogFar, yzw = 0)
const GFRAME_UBO_SIZE   = 336; // 84 × 4
const GFRAME_UBO_FLOATS = 84;

// ── OutlineUBO layout (80 bytes) ───────────────────────────────────────────
// struct OutlineUniforms { model: mat4x4f, alpha: f32, _pad: vec3f }
const OUTLINE_UBO_SIZE   = 80;
const OUTLINE_UBO_FLOATS = 20;

// ── TonemapUBO layout (16 bytes) ───────────────────────────────────────────
// struct TonemapUniforms { exposure: f32, _p0/1/2: f32 }
const TONEMAP_UBO_SIZE   = 16;
const TONEMAP_UBO_FLOATS = 4;

// ─────────────────────────────────────────────────────────────────────────────

export class WebGPURenderer implements IRenderer {
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  async start(): Promise<void> {
    const canvas = this.canvas;

    // ── 1. Adapter + device ──────────────────────────────────────────────
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) throw new Error("No WebGPU adapter available");
    const device = await adapter.requestDevice({
      label: "roughly-a-3d-game",
    });

    // rgba16float render attachment is always supported in WebGPU (no feature flag needed).
    Settings.hdrSupported = true;

    device.lost.then((info) => {
      console.error("WebGPU device lost:", info.message);
    });

    // ── 2. Canvas context ────────────────────────────────────────────────
    const context           = canvas.getContext("webgpu") as GPUCanvasContext;
    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: presentationFormat, alphaMode: "opaque" });

    // ── 3. Shader modules ────────────────────────────────────────────────
    const gbufModule     = device.createShaderModule({ label: "gbufTerrain", code: gbufTerrainWGSL });
    const deferredModule = device.createShaderModule({ label: "deferred",    code: deferredWGSL    });
    const outlineModule  = device.createShaderModule({ label: "outline",     code: outlineWGSL     });
    const tonemapModule  = device.createShaderModule({ label: "tonemap",     code: tonemapWGSL     });

    // Emit compilation errors to console early.
    await Promise.all([
      gbufModule    .getCompilationInfo().then(reportShaderErrors("gbufTerrain")),
      deferredModule.getCompilationInfo().then(reportShaderErrors("deferred")),
      outlineModule .getCompilationInfo().then(reportShaderErrors("outline")),
      tonemapModule .getCompilationInfo().then(reportShaderErrors("tonemap")),
    ]);

    // ── 4. Bind group layouts ─────────────────────────────────────────────
    const VS = GPUShaderStage.VERTEX, FS = GPUShaderStage.FRAGMENT;

    // GBuffer terrain – Group 0: GFrameUBO + 3 atlas textures + sampler
    const gbufFrameLayout = device.createBindGroupLayout({
      label: "gbufFrame",
      entries: [
        { binding: 0, visibility: VS | FS, buffer:  { type: "uniform", minBindingSize: GFRAME_UBO_SIZE } },
        { binding: 1, visibility: FS,      texture: { sampleType: "float" } }, // albedo
        { binding: 2, visibility: FS,      texture: { sampleType: "float" } }, // normal (_n)
        { binding: 3, visibility: FS,      texture: { sampleType: "float" } }, // specular (_s)
        { binding: 4, visibility: FS,      sampler: { type: "filtering" } },
      ],
    });

    // GBuffer terrain – Group 1: per-chunk model matrix
    const gbufChunkLayout = device.createBindGroupLayout({
      label: "gbufChunk",
      entries: [
        { binding: 0, visibility: VS, buffer: { type: "uniform", minBindingSize: 64 } },
      ],
    });

    // Outline – Group 0: only the view+proj part of GFrameUBO (first 128 bytes
    //   = view mat4 + proj mat4).  outline.wgsl reads FrameUniforms (160 bytes)
    //   which sits within the larger GFrameUBO — minBindingSize covers it.
    const outlineFrameLayout = device.createBindGroupLayout({
      label: "outlineFrame",
      entries: [
        { binding: 0, visibility: VS, buffer: { type: "uniform", minBindingSize: 160 } },
      ],
    });

    // Outline – Group 1: model matrix + alpha
    const outlineChunkLayout = device.createBindGroupLayout({
      label: "outlineChunk",
      entries: [
        { binding: 0, visibility: VS | FS, buffer: { type: "uniform", minBindingSize: OUTLINE_UBO_SIZE } },
      ],
    });

    // Deferred lighting – Group 0: GFrameUBO + 3 GBuffer textures + depth
    // Uses textureLoad (integer coords) so no sampler is needed.
    const deferredLayout = device.createBindGroupLayout({
      label: "deferred",
      entries: [
        { binding: 0, visibility: FS, buffer:  { type: "uniform", minBindingSize: GFRAME_UBO_SIZE } },
        { binding: 1, visibility: FS, texture: { sampleType: "float" } },            // gbuf0 rgba8unorm
        { binding: 2, visibility: FS, texture: { sampleType: "unfilterable-float" } }, // gbuf1 rgba16float (no float32-filterable feature required)
        { binding: 3, visibility: FS, texture: { sampleType: "float" } },            // gbuf2 rgba8unorm
        { binding: 4, visibility: FS, texture: { sampleType: "depth" } },             // gbufDepth
      ],
    });

    // Tonemap – Group 0 (unchanged from previous renderer)
    const tonemapLayout = device.createBindGroupLayout({
      label: "tonemap",
      entries: [
        { binding: 0, visibility: FS, texture: { sampleType: "float" } },
        { binding: 1, visibility: FS, sampler: { type: "filtering" } },
        { binding: 2, visibility: FS, buffer:  { type: "uniform", minBindingSize: TONEMAP_UBO_SIZE } },
      ],
    });

    // ── 5. Pipeline factories ─────────────────────────────────────────────
    const gbufPipelineLayout    = device.createPipelineLayout({ bindGroupLayouts: [gbufFrameLayout,   gbufChunkLayout]   });
    const outlinePipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [outlineFrameLayout, outlineChunkLayout] });
    const deferredPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [deferredLayout] });
    const tonemapPipelineLayout  = device.createPipelineLayout({ bindGroupLayouts: [tonemapLayout]  });

    // GBuffer terrain pipeline: 4 vertex buffer slots, 3 MRT outputs + depth.
    const gbufPipeline = device.createRenderPipeline({
      label: "gbufTerrain",
      layout: gbufPipelineLayout,
      vertex: {
        module: gbufModule, entryPoint: "vs_main",
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }, // pos
          { arrayStride: 16, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x4" }] }, // uvl
          { arrayStride: 12, attributes: [{ shaderLocation: 2, offset: 0, format: "float32x3" }] }, // normal
          { arrayStride: 16, attributes: [{ shaderLocation: 3, offset: 0, format: "float32x4" }] }, // tangent
        ],
      },
      fragment: {
        module: gbufModule, entryPoint: "fs_main",
        targets: [
          { format: "rgba8unorm"  },  // colortex0: albedo + roughness
          { format: "rgba16float" },  // colortex1: view-space normal + F0
          { format: "rgba8unorm"  },  // colortex2: emissive + AO
        ],
      },
      primitive:    { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
      depthStencil: { format: "depth24plus", depthCompare: "less-equal", depthWriteEnabled: true },
    });

    // Deferred lighting pipeline: fullscreen triangle, no vertex buffers.
    const buildDeferredPipeline = (colorFmt: GPUTextureFormat): GPURenderPipeline =>
      device.createRenderPipeline({
        label: "deferred",
        layout: deferredPipelineLayout,
        vertex:   { module: deferredModule, entryPoint: "vs_main" },
        fragment: { module: deferredModule, entryPoint: "fs_main",
                    targets: [{ format: colorFmt }] },
        primitive: { topology: "triangle-list" },
      });

    const buildOutlinePipeline = (colorFmt: GPUTextureFormat): GPURenderPipeline =>
      device.createRenderPipeline({
        label: "outline",
        layout: outlinePipelineLayout,
        vertex: {
          module: outlineModule, entryPoint: "vs_main",
          buffers: [
            { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
          ],
        },
        fragment: {
          module: outlineModule, entryPoint: "fs_main",
          targets: [{
            format: colorFmt,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one",       dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          }],
        },
        primitive:    { topology: "line-list" },
        depthStencil: { format: "depth24plus", depthCompare: "less-equal", depthWriteEnabled: false },
      });

    const tonemapPipeline = device.createRenderPipeline({
      label: "tonemap",
      layout: tonemapPipelineLayout,
      vertex:   { module: tonemapModule, entryPoint: "vs_main" },
      fragment: { module: tonemapModule, entryPoint: "fs_main",
                  targets: [{ format: presentationFormat }] },
      primitive: { topology: "triangle-list" },
    });

    // ── 6. Atlas textures (albedo, normal _n, specular _s) ───────────────
    // Resource-pack override path:
    //   window.__PBR_TEXTURE_MANIFEST__ = { albedo, normal, specular }
    // or
    //   window.__PBR_PACK_BASE_URL = "/path/to/textures/block"
    const resourcePacks = new ResourcePackManager();
    if (typeof window !== "undefined") {
      resourcePacks.loadFromWindow(window);
    }

    const atlasBundle = resourcePacks.getAtlasManifest()
      ? await buildAllAtlasesFromManifest(resourcePacks.getAtlasManifest())
      : await buildAllAtlases();

    const {
      albedo: albedoCanvas,
      normal: normalCanvas,
      specular: specularCanvas,
      stats: atlasStats,
    } = atlasBundle;

    if (atlasStats.albedoFallbacks + atlasStats.normalFallbacks + atlasStats.specularFallbacks > 0) {
      console.info(
        "[PBR Atlas] fallback tiles",
        `albedo=${atlasStats.albedoFallbacks}`,
        `normal=${atlasStats.normalFallbacks}`,
        `specular=${atlasStats.specularFallbacks}`,
      );
    }

    const uploadAtlas = (canvas: HTMLCanvasElement, label: string): GPUTexture => {
      const tex = device.createTexture({
        label,
        size: { width: canvas.width, height: canvas.height },
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture(
        { source: canvas, flipY: true },
        { texture: tex },
        { width: canvas.width, height: canvas.height },
      );
      return tex;
    };

    const albedoAtlasTex   = uploadAtlas(albedoCanvas,   "albedoAtlas");
    const normalAtlasTex   = uploadAtlas(normalCanvas,   "normalAtlas");
    const specularAtlasTex = uploadAtlas(specularCanvas, "specularAtlas");

    // Nearest sampler for atlas reads (GBuffer pass), linear sampler for tonemap.
    const atlasSampler = device.createSampler({
      label: "atlasNearest",
      magFilter: "nearest", minFilter: "nearest",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
    });
    const linearSampler = device.createSampler({
      label: "hdrLinear",
      magFilter: "linear", minFilter: "linear",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
    });

    // ── 7. Persistent GPU buffers ─────────────────────────────────────────
    const gframeUBO      = device.createBuffer({ label: "gframeUBO",  size: GFRAME_UBO_SIZE,   usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const gframeUBOData  = new Float32Array(GFRAME_UBO_FLOATS);

    const outlineUBO     = device.createBuffer({ label: "outlineUBO", size: OUTLINE_UBO_SIZE,  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const outlineUBOData = new Float32Array(OUTLINE_UBO_FLOATS);

    const tonemapUBO     = device.createBuffer({ label: "tonemapUBO", size: TONEMAP_UBO_SIZE,  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const tonemapUBOData = new Float32Array(TONEMAP_UBO_FLOATS);

    // Wire-cube static vertex buffer
    const wireCubeBuf = device.createBuffer({
      label: "wireCube",
      size: WIRE_CUBE.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(wireCubeBuf.getMappedRange()).set(WIRE_CUBE);
    wireCubeBuf.unmap();

    // ── 8. Mutable pipeline / texture state ──────────────────────────────
    let hdrActive  = false;
    let hdrTex:    GPUTexture | null = null;

    // GBuffer textures (screen-resolution, rebuilt on resize).
    let gbuf0Tex:     GPUTexture | null = null;  // rgba8unorm  albedo+roughness
    let gbuf1Tex:     GPUTexture | null = null;  // rgba16float normal+F0
    let gbuf2Tex:     GPUTexture | null = null;  // rgba8unorm  emissive+AO
    let gbufDepthTex: GPUTexture | null = null;  // depth24plus (sampleable)

    let deferredPipeline = buildDeferredPipeline(presentationFormat);
    let outlinePipeline  = buildOutlinePipeline(presentationFormat);

    // GBuffer frame bind group (3 atlas textures; rebuilt once here, stable).
    const gbufFrameBindGroup = device.createBindGroup({
      label: "gbufFrame",
      layout: gbufFrameLayout,
      entries: [
        { binding: 0, resource: { buffer: gframeUBO } },
        { binding: 1, resource: albedoAtlasTex.createView() },
        { binding: 2, resource: normalAtlasTex.createView() },
        { binding: 3, resource: specularAtlasTex.createView() },
        { binding: 4, resource: atlasSampler },
      ],
    });

    // Outline: reuse gframeUBO (view+proj are at the same offsets as FrameUniforms).
    const outlineFrameBindGroup = device.createBindGroup({
      label: "outlineFrame",
      layout: outlineFrameLayout,
      entries: [{ binding: 0, resource: { buffer: gframeUBO } }],
    });
    const outlineChunkBindGroup = device.createBindGroup({
      label: "outlineChunk",
      layout: outlineChunkLayout,
      entries: [{ binding: 0, resource: { buffer: outlineUBO } }],
    });

    let deferredBindGroup: GPUBindGroup | null = null;
    let tonemapBindGroup:  GPUBindGroup | null = null;

    // ── Per-chunk data store ──────────────────────────────────────────────
    const chunkData = new Map<Chunk, ChunkGPUData>();

    // ── GBuffer / HDR lifecycle ───────────────────────────────────────────
    function buildGBuffers(w: number, h: number): void {
      gbuf0Tex?.destroy();
      gbuf1Tex?.destroy();
      gbuf2Tex?.destroy();
      gbufDepthTex?.destroy();

      const mkTex = (fmt: GPUTextureFormat, label: string) =>
        device.createTexture({
          label, size: { width: w, height: h }, format: fmt,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });

      gbuf0Tex     = mkTex("rgba8unorm",  "gbuf0");
      gbuf1Tex     = mkTex("rgba16float", "gbuf1");
      gbuf2Tex     = mkTex("rgba8unorm",  "gbuf2");
      gbufDepthTex = mkTex("depth24plus", "gbufDepth");

      deferredBindGroup = device.createBindGroup({
        label: "deferred",
        layout: deferredLayout,
        entries: [
          { binding: 0, resource: { buffer: gframeUBO } },
          { binding: 1, resource: gbuf0Tex.createView() },
          { binding: 2, resource: gbuf1Tex.createView() },
          { binding: 3, resource: gbuf2Tex.createView() },
          { binding: 4, resource: gbufDepthTex.createView() },
        ],
      });
    }

    function buildHDR(w: number, h: number): void {
      hdrTex?.destroy();
      hdrTex = device.createTexture({
        label: "hdrColor", size: { width: w, height: h },
        format: "rgba16float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      tonemapBindGroup = device.createBindGroup({
        label: "tonemap",
        layout: tonemapLayout,
        entries: [
          { binding: 0, resource: hdrTex.createView() },
          { binding: 1, resource: linearSampler },
          { binding: 2, resource: { buffer: tonemapUBO } },
        ],
      });
      deferredPipeline = buildDeferredPipeline("rgba16float");
      outlinePipeline  = buildOutlinePipeline("rgba16float");
      hdrActive = true;
    }

    function destroyHDR(): void {
      hdrTex?.destroy(); hdrTex = null;
      tonemapBindGroup = null;
      deferredPipeline = buildDeferredPipeline(presentationFormat);
      outlinePipeline  = buildOutlinePipeline(presentationFormat);
      hdrActive = false;
    }

    // ── Chunk GPU data management ─────────────────────────────────────────
    function uploadChunk(chunk: Chunk): void {
      const old = chunkData.get(chunk);
      if (old) {
        old.posBuffer.destroy();
        old.uvlBuffer.destroy();
        old.norBuffer.destroy();
        old.tanBuffer.destroy();
        old.modelBuffer.destroy();
        chunkData.delete(chunk);
      }

      const mesh = chunk.buildMesh();
      if (mesh.vertexCount === 0) return;

      const mkVB = (data: Float32Array, label: string): GPUBuffer => {
        const buf = device.createBuffer({
          label, size: data.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true,
        });
        new Float32Array(buf.getMappedRange()).set(data);
        buf.unmap();
        return buf;
      };

      const posBuffer = mkVB(mesh.positions, `pos(${chunk.cx},${chunk.cz})`);
      const uvlBuffer = mkVB(mesh.uvls,      `uvl(${chunk.cx},${chunk.cz})`);
      const norBuffer = mkVB(mesh.normals,   `nor(${chunk.cx},${chunk.cz})`);
      const tanBuffer = mkVB(mesh.tangents,  `tan(${chunk.cx},${chunk.cz})`);

      const modelMat = mat4.create();
      mat4.translate(modelMat, modelMat, [chunk.cx * CHUNK_SIZE, 0, chunk.cz * CHUNK_SIZE]);

      const modelBuffer = device.createBuffer({
        label: `model(${chunk.cx},${chunk.cz})`,
        size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Float32Array(modelBuffer.getMappedRange()).set(modelMat);
      modelBuffer.unmap();

      const bindGroup = device.createBindGroup({
        label: `chunkBG(${chunk.cx},${chunk.cz})`,
        layout: gbufChunkLayout,
        entries: [{ binding: 0, resource: { buffer: modelBuffer } }],
      });

      chunkData.set(chunk, {
        posBuffer, uvlBuffer, norBuffer, tanBuffer,
        modelBuffer, bindGroup, vertexCount: mesh.vertexCount,
      });
    }

    function rebuildChunk(wx: number, _wy: number, wz: number): void {
      const chunk = world.getChunk(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE));
      if (chunk) uploadChunk(chunk);
    }

    // ── Resize ────────────────────────────────────────────────────────────
    function resize(): void {
      canvas.width  = window.innerWidth;
      canvas.height = window.innerHeight;
      buildGBuffers(canvas.width, canvas.height);
      if (hdrActive) buildHDR(canvas.width, canvas.height);
    }
    window.addEventListener("resize", resize);
    resize();

    // ── Game objects ──────────────────────────────────────────────────────
    const camera   = new Camera();
    const world    = new World();
    world.generate(4);

    const physics   = new Physics(camera, world);
    const pauseMenu = new PauseMenu(() => input.requestLock());
    pauseMenu.mount(document.getElementById("pause-root")!);

    const debug = new DebugOverlay(null);
    const input = new InputManager(canvas, camera, physics, world, rebuildChunk, pauseMenu);

    world.chunks.forEach((chunk) => uploadChunk(chunk));

    // ── Outline state ─────────────────────────────────────────────────────
    let lastHit: RayHit | null = null;
    let outlineAlpha = 0.0;
    const OUTLINE_FADE = 5.0;

    const scratchMat = mat4.create();
    const frustum    = new Frustum();
    const vpMatrix   = mat4.create();

    // ── Render loop ───────────────────────────────────────────────────────
    function frame(): void {
      requestAnimationFrame(frame);
      Time.CalculateTimeVariables();
      input.update();

      const wantHdr = Settings.hdr && Settings.hdrSupported;
      if (wantHdr && !hdrActive)       buildHDR(canvas.width, canvas.height);
      else if (!wantHdr && hdrActive)  destroyHDR();

      // ── Day-night cycle ───────────────────────────────────────────────
      const wt        = Time.worldTime;
      const sunAngle  = (wt - 0.25) * Math.PI * 2;
      const sunHeight = Math.sin(sunAngle);
      const dayFactor = Math.max(0.0, sunHeight);
      const twilight  = sunHeight > -0.3 ? Math.exp(-sunHeight * sunHeight * 30.0) : 0.0;
      const lerp      = (a: number, b: number, t: number) => a + (b - a) * t;

      const skyR = lerp(lerp(0.01, 0.88, twilight), 0.53, dayFactor);
      const skyG = lerp(lerp(0.01, 0.45, twilight), 0.81, dayFactor);
      const skyB = lerp(lerp(0.1,  0.22, twilight), 0.92, dayFactor);

      const hdrScale = wantHdr ? 1.6 : 1.0;
      const brt      = wantHdr ? 1.0 : Settings.brightness;
      const ambR = lerp(lerp(0.03, 0.75, twilight), 1.0,  dayFactor) * hdrScale * brt;
      const ambG = lerp(lerp(0.03, 0.48, twilight), 0.92, dayFactor) * hdrScale * brt;
      const ambB = lerp(lerp(0.1,  0.22, twilight), 0.8,  dayFactor) * hdrScale * brt;

      // Sun strength (brighter than ambient; zero at night).
      const sunStr = (dayFactor * 1.5 + twilight * 0.3) * hdrScale * brt;

      // ── Camera matrices ───────────────────────────────────────────────
      const aspect       = canvas.width / canvas.height;
      const viewMatrix   = camera.getViewMatrix();
      // ZO projection for correct WebGPU depth range [0, 1].
      const projMatrixZO = camera.getProjectionMatrixZO(aspect);
      // Standard perspective for frustum culling only (both work for culling).
      const projMatrix   = camera.getProjectionMatrix(aspect);
      mat4.multiply(vpMatrix, projMatrix, viewMatrix);
      frustum.update(vpMatrix);

      // Inverse matrices for the deferred lighting pass.
      const viewInv = mat4.invert(mat4.create(), viewMatrix)!;
      const projInv = mat4.invert(mat4.create(), projMatrixZO)!;

      // Sun direction: (0, sin(sunAngle), -cos(sunAngle)) → transform to view space.
      // gl-matrix column-major: M*v = result.x = M[0]*vx + M[4]*vy + M[8]*vz  (w=0 dir).
      const vm  = viewMatrix as Float32Array;
      const sdY = Math.sin(sunAngle);
      const sdZ = -Math.cos(sunAngle);
      const svx = vm[4] * sdY + vm[8]  * sdZ;
      const svy = vm[5] * sdY + vm[9]  * sdZ;
      const svz = vm[6] * sdY + vm[10] * sdZ;
      const svLen = Math.sqrt(svx*svx + svy*svy + svz*svz) || 1;

      // ── GFrameUBO write ───────────────────────────────────────────────
      gframeUBOData.set(viewMatrix,   0);   // view         [0..15]
      gframeUBOData.set(projMatrixZO, 16);  // projection   [16..31]
      gframeUBOData.set(viewInv,      32);  // viewInv      [32..47]
      gframeUBOData.set(projInv,      48);  // projInv      [48..63]
      gframeUBOData[64] = svx/svLen; gframeUBOData[65] = svy/svLen; gframeUBOData[66] = svz/svLen;
      gframeUBOData[67] = sunStr;                                         // sunDirStrength.w
      gframeUBOData[68] = 1.0; gframeUBOData[69] = 0.97; gframeUBOData[70] = 0.9; gframeUBOData[71] = 0; // sunColor
      gframeUBOData[72] = ambR; gframeUBOData[73] = ambG; gframeUBOData[74] = ambB;
      gframeUBOData[75] = 1.0;                                             // ambientColor.w (already scaled)
      gframeUBOData[76] = skyR; gframeUBOData[77] = skyG; gframeUBOData[78] = skyB;
      gframeUBOData[79] = 40.0;                                            // fogNear
      gframeUBOData[80] = 80.0;                                            // fogFar
      // indices 81-83 stay 0 (padding)
      device.queue.writeBuffer(gframeUBO, 0, gframeUBOData);

      // ── Outline UBO write ─────────────────────────────────────────────
      const hit = raycast(camera.position, camera.getForward(), world);
      if (hit) { lastHit = hit; outlineAlpha = 1.0; }
      else outlineAlpha = Math.max(0.0, outlineAlpha - Time.deltaTime * OUTLINE_FADE);

      const showOutline = outlineAlpha > 0.0 && lastHit !== null;
      if (showOutline && lastHit) {
        mat4.identity(scratchMat);
        mat4.translate(scratchMat, scratchMat, [lastHit.bx, lastHit.by, lastHit.bz]);
        outlineUBOData.set(scratchMat, 0);
        outlineUBOData[16] = outlineAlpha;
        device.queue.writeBuffer(outlineUBO, 0, outlineUBOData);
      }

      // ── Render targets ────────────────────────────────────────────────
      const canvasTex  = context.getCurrentTexture();
      const canvasView = canvasTex.createView();
      // Deferred + outline write to HDR tex (HDR path) or canvas (LDR path).
      const colorView  = (wantHdr && hdrTex) ? hdrTex.createView() : canvasView;

      // ── Command encoding ──────────────────────────────────────────────
      const encoder = device.createCommandEncoder({ label: "frame" });

      // ── Pass 1: GBuffer terrain ───────────────────────────────────────
      const gbufPass = encoder.beginRenderPass({
        label: "gbuffer",
        colorAttachments: [
          { view: gbuf0Tex!.createView(), loadOp: "clear", storeOp: "store", clearValue: { r:0,g:0,b:0,a:0 } },
          { view: gbuf1Tex!.createView(), loadOp: "clear", storeOp: "store", clearValue: { r:0,g:0,b:0,a:0 } },
          { view: gbuf2Tex!.createView(), loadOp: "clear", storeOp: "store", clearValue: { r:0,g:0,b:0,a:0 } },
        ],
        depthStencilAttachment: {
          view: gbufDepthTex!.createView(),
          depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1.0,
        },
      });

      gbufPass.setPipeline(gbufPipeline);
      gbufPass.setBindGroup(0, gbufFrameBindGroup);

      let drawCalls = 0, drawnVerts = 0, totalVerts = 0;
      world.chunks.forEach((c) => { totalVerts += chunkData.get(c)?.vertexCount ?? 0; });

      world.chunks.forEach((chunk) => {
        const cd = chunkData.get(chunk);
        if (!cd || cd.vertexCount === 0) return;

        const wx0 = chunk.cx * CHUNK_SIZE, wz0 = chunk.cz * CHUNK_SIZE;
        if (!frustum.containsAABB(wx0, 0, wz0, wx0 + CHUNK_SIZE, CHUNK_SIZE, wz0 + CHUNK_SIZE))
          return;

        drawCalls++;
        drawnVerts += cd.vertexCount;
        gbufPass.setBindGroup(1, cd.bindGroup);
        gbufPass.setVertexBuffer(0, cd.posBuffer);
        gbufPass.setVertexBuffer(1, cd.uvlBuffer);
        gbufPass.setVertexBuffer(2, cd.norBuffer);
        gbufPass.setVertexBuffer(3, cd.tanBuffer);
        gbufPass.draw(cd.vertexCount);
      });
      gbufPass.end();

      // ── Pass 2: Deferred lighting ─────────────────────────────────────
      const lightPass = encoder.beginRenderPass({
        label: "deferred",
        colorAttachments: [{
          view: colorView, loadOp: "clear", storeOp: "store",
          clearValue: { r: skyR, g: skyG, b: skyB, a: 1.0 },
        }],
      });
      lightPass.setPipeline(deferredPipeline);
      lightPass.setBindGroup(0, deferredBindGroup!);
      lightPass.draw(3);
      lightPass.end();

      // ── Pass 3: Block-selection wireframe (optional) ──────────────────
      // Renders on top of the lit scene using GBuffer depth for occlusion.
      if (showOutline) {
        const outlinePass = encoder.beginRenderPass({
          label: "outline",
          colorAttachments: [{
            view: colorView, loadOp: "load", storeOp: "store",
          }],
          depthStencilAttachment: {
            view: gbufDepthTex!.createView(),
            depthLoadOp: "load", depthStoreOp: "discard",
          },
        });
        outlinePass.setPipeline(outlinePipeline);
        outlinePass.setBindGroup(0, outlineFrameBindGroup);
        outlinePass.setBindGroup(1, outlineChunkBindGroup);
        outlinePass.setVertexBuffer(0, wireCubeBuf);
        outlinePass.draw(WIRE_CUBE_VCOUNT);
        outlinePass.end();
      }

      // ── Pass 4: Tonemap blit (HDR path only) ──────────────────────────
      if (wantHdr && tonemapBindGroup) {
        tonemapUBOData[0] = Settings.brightness;
        device.queue.writeBuffer(tonemapUBO, 0, tonemapUBOData);

        const tonemapPass = encoder.beginRenderPass({
          label: "tonemap",
          colorAttachments: [{
            view: canvasView, loadOp: "clear", storeOp: "store",
            clearValue: { r:0, g:0, b:0, a:1 },
          }],
        });
        tonemapPass.setPipeline(tonemapPipeline);
        tonemapPass.setBindGroup(0, tonemapBindGroup);
        tonemapPass.draw(3);
        tonemapPass.end();
      }

      device.queue.submit([encoder.finish()]);

      // ── Debug overlay ─────────────────────────────────────────────────
      debug.update(camera, world, {
        drawCalls,
        totalChunks:   world.chunks.size,
        drawnVertices: drawnVerts,
        totalVertices: totalVerts,
        worldTime:     Time.worldTime,
      });
    }

    frame();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function reportShaderErrors(name: string) {
  return ({ messages }: GPUCompilationInfo): void => {
    for (const m of messages) {
      if (m.type === "error") {
        console.error(`[WGSL ${name}] ${m.message} (line ${m.lineNum}:${m.linePos})`);
      } else if (m.type === "warning") {
        console.warn(`[WGSL ${name}] ${m.message}`);
      }
    }
  };
}
