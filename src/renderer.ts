import Time from "./time-manager";
import { mat4 } from "gl-matrix";
import ShaderUtilites from "./renderer-utils";
import Materials from "./shader-materials";
import { Camera } from "./camera";
import { InputManager } from "./input";
import { World } from "./world/world";
import { Chunk, CHUNK_SIZE } from "./world/chunk";

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

  // Color buffer
  chunk.colBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, chunk.colBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.colors, gl.STATIC_DRAW);
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
  const aColor = gl.getAttribLocation(program, "a_color");
  const uModel = gl.getUniformLocation(program, "u_modelMatrix");
  const uView = gl.getUniformLocation(program, "u_viewMatrix");
  const uProj = gl.getUniformLocation(program, "u_projectionMatrix");

  // ── Camera & input ──────────────────────────────────────
  const canvas = gl.canvas as HTMLCanvasElement;
  const camera = new Camera();
  const input = new InputManager(canvas, camera);

  // ── World ───────────────────────────────────────────────
  const world = new World();
  world.generate(4); // 4×4 chunks = 64×64 blocks

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

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);

    // Camera matrices
    const aspect = canvas.width / canvas.height;
    gl.uniformMatrix4fv(uView, false, camera.getViewMatrix());
    gl.uniformMatrix4fv(uProj, false, camera.getProjectionMatrix(aspect));

    // Draw each chunk
    world.chunks.forEach((chunk) => {
      if (chunk.vertexCount === 0 || !chunk.posBuffer || !chunk.colBuffer)
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

      // Bind color attribute
      gl.enableVertexAttribArray(aColor);
      gl.bindBuffer(gl.ARRAY_BUFFER, chunk.colBuffer);
      gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);

      gl.drawArrays(gl.TRIANGLES, 0, chunk.vertexCount);
    });
  }

  frame();
}

export { EngineRenderer };
