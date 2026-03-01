import Time from "./time-manager";
import { mat4 } from "gl-matrix";
import ShaderUtilites from "./renderer-utils";
import Materials from "./shader-materials";
import { Camera } from "./camera";
import { InputManager } from "./input";
import { Physics } from "./physics";
import { World } from "./world/world";
import { Chunk, CHUNK_SIZE } from "./world/chunk";
import { DebugOverlay } from "./debug";

/**
 * Procedurally generates a 64×16 pixel texture atlas using Canvas 2D.
 * Tile layout (each tile is 16×16 px, left to right):
 *   0 = grass_top  1 = grass_side  2 = dirt  3 = stone
 */
function createAtlasTexture(gl: WebGLRenderingContext): WebGLTexture | null {
  const TILE = 16;
  const atlas = document.createElement("canvas");
  atlas.width = TILE * 4;
  atlas.height = TILE;
  const ctx = atlas.getContext("2d")!;

  // Deterministic per-pixel noise so tiles look the same every run.
  function hash(x: number, y: number, seed: number): number {
    let h = (x * 374761 + y * 1390531 + seed * 72619) | 0;
    h = (h ^ (h >> 13)) | 0;
    h = ((h * 1274126177) | 0) ^ (h >> 16);
    return (h & 0xff) / 255;
  }

  function drawTile(
    col: number,
    base: [number, number, number],
    dark: [number, number, number],
    light: [number, number, number],
    seed: number,
  ) {
    for (let py = 0; py < TILE; py++) {
      for (let px = 0; px < TILE; px++) {
        const n = hash(px, py, seed);
        const [r, g, b] = n < 0.2 ? dark : n > 0.8 ? light : base;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(col * TILE + px, py, 1, 1);
      }
    }
  }

  // Tile 0: Grass top
  drawTile(0, [90, 158, 47], [70, 128, 30], [110, 178, 60], 0);

  // Tile 1: Grass side — dirt body with green top strip
  drawTile(1, [134, 96, 60], [114, 76, 44], [154, 116, 76], 2);
  for (let py = 0; py < 3; py++) {
    for (let px = 0; px < TILE; px++) {
      ctx.fillStyle =
        hash(px, py, 99) < 0.4 ? "rgb(70,128,30)" : "rgb(90,158,47)";
      ctx.fillRect(TILE + px, py, 1, 1);
    }
  }

  // Tile 2: Dirt
  drawTile(2, [134, 96, 60], [114, 76, 44], [154, 116, 76], 2);

  // Tile 3: Stone
  drawTile(3, [136, 136, 136], [116, 116, 116], [156, 156, 160], 3);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // Flip Y so canvas row 0 (top) maps to UV v=1 (world top of face).
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/**
 * Uploads a chunk's mesh to GPU buffers so it can be drawn each frame.
 */
function uploadChunk(gl: WebGLRenderingContext, chunk: Chunk): void {
  const mesh = chunk.buildMesh();
  chunk.vertexCount = mesh.vertexCount;

  if (chunk.vertexCount === 0) return;

  // Position buffer
  chunk.posBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, chunk.posBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);

  // UV + light buffer
  chunk.uvBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, chunk.uvBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.uvls, gl.STATIC_DRAW);
}

/**
 * Rebuilds and re-uploads the GPU buffers for the chunk that contains (wx,_,wz).
 * Call this after placing or breaking a block.
 */
function rebuildChunk(
  gl: WebGLRenderingContext,
  world: World,
  wx: number,
  _wy: number,
  wz: number,
): void {
  const cx = Math.floor(wx / CHUNK_SIZE);
  const cz = Math.floor(wz / CHUNK_SIZE);
  const chunk = world.getChunk(cx, cz);
  if (!chunk) return;
  // Delete old buffers.
  if (chunk.posBuffer) gl.deleteBuffer(chunk.posBuffer);
  if (chunk.uvBuffer) gl.deleteBuffer(chunk.uvBuffer);
  chunk.posBuffer = null;
  chunk.uvBuffer = null;
  uploadChunk(gl, chunk);
}

function EngineRenderer(gl: WebGLRenderingContext) {
  // ── Render state ────────────────────────────────────────
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  gl.clearColor(0.53, 0.81, 0.92, 1.0); // sky blue
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.frontFace(gl.CCW);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);

  // ── Shader ──────────────────────────────────────────────
  const program = ShaderUtilites.CreateShaderMaterial(
    gl,
    Materials.Voxel.vertexShader,
    Materials.Voxel.fragmentShader,
  );
  if (!program) {
    console.error("Failed to compile voxel shader");
    return;
  }
  gl.useProgram(program);

  const aPosition = gl.getAttribLocation(program, "a_position");
  const aUVL = gl.getAttribLocation(program, "a_uvl");
  const uModel = gl.getUniformLocation(program, "u_modelMatrix");
  const uView = gl.getUniformLocation(program, "u_viewMatrix");
  const uProj = gl.getUniformLocation(program, "u_projectionMatrix");
  const uAtlas = gl.getUniformLocation(program, "u_atlas");

  // Create the atlas texture and bind it permanently to TEXTURE0.
  const atlasTexture = createAtlasTexture(gl);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
  gl.uniform1i(uAtlas, 0);

  // ── Camera & input ──────────────────────────────────────
  const canvas = gl.canvas as HTMLCanvasElement;
  const camera = new Camera();
  const world = new World();
  world.generate(4); // 4×4 chunks = 64×64 blocks

  const physics = new Physics(camera, world);
  const input = new InputManager(canvas, camera, physics, world, (wx, wy, wz) =>
    rebuildChunk(gl, world, wx, wy, wz),
  );
  const debug = new DebugOverlay();

  // Upload all chunk meshes
  world.chunks.forEach((chunk) => uploadChunk(gl, chunk));

  // ── Resize handler ──────────────────────────────────────
  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  window.addEventListener("resize", resize);
  resize();

  // ── Render loop ─────────────────────────────────────────
  const modelMatrix = mat4.create();

  function frame() {
    requestAnimationFrame(frame);
    Time.CalculateTimeVariables();
    input.update();
    debug.update(camera, world);

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);

    // Camera matrices
    const aspect = canvas.width / canvas.height;
    gl.uniformMatrix4fv(uView, false, camera.getViewMatrix());
    gl.uniformMatrix4fv(uProj, false, camera.getProjectionMatrix(aspect));

    // Ensure the atlas is still bound (safe to call every frame).
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTexture);

    // Draw each chunk
    world.chunks.forEach((chunk) => {
      if (chunk.vertexCount === 0 || !chunk.posBuffer || !chunk.uvBuffer)
        return;

      // Model matrix = translate to chunk world position
      mat4.identity(modelMatrix);
      mat4.translate(modelMatrix, modelMatrix, [
        chunk.cx * CHUNK_SIZE,
        0,
        chunk.cz * CHUNK_SIZE,
      ]);
      gl.uniformMatrix4fv(uModel, false, modelMatrix);

      // Bind position attribute
      gl.enableVertexAttribArray(aPosition);
      gl.bindBuffer(gl.ARRAY_BUFFER, chunk.posBuffer);
      gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);

      // Bind UV + light attribute
      gl.enableVertexAttribArray(aUVL);
      gl.bindBuffer(gl.ARRAY_BUFFER, chunk.uvBuffer);
      gl.vertexAttribPointer(aUVL, 3, gl.FLOAT, false, 0, 0);

      gl.drawArrays(gl.TRIANGLES, 0, chunk.vertexCount);
    });
  }

  frame();
}

export { EngineRenderer };
