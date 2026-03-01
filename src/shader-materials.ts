import Unlit_VERTEXSHADER from "./shaders/unlit/Unlit_VERTEXSHADER.glsl?raw";
import Unlit_FRAGMENTSHADER from "./shaders/unlit/Unlit_FRAGMENTSHADER.glsl?raw";

import Texture_VERTEXSHADER from "./shaders/texture/Texture_VERTEXSHADER.glsl?raw";
import Texture_FRAGMENTSHADER from "./shaders/texture/Texture_FRAGMENTSHADER.glsl?raw";

import Voxel_VERTEXSHADER from "./shaders/voxel/voxel_VERTEXSHADER.glsl?raw";
import Voxel_FRAGMENTSHADER from "./shaders/voxel/voxel_FRAGMENTSHADER.glsl?raw";

const Unlit = {
  vertexShader: Unlit_VERTEXSHADER,
  fragmentShader: Unlit_FRAGMENTSHADER,
};

const Texture = {
  vertexShader: Texture_VERTEXSHADER,
  fragmentShader: Texture_FRAGMENTSHADER,
};

const Voxel = {
  vertexShader: Voxel_VERTEXSHADER,
  fragmentShader: Voxel_FRAGMENTSHADER,
};

const Materials = {
  Unlit,
  Texture,
  Voxel,
};

export default Materials;
