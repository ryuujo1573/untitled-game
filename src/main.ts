import { startSessionOrchestrator } from "~/logic/session/orchestrator";

async function main() {
  const canvas = document.getElementById(
    "gameCanvas",
  ) as HTMLCanvasElement | null;
  if (!canvas) {
    document.body.textContent = "⚠️ Canvas element not found.";
    return;
  }
  startSessionOrchestrator(canvas);
}

main();
