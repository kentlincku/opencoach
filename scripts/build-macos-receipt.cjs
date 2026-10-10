'use strict';
const path=require('node:path');
const fs=require('node:fs');
const {execFileSync}=require('node:child_process');
const producer=require('./build-receipt-producer.cjs');
// Single process holds the unforgeable stage through web build, Swift build,
// packager hooks and final packaging. No standalone rehash/relabel mode.
async function buildMacosReceipt({root=path.resolve(__dirname,'..'),evidenceTier='NATIVE_BUILD'}={}){
 const packagedAppPath=path.join(root,'dist/mac-arm64/Voice Practice.app');
 const stage=producer.beginBuild({root,packagedAppPath,evidenceTier});
 execFileSync(process.execPath,[path.join(root,'scripts/build-web.mjs')],{cwd:root,stdio:'inherit'});
 const builder=require('electron-builder');let captured=false;
 await builder.build({projectDir:root,targets:builder.Platform.MAC.createTarget(['dmg','zip'],builder.Arch.arm64),config:{
  extends:path.join(root,'electron-builder.yml'),
  // Use the audited, already extracted Electron distribution. A missing local
  // distribution must fail instead of entering electron-builder's download path.
  electronDist:path.join(root,'node_modules/electron/dist'),
  // The packaged production dependencies are pure JS; rebuilding can invoke a
  // package manager or fetch Electron headers, neither of which is authorized.
  npmRebuild:false,
  beforePack:async context=>{
   if(captured)throw Error('BUILD_STAGE_ALREADY_CAPTURED');
   if(path.join(context.appOutDir,context.packager.appInfo.productFilename+'.app')!==packagedAppPath)throw Error('BUILD_OUTPUT_PATH_MISMATCH');
   await require('./build-foundation-models.cjs')(context);
   await producer.captureBuildInputs(stage,context);captured=true;
  },
  afterPack:require('./verify-foundation-models-bundle.cjs'),
  afterSign:require('./verify-foundation-models-bundle.cjs')
 }});
 if(!captured)throw Error('BUILD_INPUTS_REQUIRED');
 const result=producer.generateBuildReceipt({stage});
 const receiptSha256=producer.sha256(fs.readFileSync(result.receiptFile));
 console.log(JSON.stringify({type:'BUILD_RECEIPT_CREATED',buildSha:result.receipt.buildSha,receiptSha256,evidenceTier:result.receipt.evidenceTier}));
 return {...result,receiptSha256};
}
module.exports={buildMacosReceipt};
if(require.main===module)buildMacosReceipt().catch(error=>{
 process.stderr.write(error.message+'\n',()=>process.exit(1));
});
