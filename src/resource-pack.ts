import type { AtlasSourceManifest, AtlasTileName } from "./atlas";
import { ATLAS_TILE_NAMES } from "./atlas";

function trimTrailingSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function buildChannelUrl(baseUrl: string, tileName: AtlasTileName, suffix = ""): string {
  return `${baseUrl}/${tileName}${suffix}.png`;
}

export function createManifestFromBaseUrl(baseUrl: string): AtlasSourceManifest {
  const normalized = trimTrailingSlash(baseUrl);
  const albedo: AtlasSourceManifest["albedo"] = {};
  const normal: AtlasSourceManifest["normal"] = {};
  const specular: AtlasSourceManifest["specular"] = {};

  for (const tileName of ATLAS_TILE_NAMES) {
    albedo[tileName] = buildChannelUrl(normalized, tileName);
    normal[tileName] = buildChannelUrl(normalized, tileName, "_n");
    specular[tileName] = buildChannelUrl(normalized, tileName, "_s");
  }

  return { albedo, normal, specular };
}

export class ResourcePackManager {
  private atlasManifest?: AtlasSourceManifest;

  setAtlasManifest(manifest?: AtlasSourceManifest): void {
    this.atlasManifest = manifest;
  }

  getAtlasManifest(): AtlasSourceManifest | undefined {
    return this.atlasManifest;
  }

  setAtlasBaseUrl(baseUrl: string): void {
    this.atlasManifest = createManifestFromBaseUrl(baseUrl);
  }

  /**
   * Optional runtime integration point:
   *   window.__PBR_TEXTURE_MANIFEST__ = { albedo: {...}, normal: {...}, specular: {...} }
   *   window.__PBR_PACK_BASE_URL = "/packs/my-pack/textures/block"
   */
  loadFromWindow(win: Window): void {
    const w = win as Window & {
      __PBR_TEXTURE_MANIFEST__?: AtlasSourceManifest;
      __PBR_PACK_BASE_URL?: string;
    };

    if (w.__PBR_TEXTURE_MANIFEST__) {
      this.setAtlasManifest(w.__PBR_TEXTURE_MANIFEST__);
      return;
    }
    if (typeof w.__PBR_PACK_BASE_URL === "string" && w.__PBR_PACK_BASE_URL.trim().length > 0) {
      this.setAtlasBaseUrl(w.__PBR_PACK_BASE_URL.trim());
    }
  }
}
