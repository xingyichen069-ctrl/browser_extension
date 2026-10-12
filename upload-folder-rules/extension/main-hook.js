/* showPicker() does not dispatch click. Let the isolated script claim file inputs synchronously. */
(() => {
  const prototype=HTMLInputElement.prototype;
  const original=prototype.showPicker;
  if (!original || original.__ufr) return;
  function showPicker(...args) {
    if (this instanceof HTMLInputElement && this.type==='file' && navigator.userActivation.isActive) {
      const event=new Event('ufr-request-picker',{bubbles:true,composed:true,cancelable:true});
      if (!this.dispatchEvent(event)) return;
    }
    return Reflect.apply(original,this,args);
  }
  Object.defineProperty(showPicker,'__ufr',{value:true});
  Object.defineProperty(prototype,'showPicker',{...Object.getOwnPropertyDescriptor(prototype,'showPicker'),value:showPicker});
})();
