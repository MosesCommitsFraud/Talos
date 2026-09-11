// Start Vite in web, then: node tests/dashboard_export.cjs <fixture-dir>
const {chromium}=require('playwright'), fs=require('fs'),path=require('path'),assert=require('assert');
(async()=>{
 const root=path.resolve(process.argv[2]);
 const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||undefined,args:['--enable-unsafe-swiftshader']});
 try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.argv[3]||'http://127.0.0.1:5192/tests/html-preview.html');
 await page.waitForFunction(()=>typeof window.setFixture==='function');
 const png=()=>page.getByRole('button',{name:'PNG herunterladen',exact:true});
 async function load(html){
  await page.evaluate(html=>window.setFixture(html),html);
  await png().waitFor();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='PNG herunterladen'&&!b.disabled));
  return page.frameLocator('iframe');
 }
 async function download(format,expected){
  const pending=page.waitForEvent('download',{timeout:30000});await png().click();
  const file=await pending;await file.saveAs(path.join(root,format+'.png'));
  const bytes=fs.readFileSync(path.join(root,format+'.png'));
  assert.equal(bytes.subarray(1,4).toString(),'PNG');
  const dims=[bytes.readUInt32BE(16),bytes.readUInt32BE(20)];
  if(expected)assert.deepEqual(dims,expected);
  console.log(format,dims,bytes.length,'bytes');
 }
 for(const [format,expected] of [['16-9',[1920,1080]],['a4',[2480,3508]],['a4-landscape',[3508,2480]],['web',null]]){
  const html=fs.readFileSync(path.join(root,format+'.html'),'utf8'),frame=await load(html);
  await frame.locator('#trend canvas').waitFor();
  assert.equal(await frame.locator('#td-downloads').count(),0);
  assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts allow-popups allow-downloads');
  assert(await page.evaluate(()=>{try{return document.querySelector('iframe').contentWindow.document===null}catch{return true}}));
  await download(format,expected);
  if(format==='16-9')await page.screenshot({path:path.join(root,'talos-preview.png')});
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'HTML herunterladen',exact:true}).click();
  assert.equal(fs.readFileSync(await(await pending).path(),'utf8'),html);
 }
 await load('<!doctype html><html><body style="margin:0;background:#e4f5ef"><h1>Plain HTML</h1><p>No dashboard runtime</p></body></html>');
 await download('plain-html');
 await load(fs.readFileSync(path.join(root,'overflow.html'),'utf8'));await png().click();
 await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/passt nicht/);
 await load(fs.readFileSync(path.join(root,'mixed.html'),'utf8'));
 const mixed=page.frames().find(f=>f.parentFrame());
 await mixed.waitForFunction(()=>Object.keys(window.TALOS_CHARTS||{}).length===3);
 await mixed.evaluate(()=>{document.documentElement.dataset.theme='dark'});await page.waitForTimeout(400);
 await download('mixed');
 const src='data:image/png;base64,'+fs.readFileSync(path.join(root,'mixed.png')).toString('base64');
 const blue=await page.evaluate(async src=>{
  const img=new Image();img.src=src;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
  const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
  const px=ctx.getImageData(0,Math.ceil(img.height*.6),Math.floor(img.width*.5),Math.floor(img.height*.35)).data;
  let n=0;for(let i=0;i<px.length;i+=4)if(px[i+2]>px[i]+25&&px[i+2]>px[i+1]+10)n++;return n;
 },src);
 assert(blue>30,'GL marks visible in PNG');assert.equal(await mixed.locator('#native img').count(),0);
 assert.deepEqual(errors,[]);console.log('Talos UI downloads, sandbox isolation, plain HTML, overflow and mixed engines: OK');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
