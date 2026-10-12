'use strict';
importScripts('core.js');
const PREFIX='request:';
const extensionRoot=chrome.runtime.getURL('');
const getConfig=async()=>UFR.normalizeConfig((await chrome.storage.local.get('config')).config || UFR.defaults());
let jobs=Promise.resolve();
function runJob(action){const next=jobs.catch(()=>{}).then(action);jobs=next;return next;}
let syncing=Promise.resolve();
function syncScripts() {
  const next=syncing.catch(()=>{}).then(registerScripts);syncing=next;return next;
}
async function registerScripts() {
  const origins=(await chrome.permissions.getAll()).origins || [];
  const ids=['ufr-content','ufr-hook'];
  await chrome.scripting.unregisterContentScripts({ids}).catch(()=>{});
  if (!origins.length) return;
  await chrome.scripting.registerContentScripts([
    {id:ids[0],matches:origins,js:['core.js','content.js'],runAt:'document_start',allFrames:true,world:'ISOLATED'},
    {id:ids[1],matches:origins,js:['main-hook.js'],runAt:'document_start',allFrames:true,world:'MAIN'}
  ]);
}
async function initialize() {
  if (!(await chrome.storage.local.get('config')).config) await chrome.storage.local.set({config:UFR.defaults()});
  await syncScripts();
}
chrome.runtime.onInstalled.addListener(()=>initialize().catch(console.error));
chrome.runtime.onStartup.addListener(()=>syncScripts().catch(console.error));
chrome.permissions.onAdded.addListener(()=>syncScripts().catch(console.error));
chrome.permissions.onRemoved.addListener(()=>syncScripts().catch(console.error));
chrome.action.onClicked.addListener(()=>chrome.runtime.openOptionsPage());
function optionsSender(sender) { return sender.url?.split(/[?#]/)[0] === `${extensionRoot}options.html`; }
function pickerSender(sender,id) { return sender.url === `${extensionRoot}picker.html#${id}`; }
async function finish(id, kind='cancel') {
  const key=PREFIX+id, session=(await chrome.storage.session.get(key))[key];
  if (!session) return;
  await chrome.storage.session.remove(key);
  await chrome.tabs.sendMessage(session.tabId,{type:'UFR_FINISHED',id,kind},{frameId:session.frameId}).catch(()=>{});
  if (session.windowId) await chrome.windows.remove(session.windowId).catch(()=>{});
}
async function route(message,sender) {
  if (!message || typeof message.type !== 'string') return;
  if (message.type==='UFR_SAVE') {
    if (!optionsSender(sender)) throw new Error('只有规则管理页能保存设置。');
    const config=UFR.normalizeConfig(message.config);
    for (const rule of config.rules.filter(r=>config.enabled&&r.enabled)) if (!await chrome.permissions.contains({origins:UFR.patterns(rule)})) throw new Error(`尚未获得 ${rule.domain} 的网站权限。`);
    await chrome.storage.local.set({config}); await syncScripts(); return config;
  }
  if (message.type==='UFR_OPEN') {
    if (!sender.tab?.id || !/^https?:/.test(sender.url || '') || !/^[a-f0-9-]{36}$/.test(message.id || '')) throw new Error('上传请求无效。');
    const config=await getConfig();
    const input={accept:String(message.accept || '').slice(0,4000),multiple:message.multiple===true,selectorIds:Array.isArray(message.selectorIds)?message.selectorIds:[]};
    const rules=UFR.candidates(config,sender.url,input);
    if (!rules.length) throw new Error('没有匹配且已启用的规则，请刷新页面后重试。');
    const sessions=await chrome.storage.session.get(null);
    for (const [key,old] of Object.entries(sessions)) if (key.startsWith(PREFIX) && (Date.now()-old.createdAt>30*60*1000 || (old.tabId===sender.tab.id && old.frameId===sender.frameId))) await finish(old.id);
    const session={id:message.id,tabId:sender.tab.id,frameId:sender.frameId,url:sender.url,input,ruleIds:rules.map(r=>r.id),createdAt:Date.now()};
    await chrome.storage.session.set({[PREFIX+session.id]:session});
    try {
      const window=await chrome.windows.create({url:`${extensionRoot}picker.html#${session.id}`,type:'popup',width:620,height:650,focused:true});
      session.windowId=window.id; await chrome.storage.session.set({[PREFIX+session.id]:session});
    } catch(error) { await finish(session.id); throw error; }
    return {id:session.id};
  }
  if (message.type==='UFR_SESSION') {
    if (!pickerSender(sender,message.id)) throw new Error('请求来源不正确。');
    const key=PREFIX+message.id, session=(await chrome.storage.session.get(key))[key];
    if (!session || Date.now()-session.createdAt>30*60*1000) throw new Error('上传请求已结束，请回网页重新点击上传。');
    const config=await getConfig();
    if (!config.enabled) throw new Error('扩展已暂停。');
    const rules=session.ruleIds.map(id=>config.rules.find(r=>r.id===id && r.enabled)).filter(Boolean);
    if (!rules.length) throw new Error('匹配规则已被删除或停用。');
    return {...session,rules};
  }
  if (message.type==='UFR_BOUND') {
    const config=await getConfig(); const key=PREFIX+message.id,session=(await chrome.storage.session.get(key))[key];
    if (!pickerSender(sender,message.id) || !session?.ruleIds.includes(message.ruleId)) throw new Error('无效的文件夹绑定请求。');
    const rule=config.rules.find(r=>r.id===message.ruleId); if (!rule) throw new Error('规则已删除。');
    rule.folderName=String(message.name || '').slice(0,255); await chrome.storage.local.set({config}); return true;
  }
  if (message.type==='UFR_DONE' || message.type==='UFR_CANCEL') {
    const key=PREFIX+message.id,session=(await chrome.storage.session.get(key))[key];
    if (!session) return true;
    const fromContent=sender.tab?.id===session.tabId && sender.frameId===session.frameId && new URL(sender.url).origin===new URL(session.url).origin;
    if (!fromContent && !pickerSender(sender,message.id)) throw new Error('不能结束其他网页的上传请求。');
    await finish(message.id,message.type==='UFR_DONE'?'done':'cancel'); return true;
  }
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{runJob(()=>route(message,sender)).then(data=>respond({ok:true,data}),error=>respond({ok:false,error:error.message}));return true;});
chrome.windows.onRemoved.addListener(windowId=>runJob(async()=>{
  const sessions=await chrome.storage.session.get(null);
  for(const [key,session] of Object.entries(sessions)) if(key.startsWith(PREFIX)&&session.windowId===windowId) await finish(session.id);
}).catch(console.error));
chrome.tabs.onRemoved.addListener(tabId=>runJob(async()=>{
  const sessions=await chrome.storage.session.get(null);
  for(const [key,session] of Object.entries(sessions)) if(key.startsWith(PREFIX)&&session.tabId===tabId) await finish(session.id);
}).catch(console.error));
