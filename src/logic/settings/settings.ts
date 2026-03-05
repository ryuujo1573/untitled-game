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

  message: {
    fadeOutAfterMs: 5000,
    topFadeStartRatio: 0.5,
  },

  chat: {
    areaHeightVh: 50,
    inputReservedPx: 44,
  },

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
      if (
        typeof obj.message === "object" &&
        obj.message !== null
      ) {
        const msg = obj.message as Partial<
          typeof Settings.message
        >;
        if (typeof msg.fadeOutAfterMs === "number")
          this.message.fadeOutAfterMs = Math.max(
            0,
            msg.fadeOutAfterMs,
          );
        if (typeof msg.topFadeStartRatio === "number")
          this.message.topFadeStartRatio = Math.max(
            0,
            Math.min(1, msg.topFadeStartRatio),
          );
      }
      if (
        typeof obj.chat === "object" &&
        obj.chat !== null
      ) {
        const chat = obj.chat as Partial<
          typeof Settings.chat
        >;
        if (typeof chat.areaHeightVh === "number")
          this.chat.areaHeightVh = Math.max(
            10,
            Math.min(100, chat.areaHeightVh),
          );
        if (typeof chat.inputReservedPx === "number")
          this.chat.inputReservedPx = Math.max(
            0,
            Math.min(200, chat.inputReservedPx),
          );
      }
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
        message: this.message,
        chat: this.chat,
      }),
    );
  },
};

Settings.load();
