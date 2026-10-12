/* Stores directory handles only. Selected files and their bytes are never written here. */
const FolderDB = (() => {
  let opening;
  function open() {
    return opening ||= new Promise((resolve,reject) => {
      const request = indexedDB.open('upload-folder-rules',1);
      request.onupgradeneeded = () => request.result.createObjectStore('folders');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { opening = null; reject(request.error); };
    });
  }
  async function transaction(mode, action) {
    const db=await open();
    return new Promise((resolve,reject) => {
      const tx=db.transaction('folders',mode); const request=action(tx.objectStore('folders'));
      tx.oncomplete=()=>resolve(request.result); tx.onabort=()=>reject(tx.error || new Error('文件夹记录保存失败')); tx.onerror=()=>reject(tx.error);
    });
  }
  return { get:id=>transaction('readonly',s=>s.get(id)), put:(id,handle)=>transaction('readwrite',s=>s.put(handle,id)), remove:id=>transaction('readwrite',s=>s.delete(id)) };
})();
