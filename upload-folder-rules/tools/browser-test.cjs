/* Isolated Edge only. Native dialogs are replaced with OPFS fixture handles.
 * A test-only manifest pregrants the two fixture domains; no personal profile is read.
 */
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),qa=path.join(root,'qa'),run=randomUUID();
const ext=path.join(qa,`test-extension-${run}`),profile=path.join(qa,'profiles',run);
fs.mkdirSync(ext,{recursive:true});fs.cpSync(path.join(root,'extension'),ext,{recursive:true});
const manifest=JSON.parse(fs.readFileSync(path.join(ext,'manifest.json')));
manifest.host_permissions=['https://*.oc.sjtu.edu.cn/*','http://*.oc.sjtu.edu.cn/*','https://*.example.test/*','http://*.example.test/*'];
fs.writeFileSync(path.join(ext,'manifest.json'),JSON.stringify(manifest,null,2));
fs.mkdirSync(path.join(qa,'screenshots'),{recursive:true});
const report={testedAt:new Date().toISOString(),browser:'Microsoft Edge',tests:[],errors:[],limitations:['Isolated disposable profile, not personal Edge.','Test-only manifest pregrants fixture domains; real optional-permission prompt not automated.','Native directory/file dialogs mocked with real OPFS handles; OS start directory and Canvas account UI require manual acceptance.'],sourceHashes:Object.fromEntries(fs.readdirSync(path.join(root,'extension')).map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(root,'extension',name))).digest('hex')]))};
let context,options,worker,origin,site;
async function check(name,fn){const start=Date.now();await fn();report.tests.push({name,passed:true,ms:Date.now()-start});console.log('PASS',name);}
async function until(fn,test,ms=7000){const start=Date.now();let value;while(Date.now()-start<ms){value=await fn();if(typeof test==='function'?test(value):value===test)return value;await new Promise(r=>setTimeout(r,70))}throw new Error(`Timeout; last value ${JSON.stringify(value)}`);}
const fixture=`<!doctype html><meta charset="utf-8"><title>上传测试页面</title><h1>隔离上传测试</h1>
<input id="pdf" type="file" accept=".pdf"><label for="pdf" id="label">通过标签上传</label><button id="scripted" onclick="document.querySelector('#pdf').click()">脚本上传</button><button id="show" onclick="document.querySelector('#pdf').showPicker()">showPicker</button>
<input id="multiple" type="file" multiple accept="application/pdf"><input id="image" type="file" accept="image/*"><input id="directory" type="file" webkitdirectory><input id="unknown" type="file"><input id="captured" type="file" accept=".pdf" capture>
<div id="shadow"></div><output id="result"></output><script>window.events=[];for(const name of ['input','change'])document.addEventListener(name,async e=>{if(e.target.type==='file'){events.push({event:name,id:e.target.id,files:Array.from(e.target.files,f=>({name:f.name,size:f.size,type:f.type}))});if(name==='change')document.querySelector('#result').textContent=JSON.stringify(events.at(-1))}});const root=document.querySelector('#shadow').attachShadow({mode:'open'});root.innerHTML='<input id="shadow-file" type="file" accept=".pdf">';</script>`;
async function openSite(url='https://oc.sjtu.edu.cn/courses/98447/assignments/9'){const page=await context.newPage();await page.goto(url);await page.waitForTimeout(220);return page;}
async function openPicker(page,selector='#pdf'){
  const waiting=context.waitForEvent('page', {predicate:p=>true});await page.locator(selector).click();const picker=await waiting;await picker.waitForURL('**/picker.html#*');await picker.locator('#choose:enabled').waitFor();return picker;
}
async function mockFiles(picker,names=['homework.pdf'],bytes=5){
  await picker.evaluate(({names,bytes})=>{
    window.__pickedOptions=null;
    window.showOpenFilePicker=async options=>{
      window.__pickedOptions={name:options.startIn?.name,kind:options.startIn?.kind,multiple:options.multiple,types:options.types,id:options.id};
      return names.map(name=>({getFile:async()=>new File([new Uint8Array(bytes).fill(65)],name,{type:name.endsWith('.pdf')?'application/pdf':'image/png'})}));
    };
  },{names,bytes});
}
async function clickAndCancelNative(page,selector){const waiting=page.waitForEvent('filechooser');await page.locator(selector).click();const chooser=await waiting;if(!await chooser.element().evaluate(input=>input.webkitdirectory))await chooser.setFiles([]);}
async function configNow(){return options.evaluate(async()=>(await chrome.storage.local.get('config')).config);}
async function saveRaw(config){const result=await options.evaluate(config=>chrome.runtime.sendMessage({type:'UFR_SAVE',config}),config);assert.equal(result.ok,true,result.error);}
(async()=>{
  context=await chromium.launchPersistentContext(profile,{channel:'msedge',headless:true,viewport:{width:1280,height:1024},locale:'zh-CN',ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});
  context.on('page',page=>page.on('pageerror',error=>report.errors.push({url:page.url(),message:error.message})));
  worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const u=new URL(worker.url());origin=`${u.protocol}//${u.host}`;
  await context.route(/^https?:\/\/([^/]+\.)?(oc\.sjtu\.edu\.cn|example\.test)\//,route=>route.fulfill({contentType:'text/html',body:fixture}));
  options=await context.newPage();await options.goto(origin+'/options.html');
  await check('Canvas preset is independent of course ID and preserves the requested folder hint',async()=>{
    assert.equal(await options.locator('#domain').inputValue(),'oc.sjtu.edu.cn');assert.equal(await options.locator('#path').inputValue(),'/');assert.equal(await options.locator('#custom').inputValue(),'.pdf');assert.match(await options.locator('#folder-hint').innerText(),/请选择一个|请选一个/);
  });
  await check('Bind a real directory handle, save through UI, and reload it from IndexedDB',async()=>{
    await options.evaluate(async()=>{const root=await navigator.storage.getDirectory();window.__fixtureFolder=await root.getDirectoryHandle('assignments-test',{create:true});window.showDirectoryPicker=async()=>window.__fixtureFolder;});
    await options.locator('#bind').click();await options.locator('#save').click();await until(()=>options.locator('#status').innerText(),v=>v.includes('已保存'));
    await options.reload();await until(()=>options.locator('#folder-name').innerText(),v=>v==='assignments-test');assert.equal((await configNow()).rules.length,1);
  });
  await check('Standard PDF input receives bytes and input/change events through the extension bridge',async()=>{
    site=await openSite();const picker=await openPicker(site);await mockFiles(picker);await picker.locator('#choose').click();await site.locator('#result').filter({hasText:'homework.pdf'}).waitFor();
    assert.equal(await site.locator('#pdf').evaluate(async input=>await input.files[0].text()),'AAAAA');assert.deepEqual(await site.evaluate(()=>events.map(e=>e.event)),['input','change']);
  });
  await check('The persisted directory is passed as startIn every time, without a remembered-directory ID',async()=>{
    const picker=await openPicker(site);await mockFiles(picker);await picker.evaluate(()=>{const original=showOpenFilePicker;showOpenFilePicker=async options=>{await original(options);throw new DOMException('cancel','AbortError')};});await picker.locator('#choose').click();
    const used=await picker.evaluate(()=>__pickedOptions);assert.equal(used.name,'assignments-test');assert.equal(used.kind,'directory');assert.equal(used.multiple,false);assert.equal(used.id,undefined);assert.deepEqual(used.types[0].accept,{'application/pdf':['.pdf']});await picker.locator('#cancel').click();
  });
  await check('A different Canvas course and subdomain share the same binding',async()=>{
    const page=await openSite('https://files.oc.sjtu.edu.cn/courses/12345/assignments/7');const picker=await openPicker(page);assert.equal(await picker.locator('#folder-name').innerText(),'assignments-test');await picker.locator('#cancel').click();await page.close();
  });
  await check('Label, scripted click, and native showPicker are intercepted',async()=>{
    for(const selector of ['#label','#scripted','#show']){const picker=await openPicker(site,selector);await picker.locator('#cancel').click();await until(()=>site.getByText('使用原上传方式',{exact:true}).count(),0);}
  });
  await check('Multi-file transfer preserves names, order and larger binary sizes',async()=>{
    const picker=await openPicker(site,'#multiple');await mockFiles(picker,['first.pdf','second.pdf'],8*1024*1024);await picker.locator('#choose').click();await until(()=>site.locator('#multiple').evaluate(input=>input.files.length),2);
    const data=await site.locator('#multiple').evaluate(input=>Array.from(input.files,f=>({name:f.name,size:f.size})));assert.deepEqual(data,[{name:'first.pdf',size:8*1024*1024},{name:'second.pdf',size:8*1024*1024}]);
  });
  await check('Mismatched selected files are not handed to the webpage',async()=>{
    const before=await site.evaluate(()=>events.length);const picker=await openPicker(site);await mockFiles(picker,['photo.png']);await picker.locator('#choose').click();await until(()=>picker.locator('#status').innerText(),v=>v.includes('不符合'));assert.equal(await site.evaluate(()=>events.length),before);await picker.locator('#cancel').click();
  });
  await check('Images without a matching rule, directory uploads, and capture inputs retain native behavior',async()=>{
    for(const selector of ['#image','#directory','#captured'])await clickAndCancelNative(site,selector);
  });
  await check('Native fallback is available and does not recursively reopen the extension',async()=>{
    const picker=await openPicker(site);const chooserPromise=site.waitForEvent('filechooser');await site.getByText('使用原上传方式',{exact:true}).click();const chooser=await chooserPromise;await chooser.setFiles([]);await until(()=>picker.isClosed(),true);
  });
  await check('Closing the picker cancels the session and the in-page prompt',async()=>{
    const picker=await openPicker(site);await picker.close();await until(()=>site.getByText('使用原上传方式',{exact:true}).count(),0);const sessions=await options.evaluate(()=>chrome.storage.session.get(null));assert.deepEqual(sessions,{});
  });
  await check('Navigating away cancels the pending picker',async()=>{
    const page=await openSite();const picker=await openPicker(page);await page.goto('https://oc.sjtu.edu.cn/courses/another');await until(()=>picker.isClosed(),true);await page.close();
  });
  await check('Immediate cancellation does not leave an orphan upload session',async()=>{
    await site.locator('#pdf').click();await site.getByRole('button',{name:'取消',exact:true}).click();await until(()=>options.evaluate(()=>chrome.storage.session.get(null)),value=>Object.keys(value).length===0);await site.waitForTimeout(150);assert.equal(context.pages().filter(p=>p.url().startsWith(origin+'/picker.html')).length,0);
  });
  await check('Open shadow-root input works',async()=>{
    const picker=await openPicker(site,'#shadow-file');await mockFiles(picker);await picker.locator('#choose').click();await until(()=>site.locator('#shadow-file').evaluate(input=>input.files.length),1);
  });
  await check('A page cannot spoof a file delivery message',async()=>{
    const picker=await openPicker(site);const before=await site.locator('#pdf').evaluate(input=>input.files[0]?.name);await site.evaluate(()=>{const bridge=Array.from(document.querySelectorAll('div')).flatMap(x=>x.shadowRoot?[x.shadowRoot.querySelector('iframe')]:[]).find(Boolean);const id=bridge.src.split('#')[1].split('?')[0];window.postMessage({type:'UFR_FILES',id,files:[new File(['bad'],'forged.pdf',{type:'application/pdf'})]},location.origin);});await site.waitForTimeout(150);assert.equal(await site.locator('#pdf').evaluate(input=>input.files[0]?.name),before);await picker.locator('#cancel').click();
  });
  await check('Global pause immediately restores native picking',async()=>{
    await options.locator('#pause').click();await until(()=>configNow(),v=>v.enabled===false);await site.waitForTimeout(100);await clickAndCancelNative(site,'#pdf');await options.locator('#pause').click();await until(()=>configNow(),v=>v.enabled===true);
  });
  await check('A second website can use a different folder and a different file type',async()=>{
    await options.locator('#new').click();await options.locator('#domain').fill('example.test');await options.locator('#name').fill('图片上传');await options.locator('#file-type').selectOption('images');
    await options.evaluate(async()=>{const root=await navigator.storage.getDirectory();const folder=await root.getDirectoryHandle('pictures-test',{create:true});showDirectoryPicker=async()=>folder;});await options.locator('#bind').click();await options.locator('#save').click();await until(()=>configNow(),v=>v.rules.length===2);
    const page=await openSite('https://a.example.test/upload');const picker=await openPicker(page,'#image');assert.equal(await picker.locator('#folder-name').innerText(),'pictures-test');await picker.locator('#cancel').click();await page.close();
  });
  await check('Rule export excludes local paths and handles; import appends disabled, unbound rules',async()=>{
    const downloadPromise=options.waitForEvent('download');await options.locator('#export').click();const download=await downloadPromise;const text=fs.readFileSync(await download.path(),'utf8');assert.ok(!text.includes('folderHint'));assert.ok(!text.includes('folderName'));assert.ok(!text.includes('assignments'));const before=(await configNow()).rules.length;
    await options.locator('#import-file').setInputFiles({name:'rules.json',mimeType:'application/json',buffer:Buffer.from(text)});await until(()=>configNow(),v=>v.rules.length===before*2);const added=(await configNow()).rules.slice(before);assert.ok(added.every(r=>!r.enabled&&!r.folderName));
  });
  await check('Narrow and desktop layouts fit the viewport',async()=>{
    await options.locator('#rules button').filter({hasText:'编辑'}).first().click();
    for(const width of [1280,390]){await options.setViewportSize({width,height:1050});assert.ok(await options.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await options.screenshot({path:path.join(qa,'screenshots',`options-${width}.png`),fullPage:true});}
    const picker=await openPicker(site);await picker.setViewportSize({width:560,height:650});assert.ok(await picker.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await picker.screenshot({path:path.join(qa,'screenshots','picker.png'),fullPage:true});await picker.locator('#cancel').click();
  });
  await check('No page script errors',async()=>assert.deepEqual(report.errors,[]));
})().catch(error=>{report.failure=error.stack;console.error(error);process.exitCode=1;}).finally(async()=>{if(context)await context.close();fs.writeFileSync(path.join(qa,'browser-report.json'),JSON.stringify(report,null,2));console.log(`${report.tests.length} checks passed; report: qa/browser-report.json`);});
