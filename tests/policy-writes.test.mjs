import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const sources = Object.fromEntries(await Promise.all(['core','policy','stats','history'].map(async name => [name+'.js',await readFile(new URL(`../src/${name}.js`,import.meta.url),'utf8')])));
const worker = await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
function harness(initial = {}, managed = {}) {
  let listener, fail = false;
  const saved = { policy: initial };
  const context = vm.createContext({URL, chrome:{
    runtime:{id:'test-extension',onMessage:{addListener:value=>{listener=value;}}},
    storage:{local:{get:async()=>{await new Promise(setImmediate);return structuredClone(saved);},
      set:async value=>{await new Promise(setImmediate);if(fail)throw new Error('write failed');Object.assign(saved,structuredClone(value));}},
      managed:{get:async()=>structuredClone(managed)}}},
    importScripts:(...names)=>names.forEach(name=>vm.runInContext(sources[name],context))});
  vm.runInContext(worker,context);
  const sender={id:'test-extension',url:'chrome-extension://test-extension/composer.html'};
  return {saved,context,setFailure:value=>{fail=value;},send:(change,source=sender)=>new Promise(resolve=>listener({type:'ckretguard-policy',change},source,resolve))};
}
test('concurrent policy changes preserve every field and independent settings',async()=>{
  const state=harness({sensitiveNames:['initial_field']});
  const replies=await Promise.all([
    ...Array.from({length:20},(_,i)=>state.send({kind:'addField',name:'dataset'+i})),
    state.send({kind:'set',key:'mode',value:'block'}),
    state.send({kind:'set',key:'protectClientIds',value:false}),
    state.send({kind:'removeField',name:'initial_field'}),
  ]);
  assert.ok(replies.every(reply=>reply.ok));
  assert.equal(state.saved.policy.sensitiveNames.length,20);
  assert.equal(new Set(state.saved.policy.sensitiveNames).size,20);
  assert.equal(state.saved.policy.mode,'block');
  assert.equal(state.saved.policy.protectClientIds,false);
});
test('policy writes reject duplicate, invalid, full and managed field changes',async()=>{
  const state=harness({sensitiveNames:['dataset1']});
  assert.equal((await state.send({kind:'addField',name:'DATASET1'})).error,'duplicate');
  for(const name of ['ab','1bad','key=value','a'.repeat(65)]) assert.equal((await state.send({kind:'addField',name})).error,'invalid');
  const full=harness({sensitiveNames:Array.from({length:50},(_,i)=>'dataset'+i)});
  assert.equal((await full.send({kind:'addField',name:'overflow_field'})).error,'limit');
  const locked=harness({}, {sensitiveNames:['org_field'],mode:'block'});
  assert.equal((await locked.send({kind:'addField',name:'local_field'})).error,'managed');
  assert.equal((await locked.send({kind:'set',key:'mode',value:'redact'})).error,'managed');
  assert.equal((await locked.send({kind:'set',key:'protectClientIds',value:false})).ok,true);
  assert.deepEqual(locked.saved.policy,{protectClientIds:false});
});
test('only this extension dashboard can mutate policy and failed writes permit retry',async()=>{
  const state=harness();
  for(const source of [{id:'other',url:'chrome-extension://test-extension/composer.html'},
    {id:'test-extension',url:'https://chatgpt.com/'},{id:'test-extension',url:'chrome-extension://test-extension/other.html'}]) {
    assert.equal((await state.send({kind:'set',key:'mode',value:'block'},source)).ok,false);
  }
  state.setFailure(true);
  assert.equal((await state.send({kind:'addField',name:'dataset1'})).ok,false);
  state.setFailure(false);
  assert.equal((await state.send({kind:'addField',name:'dataset1'})).ok,true);
  assert.deepEqual(state.saved.policy.sensitiveNames,['dataset1']);
});
