import puppeteer from 'puppeteer-core';
const headful = process.env.HEADFUL === '1';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/chromium',
  headless: !headful,
  env: { ...process.env, XDG_CONFIG_HOME: '/tmp/opencode/chromium-xdg-clean' },
  args: ['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-webgpu','--window-size=1280,800'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({width:1280,height:800});
  const logs=[];
  page.on('console', m=>logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e=>logs.push(`PAGEERROR ${e.message}\n${e.stack??''}`));
  page.on('requestfailed', r=>logs.push(`REQUESTFAIL ${r.url()} ${r.failure()?.errorText}`));
  await page.goto(process.env.PATH_URL ?? 'http://localhost:4173/pathtrace.html',{waitUntil:'domcontentloaded',timeout:20000});
  await new Promise(r=>setTimeout(r,12000));
  await page.evaluate(() => window.__pathtrace.tracer.updateLights());
  await new Promise(r=>setTimeout(r,1000));
  await page.evaluate(() => {
    const e = document.getElementById('gain');
    e.value = '4';
    e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise(r=>setTimeout(r,5000));
  const state=await page.evaluate(()=>{
    const g=window.__pathtrace;
    return {
      status:document.getElementById('status')?.textContent,
      canvas:[...document.querySelectorAll('canvas')].map(c=>[c.width,c.height]),
      tracer:!!g,
      samples:g?.tracer?._lastSampleCounts,
      camera:g?.camera?.position?.toArray(),
      target:g?.controls?.target?.toArray(),
      lights:g?.emitters?.map(e=>({position:e.light.position.toArray(),intensity:e.light.intensity,width:e.light.width,height:e.light.height,visible:e.light.visibleToCameraRays})),
      pathTracerLightCount:g?.lightCount?.(),
      lightData:g?.allLightData?.(),
      sceneRectLights:g?.sceneRectLights?.(),
      bounds:g?.bounds && {min:g.bounds.min.toArray(),max:g.bounds.max.toArray()},
      meshes:(()=>{if(!g)return null;const a=[];g.scene.traverse(o=>{if(o.isMesh)a.push({name:o.name,pos:o.geometry.attributes.position?.count,norm:o.geometry.attributes.normal?.count,normal0:o.geometry.attributes.normal?.array?.slice(0,3),side:o.material?.side,color:o.material?.color?.toArray?.(),em:g.three?._foo})});return a})(),
      centerHit:(()=>{if(!g)return null;const r=new g.three.Raycaster();r.setFromCamera(new g.three.Vector2(0,0),g.camera);const h=r.intersectObjects(g.scene.children,true);return h.slice(0,3).map(x=>({name:x.object.name,distance:+x.distance.toFixed(2),point:x.point.toArray().map(v=>+v.toFixed(2)),normal:x.face?.normal?.clone().transformDirection(x.object.matrixWorld).toArray().map(v=>+v.toFixed(2)),material:Array.isArray(x.object.material)?x.object.material[0]?.type:x.object.material?.type}))})(),
    };
  }).catch(e=>({evalError:e.message}));
  console.log('STATE',JSON.stringify(state));
  console.log('LOGS'); for(const l of logs.slice(-35)) console.log(l);
  await page.screenshot({path:'screenshots/pathtrace-debug.png'});
  await page.evaluate(() => {
    window.__pathtrace.renderer.setAnimationLoop(null);
    window.__pathtrace.tracer.renderDebugBounds();
  });
  await new Promise((r)=>setTimeout(r,100));
  await page.screenshot({path:'screenshots/pathtrace-bvh.png'});
  await page.click('#sun');
  await new Promise((r)=>setTimeout(r,5000));
  console.log('SUN_STATE', await page.evaluate(() => ({
    status: document.getElementById('status')?.textContent,
    lights: window.__pathtrace?.lightCount?.(),
    lightData: window.__pathtrace?.allLightData?.(),
  })));
  await page.screenshot({path:'screenshots/pathtrace-sun.png'});
  await page.click('#point');
  await new Promise((r)=>setTimeout(r,5000));
  await page.screenshot({path:'screenshots/pathtrace-point.png'});
  await page.click('#selfemit');
  await new Promise((r)=>setTimeout(r,5000));
  await page.screenshot({path:'screenshots/pathtrace-selfemit.png'});
  await page.click('#raster');
  await new Promise((r)=>setTimeout(r,500));
  await page.screenshot({path:'screenshots/pathtrace-raster.png'});
} finally {await browser.close();}
