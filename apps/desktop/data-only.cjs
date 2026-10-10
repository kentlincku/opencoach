'use strict';
// Transport values are data, never executable serialization/iteration hooks.
// Accept ordinary records/arrays from other VM realms, but not lookalike
// prototypes, accessors, proxies, extra array properties or unbounded graphs.
const {types}=require('node:util');
const functionText=Function.prototype.toString;
const fail=()=>{throw Error('DATA_ONLY_REQUIRED');};
function sameFunction(value,reference){
 return typeof value==='function'&&!types.isProxy(value)&&
  functionText.call(value)===functionText.call(reference);
}
function intrinsicPrototype(proto,reference){
 if(!proto||types.isProxy(proto))fail();
 const descriptors=Object.getOwnPropertyDescriptors(proto);
 const expected=Object.getOwnPropertyDescriptors(reference);
 const keys=Reflect.ownKeys(descriptors),expectedKeys=Reflect.ownKeys(expected);
 if(keys.length!==expectedKeys.length||keys.some((k,i)=>k!==expectedKeys[i]))fail();
 for(const key of keys){
  const d=descriptors[key],e=expected[key];
  if(d.enumerable!==e.enumerable||d.configurable!==e.configurable||d.writable!==e.writable||('value' in d)!==('value' in e))fail();
  if('value' in e){
   if(typeof e.value==='function'){if(!sameFunction(d.value,e.value))fail();}
   else if(key===Symbol.unscopables){
    // Each realm has its own null-prototype builtin boolean table.
    if(!d.value||types.isProxy(d.value)||Object.getPrototypeOf(d.value)!==null)fail();
    const actual=Object.getOwnPropertyDescriptors(d.value),table=Object.getOwnPropertyDescriptors(e.value);
    const names=Reflect.ownKeys(actual),expectedNames=Reflect.ownKeys(table);
    if(names.length!==expectedNames.length||names.some((n,i)=>n!==expectedNames[i]))fail();
    for(const n of names){const x=actual[n],y=table[n];if(!('value' in x)||x.value!==y.value||x.enumerable!==y.enumerable||x.configurable!==y.configurable||x.writable!==y.writable)fail();}
   }else if(d.value!==e.value)fail();
  }else if(!sameFunction(d.get,e.get)||!sameFunction(d.set,e.set))fail();
 }
 // A copied set of builtin descriptors is not the actual realm prototype.
 const ctor=descriptors.constructor?.value;
 if(typeof ctor!=='function'||types.isProxy(ctor)||Object.getOwnPropertyDescriptor(ctor,'prototype')?.value!==proto)fail();
}
function recordPrototype(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value))fail();
 const proto=Object.getPrototypeOf(value);
 if(proto!==null){intrinsicPrototype(proto,Object.prototype);if(Object.getPrototypeOf(proto)!==null)fail();}
}
function cloneData(value){
 const seen=new Set();let nodes=0;
 function visit(v,depth){
  if(++nodes>4096||depth>16)fail();
  if(v===null||typeof v==='boolean')return v;
  if(typeof v==='string'){if(Buffer.byteLength(v)>65536)fail();return v;}
  if(typeof v==='number'){if(!Number.isSafeInteger(v)||v<0)fail();return v;}
  if(typeof v!=='object'||types.isProxy(v)||seen.has(v))fail();
  const array=Array.isArray(v);
  if(array){
   const proto=Object.getPrototypeOf(v);intrinsicPrototype(proto,Array.prototype);
   const parent=Object.getPrototypeOf(proto);intrinsicPrototype(parent,Object.prototype);
   if(Object.getPrototypeOf(parent)!==null)fail();
  }else recordPrototype(v);
  const ds=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(ds);
  if(keys.some(k=>typeof k!=='string'))fail();
  let length=0;
  if(array){
   length=ds.length?.value;
   if(!Number.isSafeInteger(length)||length<0||length>128||keys.length!==length+1)fail();
   for(let i=0;i<length;i++)if(!Object.hasOwn(ds,String(i)))fail();
  }
  const out=array?[]:{};seen.add(v);
  for(const key of keys){
   const d=ds[key];if(!('value' in d)||(!d.enumerable&&!(array&&key==='length')))fail();
   if(array&&key==='length')continue;
   Object.defineProperty(out,key,{value:visit(d.value,depth+1),enumerable:true,writable:true,configurable:true});
  }
  seen.delete(v);return out;
 }
 return visit(value,0);
}
module.exports={cloneData,recordPrototype};
