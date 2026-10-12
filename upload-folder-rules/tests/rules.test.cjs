const test=require('node:test');
const assert=require('node:assert/strict');
require('../extension/core.js');
const C=globalThis.UFR;
const rule=(patch={})=>C.normalizeRule({id:'r1',domain:'oc.sjtu.edu.cn',type:'custom',customAccept:'.pdf',...patch});
const config=rules=>C.normalizeConfig({version:1,enabled:true,rules});
test('Canvas course IDs do not affect an all-pages rule',()=>{
  for(const path of ['/courses/98447','/courses/100000/assignments/77','/dashboard'])assert.equal(C.siteMatches('https://oc.sjtu.edu.cn'+path,rule()),true);
});
test('domain suffix has a dot boundary and respects opt-out',()=>{
  assert.equal(C.siteMatches('https://a.oc.sjtu.edu.cn/courses',rule()),true);
  for(const host of ['eviloc.sjtu.edu.cn','oc.sjtu.edu.cn.evil.test','sjtu.edu.cn','other.sjtu.edu.cn'])assert.equal(C.siteMatches(`https://${host}/`,rule()),false);
  assert.equal(C.siteMatches('https://a.oc.sjtu.edu.cn/',rule({includeSubdomains:false})),false);
});
test('URL paste extracts domain, supports IDN and rejects credentials or wildcard injection',()=>{
  assert.equal(C.domain('https://oc.sjtu.edu.cn/courses/98447'),'oc.sjtu.edu.cn');
  assert.equal(C.domain('EXAMPLE.COM.'),'example.com');
  assert.match(C.domain('例子.中国'),/^xn--/);
  for(const value of ['https://user:pass@host.test','*','file:///tmp','x.*.test','https://x.test:8080'])assert.throws(()=>C.domain(value));
});
test('path rules distinguish /courses from /courses-evil',()=>{
  const r=rule({pathPrefix:'/courses'});for(const p of ['/courses','/courses/98447'])assert.equal(C.siteMatches('https://oc.sjtu.edu.cn'+p,r),true);
  assert.equal(C.siteMatches('https://oc.sjtu.edu.cn/courses-evil',r),false);
});
test('PDF extension and PDF MIME both match a PDF rule',()=>{
  for(const accept of ['.PDF','application/pdf','.docx, .pdf'])assert.equal(C.candidates(config([rule()]),'https://oc.sjtu.edu.cn/',{accept}).length,1);
  assert.equal(C.candidates(config([rule()]),'https://oc.sjtu.edu.cn/',{accept:'image/*'}).length,0);
});
test('typed rules outrank generic rules when accept identifies the type',()=>{
  const rules=[rule({id:'any',type:'any'}),rule({id:'pdf'})];assert.equal(C.candidates(config(rules),'https://oc.sjtu.edu.cn/',{accept:'.pdf'})[0].id,'pdf');
  assert.equal(C.candidates(config(rules),'https://oc.sjtu.edu.cn/',{accept:''})[0].id,'any');
});
test('specific path, domain, and selector outrank broader matches',()=>{
  const rules=[rule({id:'parent',domain:'sjtu.edu.cn'}),rule({id:'site'}),rule({id:'path',pathPrefix:'/courses'}),rule({id:'control',pathPrefix:'/courses',selector:'#homework'})];
  assert.deepEqual(C.candidates(config(rules),'https://oc.sjtu.edu.cn/courses/42',{accept:'.pdf',selectorIds:['control']}).map(r=>r.id),['control','path','site','parent']);
  assert.equal(C.candidates(config(rules),'https://oc.sjtu.edu.cn/courses/42',{accept:'.pdf'})[0].id,'path');
});
test('disabled rules and global pause yield no candidates',()=>{
  assert.deepEqual(C.candidates(config([rule({enabled:false})]),'https://oc.sjtu.edu.cn/'),[]);
  assert.deepEqual(C.candidates({...config([rule()]),enabled:false},'https://oc.sjtu.edu.cn/'),[]);
});
test('unknown accept keeps possible rules available; insertion order breaks ties',()=>{
  const rules=[rule({id:'first'}),rule({id:'second',type:'images'})];assert.deepEqual(C.candidates(config(rules),'https://oc.sjtu.edu.cn/',{accept:''}).map(r=>r.id),['first','second']);
});
test('custom types validate, duplicated IDs and oversized imports fail',()=>{
  for(const customAccept of ['', '*.pdf','pdf','a/b/c'])assert.throws(()=>rule({customAccept}));
  assert.throws(()=>config([rule(),rule()]));assert.throws(()=>config(Array.from({length:301},(_,i)=>rule({id:'r'+i}))));assert.throws(()=>C.normalizeConfig({version:2,rules:[]}));
});
test('picker filters preserve arbitrary extensions and known MIME',()=>{
  assert.deepEqual(C.pickerTypes('.pdf,.cmo3,image/*')[0].accept,{'application/pdf':['.pdf'],'application/octet-stream':['.cmo3'],'image/*':[]});
  assert.equal(C.pickerTypes(''),undefined);
});
test('file validation supports suffixes, compound extensions, and empty MIME',()=>{
  assert.equal(C.acceptsFile({name:'homework.PDF',type:''},'application/pdf'),true);
  assert.equal(C.acceptsFile({name:'source.tar.gz',type:''},'.tar.gz'),true);
  assert.equal(C.acceptsFile({name:'image.PNG',type:''},'image/*'),true);
  assert.equal(C.acceptsFile({name:'malware.exe',type:''},'.pdf'),false);
});
test('source IDs, names, and absolute folder hints are data only',()=>{
  const r=rule({name:'<script>evil()</script>',folderHint:"D:\\Documents\\Assignments"});assert.equal(r.folderHint,"D:\\Documents\\Assignments");assert.match(r.name,/<script>/);assert.throws(()=>rule({id:'x#y'}));
});
