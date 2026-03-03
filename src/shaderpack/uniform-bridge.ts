export interface IrisFrameUniformSnapshot {
  worldTime: number;
  worldDay: number;
  frameTimeCounter: number;
  frameTime: number;
  frameCounter: number;
  viewWidth: number;
  viewHeight: number;
  near: number;
  far: number;
  fogStart: number;
  fogEnd: number;
}

export function createIrisFrameUniformSnapshot(
  input: IrisFrameUniformSnapshot,
): IrisFrameUniformSnapshot {
  return {
    ...input,
    worldTime: Math.max(
      0,
      Math.min(23999, input.worldTime),
    ),
    near: Math.max(0.001, input.near),
    far: Math.max(input.near + 1, input.far),
  };
}
