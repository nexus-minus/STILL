/**
 * Browser-side probe (imported BY rt-storage-probe.mjs over the vite dev
 * server, which resolves its bare three imports): does a `storage()` node
 * placed in the `includes` array of a raw `wgslFn` get its module-scope
 * `var<storage>` declaration + binding emitted, so the raw WGSL can index it
 * BY NAME (`probe_lights[i]`)? This is the mechanism rt.ts will use for the
 * uncapped light list. Returns { ok, readback, error }.
 */
export async function runStorageProbe() {
  const THREE = await import('three/webgpu');
  const { storage, wgslFn, uniform, workgroupId, localId } = await import('three/tsl');

  const errors = [];
  const onUncaptured = (e) => errors.push(String(e.error?.message ?? e.message ?? e));
  navigator.gpu.addEventListener?.('uncapturederror', onUncaptured);

  const out = { ok: false, errors, readback: null, stage: 'init' };
  let renderer;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
    await renderer.init();
    out.stage = 'renderer-ready';

    // 3 vec4s of known pattern — readback must show the transform of element 1
    const srcData = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const srcAttr = new THREE.StorageBufferAttribute(srcData, 4);
    const lightsRO = storage(srcAttr).toReadOnly().setName('probe_lights');

    const outData = new Float32Array(16);
    const outAttr = new THREE.StorageBufferAttribute(outData, 4);
    const outRW = storage(outAttr).setName('probe_out');

    // raw WGSL indexing both storage vars BY NAME — neither is a param.
    // three declares storage as `struct <name>Struct { value: array<T> }`
    // + `var<storage,...> <name>: <name>Struct` -> index `<name>.value[i]`
    const kernelSource = /* wgsl */ `
      fn compute(
        srcIdx: f32,
        workgroupSize: vec3u,
        workgroupId: vec3u,
        localId: vec3u,
      ) -> vec4f {
        let i = u32(srcIdx);
        let v = probe_lights.value[i];
        probe_out.value[i] = vec4f(v.x + v.y, v.z + v.w, v.x * v.w, 99.0);
        return vec4f(0.0);
      }
    `;
    const kernelFn = wgslFn(kernelSource, [lightsRO, outRW]);
    out.stage = 'build-kernel';
    const kernel = kernelFn({
      srcIdx: uniform(1),
      workgroupSize: uniform(new THREE.Vector3(1, 1, 1)),
      workgroupId,
      localId,
    }).computeKernel([1, 1, 1]);
    out.stage = 'dispatch';
    renderer.compute(kernel, [1, 1, 1]);
    out.stage = 'readback';
    const buf = await renderer.getArrayBufferAsync(outAttr);
    out.readback = Array.from(new Float32Array(buf)).map((v) => +v.toFixed(3));
    // element 1 = (5,6,7,8) -> expect (11, 15, 40, 99) at slots 4..7
    out.ok =
      errors.length === 0 &&
      Math.abs(out.readback[4] - 11) < 1e-3 &&
      Math.abs(out.readback[5] - 15) < 1e-3 &&
      Math.abs(out.readback[6] - 40) < 1e-3 &&
      Math.abs(out.readback[7] - 99) < 1e-3;
    out.stage = 'done';
  } catch (e) {
    out.error = String(e?.stack ?? e);
  } finally {
    navigator.gpu.removeEventListener?.('uncapturederror', onUncaptured);
    renderer?.dispose?.();
  }
  return out;
}
