import type { Node } from 'three/webgpu';

// three-mesh-bvh ships types only for BVHComputeData; these exports exist at
// runtime (src/webgpu/tsl/fns.js) and are needed by the raytracing kernel.
/** WGSL fn node (dependency builder) — see bvh-webgpu.d.ts */
declare module 'three-mesh-bvh/webgpu' {
  /** WGSL fn node: ndcToCameraRay(ndc, inverseModelViewProjection) -> Ray */
  export const ndcToCameraRay: (...args: never[]) => Node;
}
