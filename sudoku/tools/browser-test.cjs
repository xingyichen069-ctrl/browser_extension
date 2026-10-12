/* Reproducible Edge integration/visual QA. Uses a disposable profile and routed
 * local fixtures; it never reads the player's browser or sends fixture scores. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const qa = path.join(root, 'qa');
const extension = path.join(root, 'extension');
const profile = path.join(qa, 'profiles', `integration-${randomUUID()}`);
fs.mkdirSync(path.join(qa, 'screenshots'), { recursive: true });
const report = { testedAt: new Date().toISOString(), browser: 'Microsoft Edge', tests: [], screenshotsContainDemoData: true, errors: [] };
let context, dashboard, origin;

const fixture = (url) => {
  const params = new URL(url).searchParams;
  const data = { content_id: params.get('id') || 'fixture-1', content_type: params.get('variant') || 'classic', difficulty: params.get('difficulty') || 'extreme', mode: 'main' };
  const mode = params.get('mode') || (data.content_type === 'killer' ? 'killer' : 'classic');
  return `<!doctype html><html lang="zh"><head><title>离线测试棋盘</title><style>body{font-family:sans-serif;padding:30px}canvas{border:2px solid #214e42;background:#f6f2e9;width:360px;height:360px}#win-screen:not(.show-win){display:none}</style></head><body><h1>隔离测试棋盘 · 不是真实成绩</h1><div id="sudoku-wrapper"><div id="game"><canvas width="360" height="360"></canvas></div><span id="timer">12:34</span><div id="win-screen" class="preact-winscreen ${params.get('won') ? 'show-win' : ''}">${params.get('won') ? '<h2>太棒了！</h2>' : ''}</div></div><script>window.gameData=${JSON.stringify(data)};window.mode=${JSON.stringify(mode)};window.fixtureWin=()=>{const w=document.getElementById('win-screen');w.replaceChildren(Object.assign(document.createElement('h2'),{textContent:'太棒了！'}));w.classList.add('show-win');};window.fixtureNext=(id,seconds='00:01',difficulty='extreme',variant='classic',mode='classic')=>{window.gameData={content_id:id,content_type:variant,difficulty,mode:mode==='classic'||mode==='killer'?'main':mode};window.mode=mode;const w=document.getElementById('win-screen');w.classList.remove('show-win');w.replaceChildren();document.getElementById('timer').textContent=seconds;};</script></body></html>`;
};

async function check(name, fn) {
  const started = performance.now();
  try {
    await fn();
    report.tests.push({ name, passed: true, ms: Math.round(performance.now() - started) });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.tests.push({ name, passed: false, error: error.stack });
    throw error;
  }
}

async function poll(fn, expected, timeout = 10000) {
  const started = Date.now();
  let actual;
  do {
    actual = await fn();
    if (typeof expected === 'function' ? expected(actual) : actual === expected) return actual;
    await new Promise(resolve => setTimeout(resolve, 80));
  } while (Date.now() - started < timeout);
  assert.fail(`Timed out: expected ${expected}, last ${JSON.stringify(actual)}`);
}

async function api(type, payload = {}) {
  const response = await dashboard.evaluate(message => chrome.runtime.sendMessage(message), { type, ...payload });
  if (!response?.ok) throw new Error(response?.error || 'Invalid response');
  return response.data;
}
const snapshot = () => api('SJ_SNAPSHOT');
const count = async () => (await snapshot()).records.length;

async function status(page) {
  const tabId = await page.evaluate(() => JSON.parse(sessionStorage.getItem('__sudoku_journal_session_v1') || '{}').tabId);
  if (!Number.isInteger(tabId)) return null;
  return dashboard.evaluate(id => chrome.tabs.sendMessage(id, { type: 'SJ_CAPTURE_STATUS' }), tabId);
}

async function game(params = '') {
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push({ where: 'fixture', message: error.message }));
  await page.goto(`https://sudoku.com/zh/extreme/?${params}`);
  await poll(() => status(page), value => value?.supported === true);
  return page;
}

async function arm(page) {
  await page.locator('#game canvas').click({ position: { x: 20, y: 20 } });
  await poll(() => status(page), value => value?.phase === 'playing');
}

async function win(page, expected) {
  await page.evaluate(() => window.fixtureWin());
  await poll(count, expected);
}

async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: true, viewport: { width: 1440, height: 1100 },
    timezoneId: 'Asia/Shanghai', locale: 'zh-CN', acceptDownloads: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-precise-memory-info'],
  });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('https://sudoku.com/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture(url) });
    if (/^https?:/.test(url)) return route.abort();
    return route.continue();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const workerUrl = new URL(worker.url());
  origin = `${workerUrl.protocol}//${workerUrl.hostname}`;
  report.version = await worker.evaluate(() => navigator.userAgent);
  dashboard = await context.newPage();
  dashboard.on('pageerror', error => report.errors.push({ where: 'dashboard', message: error.message }));
  await dashboard.goto(`${origin}/dashboard.html`);
  await poll(() => dashboard.locator('#totalCount').innerText(), text => text !== '—');
}

async function run() {
  await launch();
  await check('Edge loads unpacked MV3 extension and empty onboarding', async () => {
    assert.equal(await count(), 0);
    assert.equal(await dashboard.locator('#onboarding').isVisible(), true);
    await dashboard.screenshot({ path: path.join(qa, 'screenshots', 'empty-dashboard.png'), fullPage: true });
  });

  const old = await game('id=old-win&won=1');
  await check('Opening an old victory does not backfill a win', async () => {
    await old.locator('canvas').click();
    assert.equal(await count(), 0);
  });
  await old.close();
  const play = await game('id=classic-one');
  await arm(play);
  await check('Pre-rendered text and empty victory class do not count', async () => {
    await play.evaluate(() => { document.getElementById('win-screen').textContent = '太棒了'; });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await count(), 0);
    await play.evaluate(() => { const w=document.getElementById('win-screen');w.replaceChildren();w.classList.add('show-win'); });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await count(), 0);
  });
  await check('Trusted gameplay followed by displayed win records exact metadata', async () => {
    await win(play, 1);
    const [record] = (await snapshot()).records;
    assert.equal(record.variant, 'classic'); assert.equal(record.difficulty, 'extreme');
    assert.equal(record.durationSeconds, 754); assert.equal(record.mode, 'regular');
    assert.equal(record.source, 'automatic'); assert.equal(record.timeZone, 'Asia/Shanghai');
  });
  await check('Victory redraw and dismiss/reopen do not duplicate', async () => {
    await play.evaluate(() => window.fixtureWin());
    await play.evaluate(() => document.getElementById('win-screen').classList.remove('show-win'));
    await play.locator('canvas').click();
    await play.evaluate(() => window.fixtureWin());
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await count(), 1);
  });
  await check('Same-puzzle restart is remembered before a delayed first interaction', async () => {
    await play.evaluate(() => window.fixtureNext('classic-one', '00:00'));
    await new Promise(resolve => setTimeout(resolve, 150));
    await play.evaluate(() => document.getElementById('timer').textContent = '00:10');
    await arm(play); await win(play, 2);
  });
  await check('New puzzle, killer, daily and internal evil difficulty classify correctly', async () => {
    await play.evaluate(() => window.fixtureNext('killer-one', '03:20', 'expert', 'killer', 'killer'));
    await arm(play); await win(play, 3);
    await play.evaluate(() => window.fixtureNext('daily-one', '04:30', 'evil', 'classic', 'daily'));
    await arm(play); await win(play, 4);
    const records = (await snapshot()).records;
    assert(records.some(r => r.variant === 'killer' && r.difficulty === 'expert'));
    assert(records.some(r => r.mode === 'daily' && r.difficulty === 'master'));
  });
  await check('Pause rejects completion and resume does not retroactively add it', async () => {
    await play.evaluate(() => window.fixtureNext('paused-one'));
    await arm(play);
    await api('SJ_SET_PAUSED', { paused: true });
    await poll(() => status(play), value => value?.phase === 'paused');
    await play.evaluate(() => window.fixtureWin());
    await api('SJ_SET_PAUSED', { paused: false });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(await count(), 4);
  });
  await check('Copied tab keeps independent attempt IDs', async () => {
    await play.evaluate(() => window.fixtureNext('clone-puzzle'));
    await arm(play);
    const clonedPromise = context.waitForEvent('page');
    await play.evaluate(() => window.open('/zh/extreme/?id=clone-puzzle', '_blank'));
    const clone = await clonedPromise;
    await clone.waitForLoadState();
    await poll(() => status(clone), value => value?.supported === true);
    await arm(clone);
    await win(play, 5); await win(clone, 6);
    await clone.close();
  });
  await check('Timer-only mutations do not repeatedly invoke the adapter', async () => {
    await play.evaluate(() => { window.testMessages=0; window.addEventListener('message', event => {if(event.data?.channel==='sudoku-journal-v1'&&event.data?.type==='snapshot') window.testMessages++;}); });
    await play.evaluate(() => { for(let i=0;i<500;i++) document.getElementById('timer').textContent='02:'+String(i%60).padStart(2,'0'); });
    await new Promise(resolve => setTimeout(resolve, 180));
    const messages = await play.evaluate(() => window.testMessages);
    assert.equal(messages, 0); report.timerMutations = { mutations: 500, adapterMessages: messages };
  });
  await play.close();

  await check('Manual add, delete, undo and invalid import preserve records', async () => {
    await dashboard.bringToFront();
    await dashboard.locator('#refreshData').click();
    await poll(() => dashboard.locator('#totalCount').innerText(), '6');
    await dashboard.locator('#addManual').click();
    await dashboard.locator('#manualMode').selectOption('daily');
    await dashboard.locator('#manualNote').fill('界面流程测试 · 演示数据');
    await dashboard.screenshot({ path: path.join(qa, 'screenshots', 'manual-dialog.png') });
    await dashboard.locator('#saveManual').click();
    await poll(count, 7);
    const record = (await snapshot()).records.find(r => r.note.includes('界面流程'));
    assert.equal(record.completedAt, null); assert.equal(record.mode, 'daily');
    const row = dashboard.locator('#recordRows tr').filter({ hasText: '界面流程测试' });
    await row.getByRole('button', { name: /移到回收站/ }).click();
    await poll(count, 6);
    await dashboard.locator('#toast').getByRole('button', { name: '撤销' }).click();
    await poll(count, 7);
    await dashboard.locator('#importFile').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
    await poll(() => dashboard.locator('#importFeedback').innerText(), text => text.includes('JSON'));
    assert.equal(await count(), 7);
  });
  let backup;
  await check('JSON download, duplicate import and CSV download work', async () => {
    const downloadPromise = dashboard.waitForEvent('download');
    await dashboard.locator('#exportJson').click();
    const download = await downloadPromise;
    backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(backup.records.length, 7);
    await dashboard.locator('#importFile').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await dashboard.locator('#confirmAccept').click();
    await poll(() => dashboard.locator('#importFeedback').innerText(), text => text.includes('跳过 7'));
    assert.equal(await count(), 7);
    const csvPromise = dashboard.waitForEvent('download');
    await dashboard.locator('#exportCsv').click();
    const csv = await csvPromise;
    const bytes = fs.readFileSync(await csv.path());
    assert.equal(bytes.subarray(0,3).toString('hex'), 'efbbbf');
    assert(bytes.toString('utf8').includes('界面流程测试'));
  });
  await check('UI filter and permanent deletion require explicit confirmation', async () => {
    await dashboard.locator('#filterMode').selectOption('daily');
    await dashboard.locator('#filterForm').getByRole('button', { name: '筛选', exact: true }).click();
    await poll(() => dashboard.locator('#recordRows tr').count(), 2);
    await dashboard.locator('#resetFilters').click();
    const manual = (await snapshot()).records.find(r => r.source === 'manual');
    await api('SJ_DELETE', { ids: [manual.id] });
    await dashboard.locator('#refreshData').click();
    await dashboard.locator('#trashSection summary').click();
    await dashboard.locator('#purgeAll').click();
    assert.equal((await snapshot()).trash.length, 1);
    await dashboard.locator('#confirmCancel').click();
    assert.equal((await snapshot()).trash.length, 1);
    await dashboard.locator('#purgeAll').click();
    await dashboard.locator('#confirmAccept').click();
    await poll(async () => (await snapshot()).trash.length, 0);
    assert.equal(await count(), 6);
  });

  await check('Browser restart preserves committed records and record IDs', async () => {
    const before = (await snapshot()).records.map(r => r.id).sort();
    await context.close();
    await launch();
    assert.deepEqual((await snapshot()).records.map(r => r.id).sort(), before);
  });

  await check('Illustrative data renders with bounded rows on desktop and narrow screens', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const base = (await snapshot()).records[0];
    const demo = [];
    for (let i=0;i<166;i++) {
      const date = new Date(`${today}T12:00:00Z`); date.setUTCDate(date.getUTCDate() - Math.floor(i * 0.46));
      demo.push({ ...base, id: `demo-${i}`, localDate: date.toISOString().slice(0,10), completedAt: null,
        source: 'manual', variant: i%5===0?'killer':'classic', difficulty: ['extreme','master','expert','hard','medium','easy'][i%6],
        durationSeconds: null, mode: i%13===0?'daily':'regular', puzzleKey:null, note:'演示数据 · 不代表真实游玩成绩' });
    }
    await api('SJ_IMPORT', { backup: { app:'sudoku-journal', schemaVersion:1, records:demo } });
    await dashboard.locator('#refreshData').click();
    await poll(() => dashboard.locator('#recordRows tr').count(), 50);
    await dashboard.evaluate(() => window.scrollTo(0,0));
    await dashboard.screenshot({ path: path.join(qa, 'screenshots', 'dashboard-desktop.png'), fullPage: true });
    await dashboard.setViewportSize({ width:390, height:844 });
    await dashboard.screenshot({ path: path.join(qa, 'screenshots', 'dashboard-mobile.png'), fullPage: true });
    const overflow = await dashboard.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
    if (overflow) {
      report.overflow = await dashboard.evaluate(() => [...document.querySelectorAll('body *')].map(el=>({tag:el.tagName,id:el.id,cls:el.className,right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width,position:getComputedStyle(el).position})).filter(el=>el.right>innerWidth+2).slice(0,30));
      console.log('OVERFLOW '+JSON.stringify(report.overflow));
    }
    assert.equal(overflow, false, 'Page itself must not overflow; only the record table may scroll');
    await dashboard.setViewportSize({ width:1440, height:1100 });
    const popup = await context.newPage();
    await popup.setViewportSize({ width:420, height:720 });
    await popup.goto(`${origin}/popup.html`);
    await popup.waitForFunction(() => !document.body.innerText.includes('正在读取你的记录'));
    await popup.screenshot({ path:path.join(qa,'screenshots','popup.png'), fullPage:true });
    assert.equal(await popup.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
    await popup.close();
    report.demoRecordCount = await count();
  });

  await check('Keyboard, expanded support guide and high-contrast layout remain usable', async () => {
    await dashboard.bringToFront();
    await dashboard.locator('#addManual').focus();
    await dashboard.keyboard.press('Enter');
    assert.equal(await dashboard.locator('#manualDialog').evaluate(el=>el.open),true);
    assert.equal(await dashboard.locator('#manualDate').evaluate(el=>el===document.activeElement),true);
    await dashboard.keyboard.press('Escape');
    assert.equal(await dashboard.locator('#manualDialog').evaluate(el=>el.open),false);
    assert.equal(await dashboard.locator('#addManual').evaluate(el=>el===document.activeElement),true);
    const region=dashboard.locator('.record-scroll').first();
    await region.focus(); await dashboard.keyboard.press('PageDown');
    await poll(()=>region.evaluate(el=>el.scrollTop),value=>value>0);
    await dashboard.setViewportSize({width:390,height:844});
    await dashboard.locator('.support-guide summary').click();
    assert.equal(await dashboard.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
    await dashboard.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});
    await dashboard.evaluate(()=>window.scrollTo(0,0));
    await dashboard.screenshot({path:path.join(qa,'screenshots','high-contrast.png')});
    assert.equal(await dashboard.locator('#addManual').isVisible(),true);
    await dashboard.emulateMedia({forcedColors:'none',reducedMotion:'no-preference'});
    await dashboard.locator('.support-guide summary').click();
    await dashboard.setViewportSize({width:1440,height:1100});
  });

  if (process.argv.includes('--stress')) await check('50000 records keep the rendered table bounded and exceed-limit writes atomic', async () => {
    const active = (await snapshot()).records;
    await api('SJ_DELETE',{ids:active.map(r=>r.id)});
    await api('SJ_PURGE',{ids:active.map(r=>r.id)});
    const started=performance.now();
    const seeded = await dashboard.evaluate(async () => {
      const date=new Date().toISOString().slice(0,10);
      const records=Array.from({length:50000},(_,i)=>({id:`stress-${i}`,site:'sudoku.com',variant:i%2?'classic':'killer',difficulty:'extreme',mode:'regular',completedAt:null,localDate:date,timeZone:'Asia/Shanghai',durationSeconds:null,source:'manual',puzzleKey:null,note:'隔离压力测试'}));
      return chrome.runtime.sendMessage({type:'SJ_IMPORT',backup:{app:'sudoku-journal',schemaVersion:1,records}});
    });
    const importMs=Math.round(performance.now()-started);
    assert.equal(seeded.ok,true,seeded.error);
    const reloadStarted=performance.now();
    await dashboard.reload();
    await poll(()=>dashboard.locator('#totalCount').innerText(),'50,000',40000);
    const reloadMs=Math.round(performance.now()-reloadStarted);
    assert.equal(await dashboard.locator('#recordRows tr').count(),50);
    assert.equal(await dashboard.locator('#capacityNotice').isVisible(),true);
    const cdp=await context.newCDPSession(dashboard);
    await cdp.send('HeapProfiler.collectGarbage');
    const heap=await cdp.send('Runtime.getHeapUsage');
    const summaryStarted=performance.now();
    const popupData=await api('SJ_POPUP');
    const summaryMs=Math.round(performance.now()-summaryStarted);
    assert.equal(popupData.summary.total,50000);
    assert.equal(Object.hasOwn(popupData,'records'),false);
    report.stress={records:50000,renderedRows:50,importMs,reloadMs,loadMs:Math.round(performance.now()-started),dashboardJsHeapAfterGcMB:Math.round(heap.usedSize/1048576*10)/10,popupSummaryMs:summaryMs,popupSummaryBytes:Buffer.byteLength(JSON.stringify(popupData))};
    const invalid=await dashboard.evaluate(async()=>{const r={id:'stress-extra',site:'sudoku.com',variant:'classic',difficulty:'easy',mode:'regular',completedAt:null,localDate:new Date().toISOString().slice(0,10),timeZone:'Asia/Shanghai',durationSeconds:null,source:'manual',puzzleKey:null,note:''};return chrome.runtime.sendMessage({type:'SJ_ADD_MANUAL',record:r});});
    assert.equal(invalid.ok,false); assert(invalid.error.includes('50000'));
    assert.equal(await count(),50000);
    await cdp.detach();
  });
  await check('No uncaught extension UI errors', async()=>assert.deepEqual(report.errors,[]));
}

run().then(()=>{report.passed=true;}, error=>{report.passed=false;report.failure=error.stack;console.error(error.stack);process.exitCode=1;}).finally(async()=>{
  if(context) await context.close().catch(()=>{});
  fs.writeFileSync(path.join(qa,'browser-results.json'),JSON.stringify(report,null,2));
  const allowed=path.resolve(qa,'profiles')+path.sep;
  if(path.resolve(profile).startsWith(allowed)) fs.rmSync(profile,{recursive:true,force:true});
  console.log(`Report: ${path.join(qa,'browser-results.json')}`);
});
