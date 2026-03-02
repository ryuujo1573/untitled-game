/**
 * WebGPU rendering backend.
 *
 * Implements the same game loop as the WebGL2 renderer (world, camera,
 * physics, input, debug overlay) but replaces all gl.* calls with the
 * WebGPU API.
 *
 * Bind group layout:
 *   Group 0 — per-frame:  FrameUniforms UBO + atlas texture + atlas sampler
 *   Group 1 — per-draw:   ChunkUniforms UBO (voxel) | OutlineUniforms UBO (outline)
 *
 * The three render pipelines share the same Group 0 layout so the same
 * frameBindGroup is reused without rebinding between passes.
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
import { buildAtlasCanvas } from "../atlas";
import { raycast, type RayHit } from "../raycaster";
import { Settings } from "../settings";
import { PauseMenu } from "../pause-menu.tsx";
import Time from "../time-manager";

import voxelWGSL   from "./shaders/voxel.wgsl?raw";
import outlineWGSL from "./shaders/outline.wgsl?raw";
import tonemapWGSL from "./shaders/tonemap.wgsl?raw";

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
  modelBuffer: GPUBuffer;
  bindGroup:   GPUBindGroup; // group 1 for voxel pipeline
  vertexCount: number;
}

// ── FrameUBO layout (160 bytes) ────────────────────────────────────────────
// Matches the FrameUniforms struct in voxel.wgsl and outline.wgsl.
// Float32 indices (4 bytes each):
//  [0..15]  view matrix
//  [16..31] projection matrix
//  [32..34] ambient (vec3f)
//  [35]     fogNear (f32)   — sits at byte 140 with no hidden padding
//  [36..38] fogColor (vec3f)
//  [39]     fogFar (f32)
const FRAME_UBO_SIZE   = 160;
const FRAME_UBO_FLOATS = 40;

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
    const voxelModule   = device.createShaderModule({ label: "voxel",   code: voxelWGSL   });
    const outlineModule = device.createShaderModule({ label: "outline", code: outlineWGSL });
    const tonemapModule = device.createShaderModule({ label: "tonemap", code: tonemapWGSL });

    // Emit compilation errors to console early.
    await Promise.all([
      voxelModule.getCompilationInfo().then(reportShaderErrors("voxel")),
      outlineModule.getCompilationInfo().then(reportShaderErrors("outline")),
      tonemapModule.getCompilationInfo().then(reportShaderErrors("tonemap")),
    ]);

    // ── 4. Bind group layouts ─────────────────────────────────────────────
    // Group 0 — per-frame data (shared by voxel + outline pipelines)
    const frameLayout = device.createBindGroupLayout({
      label: "frame",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform", minBindingSize: FRAME_UBO_SIZE } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" } },
      ],
    });

    // Group 1 — per-chunk model matrix (voxel pipeline)
    const voxelChunkLayout = device.createBindGroupLayout({
      label: "voxelChunk",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform", minBindingSize: 64 } },
      ],
    });

    // Group 1 — outline model + alpha (outline pipeline)
    const outlineChunkLayout = device.createBindGroupLayout({
      label: "outlineChunk",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform", minBindingSize: OUTLINE_UBO_SIZE } },
      ],
    });

    // Group 0 — HDR texture + sampler + exposure (tonemap pipeline)
    const tonemapLayout = device.createBindGroupLayout({
      label: "tonemap",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform", minBindingSize: TONEMAP_UBO_SIZE } },
      ],
    });

    // ── 5. Pipeline factories ─────────────────────────────────────────────
    // Pipelines must be recreated when the render-target format changes
    // (LDR → presentationFormat, HDR → rgba16float).

    const voxelPipelineLayout   = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, voxelChunkLayout]   });
    const outlinePipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, outlineChunkLayout] });
    const tonemapPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [tonemapLayout] });

    const buildVoxelPipeline = (colorFmt: GPUTextureFormat): GPURenderPipeline =>
      device.createRenderPipeline({
        label: "voxel",
        layout: voxelPipelineLayout,
        vertex: {
          module: voxelModule, entryPoint: "vs_main",
          buffers: [
            // slot 0: positions (vec3f, 12 bytes stride)
            { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
            // slot 1: uvl (vec4f, 16 bytes stride)
            { arrayStride: 16, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x4" }] },
          ],
        },
        fragment: {
          module: voxelModule, entryPoint: "fs_main",
          targets: [{ format: colorFmt }],
        },
        primitive:    { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
        depthStencil: { format: "depth24plus", depthCompare: "less-equal", depthWriteEnabled: true },
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

    // ── 6. Atlas texture ─────────────────────────────────────────────────
    const atlasCanvas = await buildAtlasCanvas();
    const atlasTex = device.createTexture({
      label: "atlas",
      size: { width: atlasCanvas.width, height: atlasCanvas.height },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    // flipY: true replicates WebGL's UNPACK_FLIP_Y, keeping V=0 at the bottom of each tile.
    device.queue.copyExternalImageToTexture(
      { source: atlasCanvas, flipY: true },
      { texture: atlasTex },
      { width: atlasCanvas.width, height: atlasCanvas.height },
    );
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
    const frameUBO     = device.createBuffer({ label: "frameUBO",   size: FRAME_UBO_SIZE,   usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const frameUBOData = new Float32Array(FRAME_UBO_FLOATS);

    const outlineUBO     = device.createBuffer({ label: "outlineUBO", size: OUTLINE_UBO_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const outlineUBOData = new Float32Array(OUTLINE_UBO_FLOATS);

    const tonemapUBO     = device.createBuffer({ label: "tonemapUBO", size: TONEMAP_UBO_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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

    // ── 8. Mutable pipeline/texture state (rebuilt on HDR toggle or resize) ─
    let hdrActive       = false;
    let hdrTex:         GPUTexture | null = null;
    let hdrDepthTex:    GPUTexture | null = null;
    let depthTex:       GPUTexture | null = null;

    let voxelPipeline:    GPURenderPipeline = buildVoxelPipeline(presentationFormat);
    let outlinePipeline:  GPURenderPipeline = buildOutlinePipeline(presentationFormat);

    let frameBindGroup:       GPUBindGroup = mkFrameBindGroup(atlasTex.createView());
    let outlineChunkBindGroup: GPUBindGroup = mkOutlineChunkBindGroup();
    let tonemapBindGroup:     GPUBindGroup | null = null;

    // ── Per-chunk data store ──────────────────────────────────────────────
    const chunkData = new Map<Chunk, ChunkGPUData>();

    // ── Bind group helpers ────────────────────────────────────────────────
    function mkFrameBindGroup(atlasView: GPUTextureView): GPUBindGroup {
      return device.createBindGroup({
        label: "frame",
        layout: frameLayout,
        entries: [
          { binding: 0, resource: { buffer: frameUBO } },
          { binding: 1, resource: atlasView },
          { binding: 2, resource: atlasSampler },
        ],
      });
    }

    function mkOutlineChunkBindGroup(): GPUBindGroup {
      return device.createBindGroup({
        label: "outlineChunk",
        layout: outlineChunkLayout,
        entries: [{ binding: 0, resource: { buffer: outlineUBO } }],
      });
    }

    // ── HDR lifecycle ─────────────────────────────────────────────────────
    function buildHDR(w: number, h: number): void {
      hdrTex?.destroy();
      hdrDepthTex?.destroy();
      hdrTex = device.createTexture({
        label: "hdrColor", size: { width: w, height: h },
        format: "rgba16float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      hdrDepthTex = device.createTexture({
        label: "hdrDepth", size: { width: w, height: h },
        format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
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
      voxelPipeline   = buildVoxelPipeline("rgba16float");
      outlinePipeline = buildOutlinePipeline("rgba16float");
      hdrActive = true;
    }

    function destroyHDR(): void {
      hdrTex?.destroy();      hdrTex = null;
      hdrDepthTex?.destroy(); hdrDepthTex = null;
      tonemapBindGroup = null;
      voxelPipeline   = buildVoxelPipeline(presentationFormat);
      outlinePipeline = buildOutlinePipeline(presentationFormat);
      hdrActive = false;
    }

    function buildDepth(w: number, h: number): void {
      depthTex?.destroy();
      depthTex = device.createTexture({
        label: "sceneDepth", size: { width: w, height: h },
        format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }

    // ── Chunk GPU data management ─────────────────────────────────────────
    function uploadChunk(chunk: Chunk): void {
      // Destroy old buffers if re-uploading (block edit).
      const old = chunkData.get(chunk);
      if (old) {
        old.posBuffer.destroy();
        old.uvlBuffer.destroy();
        old.modelBuffer.destroy();
        chunkData.delete(chunk);
      }

      const mesh = chunk.buildMesh();
      if (mesh.vertexCount === 0) return;

      const posBuffer = device.createBuffer({
        label: `pos(${chunk.cx},${chunk.cz})`,
        size: mesh.positions.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Float32Array(posBuffer.getMappedRange()).set(mesh.positions);
      posBuffer.unmap();

      const uvlBuffer = device.createBuffer({
        label: `uvl(${chunk.cx},${chunk.cz})`,
        size: mesh.uvls.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Float32Array(uvlBuffer.getMappedRange()).set(mesh.uvls);
      uvlBuffer.unmap();

      // Model matrix = translation to world-space chunk origin.
      // Constant for the chunk's lifetime — written once.
      const modelMat = mat4.create();
      mat4.translate(modelMat, modelMat, [chunk.cx * CHUNK_SIZE, 0, chunk.cz * CHUNK_SIZE]);

      const modelBuffer = device.createBuffer({
        label: `model(${chunk.cx},${chunk.cz})`,
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Float32Array(modelBuffer.getMappedRange()).set(modelMat);
      modelBuffer.unmap();

      const bindGroup = device.createBindGroup({
        label: `chunkBG(${chunk.cx},${chunk.cz})`,
        layout: voxelChunkLayout,
        entries: [{ binding: 0, resource: { buffer: modelBuffer } }],
      });

      chunkData.set(chunk, { posBuffer, uvlBuffer, modelBuffer, bindGroup, vertexCount: mesh.vertexCount });
    }

    function rebuildChunk(wx: number, _wy: number, wz: number): void {
      const chunk = world.getChunk(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE));
      if (chunk) uploadChunk(chunk);
    }

    // ── Resize ────────────────────────────────────────────────────────────
    function resize(): void {
      canvas.width  = window.innerWidth;
      canvas.height = window.innerHeight;
      buildDepth(canvas.width, canvas.height);
      if (hdrActive) buildHDR(canvas.width, canvas.height);
    }
    window.addEventListener("resize", resize);
    resize();

    // ── Game objects ──────────────────────────────────────────────────────
    const camera   = new Camera();
    const world    = new World();
    world.generate(4); // 4×4 chunks

    const physics   = new Physics(camera, world);
    const pauseMenu = new PauseMenu(() => canvas.requestPointerLock());
    pauseMenu.mount(document.getElementById("pause-root")!);

    // DebugOverlay accepts null for the GL context (WebGPU path skips GL queries).
    const debug = new DebugOverlay(null);

    const input = new InputManager(canvas, camera, physics, world, rebuildChunk, pauseMenu);

    world.chunks.forEach((chunk) => uploadChunk(chunk));

    // ── Outline state ─────────────────────────────────────────────────────
    let lastHit: RayHit | null = null;
    let outlineAlpha = 0.0;
    const OUTLINE_FADE = 5.0;

    // Scratch mat4 to avoid per-frame allocations in hot path.
    const scratchMat = mat4.create();
    const frustum    = new Frustum();
    const vpMatrix   = mat4.create();

    // ── Render loop ───────────────────────────────────────────────────────
    function frame(): void {
      requestAnimationFrame(frame);
      Time.CalculateTimeVariables();
      input.update();

      const wantHdr = Settings.hdr && Settings.hdrSupported;
      if (wantHdr && !hdrActive)  buildHDR(canvas.width, canvas.height);
      else if (!wantHdr && hdrActive) destroyHDR();

      // ── Day-night lighting (identical math to WebGL renderer) ─────────
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

      // ── Camera matrices ───────────────────────────────────────────────
      const aspect     = canvas.width / canvas.height;
      const viewMatrix = camera.getViewMatrix();
      const projMatrix = camera.getProjectionMatrix(aspect);
      mat4.multiply(vpMatrix, projMatrix, viewMatrix);
      frustum.update(vpMatrix);

      // ── FrameUBO write ────────────────────────────────────────────────
      // Indices match the FrameUniforms WGSL struct layout (see top of file).
      frameUBOData.set(viewMatrix, 0);
      frameUBOData.set(projMatrix, 16);
      frameUBOData[32] = ambR; frameUBOData[33] = ambG; frameUBOData[34] = ambB;
      frameUBOData[35] = 40.0;  // fogNear
      frameUBOData[36] = skyR;  frameUBOData[37] = skyG; frameUBOData[38] = skyB;
      frameUBOData[39] = 80.0;  // fogFar
      device.queue.writeBuffer(frameUBO, 0, frameUBOData);

      // ── Outline ray + UBO write ───────────────────────────────────────
      const hit = raycast(camera.position, camera.getForward(), world);
      if (hit) { lastHit = hit; outlineAlpha = 1.0; }
      else outlineAlpha = Math.max(0.0, outlineAlpha - Time.deltaTime * OUTLINE_FADE);

      const showOutline = outlineAlpha > 0.0 && lastHit !== null;
      if (showOutline && lastHit) {
        mat4.identity(scratchMat);
        mat4.translate(scratchMat, scratchMat, [lastHit.bx, lastHit.by, lastHit.bz]);
        outlineUBOData.set(scratchMat, 0); // model @ floats 0-15
        outlineUBOData[16] = outlineAlpha;  // alpha @ float 16 = byte 64
        device.queue.writeBuffer(outlineUBO, 0, outlineUBOData);
      }

      // ── Render target selection ───────────────────────────────────────
      // HDR path: world → rgba16float HDR tex → tonemap → canvas
      // LDR path: world → canvas directly
      const canvasTex    = context.getCurrentTexture();
      const canvasView   = canvasTex.createView();
      const colorView    = (wantHdr && hdrTex)      ? hdrTex.createView()      : canvasView;
      const depthView    = (wantHdr && hdrDepthTex) ? hdrDepthTex.createView() : depthTex!.createView();

      // ── Command encoding ──────────────────────────────────────────────
      const encoder = device.createCommandEncoder({ label: "frame" });

      // ── Pass 1: world geometry + block outline ────────────────────────
      const worldPass = encoder.beginRenderPass({
        label: "world",
        colorAttachments: [{
          view:       colorView,
          loadOp:     "clear",
          storeOp:    "store",
          clearValue: { r: skyR, g: skyG, b: skyB, a: 1.0 },
        }],
        depthStencilAttachment: {
          view:             depthView,
          depthLoadOp:      "clear",
          depthStoreOp:     "store",
          depthClearValue:  1.0,
        },
      });

      // Voxel terrain
      worldPass.setPipeline(voxelPipeline);
      worldPass.setBindGroup(0, frameBindGroup);

      let drawCalls = 0, drawnVerts = 0, totalVerts = 0;
      world.chunks.forEach((c) => { totalVerts += chunkData.get(c)?.vertexCount ?? 0; });

      world.chunks.forEach((chunk) => {
        const cd = chunkData.get(chunk);
        if (!cd || cd.vertexCount === 0) return;

        const wx0 = chunk.cx * CHUNK_SIZE;
        const wz0 = chunk.cz * CHUNK_SIZE;
        if (!frustum.containsAABB(wx0, 0, wz0, wx0 + CHUNK_SIZE, CHUNK_SIZE, wz0 + CHUNK_SIZE))
          return;

        drawCalls++;
        worldPass.setBindGroup(1, cd.bindGroup);
        worldPass.setVertexBuffer(0, cd.posBuffer);
        worldPass.setVertexBuffer(1, cd.uvlBuffer);
        worldPass.draw(cd.vertexCount);
        drawnVerts += cd.vertexCount;
      });

      // Block-selection wireframe outline (same render pass, different pipeline)
      if (showOutline) {
        worldPass.setPipeline(outlinePipeline);
        worldPass.setBindGroup(0, frameBindGroup);
        worldPass.setBindGroup(1, outlineChunkBindGroup);
        worldPass.setVertexBuffer(0, wireCubeBuf);
        worldPass.draw(WIRE_CUBE_VCOUNT);
      }

      worldPass.end();

      // ── Pass 2: HDR tonemapping blit ──────────────────────────────────
      if (wantHdr && tonemapBindGroup) {
        tonemapUBOData[0] = Settings.brightness;
        device.queue.writeBuffer(tonemapUBO, 0, tonemapUBOData);

        const tonemapPass = encoder.beginRenderPass({
          label: "tonemap",
          colorAttachments: [{
            view:       canvasView,
            loadOp:     "clear",
            storeOp:    "store",
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          }],
        });
        tonemapPass.setPipeline(tonemapPipeline);
        tonemapPass.setBindGroup(0, tonemapBindGroup);
        tonemapPass.draw(3); // fullscreen triangle via vertex_index
        tonemapPass.end();
      }

      device.queue.submit([encoder.finish()]);

      // ── Debug overlay (DOM-based, zero GPU calls) ─────────────────────
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
