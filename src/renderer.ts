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
import { Frustum } from "./frustum";
import { createAtlasTexture } from "./atlas";
import { raycast, RayHit } from "./raycaster";

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

/**
 * Builds a static GPU buffer containing the 12 edges (24 vertices) of a
 * unit cube slightly expanded by EPS on every side.  Used each frame to
 * draw the block-selection wireframe outline.
 */
function createWireCube(gl: WebGLRenderingContext): {
  buf: WebGLBuffer;
  count: number;
} {
  const e = 0.002;
  const lo = -e,
    hi = 1.0 + e;
  // prettier-ignore
  const v = new Float32Array([
    // Bottom face (y = lo)
    lo,lo,lo,  hi,lo,lo,
    hi,lo,lo,  hi,lo,hi,
    hi,lo,hi,  lo,lo,hi,
    lo,lo,hi,  lo,lo,lo,
    // Top face (y = hi)
    lo,hi,lo,  hi,hi,lo,
    hi,hi,lo,  hi,hi,hi,
    hi,hi,hi,  lo,hi,hi,
    lo,hi,hi,  lo,hi,lo,
    // Vertical edges
    lo,lo,lo,  lo,hi,lo,
    hi,lo,lo,  hi,hi,lo,
    hi,lo,hi,  hi,hi,hi,
    lo,lo,hi,  lo,hi,hi,
  ]);
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
  return { buf, count: v.length / 3 }; // 24
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
  const debug = new DebugOverlay(gl);

  // ── Block-selection outline ─────────────────────────────────
  const outlineProgram = ShaderUtilites.CreateShaderMaterial(
    gl,
    Materials.Outline.vertexShader,
    Materials.Outline.fragmentShader,
  );
  const aOutlinePos = outlineProgram
    ? gl.getAttribLocation(outlineProgram, "a_position")
    : -1;
  const uOutlineModel = outlineProgram
    ? gl.getUniformLocation(outlineProgram, "u_modelMatrix")
    : null;
  const uOutlineView = outlineProgram
    ? gl.getUniformLocation(outlineProgram, "u_viewMatrix")
    : null;
  const uOutlineProj = outlineProgram
    ? gl.getUniformLocation(outlineProgram, "u_projectionMatrix")
    : null;
  const uOutlineAlpha = outlineProgram
    ? gl.getUniformLocation(outlineProgram, "u_alpha")
    : null;
  const wireCube = createWireCube(gl);

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
  const vpMatrix = mat4.create();
  const frustum = new Frustum();

  // Outline fade state — persists across frames.
  let lastOutlineHit: RayHit | null = null;
  let outlineAlpha = 0.0;
  const OUTLINE_FADE_SPEED = 5.0; // alpha units per second → 0.2 s fade

  function frame() {
    requestAnimationFrame(frame);
    Time.CalculateTimeVariables();
    input.update();

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);

    // Camera matrices
    const aspect = canvas.width / canvas.height;
    const viewMatrix = camera.getViewMatrix();
    const projMatrix = camera.getProjectionMatrix(aspect);
    gl.uniformMatrix4fv(uView, false, viewMatrix);
    gl.uniformMatrix4fv(uProj, false, projMatrix);

    // Update frustum for this frame’s view-projection.
    mat4.multiply(vpMatrix, projMatrix, viewMatrix);
    frustum.update(vpMatrix);

    // Ensure the atlas is still bound (safe to call every frame).
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTexture);

    // Draw each chunk (frustum culled)
    let drawCalls = 0;
    let drawnVerts = 0;
    let totalVerts = 0;
    world.chunks.forEach((chunk) => {
      totalVerts += chunk.vertexCount;
    }); // pre-sum
    world.chunks.forEach((chunk) => {
      if (chunk.vertexCount === 0 || !chunk.posBuffer || !chunk.uvBuffer)
        return;

      // Frustum cull: skip chunks whose AABB is entirely outside the frustum.
      const wx0 = chunk.cx * CHUNK_SIZE;
      const wz0 = chunk.cz * CHUNK_SIZE;
      if (
        !frustum.containsAABB(
          wx0,
          0,
          wz0,
          wx0 + CHUNK_SIZE,
          CHUNK_SIZE,
          wz0 + CHUNK_SIZE,
        )
      )
        return;

      drawCalls++;

      // Model matrix = translate to chunk world position
      mat4.identity(modelMatrix);
      mat4.translate(modelMatrix, modelMatrix, [wx0, 0, wz0]);
      gl.uniformMatrix4fv(uModel, false, modelMatrix);

      // Bind position attribute
      gl.enableVertexAttribArray(aPosition);
      gl.bindBuffer(gl.ARRAY_BUFFER, chunk.posBuffer);
      gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);

      // Bind UV + light attribute (vec4: localU, localV, tileIndex, light)
      gl.enableVertexAttribArray(aUVL);
      gl.bindBuffer(gl.ARRAY_BUFFER, chunk.uvBuffer);
      gl.vertexAttribPointer(aUVL, 4, gl.FLOAT, false, 0, 0);

      gl.drawArrays(gl.TRIANGLES, 0, chunk.vertexCount);
      drawnVerts += chunk.vertexCount;
    });

    // ── Block-selection outline ──────────────────────────────
    if (outlineProgram && aOutlinePos >= 0) {
      const hit = raycast(camera.position, camera.getForward(), world);
      if (hit) {
        lastOutlineHit = hit;
        outlineAlpha = 1.0;
      } else {
        // No block in range: fade out from the last known position.
        outlineAlpha = Math.max(
          0.0,
          outlineAlpha - Time.deltaTime * OUTLINE_FADE_SPEED,
        );
      }

      if (outlineAlpha > 0.0 && lastOutlineHit) {
        mat4.identity(modelMatrix);
        mat4.translate(modelMatrix, modelMatrix, [
          lastOutlineHit.bx,
          lastOutlineHit.by,
          lastOutlineHit.bz,
        ]);

        gl.useProgram(outlineProgram);
        gl.uniformMatrix4fv(uOutlineModel, false, modelMatrix);
        gl.uniformMatrix4fv(uOutlineView, false, viewMatrix);
        gl.uniformMatrix4fv(uOutlineProj, false, projMatrix);
        gl.uniform1f(uOutlineAlpha, outlineAlpha);

        // Depth test stays ON so only edges on visible faces pass.
        // The wire cube is expanded by ε=0.002, placing lines fractionally
        // in front of block face depth → LEQUAL passes on visible faces,
        // fails on occluded ones.  CULL_FACE has no effect on gl.LINES.
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.enableVertexAttribArray(aOutlinePos);
        gl.bindBuffer(gl.ARRAY_BUFFER, wireCube.buf);
        gl.vertexAttribPointer(aOutlinePos, 3, gl.FLOAT, false, 0, 0);
        gl.lineWidth(2.0); // capped at 1 on most WebGL backends, still a hint
        gl.drawArrays(gl.LINES, 0, wireCube.count);
        gl.disableVertexAttribArray(aOutlinePos);

        gl.disable(gl.BLEND);
      }
    }

    debug.update(camera, world, {
      drawCalls,
      totalChunks: world.chunks.size,
      drawnVertices: drawnVerts,
      totalVertices: totalVerts,
    });
  }

  frame();
}

export { EngineRenderer };
