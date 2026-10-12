'use strict';
const $=id=>document.getElementById(id);
let config=UFR.defaults(), draft=null, stagedHandle=null, folders=new Map();
const canvasPreset=()=>({name:'交大 Canvas · PDF 作业',domain:'oc.sjtu.edu.cn',includeSubdomains:true,pathPrefix:'/',type:'custom',customAccept:'.pdf',folderHint:'',enabled:true});
function status(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
async function send(message){const result=await chrome.runtime.sendMessage(message);if(!result?.ok)throw new Error(result?.error||'保存失败');return result.data;}
function selectorValid(selector){if(selector)document.createDocumentFragment().querySelector(selector);}
async function refresh() {
  config=UFR.normalizeConfig((await chrome.storage.local.get('config')).config||UFR.defaults());
  folders=new Map(await Promise.all(config.rules.map(async r=>[r.folderId,await FolderDB.get(r.folderId)])));
  renderRules();renderReuse();
}
function renderRules(){
  $('pause').textContent=config.enabled?'暂停全部':'恢复全部';$('rules').replaceChildren();
  if(!config.rules.length){const p=document.createElement('p');p.className='empty';p.textContent='先在右侧绑定文件夹，再保存第一条规则。已为你填入交大 Canvas 示例。';$('rules').append(p);}
  for(const rule of config.rules){
    const card=document.createElement('article');card.className=`rule${draft?.id===rule.id?' selected':''}`;
    const head=document.createElement('div');head.className='rule-title';const name=document.createElement('h3');name.textContent=rule.name;const tag=document.createElement('span');tag.className=`tag${!rule.enabled||!config.enabled?' off':''}`;tag.textContent=rule.enabled&&config.enabled?'已启用':'已暂停';head.append(name,tag);
    const site=document.createElement('p');site.textContent=`${rule.domain}${rule.includeSubdomains?' 及子域名':''} · ${rule.pathPrefix}`;
    const type=document.createElement('p');type.textContent=`${UFR.TYPES[rule.type].label}${rule.type==='custom'?` (${rule.customAccept})`:''}`;
    const folder=document.createElement('p');folder.textContent=folders.get(rule.folderId)?`文件夹：${folders.get(rule.folderId).name}`:'文件夹：待绑定';
    const actions=document.createElement('div');actions.className='actions';
    const edit=document.createElement('button');edit.textContent='编辑';edit.onclick=()=>editRule(rule);
    const toggle=document.createElement('button');toggle.textContent=rule.enabled?'暂停':'启用';toggle.onclick=async()=>{try{const next=structuredClone(config);next.rules.find(r=>r.id===rule.id).enabled=!rule.enabled;await persist(next);await refresh();status('规则状态已更新。');}catch(e){status(e.message,true)}};
    const remove=document.createElement('button');remove.textContent='删除';remove.className='danger';remove.onclick=async()=>{if(!confirm(`删除规则“${rule.name}”？这不会删除本地文件。`))return;try{const next={...config,rules:config.rules.filter(r=>r.id!==rule.id)};await persist(next);if(!next.rules.some(r=>r.folderId===rule.folderId))await FolderDB.remove(rule.folderId);if(draft?.id===rule.id)editRule();await refresh();status('规则已删除。')}catch(e){status(e.message,true)}};
    actions.append(edit,toggle,remove);card.append(head,site,type,folder,actions);$('rules').append(card);
  }
}
function renderReuse(){
  $('reuse').replaceChildren(new Option('或复用其他规则的文件夹…',''));
  const seen=new Set();for(const rule of config.rules){if(folders.get(rule.folderId)&&!seen.has(rule.folderId)){seen.add(rule.folderId);$('reuse').add(new Option(`${folders.get(rule.folderId).name} · ${rule.name}`,rule.folderId));}}
}
function showFolder(){const handle=stagedHandle||folders.get(draft.folderId);$('folder-name').textContent=handle?handle.name:'尚未绑定';$('folder-hint').textContent=handle?'已选择；保存规则后生效。':draft.folderHint?`请在弹出的窗口中选择：${draft.folderHint}`:'请选一个你希望上传时打开的文件夹。';$('bind').textContent=handle?'更换文件夹':'选择并绑定文件夹';}
function editRule(rule){
  draft=UFR.normalizeRule(rule||{domain:'example.com'});if(!rule)draft.domain='';stagedHandle=null;
  $('name').value=rule?draft.name:'';$('domain').value=draft.domain;$('subdomains').checked=draft.includeSubdomains;$('path').value=draft.pathPrefix;$('file-type').value=draft.type;$('custom').value=draft.customAccept;$('selector').value=draft.selector;$('enabled').checked=draft.enabled;
  $('editor-title').textContent=config.rules.some(r=>r.id===draft.id)?'编辑规则':'添加规则';$('custom-field').hidden=draft.type!=='custom';renderRules();renderReuse();showFolder();
}
function readDraft(){const rule=UFR.normalizeRule({...draft,name:$('name').value,domain:$('domain').value,includeSubdomains:$('subdomains').checked,pathPrefix:$('path').value,type:$('file-type').value,customAccept:$('custom').value,selector:$('selector').value,enabled:$('enabled').checked});selectorValid(rule.selector);return rule;}
async function persist(next){
  const normalized=UFR.normalizeConfig(next);
  const origins=[...new Set(normalized.rules.filter(r=>normalized.enabled&&r.enabled).flatMap(UFR.patterns))];
  // Called directly from the user gesture, before any unrelated asynchronous operation.
  if(origins.length&&!await chrome.permissions.request({origins}))throw new Error('网站权限未获允许，规则没有保存。');
  return send({type:'UFR_SAVE',config:normalized});
}
for(const [value,type] of Object.entries(UFR.TYPES))$('file-type').add(new Option(type.label,value));
$('file-type').onchange=()=>{$('custom-field').hidden=$('file-type').value!=='custom'};
$('new').onclick=()=>editRule();$('canvas-preset').onclick=()=>{editRule(canvasPreset());status('示例覆盖 oc.sjtu.edu.cn 的所有课程。请选择你的作业文件夹，然后保存。')};
$('bind').onclick=async()=>{try{const handle=await showDirectoryPicker({mode:'read',id:'ufr-bind'});stagedHandle=handle;draft.folderId=draft.id;draft.folderName=handle.name;showFolder();status('文件夹已选择，点击保存规则完成设置。')}catch(error){if(error.name!=='AbortError')status(`文件夹选择失败：${error.message}`,true)}};
$('reuse').onchange=()=>{const id=$('reuse').value;if(!id)return;stagedHandle=null;draft.folderId=id;draft.folderName=folders.get(id).name;showFolder();};
$('editor').onsubmit=async event=>{
  event.preventDefault();let oldHandle,rule;
  try {
    rule=readDraft();const handle=stagedHandle||folders.get(rule.folderId);if(!handle)throw new Error('请先选择并绑定一个文件夹。');rule.folderName=handle.name;
    const next=structuredClone(config);const index=next.rules.findIndex(r=>r.id===rule.id);if(index<0)next.rules.push(rule);else next.rules[index]=rule;
    const origins=[...new Set(next.rules.filter(r=>next.enabled&&r.enabled).flatMap(UFR.patterns))];
    if(origins.length&&!await chrome.permissions.request({origins}))throw new Error('网站权限未获允许，规则没有保存。');
    $('save').disabled=true;oldHandle=await FolderDB.get(rule.folderId);await FolderDB.put(rule.folderId,handle);
    try{await send({type:'UFR_SAVE',config:next});}catch(error){if(oldHandle)await FolderDB.put(rule.folderId,oldHandle);else await FolderDB.remove(rule.folderId);throw error;}
    await refresh();editRule(config.rules.find(r=>r.id===rule.id));status('已保存。请刷新目标网页，再点击上传试用。');
  } catch(error){status(error.message,true);}finally{$('save').disabled=false;}
};
$('pause').onclick=async()=>{try{await persist({...config,enabled:!config.enabled});await refresh();status(config.enabled?'已恢复。':'已暂停，之后点击上传会使用网页原方式。')}catch(e){status(e.message,true)}};
$('export').onclick=()=>{const data={version:1,enabled:config.enabled,rules:config.rules.map(({folderHint,folderName,folderId,...rule})=>({...rule,folderId:rule.id}))};const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='upload-folder-rules.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status('已导出规则，不包含本地路径、文件夹授权或文件内容。');};
$('import').onclick=()=>$('import-file').click();
$('import-file').onchange=async()=>{try{const file=$('import-file').files[0];if(!file)return;if(file.size>1024*1024)throw new Error('规则文件过大，最多 1 MB。');const imported=UFR.normalizeConfig(JSON.parse(await file.text()));const added=imported.rules.map(rule=>{selectorValid(rule.selector);const id=crypto.randomUUID();return {...rule,id,folderId:id,folderName:'',folderHint:'',enabled:false}});await send({type:'UFR_SAVE',config:{...config,rules:[...config.rules,...added]}});await refresh();if(added.length)editRule(added[0]);status(`已追加 ${added.length} 条规则，默认暂停。请绑定文件夹并启用。`);}catch(e){status(e.message,true)}finally{$('import-file').value=''}};
refresh().then(()=>editRule(config.rules[0]||canvasPreset())).catch(e=>status(e.message,true));
