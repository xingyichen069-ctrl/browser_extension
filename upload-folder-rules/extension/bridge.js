'use strict';
// No filesystem API and no data storage: only the files explicitly selected for this request.
const [requestId,encodedOrigin]=(location.hash.slice(1)).split('?');
let parentOrigin='';try{parentOrigin=decodeURIComponent(encodedOrigin||'');}catch{}
if (/^[a-f0-9-]{36}$/.test(requestId) && /^https?:\/\//.test(parentOrigin) && parent!==window) {
  const channel=new BroadcastChannel(`ufr-files-${requestId}`);
  channel.onmessage=event=>{if(event.data?.type==='UFR_FILES'&&event.data.id===requestId)parent.postMessage(event.data,parentOrigin);};
  window.addEventListener('message',event=>{if(event.source===parent&&event.origin===parentOrigin&&event.data?.id===requestId&&['UFR_ACK','UFR_ERROR'].includes(event.data.type))channel.postMessage(event.data);});
  parent.postMessage({type:'UFR_BRIDGE_READY',id:requestId},parentOrigin);
  window.addEventListener('pagehide',()=>channel.close(),{once:true});
}
