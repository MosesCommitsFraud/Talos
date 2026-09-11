// node tests/dashboard_export.cjs <fixture-dir>; requires Playwright.
const {chromium} = require('playwright');
const {pathToFileURL} = require('url');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
(async () => {
  const root = path.resolve(process.argv[2]);
  const browser = await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL || undefined,args:['--enable-unsafe-swiftshader']});
  const page = await browser.newPage({viewport:{width:1440,height:1000}, colorScheme:'light'});
  const errors=[], requests=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error') errors.push(m.text())});
  await page.route(/^https?:/, r=>{requests.push(r.request().url());r.abort()});
  for(const [format, expected] of [['16-9',[1920,1080]],['a4',[2480,3508]],['a4-landscape',[3508,2480]],['web',null]]) {
    await page.goto(pathToFileURL(path.join(root,format+'.html')).href);
    await page.waitForFunction(()=>!!window.TALOS_EXPORT);
    if(format==='16-9') {
      await page.setViewportSize({width:390,height:844});
      await page.waitForFunction(()=>document.documentElement.scrollWidth<=390);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=390),true);
    }
    const downloadPromise = page.waitForEvent('download',{timeout:20000});
    await page.locator('#td-save-png').click();
    await page.waitForFunction(()=>!document.getElementById('td-save-png').disabled);
    const status = await page.locator('#td-export-status').innerText();
    assert.equal(status,'PNG heruntergeladen.',status);
    const download = await downloadPromise;
    const output=path.join(root,format+'.png');
    await download.saveAs(output);
    const bytes=fs.readFileSync(output);
    assert.equal(bytes.subarray(1,4).toString(),'PNG');
    const dims=[bytes.readUInt32BE(16),bytes.readUInt32BE(20)];
    if(expected) assert.deepEqual(dims,expected);
    else assert(dims[0]>0 && dims[1]>0);
    console.log(format, dims, bytes.length, 'bytes');
    await page.setViewportSize({width:1440,height:1000});
  }
  const htmlPromise=page.waitForEvent('download');
  await page.locator('#td-save-html').click();
  await (await htmlPromise).saveAs(path.join(root,'downloaded.html'));
  await page.goto(pathToFileURL(path.join(root,'downloaded.html')).href);
  await page.waitForFunction(()=>!!window.TALOS_CHARTS?.trend?.chart);
  assert.equal(await page.locator('#trend canvas').count(),1);
  await page.goto(pathToFileURL(path.join(root,'overflow.html')).href);
  await page.locator('#td-save-png').click();
  await page.waitForFunction(()=>!document.getElementById('td-save-png').disabled);
  assert.match(await page.locator('#td-export-status').innerText(),/passt nicht/);
  // Match the actual preview: opaque-origin sandbox with downloads enabled.
  const html=fs.readFileSync(path.join(root,'16-9.html'),'utf8');
  await page.setContent('<iframe sandbox="allow-scripts allow-downloads" style="width:100%;height:900px"></iframe>');
  await page.locator('iframe').evaluate((el,html)=>{el.srcdoc=html},html);
  const frame=page.frameLocator('iframe');
  const frameDownload=page.waitForEvent('download',{timeout:20000});
  await frame.locator('#td-save-png').click();
  await (await frameDownload).saveAs(path.join(root,'iframe.png'));
  await page.goto(pathToFileURL(path.join(root,'mixed.html')).href);
  await page.waitForFunction(()=>Object.keys(window.TALOS_CHARTS||{}).length===3);
  await page.evaluate(()=>{document.documentElement.dataset.theme='dark'});
  await page.waitForTimeout(400);
  const mixedDownload=page.waitForEvent('download',{timeout:20000});
  await page.locator('#td-save-png').click();
  await (await mixedDownload).saveAs(path.join(root,'mixed.png'));
  const mixedURL='data:image/png;base64,'+fs.readFileSync(path.join(root,'mixed.png')).toString('base64');
  const glPixels=await page.evaluate(async src=>{
    const img=new Image();img.src=src;await img.decode();
    const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
    const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
    const pixels=ctx.getImageData(0,Math.ceil(img.height*.6),Math.floor(img.width*.5),Math.floor(img.height*.35)).data;
    let blue=0;for(let i=0;i<pixels.length;i+=4) if(pixels[i+2]>pixels[i]+25 && pixels[i+2]>pixels[i+1]+10) blue++;
    return blue;
  },mixedURL);
  assert(glPixels>30,'GL marks must be visible in the exported PNG');
  assert.equal(await page.locator('#native canvas').count(),1);
  assert.equal(await page.locator('#native img').count(),0);
  assert.deepEqual(requests,[]);
  assert.deepEqual(errors,[]);
  console.log('HTML roundtrip, overflow refusal, sandboxed PNG, dark mixed engines and GL: OK');
  await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
