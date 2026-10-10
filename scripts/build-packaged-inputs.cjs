'use strict';
// Forward contract against the locked builder's pure file-selection and metadata
// transformer APIs. No native builder/compiler or package-manager invocation.
const fs=require('node:fs'),path=require('node:path');
async function packagedInputReceipts(root,context,raw,fileReceipt,sha256){
 const lib=require('app-builder-lib/package.json');
 const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
 if(lib.version!==lock.packages?.['node_modules/app-builder-lib']?.version)throw Error('BUILD_PACKAGER_LOCK_MISMATCH');
 const info=context.packager.info||context.packager,cfg=context.packager.config;
 if(context.electronPlatformName!=='darwin'||context.arch!==3||context.packager.projectDir!==root||cfg.asar!==true||cfg.electronCompile||cfg.asarUnpack||cfg.onNodeModuleFile||cfg.mac?.identity!==null)throw Error('BUILD_PACKAGER_CONFIG_UNSUPPORTED');
 // This product has exactly these two production packages. Fail closed on a
 // new dependency graph until the packaging receipt contract is extended.
 const dependencies=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).dependencies;
 if(Object.keys(dependencies||{}).sort().join(',')!=='pend,yauzl')throw Error('BUILD_DEPENDENCY_GRAPH_UNSUPPORTED');
 for(const name of ['pend','yauzl']){
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'node_modules',name,'package.json'),'utf8'));
  if(Object.keys(pkg.dependencies||{}).some(dep=>dep!=='pend'))throw Error('BUILD_DEPENDENCY_GRAPH_UNSUPPORTED');
 }
 const {getMainFileMatchers,getNodeModuleFileMatcher,FileMatcher,excludedExts}=require('app-builder-lib/out/fileMatcher.js');
 const {AppFileWalker}=require('app-builder-lib/out/util/AppFileWalker.js');
 const {NodeModuleCopyHelper}=require('app-builder-lib/out/util/NodeModuleCopyHelper.js');
 const {walk}=require('builder-util'),{createTransformer}=require('app-builder-lib/out/fileTransformer.js');
 const dest=path.join(context.appOutDir,'receipt-asar-target'),expand=x=>x.replace(/\$\{arch\}/g,'arm64').replace(/\$\{os\}/g,'mac');
 const selected=new Map(),transform=createTransformer(root,cfg,cfg.extraMetadata,null);
 const platform={info,config:cfg};
 for(const matcher of getMainFileMatchers(root,dest,expand,cfg.mac,platform,path.dirname(context.appOutDir),false)){
  if(matcher.from!==root||matcher.to!==dest)throw Error('BUILD_PACKAGER_CONFIG_UNSUPPORTED');
  const walker=new AppFileWalker(matcher,info);
  for(const file of await walk(matcher.from,walker.filter,walker))if(walker.metadata.get(file)?.isFile())selected.set(path.relative(root,file),file);
 }
 const nodeMatcher=getNodeModuleFileMatcher(root,dest,expand,cfg.mac,info);
 for(const name of ['pend','yauzl']){
  const from=path.join(root,'node_modules',name),to=path.join(dest,'node_modules',name),matcher=new FileMatcher(from,to,expand,nodeMatcher.patterns),copier=new NodeModuleCopyHelper(matcher,info);
  const exts=['.o','.obj',...excludedExts.split(',').map(x=>'.'+x),...(cfg.includePdb===true?[]:['.pdb']),'.dll','.exe'];
  for(const file of await copier.collectNodeModules({name,dir:from},exts,path.relative(dest,to)))selected.set(path.relative(root,file),file);
 }
 const inputs={};
 for(const [n,file]of [...selected].sort()){
  if(!raw[n]||raw[n].link)throw Error('BUILD_PACKAGER_INPUT_UNBOUND');
  if(JSON.stringify(fileReceipt(file))!==JSON.stringify(raw[n]))throw Error('BUILD_INPUTS_CHANGED');
  const data=await transform(file),bytes=data===null||data===undefined?null:Buffer.from(data);
  inputs[n]=bytes?{bytes:bytes.length,sha256:sha256(bytes),mode:raw[n].mode}:raw[n];
 }
 for(const n of ['package.json','apps/desktop/main.cjs','apps/web/index.html','node_modules/pend/index.js','node_modules/yauzl/index.js'])if(!inputs[n])throw Error('BUILD_PACKAGER_REQUIRED_INPUT');
 return inputs;
}
module.exports={packagedInputReceipts};
