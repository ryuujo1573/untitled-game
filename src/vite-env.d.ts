/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />

// Allow importing .wgsl files as raw strings via Vite's ?raw suffix.
declare module "*.wgsl?raw" {
  const source: string;
  export default source;
}
