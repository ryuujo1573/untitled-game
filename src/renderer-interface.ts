/**
 * IRenderer — thin abstraction that lets main.ts pick between
 * the WebGL2 and WebGPU backends without coupling to either.
 *
 * Both backends are self-contained: they own the game loop, camera,
 * world, physics, and input.  The only surface is `start()`.
 */
export interface IRenderer {
  /** Initialise GPU resources and begin the RAF render loop. */
  start(): Promise<void>;
}
