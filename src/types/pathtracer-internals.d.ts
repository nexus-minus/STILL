declare module 'three-gpu-pathtracer/src/core/utils/sceneUpdateUtils.js' {
  import type { Scene } from 'three';

  export function getLights(scene: Scene): Array<{ isRectAreaLight?: boolean }>;
}
