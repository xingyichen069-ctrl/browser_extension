'use strict';
const $=id=>document.getElementById(id), id=location.hash.slice(1);
let session=null,handles=new Map(), busy=false, channel;
const selected=()=>session.rules.find(r=>r.id===$('rule').value);
const status=(text,error=false)=>{$('status').textContent=text;$('status').classList.toggle('error',error)};
async function send(message){const result=await chrome.runtime.sendMessage(message);if(!result?.ok)throw new Error(result?.error||'扩展未响应');return result.data;}
function setBusy(value){busy=value;for(const key of ['choose','bind','rule'])$(key).disabled=value; if(!value)$('choose').disabled=!handles.get(selected().folderId);}
function render(){const rule=selected(),handle=handles.get(rule.folderId);$('folder-name').textContent=handle?handle.name:'请先绑定文件夹';$('folder-hint').textContent=handle?'每次都以这个文件夹作为起始位置。':rule.folderHint||'选择一次，之后在同一网站复用。';$('bind').textContent=handle?'更换绑定文件夹':'选择并绑定文件夹';$('accept').textContent=`${session.input.multiple?'可选择多个文件':'每次选择一个文件'} · ${session.input.accept?`网页声明：${session.input.accept}`:`网页未指定类型，当前规则：${UFR.acceptFor(rule)||'所有文件'}`}`;setBusy(false);}
$('rule').onchange=()=>{status('');render()};
$('bind').onclick=async()=>{if(busy)return;const rule=selected();try{const handle=await showDirectoryPicker({mode:'read',id:'ufr-bind'});setBusy(true);await FolderDB.put(rule.folderId,handle);handles.set(rule.folderId,handle);await send({type:'UFR_BOUND',id,ruleId:rule.id,name:handle.name});render();status('已绑定。现在可以选择文件。');}catch(error){if(error.name!=='AbortError')status(`绑定失败：${error.message}`,true);setBusy(false)}};
$('choose').onclick=async()=>{
  if(busy)return;const rule=selected(),handle=handles.get(rule.folderId);if(!handle)return;
  const options={startIn:handle,multiple:session.input.multiple};
  const types=UFR.pickerTypes(session.input.accept||UFR.acceptFor(rule));if(types)options.types=types;
  try {
    // Do not put an await before this call: the native picker requires this click's user activation.
    const picking=showOpenFilePicker(options);setBusy(true);status('');
    const picked=await picking;const files=await Promise.all(picked.map(item=>item.getFile()));
    if(!files.length){setBusy(false);return;}
    const mismatch=files.filter(file=>!UFR.acceptsFile(file,session.input.accept));
    if(mismatch.length){status(`这些文件不符合网页声明的类型：${mismatch.map(f=>f.name).join('、')}。请重新选择，或使用网页原上传方式。`,true);setBusy(false);return;}
    $('picked').textContent=`已选择：${files.map(f=>f.name).join('、')}`;
    channel.postMessage({type:'UFR_FILES',id,files});status('正在交给网页…');
    setTimeout(()=>{if(busy) {status('网页尚未确认接收，可能已刷新或阻止连接。请回到网页检查，避免重复上传。',true);}},10000);
  } catch(error){
    if(error.name!=='AbortError')status(`无法打开或读取文件：${error.message}。可重新绑定文件夹，或使用网页原上传方式。`,true);
    setBusy(false);
  }
};
$('cancel').onclick=()=>send({type:'UFR_CANCEL',id}).catch(()=>window.close());
(async()=>{try{
  session=await send({type:'UFR_SESSION',id});const target=new URL(session.url);$('target').textContent=`将交给：${target.host}${target.pathname}`;
  for(const rule of session.rules){$('rule').add(new Option(rule.name,rule.id));handles.set(rule.folderId,await FolderDB.get(rule.folderId));}
  channel=new BroadcastChannel(`ufr-files-${id}`);
  channel.onmessage=event=>{if(event.data?.id!==id)return;if(event.data.type==='UFR_ACK'){status('已交给网页。');busy=false;}if(event.data.type==='UFR_ERROR'){status(event.data.error,true);setBusy(false)}};
  window.addEventListener('pagehide',()=>channel.close(),{once:true});render();
}catch(error){status(error.message,true);$('folder-name').textContent='连接已结束';}})();
