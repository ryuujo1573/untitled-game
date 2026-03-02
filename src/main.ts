import { initializeCanvas } from "./canvas";
import { EngineRenderer } from "./renderer";
import { WebGPURenderer } from "./webgpu/renderer";

async function main() {
  const canvas = document.getElementById("webglCanvas") as HTMLCanvasElement | null;
  if (!canvas) {
    document.body.textContent = "⚠️ Canvas element not found.";
    return;
  }

  // Try WebGPU first — it is the preferred backend.
  if (typeof navigator !== "undefined" && navigator.gpu) {
    try {
      const renderer = new WebGPURenderer(canvas);
      await renderer.start();
      return;
    } catch (err) {
      console.warn("WebGPU initialisation failed, falling back to WebGL2:", err);
    }
  }

  // WebGL2 fallback — reuses the existing EngineRenderer.
  const gl = initializeCanvas("webglCanvas");
  if (!gl) {
    document.body.textContent = "⚠️ Neither WebGPU nor WebGL2 is supported by your browser.";
    return;
  }

  EngineRenderer(gl).catch((err) => {
    console.error("Failed to start renderer:", err);
    document.body.textContent = "⚠️ Failed to load textures. Check the console.";
  });
}

main();
