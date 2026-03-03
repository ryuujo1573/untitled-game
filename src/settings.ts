/**
 * Persistent game settings.
 *
 * Values are stored in localStorage so they survive page reloads.
 * All consumers should read from Settings.* directly; mutations call
 * Settings.save() automatically.
 */
export const Settings = {
  /** Baseline brightness multiplier applied on top of the day-night ambient.
   *  Range [0, 2].  1.0 = no adjustment, 0 = pitch black, 2 = fully lit. */
  brightness: 1.0,

  /** Whether HDR rendering is enabled (float16 FBO + ACES tonemapping).
   *  Only meaningful when hdrSupported is true. */
  hdr: false,

  /** Set once at startup by the renderer.  Never persisted.
   *  True when EXT_color_buffer_float is available in WebGL2. */
  hdrSupported: false,

  /** Load persisted values from localStorage, if present. */
  load(): void {
    const raw = localStorage.getItem("voxer_settings");
    if (!raw) return;
    try {
      const obj = JSON.parse(raw) as Partial<
        typeof Settings
      >;
      if (typeof obj.brightness === "number")
        this.brightness = Math.max(
          0,
          Math.min(2, obj.brightness),
        );
      if (typeof obj.hdr === "boolean") this.hdr = obj.hdr;
    } catch {
      // Ignore corrupt data.
    }
  },

  save(): void {
    localStorage.setItem(
      "voxer_settings",
      JSON.stringify({
        brightness: this.brightness,
        hdr: this.hdr,
      }),
    );
  },
};

Settings.load();
