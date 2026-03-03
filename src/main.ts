import { startSessionOrchestrator } from "./app/session-orchestrator";

async function main() {
  const canvas = document.getElementById(
    "webglCanvas",
  ) as HTMLCanvasElement | null;
  if (!canvas) {
    document.body.textContent =
      "⚠️ Canvas element not found.";
    return;
  }
  startSessionOrchestrator(canvas);
}

main();
