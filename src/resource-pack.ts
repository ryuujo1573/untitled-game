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
  private cloudTextureUrl?: string;
  private skyboxTextureUrl?: string;

  setAtlasManifest(manifest?: AtlasSourceManifest): void {
    this.atlasManifest = manifest;
  }

  getAtlasManifest(): AtlasSourceManifest | undefined {
    return this.atlasManifest;
  }

  setCloudTextureUrl(url?: string): void {
    this.cloudTextureUrl = url;
  }

  getCloudTextureUrl(): string | undefined {
    return this.cloudTextureUrl;
  }

  setSkyboxTextureUrl(url?: string): void {
    this.skyboxTextureUrl = url;
  }

  getSkyboxTextureUrl(): string | undefined {
    return this.skyboxTextureUrl;
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
      __CLOUD_TEXTURE_URL?: string;
      __SKYBOX_TEXTURE_URL?: string;
    };

    if (w.__PBR_TEXTURE_MANIFEST__) {
      this.setAtlasManifest(w.__PBR_TEXTURE_MANIFEST__);
      return;
    }
    if (typeof w.__PBR_PACK_BASE_URL === "string" && w.__PBR_PACK_BASE_URL.trim().length > 0) {
      this.setAtlasBaseUrl(w.__PBR_PACK_BASE_URL.trim());
    }
    if (typeof w.__CLOUD_TEXTURE_URL === "string" && w.__CLOUD_TEXTURE_URL.trim().length > 0) {
      this.setCloudTextureUrl(w.__CLOUD_TEXTURE_URL.trim());
    }
    if (typeof w.__SKYBOX_TEXTURE_URL === "string" && w.__SKYBOX_TEXTURE_URL.trim().length > 0) {
      this.setSkyboxTextureUrl(w.__SKYBOX_TEXTURE_URL.trim());
    }
  }
}
