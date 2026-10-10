'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {cloneData,recordPrototype}=require('../apps/desktop/data-only.cjs');
const {createAssetSourceAuthority,createAssetSourceConsumer,missingSource,authenticatedSource}=require('../apps/desktop/asset-source-observation.cjs');
test('data clone accepts cross-realm frozen plain records, arrays and null records without retaining aliases',()=>{
 const raw=vm.runInNewContext('Object.freeze({a:Object.freeze([1,true,null,{b:"text"}]),n:Object.assign(Object.create(null),{c:2})})');
 const copy=cloneData(raw);assert.deepEqual(copy,{a:[1,true,null,{b:'text'}],n:{c:2}});assert.notEqual(copy.a,raw.a);copy.a[3].b='changed';assert.equal(raw.a[3].b,'text');
 const record=JSON.parse('{"__proto__":{"polluted":true},"constructor":"data"}');
 const result=cloneData(record);assert.equal(Object.getPrototypeOf(result),Object.prototype);assert.equal(Object.hasOwn(result,'__proto__'),true);assert.equal({}.polluted,undefined);
});
test('data clone rejects getters, proxies and own serializers without invoking them',()=>{
 let calls=0;const record={};Object.defineProperty(record,'a',{enumerable:true,get(){calls++;return 1;}});
 const proxy=new Proxy({}, {ownKeys(){calls++;return [];},getPrototypeOf(){calls++;return Object.prototype;}});
 for(const value of [record,proxy,{toJSON(){calls++;return {};}}])assert.throws(()=>cloneData(value),/DATA_ONLY_REQUIRED/);
 assert.equal(calls,0);assert.throws(()=>recordPrototype(proxy),/DATA_ONLY_REQUIRED/);assert.equal(calls,0);
});
test('data clone rejects sparse, extra-property and bounded cyclic structures',()=>{
 const sparse=new Array(1),extra=[];extra.extra=1;const cycle={};cycle.self=cycle;
 for(const value of [sparse,extra,cycle,new Array(129).fill(0),{a:-1},{a:NaN},'x'.repeat(65537)])assert.throws(()=>cloneData(value),/DATA_ONLY_REQUIRED/);
 assert.equal(cloneData(new Array(128).fill(0)).length,128);
});
test('source reader preserves authentic cross-realm missing observation and freezes snapshot',async()=>{
 const expected={launchNonce:'data-only-positive',mainPid:12345,webContentsId:23};
 const observe=()=>missingSource('NO_MANAGED_LAUNCH');
 const producer=createAssetSourceAuthority({...expected,observe},'test-secret');
 const reader=createAssetSourceConsumer(expected,'test-secret');
 try{
  const result=await reader.read(command=>vm.runInNewContext('JSON.parse(text)',{text:JSON.stringify(producer(command,expected.webContentsId))}));
  assert.equal(result.status,'NOT_PROVEN');assert.equal(authenticatedSource(result,expected),true);assert.equal(Object.isFrozen(result),true);assert.throws(()=>{result.status='SOURCE_BOUND';},TypeError);
 }finally{reader.dispose();}
});
