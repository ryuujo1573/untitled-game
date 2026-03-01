import { initializeCanvas } from "./canvas";
import { EngineRenderer } from "./renderer";

function main() {
  const canvasId = "webglCanvas";
  const gl = initializeCanvas(canvasId);

  if (!gl) {
    document.body.textContent = "⚠️ WebGL is not supported by your browser.";
    return;
  }

  EngineRenderer(gl).catch((err) => {
    console.error("Failed to start renderer:", err);
    document.body.textContent =
      "⚠️ Failed to load textures. Check the console.";
  });
}

main();
