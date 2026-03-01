import { Settings } from "./settings";

/**
 * Manages the ESC pause overlay and the inline Settings sub-panel.
 *
 * The overlay is always present in the DOM (index.html); this class just
 * toggles CSS classes and wires the buttons.
 *
 * Usage in renderer.ts:
 *   const pause = new PauseMenu(() => canvas.requestPointerLock());
 */
export class PauseMenu {
  private overlay = document.getElementById("pause-overlay")!;
  private pausePanel = document.getElementById("pause-panel")!;
  private settingsPanel = document.getElementById("settings-panel")!;
  private brightnessSlider = document.getElementById(
    "brightness-slider",
  ) as HTMLInputElement;
  private brightnessValue = document.getElementById("brightness-value")!;

  /** Whether the game is currently paused. InputManager reads this. */
  paused = false;

  private readonly onResume: () => void;

  constructor(onResume: () => void) {
    this.onResume = onResume;

    // Sync slider with persisted setting on load.
    const pct = Math.round(Settings.brightness * 100);
    this.brightnessSlider.value = String(pct);
    this.brightnessValue.textContent = pct + "%";

    // ── Button wiring ───────────────────────────────────────────
    document
      .getElementById("btn-resume")!
      .addEventListener("click", () => this.resume());

    document.getElementById("btn-settings")!.addEventListener("click", () => {
      this.pausePanel.classList.add("hidden");
      this.settingsPanel.classList.remove("hidden");
      this.settingsPanel.classList.add("flex");
    });

    const backToMenu = (): void => {
      this.settingsPanel.classList.add("hidden");
      this.settingsPanel.classList.remove("flex");
      this.pausePanel.classList.remove("hidden");
    };
    document.getElementById("btn-back")!.addEventListener("click", backToMenu);
    document
      .getElementById("btn-settings-done")!
      .addEventListener("click", backToMenu);

    // Quit reloads the page (returns to the "click to play" state).
    document
      .getElementById("btn-quit")!
      .addEventListener("click", () => location.reload());

    // Live brightness update.
    this.brightnessSlider.addEventListener("input", () => {
      const v = Number(this.brightnessSlider.value);
      this.brightnessValue.textContent = v + "%";
      Settings.brightness = v / 100;
      Settings.save();
    });

    // Click on the dark backdrop (outside the card) resumes.
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.resume();
    });
  }

  toggle(): void {
    if (this.paused) this.resume();
    else this.pause();
  }

  pause(): void {
    this.paused = true;
    // Always return to the main pause panel when opening.
    this.settingsPanel.classList.add("hidden");
    this.settingsPanel.classList.remove("flex");
    this.pausePanel.classList.remove("hidden");
    // Show overlay.
    this.overlay.classList.remove("hidden");
    this.overlay.classList.add("active");
  }

  resume(): void {
    this.paused = false;
    this.overlay.classList.remove("active");
    this.overlay.classList.add("hidden");
    this.onResume();
  }
}
