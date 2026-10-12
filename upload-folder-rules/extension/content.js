(() => {
  if (globalThis.__ufrContent) return;
  globalThis.__ufrContent=true;
  let config=UFR.defaults(), pending=null, bypass=false;
  const extensionOrigin=chrome.runtime.getURL('').replace(/\/$/,'');
  chrome.storage.local.get('config').then(data=>{config=UFR.normalizeConfig(data.config||UFR.defaults());}).catch(()=>{});
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.config) {try {config=UFR.normalizeConfig(changes.config.newValue);}catch{config=UFR.defaults();}}});
  function send(message) {return chrome.runtime.sendMessage(message).then(r=>{if(!r?.ok) throw new Error(r?.error||'扩展未响应');return r.data;});}
  function clear() {if(!pending)return;clearTimeout(pending.timeout);pending.host.remove();pending=null;}
  function cancel() {if(pending)send({type:'UFR_CANCEL',id:pending.id}).catch(()=>{});clear();}
  function native(input) {
    cancel();bypass=true;
    try {input.click();}finally{bypass=false;}
  }
  function show(input,rules,selectorIds) {
    cancel();
    const id=crypto.randomUUID();
    const host=document.createElement('div');host.style.cssText='all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;max-width:calc(100vw - 40px)';
    const shadow=host.attachShadow({mode:'open'});
    const card=document.createElement('div');card.style.cssText='font:14px/1.6 system-ui,sans-serif;color:#16312b;background:#fff;border:1px solid #c7d8d1;border-radius:14px;padding:18px;box-shadow:0 8px 35px #001e2330;width:320px;max-width:calc(100vw - 80px)';
    const title=document.createElement('strong');title.textContent='上传文件夹规则';
    const status=document.createElement('p');status.textContent='正在打开选文件窗口…';status.style.margin='8px 0 12px';
    const fallback=document.createElement('button');fallback.textContent='使用原上传方式';fallback.type='button';
    const close=document.createElement('button');close.textContent='取消';close.type='button';
    for(const button of [fallback,close])button.style.cssText='font:inherit;padding:6px 10px;margin-right:8px;border:1px solid #b3c5bf;border-radius:7px;background:#f1f6f3;cursor:pointer;color:#16312b';
    fallback.addEventListener('click',()=>native(input));close.addEventListener('click',cancel);
    card.append(title,status,fallback,close);shadow.append(card);
    const frame=document.createElement('iframe');frame.title='上传文件传递';frame.hidden=true;
    frame.src=`${extensionOrigin}/bridge.html#${id}?${encodeURIComponent(location.origin)}`;
    pending={id,input,host,status,frame,rules,selectorIds,opened:false,timeout:setTimeout(()=>{if(pending?.id===id&&!pending.opened)status.textContent='网页可能阻止了扩展连接，请使用原上传方式。';},6000)};
    shadow.append(frame);document.documentElement.append(host);
  }
  function intercept(event) {
    if(bypass || !config.enabled || (!event.isTrusted&&!navigator.userActivation.isActive))return;
    const input=event.composedPath().find(node=>node instanceof HTMLInputElement&&node.type==='file');
    if(!input || input.disabled || input.webkitdirectory || input.hasAttribute('capture') || !input.isConnected)return;
    const selectorIds=config.rules.filter(r=>r.selector&&(()=>{try{return input.matches(r.selector)}catch{return false}})()).map(r=>r.id);
    const rules=UFR.candidates(config,location.href,{accept:input.accept,selectorIds});
    if(!rules.length || !event.cancelable)return;
    event.preventDefault(); // Keep the site's own click listeners; suppress only the native default picker.
    if(pending?.input===input)return;
    show(input,rules,selectorIds);
  }
  window.addEventListener('click',intercept,true);
  window.addEventListener('ufr-request-picker',intercept,true);
  window.addEventListener('pagehide',cancel);
  window.addEventListener('message',async event=>{
    const current=pending;
    if(!current || event.source!==current.frame.contentWindow || event.origin!==extensionOrigin || event.data?.id!==current.id)return;
    if(event.data.type==='UFR_BRIDGE_READY'&&!current.opened) {
      current.opened=true;clearTimeout(current.timeout);
      try {await send({type:'UFR_OPEN',id:current.id,accept:current.input.accept,multiple:current.input.multiple,selectorIds:current.selectorIds});current.status.textContent='在扩展窗口中选择文件；选好后会交给当前网页。';}
      catch(error){current.status.textContent=error.message+'。可使用原上传方式。';}
    }
    if(event.data.type==='UFR_FILES') {
      try {
        const input=current.input, files=event.data.files;
        if(!config.enabled)throw new Error('扩展已暂停，请重新点击上传。');
        if(!input.isConnected || input.type!=='file' || input.disabled)throw new Error('原上传控件已变化，请重新点击上传。');
        if(!Array.isArray(files)||!files.length||files.some(f=>!(f instanceof File))||(!input.multiple&&files.length>1))throw new Error('选中的文件与上传控件不匹配。');
        const transfer=new DataTransfer();for(const file of files)transfer.items.add(file);input.files=transfer.files;
        input.dispatchEvent(new Event('input',{bubbles:true,composed:true}));input.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
        current.frame.contentWindow.postMessage({type:'UFR_ACK',id:current.id},extensionOrigin);
        await send({type:'UFR_DONE',id:current.id});if(pending?.id===current.id)clear();
      } catch(error) {current.status.textContent=error.message;current.frame.contentWindow.postMessage({type:'UFR_ERROR',id:current.id,error:error.message},extensionOrigin);}
    }
  });
  chrome.runtime.onMessage.addListener(message=>{if(message.type==='UFR_FINISHED'&&pending?.id===message.id)clear();});
})();
