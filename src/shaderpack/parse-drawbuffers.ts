function uniqSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

export function parseDrawTargetsFromShaderSource(source: string): number[] | undefined {
  const rtMatch = source.match(/\/\*\s*RENDERTARGETS\s*:\s*([^*]+)\*\//i);
  if (rtMatch) {
    const parsed = rtMatch[1]
      .split(",")
      .map((x) => Number.parseInt(x.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 15);
    return parsed.length > 0 ? uniqSorted(parsed) : undefined;
  }

  const dbMatch = source.match(/\/\*\s*DRAWBUFFERS\s*:\s*([0-9]+)\s*\*\//i);
  if (dbMatch) {
    const parsed = dbMatch[1]
      .split("")
      .map((x) => Number.parseInt(x, 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 9);
    return parsed.length > 0 ? uniqSorted(parsed) : undefined;
  }

  return undefined;
}
