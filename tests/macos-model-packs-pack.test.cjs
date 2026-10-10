'use strict';
// TOOLING COMPONENT ONLY. Tiny files/repos are NOT runtime/signature/App evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {execFileSync,spawnSync} = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/macos-pack-model-packs.cjs');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const catalog = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'resources/macos-model-packs.json')));
const fixtureInventory = () => [{path:'runtime/bin/voice-runtime',bytes:18,sha256:sha('NON_NATIVE_FIXTURE!')}];
function tooling() {
  assert.ok(fs.existsSync(SCRIPT), 'runtime-only pack tool must exist');
  return require(SCRIPT);
}
function temporary(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'macos-pack-tooling-')));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  return dir;
}

function fileState(file) {
  const stat = fs.lstatSync(file);
  const identity = {dev:stat.dev,ino:stat.ino,nlink:stat.nlink,
    mode:stat.mode,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs};
  if (stat.isSymbolicLink()) return {...identity,target:fs.readlinkSync(file)};
  assert.equal(stat.isFile(),true,'fixture snapshot must not read a special file');
  return {...identity,sha256:sha(fs.readFileSync(file))};
}

function boundaryTooling(overrides = {}) {
  // Only OS/dependency boundaries are doubled; source guards and tokens stay real.
  const {createRequire} = require('node:module'), vm = require('node:vm');
  const actualRequire = createRequire(SCRIPT), module = {exports:{}};
  const boundaryRequire = name => Object.hasOwn(overrides,name) ? overrides[name] : actualRequire(name);
  boundaryRequire.resolve = actualRequire.resolve;
  boundaryRequire.cache = require.cache;
  const factory = vm.runInThisContext('(function(require,module,__filename,__dirname,process,Buffer,console){\n'
    + fs.readFileSync(SCRIPT,'utf8').replace(/^#![^\n]*\n/,'')
    + '\nreturn {...module.exports,privateOutput,assertPackagedSourceFiles,assertArtifactPolicy};\n})',{filename:SCRIPT});
  return factory(boundaryRequire,module,SCRIPT,path.dirname(SCRIPT),process,Buffer,console);
}

function boundedStageVerification(stage, anchor, ancestorStep = 'normal') {
  const code = `
    const fs = require('node:fs'), path = require('node:path');
    const [SCRIPT,stage,anchor,ancestorStep] = process.argv.slice(1);
    const source = JSON.parse(fs.readFileSync(path.join(stage,'source.json')));
    let verifier = require(SCRIPT).verifyStage;
    if (ancestorStep !== 'normal') {
      // Path-boundary fault only. Receipt/inventory/source checks remain real.
      const boundary = (${boundaryTooling.toString()});
      verifier = boundary({'node:path':{...path,dirname(full) {
        const parent = path.dirname(full);
        if (full.startsWith(stage+path.sep) && parent === stage) {
          if (ancestorStep === 'root') return path.parse(stage).root;
          if (ancestorStep === 'outside') return path.dirname(stage);
          if (ancestorStep === 'fixed-point') return full;
        }
        return parent;
      }}}).verifyStage;
    }
    console.log('ENTER_VERIFY_STAGE');
    try {
      const admitted = verifier(stage,anchor,source);
      console.log('ACCEPTED_STAGE:' + admitted.root);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 2;
    }
  `;
  return spawnSync(process.execPath,['-e',code,SCRIPT,stage,anchor,ancestorStep],
    {encoding:'utf8',timeout:1800,killSignal:'SIGKILL',maxBuffer:1024*1024});
}

function boundedTrustWriteFailure(dir, generated, operation) {
  const code = `
    const fs = require('node:fs'), path = require('node:path');
    const [SCRIPT,dir,operation] = process.argv.slice(1);
    const generated = fs.readFileSync(0), boundary = (${boundaryTooling.toString()});
    const {sourceSnapshot} = require(SCRIPT);
    const trustFile = path.join(dir,'apps/desktop/bundled-voice-trust.cjs');
    const original = fs.readFileSync(trustFile), originalStat = fs.statSync(trustFile);
    const baseline = sourceSnapshot(dir), openDescriptors = new Set(), mutations = [];
    const ioError = Object.assign(Error('ONE_SHOT_TRUST_IO_FAILURE:' + operation),{code:'EIO'});
    let heldFd, injected = false, callbackRan = false, synced = false, fsyncCalls = 0, ownedAtFault;
    const inject = () => {
      injected = true;
      const listed = fs.lstatSync(trustFile), held = fs.fstatSync(heldFd), bytes = Buffer.alloc(generated.length);
      let offset = 0, count;
      while (offset < bytes.length && (count = fs.readSync(heldFd,bytes,offset,bytes.length-offset,offset))) offset += count;
      const sameIdentity = stat => stat.isFile() && stat.dev === originalStat.dev && stat.ino === originalStat.ino;
      ownedAtFault = {pathnameIdentity:sameIdentity(listed),heldIdentity:sameIdentity(held),
        oneLink:listed.nlink === 1 && held.nlink === 1,
        fullMode:listed.mode === originalStat.mode && held.mode === originalStat.mode,
        pathnameBytes:fs.readFileSync(trustFile).equals(generated),
        heldBytes:offset === generated.length && held.size === generated.length && bytes.equals(generated)};
      throw ioError;
    };
    // All operations remain real; inject only after a completed syscall once.
    const boundaryFs = {...fs,
      openSync(file,flags,...rest) {
        const fd = fs.openSync(file,flags,...rest); openDescriptors.add(fd);
        if (file === trustFile && (flags & fs.constants.O_RDWR)) heldFd = fd;
        return fd;
      },
      closeSync(fd) { fs.closeSync(fd); openDescriptors.delete(fd); },
      ftruncateSync(...args) { mutations.push('truncate'); return fs.ftruncateSync(...args); },
      writeSync(...args) {
        mutations.push('write');
        const written = fs.writeSync(...args);
        if (!injected && operation === 'writeSync' && args[4]+written === generated.length) inject();
        return written;
      },
      fchmodSync(...args) {
        mutations.push('chmod');
        const result = fs.fchmodSync(...args);
        if (!injected && operation === 'fchmodSync') inject();
        return result;
      },
      fsyncSync(...args) {
        const result = fs.fsyncSync(...args); fsyncCalls++; synced = true;
        if (!injected && operation === 'fsyncSync') inject();
        return result;
      },
      fstatSync(fd,...rest) {
        const result = fs.fstatSync(fd,...rest);
        if (!injected && operation === 'post-write-fstat' && synced && fd === heldFd) inject();
        return result;
      },
    };
    (async () => {
      let failure, sourceAfter, heldFdClosed = false;
      try {
        await boundary({'node:fs':boundaryFs}).withCompiledTrust(dir,generated,async () => { callbackRan = true; });
      } catch (error) { failure = error; }
      try { fs.fstatSync(heldFd); } catch (error) { heldFdClosed = error.code === 'EBADF'; }
      try { sourceAfter = JSON.stringify(sourceSnapshot(dir)) === JSON.stringify(baseline) ? 'CLEAN_BASELINE_MATCH' : 'SOURCE_MISMATCH'; }
      catch (error) { sourceAfter = error.message; }
      const after = fs.statSync(trustFile);
      console.log(JSON.stringify({operation,injected,ownedAtFault,callbackRan,heldFdClosed,
        openDescriptors:[...openDescriptors],errorIsOriginal:failure === ioError,errorCode:failure?.code,error:failure?.message,
        originalRestored:fs.readFileSync(trustFile).equals(original),generatedRemains:fs.readFileSync(trustFile).equals(generated),
        fullModeRestored:after.mode === originalStat.mode,identityRetained:after.dev === originalStat.dev && after.ino === originalStat.ino,
        oneLink:after.nlink === 1,cacheCleared:!require.cache[require.resolve(trustFile)],sourceAfter,fsyncCalls,mutations}));
    })().catch(error => { console.error(error); process.exitCode = 2; });
  `;
  const result = spawnSync(process.execPath,['-e',code,SCRIPT,dir,operation],
    {input:generated,encoding:'utf8',timeout:8000,killSignal:'SIGKILL',maxBuffer:1024*1024});
  assert.equal(result.error,undefined,'trust fault child must finish before timeout: '+result.stderr);
  assert.equal(result.signal,null);
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}

function fixtureRepo(t) {
  const dir = temporary(t);
  fs.mkdirSync(path.join(dir, 'apps/desktop'), {recursive:true});
  fs.writeFileSync(path.join(dir, 'apps/desktop/bundled-voice-trust.cjs'), "'use strict';\r\nmodule.exports = null;\r\n");
  fs.writeFileSync(path.join(dir, 'source.cjs'), '// NON_NATIVE_TEST_FIXTURE\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n');
  for (const relative of ['resources/macos-model-packs.json', 'resources/runtime-manifest.json', 'build/entitlements.runtime.plist',
    ...['bundled-voice-assets','tree-integrity','runtime-paths','runtime-manifest'].map(n => 'apps/desktop/'+n+'.cjs')]) {
    fs.mkdirSync(path.dirname(path.join(dir,relative)), {recursive:true,mode:0o700});
    fs.copyFileSync(path.join(ROOT,relative), path.join(dir,relative));
  }
  const git = args => execFileSync('git', args, {cwd:dir, encoding:'utf8'});
  git(['init', '-q']);
  git(['add', '.']);
  // The only commits in this suite are in disposable TMPDIR fixture repositories.
  git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null',
    '-c','commit.gpgsign=false','commit','-qm','NON_NATIVE_TEST_FIXTURE']);
  return {dir, git};
}

function fixtureStage(t, source, extraRuntime = []) {
  // Deliberately non-executable bytes: verifyNativeSignatures must reject them.
  const dir = temporary(t);
  const {deriveStageMetadata,compiledTrustBytes} = tooling();
  const {canonicalInventory,scanFiles} = require('../apps/desktop/tree-integrity.cjs');
  const write = (relative, bytes) => {
    const full = path.join(dir,relative);
    fs.mkdirSync(path.dirname(full), {recursive:true,mode:0o700});
    fs.writeFileSync(full,bytes,{mode:0o600});
  };
  const json = (relative,value) => write(relative, JSON.stringify(value,null,2)+'\n');
  const payload = Buffer.from('NON_NATIVE_FIXTURE!');
  write('resources/voice-assets/runtime/bin/voice-runtime',payload);
  fs.chmodSync(path.join(dir,'resources/voice-assets/runtime/bin/voice-runtime'),0o700);
  const files = [{path:'runtime/bin/voice-runtime',bytes:payload.length,sha256:sha(payload)}];
  for (const [relative,bytes] of extraRuntime) {
    write('resources/voice-assets/'+relative,bytes);
    files.push({path:relative,bytes:bytes.length,sha256:sha(bytes)});
  }
  const metadata = deriveStageMetadata(catalog(),files);
  json('resources/voice-assets-inventory.json',{files});
  json('resources/manifests/model-manifest.json',metadata.modelManifest);
  json('resources/manifests/speech-model-capabilities.json',metadata.capabilities);
  write('resources/manifests/runtime-manifest.json',fs.readFileSync(path.join(ROOT,'resources/runtime-manifest.json')));
  json('trust.json',metadata.trust);
  write('bundled-voice-trust.cjs',compiledTrustBytes(metadata.trust));
  json('source.json',source);
  const signing = {status:'PASS',identity:'NON_NATIVE_BOUNDARY_FIXTURE',files:['runtime/bin/voice-runtime'],
    entitlementsSha256:sha(fs.readFileSync(path.join(ROOT,'build/entitlements.runtime.plist')))};
  json('signing.json',{...signing,commands:[]});
  const receipt = {schemaVersion:1,class:'MACOS_RUNTIME_ONLY_LOCAL_NOT_RELEASE',operation:'STAGE',status:'PASS',
    source:{commit:source.commit,gitTree:source.gitTree,treeSha256:source.treeSha256},
    runtimeInput:{buildDirectory:path.join(dir,'not-a-runtime-input'),commit:source.commit,
      treeSha256:sha('fixture-runtime'),receiptSha256:sha('fixture-receipt'),fileCount:files.length},
    acquisition:{path:path.join(dir,'not-an-acquisition'),manifestSha256:sha('fixture-acquisition'),files:[]},
    inputs:{catalog:{path:'resources/macos-model-packs.json',sha256:sha(fs.readFileSync(path.join(ROOT,'resources/macos-model-packs.json')))},
      entitlements:{path:'build/entitlements.runtime.plist',sha256:signing.entitlementsSha256}},
    signing,treeDigest:metadata.trust.treeDigest,runtimeTreeDigest:metadata.trust.runtimeTreeDigest,fileCount:files.length,
    appAcceptance:'NOT_RUN'};
  function seal() {
    const listed = scanFiles(dir,{exclude:new Set(['receipt.json'])});
    const inventory = canonicalInventory(listed);
    receipt.files = inventory.files;
    receipt.stageTreeDigest = inventory.treeDigest;
    json('receipt.json',receipt);
    return sha(fs.readFileSync(path.join(dir,'receipt.json')));
  }
  return {dir,receipt,sha256:seal(),seal,json,write,trust:metadata.trust};
}

test('pack CLI admits only explicit private stage/receipt/output and optional dmg, with no bypass or release switches', async t => {
  const {parseCli,pack} = tooling();
  assert.equal(typeof parseCli,'function','strict executable pack CLI is required');
  const stage=temporary(t), output=path.join(temporary(t),'fresh'), digest=sha('receipt-anchor-fixture');
  const args=['--stage',stage,'--stage-receipt-sha256',digest,'--output',output];
  assert.deepEqual(parseCli(args),{stage,stageReceiptSha256:digest,output,dmg:false});
  assert.equal(parseCli([...args,'--dmg']).dmg,true);
  for (const bad of [[],[...args,'--trust','{}'],[...args,'--root',ROOT],[...args,'--allow-dirty'],
    [...args,'--publish','always'],[...args,'--notarize'],[...args,'--stage',stage],args.map(a=>a===digest?digest.toUpperCase():a)]) {
    assert.throws(()=>parseCli(bad),/MODEL_PACK_/);
  }
  await assert.rejects(pack({root:ROOT,stage,stageReceiptSha256:digest,output}),/MODEL_PACK_OPTIONS/);
  const help=require('node:child_process').spawnSync(process.execPath,[SCRIPT,'--help'],{encoding:'utf8'});
  assert.equal(help.status,0); assert.match(help.stdout,/--stage-receipt-sha256/);
  const missing=require('node:child_process').spawnSync(process.execPath,[SCRIPT],{encoding:'utf8'});
  assert.notEqual(missing.status,0);
  assert.equal(fs.existsSync(output),false);
});

for (const spelling of ['dot','repeated-separator','double-leading-separator','trailing-separator']) {
  for (const side of ['output','input']) {
    test(`S2 private output rejects ${spelling} in ${side} before writing inside readonly input`, t => {
      const {privateOutput} = boundaryTooling(), base = temporary(t), outside = temporary(t);
      const input = path.join(base,'readonly-input'), actualOutput = path.join(input,'fresh-output');
      fs.mkdirSync(input,{mode:0o700});
      const inputSentinel = path.join(input,'sentinel'), externalSentinel = path.join(outside,'sentinel');
      fs.writeFileSync(inputSentinel,'READONLY_INPUT_UNCHANGED',{mode:0o600});
      fs.writeFileSync(externalSentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
      const inputBefore = fileState(inputSentinel), externalBefore = fileState(externalSentinel);
      const aliases = {
        dot:base+path.sep+'.'+path.sep+'readonly-input',
        'repeated-separator':base+path.sep+path.sep+'readonly-input',
        'double-leading-separator':path.sep+input,
        'trailing-separator':input+path.sep,
      };
      const alias = aliases[spelling];
      const output = side === 'input' ? actualOutput
        : spelling === 'trailing-separator' ? actualOutput+path.sep : alias+path.sep+'fresh-output';
      let failure;
      try { privateOutput(output,[side === 'input' ? alias : input]); }
      catch (error) { failure = error; }
      assert.equal(fs.existsSync(actualOutput),false,'must reject the spelling before mkdir touches readonly input');
      assert.deepEqual(fileState(inputSentinel),inputBefore);
      assert.deepEqual(fileState(externalSentinel),externalBefore);
      assert.deepEqual(fs.readdirSync(input),['sentinel']);
      assert.deepEqual(fs.readdirSync(outside),['sentinel']);
      assert.equal(fs.statSync(input).mode & 0o777,0o700);
      assert.match(failure?.message || '',/^MODEL_PACK_UNSAFE_PATH$/);
    });
  }
}

for (const side of ['output','input']) {
  test(`S2 actual ancestor identity rejects a case alias in ${side} before mkdir`, t => {
    const {privateOutput} = boundaryTooling(), base = temporary(t), outside = temporary(t);
    const input = path.join(base,'ReadOnlyInput'), alias = path.join(base,'readonlyinput');
    fs.mkdirSync(path.join(input,'existing/parent'),{recursive:true,mode:0o700});
    if (!fs.existsSync(alias)) return t.skip('filesystem does not support this case alias');
    const actual = fs.lstatSync(input), aliased = fs.lstatSync(alias);
    if (actual.dev !== aliased.dev || actual.ino !== aliased.ino) return t.skip('case spellings have distinct filesystem identities');
    const sentinel = path.join(input,'sentinel'), externalSentinel = path.join(outside,'sentinel');
    fs.writeFileSync(sentinel,'READONLY_INPUT_UNCHANGED',{mode:0o600});
    fs.writeFileSync(externalSentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
    const before = fileState(sentinel), externalBefore = fileState(externalSentinel);
    const actualOutput = path.join(input,'existing/parent/fresh-output');
    const output = side === 'output' ? path.join(alias,'existing/parent/fresh-output') : actualOutput;
    let failure;
    try { privateOutput(output,[side === 'input' ? alias : input]); }
    catch (error) { failure = error; }
    assert.equal(fs.existsSync(actualOutput),false,'case aliases cannot create output in the readonly subtree');
    assert.deepEqual(fileState(sentinel),before);
    assert.deepEqual(fileState(externalSentinel),externalBefore);
    assert.deepEqual(fs.readdirSync(path.dirname(actualOutput)),[]);
    assert.deepEqual(fs.readdirSync(outside),['sentinel']);
    assert.match(failure?.message || '',/^MODEL_PACK_OUTPUT_OVERLAPS_INPUT$/);
  });
}

test('S2 actual root ancestry rejects an output under a readonly filesystem root', t => {
  const {privateOutput} = boundaryTooling(), outside = temporary(t), output = path.join(outside,'fresh-output');
  const sentinel = path.join(outside,'sentinel');
  fs.writeFileSync(sentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
  const before = fileState(sentinel);
  let failure;
  try { privateOutput(output,[path.parse(outside).root]); }
  catch (error) { failure = error; }
  assert.equal(fs.existsSync(output),false,'root is an ancestor, not a double-separator string prefix');
  assert.deepEqual(fileState(sentinel),before);
  assert.deepEqual(fs.readdirSync(outside),['sentinel']);
  assert.match(failure?.message || '',/^MODEL_PACK_OUTPUT_OVERLAPS_INPUT$/);
});

for (const linkSide of ['output-ancestor','input-ancestor','dangling-output-ancestor']) {
  test(`S2 retains lexical no-symlink rejection for ${linkSide} before outside output exists`, t => {
    const {privateOutput} = boundaryTooling(), base = temporary(t), outside = temporary(t);
    const input = path.join(base,'readonly-input'), link = path.join(base,'link');
    fs.mkdirSync(input,{mode:0o700});
    const inputSentinel = path.join(input,'sentinel'), sentinel = path.join(outside,'sentinel');
    fs.writeFileSync(inputSentinel,'READONLY_INPUT_UNCHANGED',{mode:0o600});
    fs.writeFileSync(sentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
    const before = fileState(sentinel), inputBefore = fileState(inputSentinel);
    const target = linkSide === 'input-ancestor' ? input
      : linkSide === 'dangling-output-ancestor' ? path.join(outside,'missing-parent') : outside;
    fs.symlinkSync(target,link);
    const linkBefore = fileState(link), output = linkSide === 'input-ancestor'
      ? path.join(outside,'fresh-output') : path.join(link,'fresh-output');
    let failure;
    try { privateOutput(output,[linkSide === 'input-ancestor' ? link : input]); }
    catch (error) { failure = error; }
    assert.equal(fs.existsSync(path.join(outside,'fresh-output')),false);
    assert.equal(fs.existsSync(path.join(outside,'missing-parent')),false);
    assert.deepEqual(fileState(sentinel),before);
    assert.deepEqual(fileState(inputSentinel),inputBefore);
    assert.deepEqual(fileState(link),linkBefore);
    assert.deepEqual(fs.readdirSync(outside),['sentinel']);
    assert.deepEqual(fs.readdirSync(input),['sentinel']);
    assert.match(failure?.message || '',/^MODEL_PACK_UNSAFE_LINK$/);
  });
}

test('S2 disjoint canonical output is fresh and private without changing readonly inputs', t => {
  const {privateOutput} = boundaryTooling(), base = temporary(t);
  const input = path.join(base,'readonly-input'), output = path.join(base,'readonly-input-sibling');
  fs.mkdirSync(input,{mode:0o700});
  const sentinel = path.join(input,'sentinel');
  fs.writeFileSync(sentinel,'READONLY_INPUT_UNCHANGED',{mode:0o600});
  const before = fileState(sentinel);
  assert.equal(privateOutput(output,[input]),output);
  assert.equal(fs.statSync(output).mode & 0o777,0o700);
  assert.deepEqual(fs.readdirSync(output),[]);
  assert.throws(() => privateOutput(output,[input]),/^Error: MODEL_PACK_OUTPUT_EXISTS$/);
  assert.deepEqual(fileState(sentinel),before);
  assert.deepEqual(fs.readdirSync(input),['sentinel']);
  assert.deepEqual(fs.readdirSync(output),[]);
});

test('S2 rejects an existing output ancestor case alias without trying mkdir', t => {
  const base = temporary(t), parent = path.join(base,'OutputParent'), alias = path.join(base,'outputparent');
  const input = path.join(parent,'readonly-input');
  fs.mkdirSync(input,{recursive:true,mode:0o700});
  if (!fs.existsSync(alias)) return t.skip('filesystem does not support this case alias');
  const sentinel = path.join(input,'sentinel');
  fs.writeFileSync(sentinel,'READONLY_INPUT_UNCHANGED',{mode:0o600});
  const before = fileState(sentinel), calls = [];
  const {privateOutput} = boundaryTooling({'node:fs':{...fs,mkdirSync(...args) {
    calls.push(args); return fs.mkdirSync(...args);
  }}});
  assert.throws(() => privateOutput(alias,[input]),/MODEL_PACK_OUTPUT_OVERLAPS_INPUT/);
  assert.deepEqual(calls,[]);
  assert.deepEqual(fileState(sentinel),before);
  assert.deepEqual(fs.readdirSync(parent),['readonly-input']);
  assert.deepEqual(fs.readdirSync(input),['sentinel']);
});

test('native pack orchestration is exercised only with labelled build/signing doubles and a real fixture asar', async t => {
  assert.equal(typeof tooling().pack,'function','executable pack orchestration is required');
  const {createRequire} = require('node:module'), vm = require('node:vm');
  const actualRequire = createRequire(SCRIPT), actualBuilder = actualRequire('electron-builder');
  for (const scenario of [null,'builder','trust','runtime-zip']) {
    const failureMode = ['builder','trust'].includes(scenario) ? scenario : null;
    const runtimeZip = scenario === 'runtime-zip', failBuilder = failureMode === 'builder';
    const {dir,git} = fixtureRepo(t);
    const extra = ['electron-builder.yml','package.json','package-lock.json','scripts/macos-pack-model-packs.cjs',
      ...['asset-manifest-trust','macos-model-catalog','speech-model-selection'].map(n=>'apps/desktop/'+n+'.cjs')];
    for (const relative of extra) { fs.mkdirSync(path.dirname(path.join(dir,relative)),{recursive:true}); fs.copyFileSync(path.join(ROOT,relative),path.join(dir,relative)); }
    fs.mkdirSync(path.join(dir,'apps/web'),{recursive:true});
    fs.writeFileSync(path.join(dir,'apps/web/index.html'),'NON_NATIVE_WEB_FIXTURE');
    fs.appendFileSync(path.join(dir,'.gitignore'),'node_modules/\n');
    git(['add','.']);
    git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','commit','-qm','NON_NATIVE_PIPELINE_FIXTURE']);
    const electron = path.join(dir,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
    fs.mkdirSync(path.dirname(electron),{recursive:true}); fs.writeFileSync(electron,'NOT_REAL_ELECTRON');
    const fixtureSource = tooling().sourceSnapshot(dir), staged = fixtureStage(t,fixtureSource);
    const entry = path.join(staged.dir,'resources/voice-assets/runtime/bin/voice-runtime');
    const payload = Buffer.concat([Buffer.from('cffaedfe','hex'),Buffer.from('NON_NATIVE_PIPELINE_RUNTIME')]);
    fs.writeFileSync(entry,payload);
    const inv = [{path:'runtime/bin/voice-runtime',bytes:payload.length,sha256:sha(payload)}];
    const zipPath = 'runtime/bin/_internal/base_library.zip', zipBytes = Buffer.from('NON_NATIVE_RUNTIME_ZIP_FIXTURE');
    if (runtimeZip) {
      staged.write('resources/voice-assets/'+zipPath,zipBytes);
      inv.push({path:zipPath,bytes:zipBytes.length,sha256:sha(zipBytes)});
    }
    const metadata = tooling().deriveStageMetadata(catalog(),inv);
    staged.json('resources/voice-assets-inventory.json',{files:inv}); staged.json('trust.json',metadata.trust);
    staged.write('bundled-voice-trust.cjs',tooling().compiledTrustBytes(metadata.trust));
    Object.assign(staged.receipt,{treeDigest:metadata.trust.treeDigest,runtimeTreeDigest:metadata.trust.runtimeTreeDigest,fileCount:inv.length});
    const anchor = staged.seal(), output = path.join(temporary(t),'pack'), events = [];
    const outside = temporary(t), sentinel = path.join(outside,'sentinel');
    fs.writeFileSync(sentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
    const sentinelBefore = fileState(sentinel);
    let concurrentBefore, backupBefore;
    const localRequire = createRequire(path.join(dir,'scripts/macos-pack-model-packs.cjs'));
    const context = {module:{exports:{}},Buffer,__dirname:path.join(dir,'scripts'),__filename:path.join(dir,'scripts/macos-pack-model-packs.cjs'),
      process:{...process,platform:'darwin',arch:'arm64',env:{TMPDIR:process.env.TMPDIR,PATH:process.env.PATH}},console};
    const fakeBuilder = {...actualBuilder,build:async options=>{
      events.push('builder');
      backupBefore = fileState(path.join(output,'original-bundled-voice-trust.cjs'));
      assert.equal(context.process.env.CSC_IDENTITY_AUTO_DISCOVERY,'false');
      assert.equal(options.publish,'never');
      const {Packager} = actualRequire('app-builder-lib/out/packager.js'), loader = new Packager(options);
      await loader.validateConfig();
      const config = loader.config, appOutDir = path.join(output,'artifacts/mac-arm64');
      const ctx = {electronPlatformName:'darwin',arch:actualBuilder.Arch.arm64,appOutDir,
        packager:{projectDir:dir,config,appInfo:{productFilename:'Voice Practice'}}};
      await config.beforePack(ctx);
      if (failBuilder) throw Error('NON_NATIVE_BUILDER_FAILURE');
      if (failureMode === 'trust') {
        fs.appendFileSync(trustFile,'// CONCURRENT_PACK_TRUST_EDIT\n');
        concurrentBefore = fileState(trustFile);
        throw Error('NON_NATIVE_BUILDER_FAILURE_WITH_CONCURRENT_EDIT');
      }
      const resources = path.join(appOutDir,'Voice Practice.app/Contents/Resources');
      fs.mkdirSync(resources,{recursive:true}); fs.cpSync(path.join(staged.dir,'resources'),resources,{recursive:true});
      fs.cpSync(path.join(output,'foundation-models'),path.join(resources,'foundation-models'),{recursive:true});
      const asarInput = path.join(temporary(t),'asar-input');
      for (const part of ['apps/desktop','apps/web']) fs.cpSync(path.join(dir,part),path.join(asarInput,part),{recursive:true});
      await actualRequire('@electron/asar').createPackage(asarInput,path.join(resources,'app.asar'));
      await config.afterPack(ctx); await config.afterSign(ctx);
      if (runtimeZip) fs.writeFileSync(path.join(output,'artifacts/NON_NATIVE_FIXTURE.dmg'),'NON_NATIVE_DMG_FIXTURE');
      return [];
    }};
    context.require = name => {
      if (name==='node:child_process') return {...require('node:child_process'),spawnSync(command,args){
        events.push(command==='/usr/bin/codesign'?'signature-boundary':'command-boundary');
        return {status:0,signal:null,stdout:Buffer.from('NON_NATIVE_BOUNDARY_DOUBLE'),stderr:Buffer.from('')};
      }};
      if (name==='electron-builder') return fakeBuilder;
      if (name==='./build-foundation-models.cjs') return {buildHelper:async ({output:helper})=>{
        events.push('helper-boundary'); fs.mkdirSync(helper,{mode:0o700});
        fs.writeFileSync(path.join(helper,'voice-foundation-models'),'NON_NATIVE_HELPER');
        fs.writeFileSync(path.join(helper,'manifest.json'),'{}'); return {status:'PASS'};
      }};
      if (name==='./verify-foundation-models-bundle.cjs') return async ()=>{events.push('helper-readback-boundary');};
      if (name.startsWith('.')) return localRequire(name);
      return actualRequire(name);
    };
    context.require.resolve = localRequire.resolve;
    context.require.cache = require.cache;
    const factory = vm.runInThisContext('(function(require,module,__filename,__dirname,process,Buffer,console){\n'
      + fs.readFileSync(SCRIPT,'utf8').replace(/^#![^\n]*\n/,'') + '\n})',
      {filename:path.join(dir,'scripts/macos-pack-model-packs.cjs')});
    factory(context.require,context.module,context.__filename,context.__dirname,context.process,Buffer,console);
    const trustFile=path.join(dir,'apps/desktop/bundled-voice-trust.cjs'), original=fs.readFileSync(trustFile);
    const work=context.module.exports.pack({stage:staged.dir,stageReceiptSha256:anchor,output,dmg:runtimeZip});
    if (failureMode) {
      const expected = failureMode === 'trust' ? /MODEL_PACK_TRUST_OWNERSHIP_CONFLICT/ : /NON_NATIVE_BUILDER_FAILURE/;
      await assert.rejects(work,expected);
      assert.equal(fs.existsSync(path.join(output,'receipt.json')),false);
      const failure = JSON.parse(fs.readFileSync(path.join(output,'failure.json')));
      assert.equal(failure.status,'FAILED');
      assert.equal(failure.appAcceptance,'NOT_RUN');
      assert.match(failure.error,expected);
    } else {
      const result=await work, receipt=JSON.parse(fs.readFileSync(path.join(output,'receipt.json')));
      assert.equal(result.receiptSha256,sha(fs.readFileSync(path.join(output,'receipt.json'))));
      assert.equal(receipt.appAcceptance,'NOT_RUN');
      assert.equal(receipt.stage.receiptSha256,anchor);
      assert.equal(receipt.source.commit,fixtureSource.commit);
      assert.equal(receipt.published,false); assert.equal(receipt.notarized,false);
      assert.deepEqual(receipt.targets,runtimeZip ? ['dir','dmg'] : ['dir']);
      if (runtimeZip) {
        const artifacts = JSON.parse(fs.readFileSync(path.join(output,'artifacts.json')));
        const archived = artifacts.files.find(file => file.path === 'mac-arm64/Voice Practice.app/Contents/Resources/voice-assets/'+zipPath);
        assert.equal(archived.type,'file'); assert.equal(archived.bytes,zipBytes.length); assert.equal(archived.sha256,sha(zipBytes));
        assert.equal(fs.existsSync(path.join(output,'app-signature-readback.json')),true);
        assert.equal(fs.existsSync(path.join(output,'failure.json')),false);
      }
      const configReceipt=JSON.parse(fs.readFileSync(path.join(output,'builder-configuration.json')));
      for (const hook of ['beforePack','afterPack','afterSign']) {
        assert.equal(configReceipt.config[hook].kind,'in-process-hook');
        assert.match(configReceipt.config[hook].sha256,/^[a-f0-9]{64}$/);
      }
      assert.equal(fs.statSync(output).mode & 0o777,0o700);
      assert.equal(fs.statSync(path.join(output,'receipt.json')).mode & 0o777,0o600);
    }
    assert.equal(events.filter(e=>e==='builder').length,1);
    assert.ok(events.includes('helper-boundary'));
    if (failureMode === 'trust') {
      assert.deepEqual(fileState(trustFile),concurrentBefore,'failed pack must retain the concurrent trust edit');
      assert.throws(() => tooling().sourceSnapshot(dir),/SOURCE_DIRTY/);
      assert.equal(fs.existsSync(path.join(output,'artifacts')),false);
    } else {
      assert.deepEqual(fs.readFileSync(trustFile),original);
      assert.deepEqual(tooling().sourceSnapshot(dir),fixtureSource);
    }
    const backup = path.join(output,'original-bundled-voice-trust.cjs');
    assert.deepEqual(fileState(backup),backupBefore,'retain the real pack-created private backup');
    assert.ok(fs.readFileSync(backup).equals(original));
    assert.equal(fs.statSync(backup).mode & 0o777,0o600);
    assert.equal(fs.statSync(output).mode & 0o777,0o700);
    assert.deepEqual(fileState(sentinel),sentinelBefore);
    assert.deepEqual(fs.readdirSync(outside),['sentinel']);
    assert.equal(Object.hasOwn(context.process.env,'CSC_IDENTITY_AUTO_DISCOVERY'),false);
  }
});

// Preloaded only into a disposable CLI fixture. Production main/pack/finally,
// Git, inventory, config, asar and installed temp-file/exit hooks remain real.
function cliPackBoundaries({dependencyScript,fixtureScript,stage,output,trace,asarInput,failureMode}) {
  const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
  const dependencies = Module.createRequire(dependencyScript), root = path.resolve(fixtureScript,'../..');
  const builder = dependencies('electron-builder'), {Packager} = dependencies('app-builder-lib/out/packager.js');
  const childProcess = require('node:child_process'), originalLoad = Module._load;
  const trustFile = path.join(root,'apps/desktop/bundled-voice-trust.cjs');
  const originalTrust = fs.readFileSync(trustFile), originalMode = fs.statSync(trustFile).mode;
  const event = value => fs.appendFileSync(trace,JSON.stringify(value)+'\n',{mode:0o600});
  let exitTemporary;
  process.on('beforeExit',code=>{
    event({event:'beforeExit',code,exitCode:process.exitCode,
      trustRestored:fs.readFileSync(trustFile).equals(originalTrust),modeRestored:fs.statSync(trustFile).mode===originalMode,
      environmentRestored:process.env.CSC_IDENTITY_AUTO_DISCOVERY==='CLI_ORIGINAL_ENVIRONMENT',
      receiptExists:fs.existsSync(path.join(output,'receipt.json')),failureExists:fs.existsSync(path.join(output,'failure.json'))});
    // Register after the CLI completion handler without altering the exit status.
    process.once('exit',code=>event({event:'exit-observed',argument:code,exitCode:process.exitCode,
      temporaryExists:exitTemporary && fs.existsSync(exitTemporary)}));
  });
  const build = async options=>{
    const loader = new Packager(options);
    await loader.validateConfig();
    const builderTemporary = await loader.tempDirManager.createTempDir({prefix:'NON_NATIVE_CLI_BUILDER'});
    const exitManager = new (dependencies('temp-file').TmpDir)('NON_NATIVE_CLI_EXIT');
    exitTemporary = await exitManager.createTempDir({prefix:'NON_NATIVE_CLI_EXIT'});
    fs.writeFileSync(path.join(exitTemporary,'sentinel'),'NON_NATIVE_TEMPORARY');
    dependencies('async-exit-hook')(callback=>{
      event({event:'async-cleanup-start',asynchronous:typeof callback==='function'});
      if (typeof callback==='function') setTimeout(()=>{event({event:'async-cleanup-complete'});callback();},15);
    });
    try {
      event({event:'builder-enter',generatedTrust:!fs.readFileSync(trustFile).equals(originalTrust)});
      const config = loader.config, appOutDir = path.join(output,'artifacts/mac-arm64');
      const context = {electronPlatformName:'darwin',arch:builder.Arch.arm64,appOutDir,
        packager:{projectDir:root,config,appInfo:{productFilename:'Voice Practice'}}};
      await config.beforePack(context);
      if (failureMode==='builder') throw Error('NON_NATIVE_CLI_BUILDER_FAILURE:'+'x'.repeat(256*1024)+':END_LARGE_ERROR');
      const resources = path.join(appOutDir,'Voice Practice.app/Contents/Resources');
      fs.mkdirSync(resources,{recursive:true}); fs.cpSync(path.join(stage,'resources'),resources,{recursive:true});
      fs.cpSync(path.join(output,'foundation-models'),path.join(resources,'foundation-models'),{recursive:true});
      for (const part of ['apps/desktop','apps/web']) fs.cpSync(path.join(root,part),path.join(asarInput,part),{recursive:true});
      await dependencies('@electron/asar').createPackage(asarInput,path.join(resources,'app.asar'));
      await config.afterPack(context); await config.afterSign(context);
      fs.writeFileSync(path.join(output,'artifacts/NON_NATIVE_CLI.dmg'),'NON_NATIVE_DMG_FIXTURE');
      if (failureMode==='artifact') {
        fs.mkdirSync(path.join(output,'artifacts/nested'));
        fs.writeFileSync(path.join(output,'artifacts/nested/extra.zip'),'NON_NATIVE_EXTRA_RELEASE_ZIP');
      }
      return [];
    } finally {
      await loader.tempDirManager.cleanup(); // Same installed cleanup as Packager.build().
      event({event:'builder-finally',builderTemporaryExists:fs.existsSync(builderTemporary),exitTemporaryExists:fs.existsSync(exitTemporary)});
    }
  };
  Module._load = function(request,parent,isMain) {
    if (parent?.filename===fixtureScript) {
      if (request==='electron-builder') return {...builder,build};
      if (request==='node:child_process') return {...childProcess,spawnSync(command,args) {
        if (!['/usr/bin/lipo','/usr/bin/codesign'].includes(command)
            && !(command===process.execPath && args[0]===path.join(root,'scripts/build-web.mjs'))) throw Error('UNEXPECTED_NATIVE_BOUNDARY');
        event({event:'NON_NATIVE_COMMAND_BOUNDARY',command});
        return {status:0,signal:null,stdout:Buffer.from('NON_NATIVE_BOUNDARY_DOUBLE'),stderr:Buffer.from('')};
      }};
      if (request==='./build-foundation-models.cjs') return {buildHelper:async ({output:helper})=>{
        fs.mkdirSync(helper,{mode:0o700}); fs.writeFileSync(path.join(helper,'voice-foundation-models'),'NON_NATIVE_HELPER');
        fs.writeFileSync(path.join(helper,'manifest.json'),'{}'); return {status:'PASS'};
      }};
      if (request==='./verify-foundation-models-bundle.cjs') return async ()=>{event({event:'NON_NATIVE_HELPER_READBACK_BOUNDARY'});};
      if (!request.startsWith('.') && !request.startsWith('node:')) return dependencies(request);
    }
    return originalLoad.call(this,request,parent,isMain);
  };
}

function fixturePackCli(t, failureMode) {
  const {dir,git} = fixtureRepo(t), harness = temporary(t);
  for (const relative of ['electron-builder.yml','package.json','scripts/macos-pack-model-packs.cjs',
    ...['asset-manifest-trust','macos-model-catalog','speech-model-selection'].map(name=>'apps/desktop/'+name+'.cjs')]) {
    fs.mkdirSync(path.dirname(path.join(dir,relative)),{recursive:true}); fs.copyFileSync(path.join(ROOT,relative),path.join(dir,relative));
  }
  fs.mkdirSync(path.join(dir,'apps/web'),{recursive:true});
  fs.writeFileSync(path.join(dir,'apps/web/index.html'),'NON_NATIVE_CLI_WEB_FIXTURE');
  fs.appendFileSync(path.join(dir,'.gitignore'),'node_modules/\n');
  git(['add','.']);
  git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null',
    '-c','commit.gpgsign=false','commit','-qm','NON_NATIVE_CLI_FIXTURE']);
  const electron = path.join(dir,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  fs.mkdirSync(path.dirname(electron),{recursive:true}); fs.writeFileSync(electron,'NON_NATIVE_ELECTRON');
  const source = tooling().sourceSnapshot(dir), staged = fixtureStage(t,source,
    [['runtime/bin/_internal/base_library.zip',Buffer.from('NON_NATIVE_RUNTIME_ZIP_FIXTURE')]]);
  const entry = 'runtime/bin/voice-runtime', payload = Buffer.concat([Buffer.from('cffaedfe','hex'),Buffer.from('NON_NATIVE_CLI_RUNTIME')]);
  staged.write('resources/voice-assets/'+entry,payload);
  const inventory = JSON.parse(fs.readFileSync(path.join(staged.dir,'resources/voice-assets-inventory.json'))).files
    .map(file=>file.path===entry ? {path:entry,bytes:payload.length,sha256:sha(payload)} : file);
  const metadata = tooling().deriveStageMetadata(catalog(),inventory);
  staged.json('resources/voice-assets-inventory.json',{files:inventory}); staged.json('trust.json',metadata.trust);
  staged.write('bundled-voice-trust.cjs',tooling().compiledTrustBytes(metadata.trust));
  Object.assign(staged.receipt,{treeDigest:metadata.trust.treeDigest,runtimeTreeDigest:metadata.trust.runtimeTreeDigest});
  const anchor = staged.seal(), output = path.join(harness,'pack'), trace = path.join(harness,'trace.jsonl');
  const fixtureScript = path.join(dir,'scripts/macos-pack-model-packs.cjs'), preload = path.join(harness,'boundaries.cjs');
  assert.equal(sha(fs.readFileSync(fixtureScript)),sha(fs.readFileSync(SCRIPT)),'CLI must execute unchanged product script bytes');
  fs.writeFileSync(preload,'('+cliPackBoundaries.toString()+')('+JSON.stringify({dependencyScript:SCRIPT,fixtureScript,
    stage:staged.dir,output,trace,asarInput:path.join(harness,'asar-input'),failureMode})+');\n',{mode:0o600});
  const result = spawnSync(process.execPath,['--require',preload,fixtureScript,'--stage',staged.dir,
    '--stage-receipt-sha256',anchor,'--output',output,'--dmg'],{encoding:'utf8',timeout:12000,killSignal:'SIGKILL',maxBuffer:4*1024**2,
    env:{...process.env,APP_BUILDER_TMP_DIR:harness,TMP_DIR_MANAGER_ENSURE_REMOVED_ON_EXIT:'true',CSC_IDENTITY_AUTO_DISCOVERY:'CLI_ORIGINAL_ENVIRONMENT'}});
  assert.equal(result.error,undefined,result.stderr); assert.equal(result.signal,null);
  return {result,output,dir,source,events:fs.readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line))};
}

test('pack CLI preserves failure after real dependency cleanup, owned trust restore and complete output', t => {
  for (const failureMode of ['artifact','builder',null]) {
    const {result,output,dir,source,events} = fixturePackCli(t,failureMode);
    t.diagnostic(JSON.stringify({failureMode,status:result.status,stdoutBytes:Buffer.byteLength(result.stdout),
      stderrBytes:Buffer.byteLength(result.stderr),events}));
    assert.deepEqual(tooling().sourceSnapshot(dir),source,'the real CLI must finish owned trust restoration');
    assert.equal(events.find(event=>event.event==='builder-enter').generatedTrust,true);
    assert.deepEqual(events.find(event=>event.event==='builder-finally'),{event:'builder-finally',builderTemporaryExists:false,exitTemporaryExists:true});
    const before = events.find(event=>event.event==='beforeExit');
    assert.equal(before.trustRestored,true); assert.equal(before.modeRestored,true); assert.equal(before.environmentRestored,true);
    assert.equal(events.find(event=>event.event==='async-cleanup-start').asynchronous,true,'do not hard-exit and skip asynchronous cleanup');
    assert.ok(events.find(event=>event.event==='async-cleanup-complete'));
    assert.equal(events.find(event=>event.event==='exit-observed').temporaryExists,false,'installed temp-file cleanup must finish');
    assert.equal(before.receiptExists,!failureMode); assert.equal(before.failureExists,Boolean(failureMode));
    if (failureMode) {
      const failure = JSON.parse(fs.readFileSync(path.join(output,'failure.json')));
      assert.equal(failure.status,'FAILED'); assert.equal(failure.appAcceptance,'NOT_RUN');
      const error = failureMode==='artifact' ? /MODEL_PACK_UNEXPECTED_ARTIFACTS/ : /NON_NATIVE_CLI_BUILDER_FAILURE/;
      assert.match(failure.error,error); assert.match(result.stderr,error);
      if (failureMode==='artifact') assert.ok(fs.existsSync(path.join(output,'app-signature-readback.json')),'late artifact guard must really be reached');
      else assert.ok(result.stderr.includes('x'.repeat(256*1024)+':END_LARGE_ERROR'),'piped error output must not be truncated');
      assert.equal(result.stdout.includes('MACOS_MODEL_PACKS_PACKAGE'),false);
      assert.equal(before.code,1,'main must already have reported failure before dependency exit hooks');
      assert.equal(result.status,1,'dependency process.exit(0) must not turn a failed pack into CLI success');
    } else {
      const line = result.stdout.trimEnd().split('\n').at(-1), message = JSON.parse(line);
      assert.equal(message.type,'MACOS_MODEL_PACKS_PACKAGE'); assert.equal(message.appAcceptance,'NOT_RUN');
      assert.equal(message.receiptSha256,sha(fs.readFileSync(message.receiptPath)));
      assert.equal(JSON.parse(fs.readFileSync(message.receiptPath)).status,'PASS');
      assert.equal(result.stderr,''); assert.equal(result.status,0);
    }
  }
});

test('importing the pack module leaves caller lifecycle and exit status untouched', () => {
  const result = spawnSync(process.execPath,['-e',`
    const before = process.listenerCount('exit');
    const tool = require(process.argv[1]);
    process.exitCode = 23;
    setTimeout(()=>console.log(JSON.stringify({pack:typeof tool.pack,extraExitListeners:process.listenerCount('exit')-before})),15);
  `,SCRIPT],{encoding:'utf8',timeout:2000,killSignal:'SIGKILL'});
  assert.equal(result.error,undefined); assert.equal(result.signal,null); assert.equal(result.status,23);
  assert.deepEqual(JSON.parse(result.stdout),{pack:'function',extraExitListeners:0});
});

test('artifact tree receipts hash file bytes and internal framework links without following external aliases', t => {
  const {artifactSnapshot} = tooling();
  assert.equal(typeof artifactSnapshot,'function','artifact input/output tree hashing is required');
  const root = temporary(t), target = path.join(root,'Framework.framework/Versions/A/binary');
  fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,'NON_NATIVE_FRAMEWORK_FIXTURE');
  const link = path.join(root,'Framework.framework/Versions/Current');
  fs.symlinkSync('A',link);
  const before = artifactSnapshot(root);
  assert.equal(before.files.find(f=>f.path.endsWith('/binary')).sha256,sha('NON_NATIVE_FRAMEWORK_FIXTURE'));
  assert.equal(before.files.find(f=>f.path.endsWith('/Current')).target,'A');
  assert.deepEqual(artifactSnapshot(root),before);
  fs.appendFileSync(target,'changed');
  assert.notEqual(artifactSnapshot(root).treeSha256,before.treeSha256);
  fs.unlinkSync(link); fs.symlinkSync(os.tmpdir(),link);
  assert.throws(()=>artifactSnapshot(root),/TREE_EXTERNAL_LINK/);
});

test('packaged payload readback inspects real asar trust bytes and manifest placement without launching an App', async t => {
  const {verifyPackagedPayload,sourceSnapshot,verifyStage} = tooling();
  assert.equal(typeof verifyPackagedPayload,'function','packaged asar byte readback is required');
  const {dir} = fixtureRepo(t), source = sourceSnapshot(dir), staged = fixtureStage(t,source);
  const admitted = verifyStage(staged.dir,staged.sha256,source), root = temporary(t);
  const app = path.join(root,'NON_NATIVE_FIXTURE.app'), resources = path.join(app,'Contents/Resources');
  fs.mkdirSync(resources,{recursive:true,mode:0o700});
  fs.cpSync(admitted.resources,resources,{recursive:true});
  const asarSource = path.join(root,'asar-source');
  for (const file of source.files.filter(f=>f.path.startsWith('apps/desktop/'))) {
    const target = path.join(asarSource,file.path); fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
    fs.writeFileSync(target,file.path.endsWith('/bundled-voice-trust.cjs') ? admitted.trustBytes : fs.readFileSync(path.join(dir,file.path)));
  }
  const asar = require('@electron/asar'), archive = path.join(resources,'app.asar');
  await asar.createPackage(asarSource,archive);
  const result = verifyPackagedPayload(app,admitted);
  assert.equal(result.compiledTrustSha256,sha(admitted.trustBytes));
  assert.equal(result.appAcceptance,'NOT_RUN');
  assert.equal(result.treeDigest,admitted.trust.treeDigest);
  const capability = path.join(resources,'manifests/speech-model-capabilities.json');
  fs.appendFileSync(capability,' ');
  assert.throws(()=>verifyPackagedPayload(app,admitted),/INVENTORY_FILE_MISMATCH/);
  fs.copyFileSync(path.join(admitted.resources,'manifests/speech-model-capabilities.json'),capability);
  fs.writeFileSync(path.join(asarSource,'apps/desktop/bundled-voice-trust.cjs'),'module.exports=null;\n');
  await asar.createPackage(asarSource,archive);
  assert.throws(()=>verifyPackagedPayload(app,admitted),/PACKAGED_COMPILED_TRUST/);
});

function fixtureAsarPayload(t, sourceDir, source, extraRuntime = []) {
  const staged = fixtureStage(t,source,extraRuntime), {verifyStage} = tooling(), root = temporary(t);
  const admitted = verifyStage(staged.dir,staged.sha256,source), app = path.join(root,'NON_NATIVE_FIXTURE.app');
  const resources = path.join(app,'Contents/Resources'), input = path.join(root,'asar-input');
  fs.mkdirSync(resources,{recursive:true,mode:0o700});
  fs.cpSync(admitted.resources,resources,{recursive:true});
  for (const file of source.files.filter(file => file.path.startsWith('apps/desktop/') || file.path.startsWith('apps/web/'))) {
    const target = path.join(input,file.path);
    fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
    fs.writeFileSync(target,file.path === 'apps/desktop/bundled-voice-trust.cjs'
      ? admitted.trustBytes : fs.readFileSync(path.join(sourceDir,file.path)),{mode:0o600});
  }
  return {app,input,admitted,archive:path.join(resources,'app.asar')};
}

async function runtimeZipArtifacts(t) {
  const {dir} = fixtureRepo(t), source = tooling().sourceSnapshot(dir);
  const zipRelative = 'runtime/bin/_internal/base_library.zip', zipBytes = Buffer.from('NON_NATIVE_RUNTIME_ZIP_FIXTURE');
  const fixture = fixtureAsarPayload(t,dir,source,[[zipRelative,zipBytes]]);
  await require('@electron/asar').createPackage(fixture.input,fixture.archive);
  const root = temporary(t), appRelative = 'mac-arm64/Voice Practice.app', app = path.join(root,appRelative);
  fs.mkdirSync(path.dirname(app),{recursive:true,mode:0o700});
  fs.renameSync(fixture.app,app);
  // Real stage, compiled inventory and asar payload checks precede every mutation.
  tooling().verifyPackagedPayload(app,fixture.admitted);
  const {assertArtifactPolicy} = boundaryTooling(); // Private test seam, not a product export.
  const check = dmg => assertArtifactPolicy(tooling().artifactSnapshot(root),appRelative,fixture.admitted.inventory,dmg);
  return {root,appRelative,zipRelative,zipBytes,zip:path.join(app,'Contents/Resources/voice-assets',zipRelative),check};
}

test('artifact ZIP policy accepts admitted runtime bytes but rejects extra release ZIPs at every depth', async t => {
  const {root,appRelative,zipRelative,check} = await runtimeZipArtifacts(t);
  check(false); // An internal ZIP is also valid for the default dir-only target.
  fs.writeFileSync(path.join(root,'NON_NATIVE_FIXTURE.dmg'),'NON_NATIVE_DMG_FIXTURE');
  check(true);
  for (const relative of ['extra.zip','nested/extra.zip',
    appRelative+'-copy/Contents/Resources/voice-assets/'+zipRelative,
    appRelative+'/Contents/Resources/extra.zip',
    appRelative+'/Contents/Resources/voice-assets/runtime/bin/_internal/unlisted.zip',
    appRelative+'/Contents/Resources/voice-assets/runtime-copy/bin/_internal/base_library.zip']) {
    const extra = path.join(root,relative);
    fs.mkdirSync(path.dirname(extra),{recursive:true,mode:0o700});
    fs.writeFileSync(extra,'NON_NATIVE_EXTRA_ZIP',{mode:0o600});
    assert.throws(()=>check(true),/^Error: MODEL_PACK_UNEXPECTED_ARTIFACTS$/,relative);
    fs.unlinkSync(extra);
  }
  check(true);
});

test('artifact ZIP policy rechecks final type bytes and hash after payload readback and preserves DMG counts', async t => {
  const {root,zip,zipBytes,check} = await runtimeZipArtifacts(t);
  for (const mutation of ['hash','bytes','symlink','directory']) {
    if (mutation === 'hash') {
      const changed = Buffer.from(zipBytes); changed[0] ^= 1;
      fs.writeFileSync(zip,changed);
    } else if (mutation === 'bytes') fs.appendFileSync(zip,'x');
    else {
      fs.unlinkSync(zip);
      if (mutation === 'directory') fs.mkdirSync(zip,{mode:0o700});
      else {
        fs.writeFileSync(zip+'-content',zipBytes,{mode:0o600});
        fs.symlinkSync(path.basename(zip)+'-content',zip);
      }
    }
    assert.throws(()=>check(false),/^Error: MODEL_PACK_UNEXPECTED_ARTIFACTS$/,mutation);
    fs.rmSync(zip,{recursive:true});
    if (mutation === 'symlink') fs.unlinkSync(zip+'-content');
    fs.writeFileSync(zip,zipBytes,{mode:0o600});
  }
  check(false);
  assert.throws(()=>check(true),/^Error: MODEL_PACK_UNEXPECTED_ARTIFACTS$/,'--dmg requires one image');
  const first = path.join(root,'NON_NATIVE_ONE.dmg'), second = path.join(root,'nested/NON_NATIVE_TWO.dmg');
  fs.writeFileSync(first,'NON_NATIVE_DMG_FIXTURE');
  check(true);
  assert.throws(()=>check(false),/^Error: MODEL_PACK_UNEXPECTED_ARTIFACTS$/,'dir-only rejects DMG');
  fs.mkdirSync(path.dirname(second),{mode:0o700}); fs.writeFileSync(second,'NON_NATIVE_DMG_FIXTURE');
  assert.throws(()=>check(true),/^Error: MODEL_PACK_UNEXPECTED_ARTIFACTS$/,'nested second DMG still counts');
});

test('source descriptor asar readback rejects a materialized .venv descriptor in a real archive', async t => {
  const {dir,link,target} = fixtureSourceLink(t), {sourceSnapshot,verifyPackagedPayload} = tooling();
  const source = sourceSnapshot(dir), before = fileState(link), fixture = fixtureAsarPayload(t,dir,source);
  const asar = require('@electron/asar');
  await asar.createPackage(fixture.input,fixture.archive);
  assert.equal(verifyPackagedPayload(fixture.app,fixture.admitted).appAcceptance,'NOT_RUN');
  fs.writeFileSync(path.join(fixture.input,'.venv'),target,{mode:0o600});
  await asar.createPackage(fixture.input,fixture.archive);
  assert.throws(() => verifyPackagedPayload(fixture.app,fixture.admitted),/^Error: MODEL_PACK_PACKAGED_SOURCE_LINK$/);
  assert.deepEqual(fileState(link),before,'the real source link must never be materialized or removed');
  assert.deepEqual(sourceSnapshot(dir),source);
});

test('source descriptor input policy rejects broadened builder files before packing', t => {
  const stage = temporary(t), output = temporary(t), yaml = require('js-yaml');
  fs.writeFileSync(path.join(output,'builder-base.json'),'{}\n',{mode:0o600});
  const reader = boundaryTooling({'js-yaml':{...yaml,load(bytes) {
    const config = yaml.load(bytes);
    config.files.push('.venv'); // Config-boundary fault; no actual YAML/source edit.
    return config;
  }}});
  assert.throws(() => reader.packConfiguration(stage,output),/^Error: MODEL_PACK_BUILDER_SOURCE_FILES$/);
});

test('electron-builder effective config is local arm64 dir by default, with only staged manifests and optional dmg', async t => {
  const {packConfiguration} = tooling();
  assert.equal(typeof packConfiguration,'function','local-only builder configuration is required');
  const stage = temporary(t), output = path.join(temporary(t),'fresh-pack');
  fs.mkdirSync(output,{mode:0o700});
  fs.writeFileSync(path.join(output,'builder-base.json'),'{}\n',{mode:0o600});
  const builder = require('electron-builder');
  const {Packager} = require('app-builder-lib/out/packager.js');
  for (const dmg of [false,true]) {
    const plan = packConfiguration(stage,output,dmg);
    assert.equal(plan.projectDir,ROOT);
    assert.equal(plan.publish,'never');
    const mac = plan.targets.get(builder.Platform.MAC);
    assert.deepEqual([...mac.keys()],[builder.Arch.arm64]);
    assert.deepEqual(mac.get(builder.Arch.arm64),dmg ? ['dir','dmg'] : ['dir']);
    const packager = new Packager(plan);
    await packager.validateConfig(); // Real loader/schema only: never call build().
    const config = packager.config;
    assert.equal(config.mac.identity,null);
    assert.equal(config.mac.notarize,false);
    assert.equal(config.publish,null);
    assert.equal(config.npmRebuild,false);
    assert.deepEqual(config.mac.signIgnore,['/voice-assets/']);
    assert.equal(config.directories.output,path.join(output,'artifacts'));
    assert.equal(config.electronDist,path.join(ROOT,'node_modules/electron/dist'));
    assert.deepEqual(config.extraResources,[{from:path.join(stage,'resources/manifests'),to:'manifests',filter:['*.json']}]);
    assert.deepEqual(config.mac.extraResources.map(x=>x.to).sort(),['foundation-models','voice-assets','voice-assets-inventory.json']);
    assert.equal(config.mac.extraResources.find(x=>x.to==='voice-assets').from,path.join(stage,'resources/voice-assets'));
    assert.equal(config.dmg.writeUpdateInfo,false);
    assert.equal(config.dmg.sign,false);
    assert.equal(JSON.stringify(config.mac.target).includes('zip'),false);
  }
});

test('source descriptor effective files exclude both leaves after real Packager validation and main matching', async t => {
  const stage = temporary(t), output = temporary(t), {Packager} = require('app-builder-lib/out/packager.js');
  const {getMainFileMatchers} = require('app-builder-lib/out/fileMatcher.js');
  const {assertPackagedSourceFiles} = boundaryTooling(); // Test-only access; not a product export or override.
  fs.writeFileSync(path.join(output,'builder-base.json'),'{}\n',{mode:0o600});
  for (const dmg of [false,true]) {
    const plan = tooling().packConfiguration(stage,output,dmg), loader = new Packager(plan);
    await loader.validateConfig(); // Real installed loader only; never build().
    const config = loader.config;
    assert.deepEqual(config.files,[{filter:['package.json','apps/desktop/**','apps/web/**','node_modules/pend/**','node_modules/yauzl/**']}]);
    assertPackagedSourceFiles(config);
    const matchers = getMainFileMatchers(ROOT,path.join(output,'asar'),value=>value,config.mac,{info:loader},config.directories.output,false);
    const filters = matchers.map(matcher=>matcher.createFilter());
    const selected = (relative,stat) => filters.some(filter=>filter(path.join(ROOT,relative),stat));
    const fileStat = fs.lstatSync(path.join(ROOT,'package.json'));
    // A checkout without the optional local .venv link (CI) has nothing to exclude there.
    for (const relative of SOURCE_LINK_PATHS.filter(rel => fs.existsSync(path.join(ROOT,rel)) || fs.lstatSync(path.join(ROOT,rel),{throwIfNoEntry:false}))) {
      assert.equal(selected(relative,fs.lstatSync(path.join(ROOT,relative))),false,relative);
      assert.equal(selected(relative+'/child',fileStat),false,'no following a descriptor subtree');
    }
    for (const relative of ['package.json','apps/desktop/bundled-voice-trust.cjs','apps/web/index.html']) {
      assert.equal(selected(relative,fileStat),true,'legitimate payload selection must remain: '+relative);
    }
    t.diagnostic(JSON.stringify({dmg,effectiveFiles:config.files,descriptorLeavesSelected:false}));
  }
});

for (const mutation of ['global-glob','global-venv','renamed-venv','renamed-ios','mac-files','extra-files','mac-extra-files']) {
  test(`source descriptor effective file guard rejects ${mutation} after real Packager validation`, async t => {
    const stage = temporary(t), output = temporary(t), {Packager} = require('app-builder-lib/out/packager.js');
    fs.writeFileSync(path.join(output,'builder-base.json'),'{}\n',{mode:0o600});
    const plan = tooling().packConfiguration(stage,output);
    if (mutation === 'global-glob') plan.config.files.push('**/*');
    else if (mutation === 'global-venv') plan.config.files.push('.venv');
    else if (mutation === 'renamed-venv' || mutation === 'renamed-ios') {
      plan.config.files.push({from:mutation === 'renamed-venv' ? '.venv' : SOURCE_LINK_PATHS[1],to:'renamed-source-descriptor'});
    } else if (mutation === 'mac-files') plan.config.mac.files = [SOURCE_LINK_PATHS[1]];
    else if (mutation === 'extra-files') plan.config.extraFiles = [{from:'.venv',to:'renamed-source-descriptor'}];
    else plan.config.mac.extraFiles = [{from:SOURCE_LINK_PATHS[1],to:'renamed-source-descriptor'}];
    const loader = new Packager(plan);
    await loader.validateConfig();
    assert.throws(() => boundaryTooling().assertPackagedSourceFiles(loader.config),/^Error: MODEL_PACK_BUILDER_SOURCE_FILES$/);
  });
}

test('a reanchored stage still hashes actual runtime bytes against the compiled inventory', t => {
  const {verifyStage,sourceSnapshot} = tooling();
  const {dir} = fixtureRepo(t), source = sourceSnapshot(dir), staged = fixtureStage(t,source);
  fs.appendFileSync(path.join(staged.dir,'resources/voice-assets/runtime/bin/voice-runtime'),'modified after signing');
  assert.throws(() => verifyStage(staged.dir,staged.seal(),source),/INVENTORY_FILE_MISMATCH/);
});

test('native signature admission rejects the tiny metadata fixture, never promoting it to a real runtime', t => {
  const {verifyNativeSignatures,verifyStage,sourceSnapshot} = tooling();
  assert.equal(typeof verifyNativeSignatures,'function','independent native signature verification is required');
  const {dir} = fixtureRepo(t), source = sourceSnapshot(dir), staged = fixtureStage(t,source);
  const admitted = verifyStage(staged.dir,staged.sha256,source);
  assert.throws(() => verifyNativeSignatures(path.join(admitted.resources,'voice-assets'),admitted.inventory,admitted.receipt.signing),
    /MACHO_ENTRY_REQUIRED|MAC_ARM64_REQUIRED/);
});

test('native verifier checks every Mach-O with lipo and strict codesign (OS-boundary double only)', t => {
  const {createRequire} = require('node:module'), vm = require('node:vm');
  const base = temporary(t), files = [];
  for (const relative of ['runtime/bin/voice-runtime','runtime/bin/libfixture.dylib']) {
    const file = path.join(base,relative), bytes = Buffer.concat([Buffer.from('cffaedfe','hex'),Buffer.from('NON_NATIVE_MACHO_FIXTURE')]);
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700}); fs.writeFileSync(file,bytes,{mode:0o700});
    files.push({path:relative,bytes:bytes.length,sha256:sha(bytes)});
  }
  const calls = [], localRequire = createRequire(SCRIPT), context = {module:{exports:{}}, Buffer,
    __dirname:path.dirname(SCRIPT), process:{...process,platform:'darwin',arch:'arm64'}};
  context.require = name => name === 'node:child_process'
    ? {spawnSync(command,args) { calls.push([command,...args]); return {status:0,signal:null,stdout:Buffer.from(''),stderr:Buffer.from('')}; }} : localRequire(name);
  vm.runInNewContext(fs.readFileSync(SCRIPT,'utf8'),context,{filename:SCRIPT});
  const fn = context.module.exports.verifyNativeSignatures;
  assert.equal(typeof fn,'function','native signature verifier is required');
  const inv = require('../apps/desktop/tree-integrity.cjs').canonicalInventory(files);
  const result = fn(base,inv,{files:files.map(f=>f.path).sort()});
  assert.equal(result.status,'PASS'); // A boundary-double result, never a native receipt.
  assert.equal(calls.filter(c=>c[0]==='/usr/bin/codesign').length,files.length);
  assert.equal(calls.filter(c=>c[0]==='/usr/bin/lipo').length,files.length);
  assert.ok(calls.filter(c=>c[0]==='/usr/bin/codesign').every(c=>c.includes('--verify') && c.includes('--strict') && !c.includes('--sign')));
  assert.ok(calls.filter(c=>c[0]==='/usr/bin/lipo').every(c=>c.includes('-verify_arch') && c.includes('arm64')));
});

test('temporary trust uses the real compiled module and restores exact original bytes on success and failure', async t => {
  const {withCompiledTrust,sourceSnapshot,verifyStage} = tooling();
  assert.equal(typeof withCompiledTrust,'function','scoped compiled-root transaction is required');
  const {dir} = fixtureRepo(t), source = sourceSnapshot(dir), staged = fixtureStage(t,source);
  const admitted = verifyStage(staged.dir,staged.sha256,source);
  const trustFile = path.join(dir,'apps/desktop/bundled-voice-trust.cjs');
  const original = fs.readFileSync(trustFile), mode = fs.statSync(trustFile).mode;
  const bundled = require(path.join(dir,'apps/desktop/bundled-voice-assets.cjs'));
  assert.equal(bundled.loadTrust(undefined,'darwin'),null); // Deliberately populate the require cache first.
  for (const fail of [false,true]) {
    const work = withCompiledTrust(dir,admitted.trustBytes,async ({assertSourceUnchanged}) => {
      assertSourceUnchanged();
      assert.deepEqual(fs.readFileSync(trustFile),admitted.trustBytes);
      const prepared = await bundled.prepareBundledRuntimeAssets({resourcesPath:admitted.resources,platform:'darwin'});
      assert.equal(bundled.describeBundledRuntimeSource(prepared).authority,'COMPILED_ROOT');
      assert.ok(bundled.authenticatedBundledRuntimeSource(prepared));
      if (fail) throw Error('simulated builder rejection (NOT native builder)');
      return 'component-readback';
    });
    if (fail) await assert.rejects(work,/simulated builder rejection/);
    else assert.equal(await work,'component-readback');
    assert.deepEqual(fs.readFileSync(trustFile),original);
    assert.equal(fs.statSync(trustFile).mode,mode);
    assert.equal(bundled.loadTrust(undefined,'darwin'),null);
    assert.deepEqual(sourceSnapshot(dir),source);
  }
});

for (const mode of [0o1644,0o2644,0o4644]) {
  test(`B1 rejects unsupported trust mode ${mode.toString(8)} before any write`, async t => {
    const {dir} = fixtureRepo(t), trustFile = path.join(dir,'apps/desktop/bundled-voice-trust.cjs');
    const {sourceSnapshot,compiledTrustBytes,deriveStageMetadata} = tooling();
    fs.chmodSync(trustFile,mode);
    assert.equal(fs.statSync(trustFile).mode & 0o7777,mode,'real filesystem must carry the tested special bit');
    const source = sourceSnapshot(dir), before = fileState(trustFile), writes = [], openDescriptors = new Set();
    const generated = compiledTrustBytes(deriveStageMetadata(catalog(),fixtureInventory()).trust);
    let called = false, failure, openedForWrite = false;
    const boundaryFs = {...fs,
      openSync(file,flags,...rest) {
        const fd = fs.openSync(file,flags,...rest); openDescriptors.add(fd);
        if (file === trustFile && (flags & fs.constants.O_RDWR)) openedForWrite = true;
        return fd;
      },
      closeSync(fd) { fs.closeSync(fd); openDescriptors.delete(fd); },
      ftruncateSync(...args) { writes.push('truncate'); return fs.ftruncateSync(...args); },
      writeSync(...args) { writes.push('write'); return fs.writeSync(...args); },
      fchmodSync(...args) { writes.push('chmod'); return fs.fchmodSync(...args); },
    };
    try {
      await boundaryTooling({'node:fs':boundaryFs}).withCompiledTrust(dir,generated,async () => { called = true; });
    } catch (error) { failure = error; }
    t.diagnostic(JSON.stringify({mode:mode.toString(8),writes,called,openedForWrite,
      modeAfter:(fs.statSync(trustFile).mode & 0o7777).toString(8),error:failure?.message}));
    assert.deepEqual(writes,[],'unsupported bits must be rejected before truncate/write/chmod');
    assert.equal(openedForWrite,false);
    assert.equal(called,false);
    assert.deepEqual([...openDescriptors],[]);
    assert.deepEqual(fileState(trustFile),before,'mode-policy rejection must leave original bytes and full mode intact');
    assert.match(failure?.message || '',/^MODEL_PACK_TRUST_MODE_UNSUPPORTED$/);
    assert.deepEqual(sourceSnapshot(dir),source);
  });
}

for (const operation of ['fsyncSync','fchmodSync','writeSync','post-write-fstat']) {
  test(`L2 restores fully owned generated trust after one-shot ${operation} failure (bounded real filesystem)`, t => {
    const {dir} = fixtureRepo(t), {sourceSnapshot,compiledTrustBytes,deriveStageMetadata} = tooling();
    const source = sourceSnapshot(dir), generated = compiledTrustBytes(deriveStageMetadata(catalog(),fixtureInventory()).trust);
    const observed = boundedTrustWriteFailure(dir,generated,operation);
    t.diagnostic(JSON.stringify(observed));
    assert.equal(observed.injected,true,'fault must run after the real first write');
    assert.deepEqual(observed.ownedAtFault,{pathnameIdentity:true,heldIdentity:true,oneLink:true,
      fullMode:true,pathnameBytes:true,heldBytes:true});
    assert.equal(observed.callbackRan,false,'a failed initial replacement must never invoke the callback');
    assert.equal(observed.heldFdClosed,true);
    assert.deepEqual(observed.openDescriptors,[]);
    assert.equal(observed.errorIsOriginal,true,'successful owned recovery must propagate the same I/O error');
    assert.equal(observed.errorCode,'EIO');
    assert.equal(observed.originalRestored,true,'fully owned generated bytes must be restored even when replace did not return');
    assert.equal(observed.generatedRemains,false);
    assert.equal(observed.fullModeRestored,true);
    assert.equal(observed.identityRetained,true);
    assert.equal(observed.oneLink,true);
    assert.equal(observed.cacheCleared,true);
    assert.equal(observed.fsyncCalls,['fsyncSync','post-write-fstat'].includes(operation) ? 2 : 1);
    assert.equal(observed.sourceAfter,'CLEAN_BASELINE_MATCH');
    assert.deepEqual(sourceSnapshot(dir),source);
  });
}

for (const change of ['bytes','mode','path','symlink','hardlink','partial-write','truncate']) {
  test(`L2 preserves ${change} state when initial write fails without provable generated ownership`, async t => {
    const {dir} = fixtureRepo(t), outside = temporary(t);
    const trustFile = path.join(dir,'apps/desktop/bundled-voice-trust.cjs');
    const {sourceSnapshot,compiledTrustBytes,deriveStageMetadata} = tooling();
    const generated = compiledTrustBytes(deriveStageMetadata(catalog(),fixtureInventory()).trust);
    const original = fs.readFileSync(trustFile), originalStat = fs.statSync(trustFile);
    const sentinel = path.join(outside,'sentinel'), backup = path.join(outside,'original.cjs');
    const displaced = path.join(outside,'displaced.cjs');
    fs.writeFileSync(sentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
    // Test-owned backup only; real pack-created backup coverage remains in the orchestration test.
    fs.writeFileSync(backup,original,{mode:0o600});
    const sentinelBefore = fileState(sentinel), backupBefore = fileState(backup), mutations = [], openDescriptors = new Set();
    const ioError = Object.assign(Error('ONE_SHOT_CONFLICTING_TRUST_IO_FAILURE'),{code:'EIO'});
    let heldFd, injected = false, callbackRan = false, failure, concurrentBefore, displacedBefore, mutationsAtFault, ownershipAtFault;
    const inject = () => {
      injected = true;
      const held = fs.fstatSync(heldFd), listed = fs.lstatSync(trustFile), bytes = Buffer.alloc(generated.length);
      let offset = 0, count;
      while (offset < bytes.length && (count = fs.readSync(heldFd,bytes,offset,bytes.length-offset,offset))) offset += count;
      ownershipAtFault = {identity:held.dev === originalStat.dev && held.ino === originalStat.ino
        && listed.dev === originalStat.dev && listed.ino === originalStat.ino,
        oneLink:held.nlink === 1 && listed.nlink === 1,fullMode:held.mode === originalStat.mode && listed.mode === originalStat.mode,
        generatedBytes:held.size === generated.length && offset === generated.length && bytes.equals(generated)
          && fs.readFileSync(trustFile).equals(generated)};
      if (change === 'bytes') {
        const concurrent = Buffer.from(generated); concurrent[concurrent.indexOf('Generated')] = 'g'.charCodeAt(0);
        fs.writeFileSync(trustFile,concurrent);
      } else if (change === 'mode') fs.chmodSync(trustFile,(originalStat.mode & 0o777) ^ 0o040);
      else if (change === 'hardlink') fs.linkSync(trustFile,displaced);
      else if (change === 'path' || change === 'symlink') {
        fs.renameSync(trustFile,displaced);
        if (change === 'symlink') fs.symlinkSync(sentinel,trustFile);
        else fs.writeFileSync(trustFile,generated,{mode:originalStat.mode & 0o777});
      }
      concurrentBefore = fileState(trustFile);
      if (fs.existsSync(displaced)) displacedBefore = fileState(displaced);
      mutationsAtFault = mutations.slice();
      throw ioError;
    };
    const boundaryFs = {...fs,
      openSync(file,flags,...rest) {
        const fd = fs.openSync(file,flags,...rest); openDescriptors.add(fd);
        if (file === trustFile && (flags & fs.constants.O_RDWR)) heldFd = fd;
        return fd;
      },
      closeSync(fd) { fs.closeSync(fd); openDescriptors.delete(fd); },
      ftruncateSync(...args) {
        mutations.push('truncate');
        const result = fs.ftruncateSync(...args);
        if (!injected && change === 'truncate') inject();
        return result;
      },
      writeSync(fd,buffer,offset,length,position) {
        mutations.push('write');
        const partial = !injected && change === 'partial-write';
        const written = fs.writeSync(fd,buffer,offset,partial ? Math.min(length,8) : length,position);
        if (partial) inject();
        return written;
      },
      fchmodSync(...args) { mutations.push('chmod'); return fs.fchmodSync(...args); },
      fsyncSync(...args) {
        const result = fs.fsyncSync(...args);
        if (!injected) inject();
        return result;
      },
    };
    try {
      await boundaryTooling({'node:fs':boundaryFs}).withCompiledTrust(dir,generated,async () => { callbackRan = true; });
    } catch (error) { failure = error; }
    t.diagnostic(JSON.stringify({change,injected,ownershipAtFault,callbackRan,mutationsAtFault,mutations,error:failure?.message}));
    assert.equal(injected,true,'the actual first-write syscall boundary must be reached');
    assert.deepEqual(ownershipAtFault,{identity:true,oneLink:true,fullMode:true,
      generatedBytes:!['partial-write','truncate'].includes(change)});
    assert.equal(callbackRan,false);
    assert.throws(() => fs.fstatSync(heldFd),{code:'EBADF'});
    assert.deepEqual([...openDescriptors],[]);
    assert.equal(require.cache[trustFile],undefined);
    assert.deepEqual(mutations,mutationsAtFault,'unproven or conflicting bytes must not trigger a recovery write/chmod');
    assert.deepEqual(fileState(trustFile),concurrentBefore,'failed ownership must preserve the exact current state, not force original bytes');
    if (displacedBefore) assert.deepEqual(fileState(displaced),displacedBefore,'held-fd identity cannot authorize writes to a displaced/shared inode');
    assert.deepEqual(fileState(sentinel),sentinelBefore);
    assert.deepEqual(fileState(backup),backupBefore);
    assert.equal(fs.statSync(backup).mode & 0o777,0o600);
    assert.deepEqual(fs.readdirSync(outside).sort(),displacedBefore ? ['displaced.cjs','original.cjs','sentinel'] : ['original.cjs','sentinel']);
    assert.match(failure?.message || '',/MODEL_PACK_(TRUST_|UNSAFE_LINK)/);
    assert.throws(() => sourceSnapshot(dir),/SOURCE_DIRTY/);
  });
}

test('S1 restore preserves another writer\'s in-place trust bytes', async t => {
  const {dir} = fixtureRepo(t), outside = temporary(t);
  const {withCompiledTrust,sourceSnapshot,compiledTrustBytes,deriveStageMetadata} = tooling();
  const trustFile = path.join(dir,'apps/desktop/bundled-voice-trust.cjs');
  const generated = compiledTrustBytes(deriveStageMetadata(catalog(),fixtureInventory()).trust);
  const concurrent = Buffer.from(generated);
  concurrent[concurrent.indexOf('Generated')] = 'g'.charCodeAt(0); // Same length, same inode/nlink.
  const sentinel = path.join(outside,'sentinel'), sentinelBytes = Buffer.from('EXTERNAL_SENTINEL_UNCHANGED');
  fs.writeFileSync(sentinel,sentinelBytes,{mode:0o600});
  const before = fs.statSync(trustFile), sentinelBefore = fs.statSync(sentinel);
  let failure;
  try {
    await withCompiledTrust(dir,generated,async () => {
      fs.writeFileSync(trustFile,concurrent);
      assert.equal(fs.statSync(trustFile).ino,before.ino);
      assert.equal(fs.statSync(trustFile).nlink,1);
    });
  } catch (error) { failure = error; }
  assert.deepEqual(fs.readFileSync(trustFile),concurrent,'restore must not overwrite concurrent trust bytes');
  assert.equal(fs.statSync(trustFile).mode,before.mode);
  assert.equal(fs.statSync(trustFile).ino,before.ino);
  assert.deepEqual(fs.readFileSync(sentinel),sentinelBytes);
  assert.equal(fs.statSync(sentinel).mode,sentinelBefore.mode);
  assert.equal(fs.statSync(sentinel).ino,sentinelBefore.ino);
  assert.deepEqual(fs.readdirSync(outside),['sentinel']);
  assert.match(failure?.message || '',/MODEL_PACK_(SOURCE_BYTES|TRUST_)/);
  assert.throws(() => sourceSnapshot(dir),/SOURCE_DIRTY/);
});

test('S1 restore preserves a concurrent non-executable trust mode change', async t => {
  const {dir} = fixtureRepo(t), outside = temporary(t);
  const {withCompiledTrust,compiledTrustBytes,deriveStageMetadata} = tooling();
  const trustFile = path.join(dir,'apps/desktop/bundled-voice-trust.cjs');
  const generated = compiledTrustBytes(deriveStageMetadata(catalog(),fixtureInventory()).trust);
  const sentinel = path.join(outside,'sentinel');
  fs.writeFileSync(sentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
  const sentinelBefore = fs.statSync(sentinel), original = fs.statSync(trustFile);
  const concurrentMode = (original.mode & 0o777) ^ 0o040;
  let failure;
  try {
    await withCompiledTrust(dir,generated,async () => {
      fs.chmodSync(trustFile,concurrentMode); // Git's executable bit does not change.
    });
  } catch (error) { failure = error; }
  assert.equal(fs.statSync(trustFile).mode & 0o777,concurrentMode,'restore must not chmod another writer\'s edit');
  assert.ok(fs.readFileSync(trustFile).equals(generated),'conflicted generated bytes must remain for owner review');
  assert.equal(fs.statSync(trustFile).ino,original.ino);
  assert.equal(fs.readFileSync(sentinel,'utf8'),'EXTERNAL_SENTINEL_UNCHANGED');
  assert.equal(fs.statSync(sentinel).mode,sentinelBefore.mode);
  assert.equal(fs.statSync(sentinel).ino,sentinelBefore.ino);
  assert.deepEqual(fs.readdirSync(outside),['sentinel']);
  assert.match(failure?.message || '',/MODEL_PACK_TRUST_/);
});

test('S1 restore leaves a replaced pathname and displaced trust descriptor untouched', async t => {
  const {dir} = fixtureRepo(t), outside = temporary(t);
  const {withCompiledTrust,compiledTrustBytes,deriveStageMetadata} = tooling();
  const trustFile = path.join(dir,'apps/desktop/bundled-voice-trust.cjs');
  const generated = compiledTrustBytes(deriveStageMetadata(catalog(),fixtureInventory()).trust);
  const sentinel = path.join(outside,'sentinel'), displaced = path.join(outside,'displaced.cjs');
  fs.writeFileSync(sentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
  const sentinelBefore = fileState(sentinel), mode = fs.statSync(trustFile).mode & 0o777;
  let failure, replacementBefore, displacedBefore;
  try {
    await withCompiledTrust(dir,generated,async () => {
      fs.renameSync(trustFile,displaced); // Held descriptor still has nlink === 1.
      fs.writeFileSync(trustFile,generated,{mode}); // Equal bytes/mode are not ownership.
      replacementBefore = fileState(trustFile);
      displacedBefore = fileState(displaced);
      assert.notEqual(replacementBefore.ino,displacedBefore.ino);
      assert.equal(displacedBefore.nlink,1);
    });
  } catch (error) { failure = error; }
  assert.deepEqual(fileState(displaced),displacedBefore,'restore must not write the displaced external inode');
  assert.deepEqual(fileState(trustFile),replacementBefore,'replacement path belongs to the other writer');
  assert.deepEqual(fileState(sentinel),sentinelBefore);
  assert.deepEqual(fs.readdirSync(outside).sort(),['displaced.cjs','sentinel']);
  assert.match(failure?.message || '',/MODEL_PACK_TRUST_/);
});

for (const link of ['symlink','hardlink']) {
  test(`S1 restore preserves a concurrent ${link} conflict without touching external files`, async t => {
    const {dir} = fixtureRepo(t), outside = temporary(t);
    const {withCompiledTrust,compiledTrustBytes,deriveStageMetadata} = tooling();
    const trustFile = path.join(dir,'apps/desktop/bundled-voice-trust.cjs');
    const generated = compiledTrustBytes(deriveStageMetadata(catalog(),fixtureInventory()).trust);
    const sentinel = path.join(outside,'sentinel'), displaced = path.join(outside,'displaced.cjs');
    fs.writeFileSync(sentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
    const sentinelBefore = fileState(sentinel);
    let failure, trustBefore, displacedBefore;
    try {
      await withCompiledTrust(dir,generated,async () => {
        if (link === 'symlink') {
          fs.renameSync(trustFile,displaced);
          fs.symlinkSync(sentinel,trustFile);
        } else fs.linkSync(trustFile,displaced);
        trustBefore = fileState(trustFile);
        displacedBefore = fileState(displaced);
      });
    } catch (error) { failure = error; }
    assert.deepEqual(fileState(displaced),displacedBefore,'no restore through a displaced or shared descriptor');
    assert.deepEqual(fileState(trustFile),trustBefore);
    assert.deepEqual(fileState(sentinel),sentinelBefore);
    assert.deepEqual(fs.readdirSync(outside).sort(),['displaced.cjs','sentinel']);
    assert.match(failure?.message || '',/MODEL_PACK_(TRUST_|UNSAFE_LINK)/);
  });
}

for (const change of ['bytes','mode','path','symlink','hardlink']) {
  test(`S1 initial replacement validates ${change} ownership before any write`, async t => {
    const {dir} = fixtureRepo(t), outside = temporary(t);
    const trustFile = path.join(dir,'apps/desktop/bundled-voice-trust.cjs');
    const {compiledTrustBytes,deriveStageMetadata} = tooling();
    const generated = compiledTrustBytes(deriveStageMetadata(catalog(),fixtureInventory()).trust);
    const sentinel = path.join(outside,'sentinel');
    fs.writeFileSync(sentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
    const sentinelBefore = fileState(sentinel), writes = [];
    const displaced = path.join(outside,'displaced.cjs');
    let injected = false, heldFd, concurrentBefore, displacedBefore, called = false, failure;
    const boundaryFs = {...fs,
      openSync(file,flags,...rest) {
        const fd = fs.openSync(file,flags,...rest);
        if (file === trustFile && (flags & fs.constants.O_RDWR) && !injected) {
          injected = true; heldFd = fd;
          if (change === 'bytes') {
            const concurrent = fs.readFileSync(file);
            concurrent[1] = 'U'.charCodeAt(0); // Exports still null, but no longer the admitted bytes.
            fs.writeFileSync(file,concurrent);
          } else if (change === 'mode') fs.chmodSync(file,(fs.statSync(file).mode & 0o777) ^ 0o040);
          else if (change === 'hardlink') fs.linkSync(file,displaced);
          else {
            const original = fs.readFileSync(file), mode = fs.statSync(file).mode & 0o777;
            fs.renameSync(file,displaced);
            if (change === 'symlink') fs.symlinkSync(sentinel,file);
            else fs.writeFileSync(file,original,{mode});
          }
          concurrentBefore = fileState(file);
          if (fs.existsSync(displaced)) displacedBefore = fileState(displaced);
        }
        return fd;
      },
      ftruncateSync(...args) { writes.push('truncate'); return fs.ftruncateSync(...args); },
      writeSync(...args) { writes.push('write'); return fs.writeSync(...args); },
      fchmodSync(...args) { writes.push('chmod'); return fs.fchmodSync(...args); },
    };
    try {
      await boundaryTooling({'node:fs':boundaryFs}).withCompiledTrust(dir,generated,async () => { called = true; });
    } catch (error) { failure = error; }
    assert.equal(injected,true,'race must occur after real source admission and descriptor open');
    assert.deepEqual(fileState(trustFile),concurrentBefore,'first replacement must leave concurrent bytes and mode intact');
    assert.deepEqual(writes,[],'no truncate/write/chmod may run without initial ownership');
    assert.equal(called,false);
    assert.match(failure?.message || '',/MODEL_PACK_(TRUST_|UNSAFE_LINK)/);
    assert.throws(() => fs.fstatSync(heldFd),{code:'EBADF'});
    assert.deepEqual(fileState(sentinel),sentinelBefore);
    if (displacedBefore) assert.deepEqual(fileState(displaced),displacedBefore);
    assert.deepEqual(fs.readdirSync(outside).sort(),displacedBefore ? ['displaced.cjs','sentinel'] : ['sentinel']);
  });
}

for (const change of ['pathname-after-original-read','bytes-after-admission']) {
  test(`S1 initial snapshot rejects ${change} without adopting another writer\'s state`, async t => {
    const {dir} = fixtureRepo(t), outside = temporary(t), trustFile = path.join(dir,'apps/desktop/bundled-voice-trust.cjs');
    const {compiledTrustBytes,deriveStageMetadata} = tooling();
    const generated = compiledTrustBytes(deriveStageMetadata(catalog(),fixtureInventory()).trust);
    const original = fs.readFileSync(trustFile), mode = fs.statSync(trustFile).mode & 0o777;
    const displaced = path.join(outside,'displaced.cjs'), sentinel = path.join(outside,'sentinel');
    fs.writeFileSync(sentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
    const sentinelBefore = fileState(sentinel), writes = [];
    let reads = 0, originalReadFd, injected = false, concurrentBefore, displacedBefore, called = false, failure;
    const boundaryFs = {...fs,
      openSync(file,flags,...rest) {
        const fd = fs.openSync(file,flags,...rest);
        if (file === trustFile && !(flags & fs.constants.O_RDWR) && ++reads === 2) {
          originalReadFd = fd; // The first read belonged to real sourceSnapshot.
          if (change === 'bytes-after-admission') {
            const concurrent = Buffer.from(original); concurrent[1] = 'U'.charCodeAt(0);
            fs.writeFileSync(file,concurrent);
            injected = true; concurrentBefore = fileState(file);
          }
        }
        return fd;
      },
      closeSync(fd) {
        fs.closeSync(fd);
        if (fd === originalReadFd && !injected && change === 'pathname-after-original-read') {
          fs.renameSync(trustFile,displaced);
          fs.writeFileSync(trustFile,original,{mode});
          injected = true;
          concurrentBefore = fileState(trustFile); displacedBefore = fileState(displaced);
        }
      },
      ftruncateSync(...args) { writes.push('truncate'); return fs.ftruncateSync(...args); },
      writeSync(...args) { writes.push('write'); return fs.writeSync(...args); },
      fchmodSync(...args) { writes.push('chmod'); return fs.fchmodSync(...args); },
    };
    try {
      await boundaryTooling({'node:fs':boundaryFs}).withCompiledTrust(dir,generated,async () => { called = true; });
    } catch (error) { failure = error; }
    assert.equal(injected,true);
    assert.deepEqual(fileState(trustFile),concurrentBefore,'initial snapshot cannot adopt raced-in bytes or inode');
    assert.deepEqual(writes,[]);
    assert.equal(called,false);
    assert.match(failure?.message || '',/MODEL_PACK_(TRUST_|SOURCE_BYTES)/);
    assert.deepEqual(fileState(sentinel),sentinelBefore);
    if (displacedBefore) assert.deepEqual(fileState(displaced),displacedBefore);
    assert.deepEqual(fs.readdirSync(outside).sort(),displacedBefore ? ['displaced.cjs','sentinel'] : ['sentinel']);
  });
}

test('compiled-root transaction never excuses preexisting trust edits or restores unrelated dirty files', async t => {
  const {withCompiledTrust,sourceSnapshot,compiledTrustBytes,deriveStageMetadata} = tooling();
  assert.equal(typeof withCompiledTrust,'function','strict transaction admission is required');
  const {dir} = fixtureRepo(t), trustFile = path.join(dir,'apps/desktop/bundled-voice-trust.cjs');
  const original = fs.readFileSync(trustFile), generated = compiledTrustBytes(deriveStageMetadata(catalog(),fixtureInventory()).trust);
  fs.appendFileSync(trustFile,'// existing private change\n');
  const dirty = fs.readFileSync(trustFile);
  let called = false;
  await assert.rejects(withCompiledTrust(dir,generated,async () => { called = true; }),/SOURCE_DIRTY/);
  assert.equal(called,false);
  assert.deepEqual(fs.readFileSync(trustFile),dirty);
  fs.writeFileSync(trustFile,original);
  await assert.rejects(withCompiledTrust(dir,generated,async () => {
    fs.writeFileSync(path.join(dir,'source.cjs'),'unrelated change: must be preserved');
  }),/SOURCE_DIRTY|SOURCE_BYTES/);
  assert.deepEqual(fs.readFileSync(trustFile),original);
  assert.equal(fs.readFileSync(path.join(dir,'source.cjs'),'utf8'),'unrelated change: must be preserved');
  assert.throws(() => sourceSnapshot(dir),/SOURCE_DIRTY/);
});

test('L1 a trailing stage separator is rejected within a bounded child, while the canonical receipt succeeds', t => {
  const {dir} = fixtureRepo(t), {sourceSnapshot,artifactSnapshot} = tooling();
  const source = sourceSnapshot(dir), staged = fixtureStage(t,source), outside = temporary(t);
  const before = artifactSnapshot(staged.dir), sentinel = path.join(outside,'sentinel');
  fs.writeFileSync(sentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
  const sentinelBefore = fileState(sentinel);
  const canonical = boundedStageVerification(staged.dir,staged.sha256);
  const trailing = boundedStageVerification(staged.dir+path.sep,staged.sha256);
  assert.deepEqual(artifactSnapshot(staged.dir),before,'verification cannot mutate the receipted stage');
  assert.deepEqual(sourceSnapshot(dir),source);
  assert.deepEqual(fileState(sentinel),sentinelBefore);
  assert.deepEqual(fs.readdirSync(outside),['sentinel']);
  assert.equal(fs.existsSync(path.join(outside,'fresh-output')),false);
  assert.equal(canonical.error,undefined,canonical.stderr);
  assert.equal(canonical.status,0,canonical.stderr);
  assert.ok(canonical.stdout.includes('ACCEPTED_STAGE:'+staged.dir));
  assert.match(trailing.stdout,/ENTER_VERIFY_STAGE/,'the bounded child must reach the real verifier');
  assert.equal(trailing.error?.code,undefined,'noncanonical stage must reject, not time out in dirname(root)');
  assert.equal(trailing.signal,null);
  assert.equal(trailing.status,2,trailing.stderr);
  assert.match(trailing.stderr,/MODEL_PACK_UNSAFE_PATH/);
});

for (const step of ['root','outside','fixed-point']) {
  test(`L1 private-stage ancestor traversal rejects ${step} rather than looping (bounded path-boundary fault)`, t => {
    const {dir} = fixtureRepo(t), {sourceSnapshot,artifactSnapshot} = tooling();
    const source = sourceSnapshot(dir), staged = fixtureStage(t,source), outside = temporary(t);
    const before = artifactSnapshot(staged.dir), sentinel = path.join(outside,'sentinel');
    fs.writeFileSync(sentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
    const sentinelBefore = fileState(sentinel), result = boundedStageVerification(staged.dir,staged.sha256,step);
    assert.deepEqual(artifactSnapshot(staged.dir),before);
    assert.deepEqual(fileState(sentinel),sentinelBefore);
    assert.deepEqual(fs.readdirSync(outside),['sentinel']);
    assert.deepEqual(sourceSnapshot(dir),source);
    assert.match(result.stdout,/ENTER_VERIFY_STAGE/);
    assert.equal(result.error?.code,undefined,'ancestor traversal must fail closed before the child timeout');
    assert.equal(result.signal,null);
    assert.equal(result.status,2,result.stderr);
    assert.match(result.stderr,/MODEL_PACK_STAGE_PATH_ESCAPE/);
  });
}

test('stage receipt anchor verifies exact bytes, source, manifests and generated trust without executing stage JS', t => {
  const {verifyStage,sourceSnapshot,compiledTrustBytes} = tooling();
  assert.equal(typeof verifyStage,'function','stage verifier is required');
  const {dir} = fixtureRepo(t), source = sourceSnapshot(dir), staged = fixtureStage(t,source);
  const result = verifyStage(staged.dir,staged.sha256,source);
  assert.equal(result.receiptSha256,staged.sha256);
  assert.deepEqual(result.trustBytes,compiledTrustBytes(staged.trust));
  assert.throws(() => verifyStage(staged.dir,sha('wrong-anchor'),source),/STAGE_RECEIPT_HASH/);
  assert.throws(() => verifyStage(staged.dir,staged.sha256,{...source,commit:'4'.repeat(40)}),/SOURCE_MISMATCH/);
  const entry = path.join(staged.dir,'resources/voice-assets/runtime/bin/voice-runtime');
  fs.appendFileSync(entry,'tamper');
  assert.throws(() => verifyStage(staged.dir,staged.sha256,source),/INVENTORY_FILE_MISMATCH/);
});

test('a rehashed stage cannot substitute executable trust, claim an unsigned stage or smuggle extra files', t => {
  const {verifyStage,sourceSnapshot} = tooling();
  assert.equal(typeof verifyStage,'function','strict stage semantics are required');
  const {dir} = fixtureRepo(t), source = sourceSnapshot(dir), staged = fixtureStage(t,source);
  const trustFile = path.join(staged.dir,'bundled-voice-trust.cjs'), original = fs.readFileSync(trustFile);
  fs.appendFileSync(trustFile,'\nthrow Error("stage JS must never execute");\n');
  assert.throws(() => verifyStage(staged.dir,staged.seal(),source),/COMPILED_TRUST_MISMATCH/);
  fs.writeFileSync(trustFile,original);
  staged.receipt.signing.status = 'NOT_RUN';
  assert.throws(() => verifyStage(staged.dir,staged.seal(),source),/STAGE_SIGNING/);
  staged.receipt.signing.status = 'PASS';
  const anchor = staged.seal();
  fs.mkdirSync(path.join(staged.dir,'extra'),{mode:0o700});
  assert.throws(() => verifyStage(staged.dir,anchor,source),/UNLISTED_DIRECTORY/);
});

const SOURCE_LINK_PATHS = ['.venv','apps/ios/Sources/VoicePracticeCore/ScriptBridgeHandler.swift'];
function fixtureSourceLink(t, relative = '.venv', target = Buffer.from('missing-descriptor-only-fixture')) {
  const {dir,git} = fixtureRepo(t), link = path.join(dir,relative);
  fs.mkdirSync(path.dirname(link),{recursive:true,mode:0o700});
  fs.symlinkSync(target,link);
  git(['add','--',relative]);
  git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null',
    '-c','commit.gpgsign=false','commit','-qm','NON_NATIVE_SOURCE_LINK_FIXTURE']);
  assert.equal(git(['status','--porcelain=v1']), '');
  assert.match(git(['ls-tree','HEAD','--',relative]), /^120000 blob /);
  return {dir,git,relative,link,target};
}

test('source descriptor tracer admits the committed .venv link without resolving its absent target', t => {
  const {dir,git,relative,link,target} = fixtureSourceLink(t);
  const before = fileState(link), source = tooling().sourceSnapshot(dir);
  assert.deepEqual(source.files.find(file => file.path === relative), {path:relative,mode:'120000',
    blob:git(['rev-parse','HEAD:'+relative]).trim(),bytes:target.length,sha256:sha(target)});
  assert.equal(source.commit,git(['rev-parse','HEAD']).trim());
  assert.equal(source.files.length,git(['ls-files','-z']).split('\0').filter(Boolean).length);
  assert.deepEqual(fileState(link),before);
});

test('source descriptor admits only the exact committed iOS Swift link as mode 120000', t => {
  const {dir,git,relative,link,target} = fixtureSourceLink(t,SOURCE_LINK_PATHS[1],Buffer.from('../../VoicePractice/App/ScriptBridgeHandler.swift'));
  const before = fileState(link), source = tooling().sourceSnapshot(dir);
  assert.deepEqual(source.files.find(file => file.path === relative),{path:relative,mode:'120000',
    blob:git(['rev-parse','HEAD:'+relative]).trim(),bytes:target.length,sha256:sha(target)});
  assert.deepEqual(fileState(link),before);
});

function sourceReadBoundary(link, forbiddenRoot, attempts) {
  const boundary = {...fs};
  // Observe real filesystem calls; do not mock source/Git/blob validation.
  for (const method of ['statSync','realpathSync','readFileSync','openSync','existsSync','readdirSync']) {
    boundary[method] = (file,...args) => {
      const value = Buffer.isBuffer(file) ? file.toString() : file;
      if (typeof value === 'string' && (value === link || value.startsWith(link+path.sep)
          || value === forbiddenRoot || value.startsWith(forbiddenRoot+path.sep))) {
        attempts.push({method,file:value});
        throw Error('FORBIDDEN_SOURCE_LINK_TARGET_ACCESS');
      }
      return fs[method](file,...args);
    };
  }
  return boundary;
}

for (const relative of SOURCE_LINK_PATHS) {
  test(`source descriptor never stats opens resolves or reads an external target through ${relative}`, t => {
    const outside = temporary(t), sentinel = path.join(outside,'sentinel');
    fs.writeFileSync(sentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
    const {dir,link} = fixtureSourceLink(t,relative,Buffer.from(sentinel));
    const before = fileState(sentinel), linkBefore = fileState(link), attempts = [];
    const source = boundaryTooling({'node:fs':sourceReadBoundary(link,outside,attempts)}).sourceSnapshot(dir);
    assert.equal(source.files.find(file => file.path === relative).sha256,sha(Buffer.from(sentinel)));
    assert.deepEqual(attempts,[]);
    assert.deepEqual(fileState(link),linkBefore);
    assert.deepEqual(fileState(sentinel),before);
    assert.deepEqual(fs.readdirSync(outside),['sentinel']);
  });
}

test('source descriptor hashes raw readlink bytes without UTF-8 or path normalization', t => {
  const target = Buffer.concat([Buffer.from('./absent//../raw-'),Buffer.from([0xff,0xfe,0x0a])]);
  const {dir,git,link} = fixtureSourceLink(t,'.venv',target);
  assert.deepEqual(fs.readlinkSync(link,{encoding:'buffer'}),target);
  const source = tooling().sourceSnapshot(dir), descriptor = source.files.find(file => file.path === '.venv');
  assert.deepEqual(descriptor,{path:'.venv',mode:'120000',blob:git(['rev-parse','HEAD:.venv']).trim(),
    bytes:target.length,sha256:sha(target)});
  assert.notEqual(descriptor.sha256,sha(Buffer.from(target.toString('utf8'))));
});

test('source descriptor rejects a moved ancestor before reading the relocated link', t => {
  const {dir,link} = fixtureSourceLink(t,SOURCE_LINK_PATHS[1]);
  const outside = temporary(t), sentinel = path.join(outside,'sentinel'), displaced = path.join(outside,'displaced');
  fs.writeFileSync(sentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
  const before = fileState(sentinel), parent = path.dirname(link), attempts = [];
  let injected = false, relocatedReads = 0, concurrent, failure;
  const boundary = sourceReadBoundary(link,outside,attempts);
  boundary.lstatSync = (file,...args) => {
    const stat = fs.lstatSync(file,...args);
    if (file === link && !injected) {
      fs.renameSync(parent,displaced); fs.symlinkSync(displaced,parent);
      injected = true; concurrent = fileState(parent);
    }
    return stat;
  };
  boundary.readlinkSync = (file,...args) => {
    if (file === link && injected) relocatedReads++;
    return fs.readlinkSync(file,...args);
  };
  try { boundaryTooling({'node:fs':boundary}).sourceSnapshot(dir); }
  catch (error) { failure = error; }
  assert.equal(injected,true,'race must follow the real initial leaf lstat');
  assert.equal(relocatedReads,0,'ancestor identity must be rechecked before any relocated leaf read');
  assert.deepEqual(attempts,[]);
  assert.deepEqual(fileState(parent),concurrent);
  assert.deepEqual(fileState(sentinel),before);
  assert.deepEqual(fs.readdirSync(outside).sort(),['displaced','sentinel']);
  assert.match(failure?.message || '',/MODEL_PACK_(SOURCE_LINK_ANCESTOR|UNSAFE_LINK)/);
});

function afterSourceTree(action) {
  return {...require('node:child_process'),execFileSync(command,args,options) {
    const result = execFileSync(command,args,options);
    if (command === 'git' && args[0] === 'ls-tree') action();
    return result;
  }};
}

test('source descriptor rejects changed link bytes after the clean Git check', t => {
  const {dir,link} = fixtureSourceLink(t), outside = temporary(t), sentinel = path.join(outside,'sentinel');
  fs.writeFileSync(sentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
  const before = fileState(sentinel), attempts = [];
  let injected = false, concurrent;
  const reader = boundaryTooling({'node:fs':sourceReadBoundary(link,outside,attempts),
    'node:child_process':afterSourceTree(() => {
      fs.unlinkSync(link); fs.symlinkSync(sentinel,link);
      injected = true; concurrent = fileState(link);
    })});
  assert.throws(() => reader.sourceSnapshot(dir),/^Error: MODEL_PACK_SOURCE_BYTES:\.venv$/);
  assert.equal(injected,true);
  assert.deepEqual(attempts,[]);
  assert.deepEqual(fileState(link),concurrent);
  assert.deepEqual(fileState(sentinel),before);
  assert.deepEqual(fs.readdirSync(outside),['sentinel']);
});

for (const change of ['same-byte-replacement','mode','mtime','hardlink','regular','external-link','removed']) {
  test(`source descriptor stable read rejects ${change} without following or restoring a target`, t => {
    const {dir,link,target} = fixtureSourceLink(t), outside = temporary(t);
    const sentinel = path.join(outside,'sentinel'), displaced = path.join(outside,'displaced');
    fs.writeFileSync(sentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
    const before = fileState(sentinel), attempts = [];
    let injected = false, concurrent, displacedBefore, failure;
    const boundary = sourceReadBoundary(link,outside,attempts);
    boundary.readlinkSync = (file,...args) => {
      const bytes = fs.readlinkSync(file,...args);
      if (file === link && !injected) {
        injected = true;
        if (change === 'mode') fs.lchmodSync(link,fs.lstatSync(link).mode & 0o777 ^ 0o040);
        else if (change === 'mtime') fs.lutimesSync(link,1,1);
        else if (change === 'hardlink') {
          execFileSync('/bin/ln',['-P',link,displaced]); // Darwin link() follows; ln -P links the leaf itself.
          assert.equal(fs.lstatSync(displaced).isSymbolicLink(),true,'hardlink fixture must share the symlink inode, not its target');
        } else {
          fs.renameSync(link,displaced);
          if (change === 'same-byte-replacement') fs.symlinkSync(target,link);
          else if (change === 'regular') fs.writeFileSync(link,target,{mode:0o600});
          else if (change === 'external-link') fs.symlinkSync(sentinel,link);
        }
        if (change !== 'removed') concurrent = fileState(link);
        if (['hardlink','same-byte-replacement','regular','external-link','removed'].includes(change)) displacedBefore = fileState(displaced);
      }
      return bytes;
    };
    try { boundaryTooling({'node:fs':boundary}).sourceSnapshot(dir); }
    catch (error) { failure = error; }
    assert.equal(injected,true,'fault must happen after real raw readlink');
    if (change === 'removed') {
      assert.equal(failure?.code,'ENOENT');
      assert.throws(() => fs.lstatSync(link),{code:'ENOENT'});
    } else {
      assert.match(failure?.message || '',/^MODEL_PACK_SOURCE_LINK_CHANGED$/);
      assert.deepEqual(fileState(link),concurrent);
    }
    if (displacedBefore) assert.deepEqual(fileState(displaced),displacedBefore);
    assert.deepEqual(attempts,[]);
    assert.deepEqual(fileState(sentinel),before);
    assert.deepEqual(fs.readdirSync(outside).sort(),displacedBefore ? ['displaced','sentinel'] : ['sentinel']);
  });
}

for (const boundaryAt of ['before-leaf','after-readlink']) {
  test(`source descriptor rejects a symlink ancestor ${boundaryAt}`, t => {
    const {dir,link} = fixtureSourceLink(t,SOURCE_LINK_PATHS[1]), outside = temporary(t);
    const parent = path.dirname(link), displaced = path.join(outside,'displaced'), sentinel = path.join(outside,'sentinel');
    fs.writeFileSync(sentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
    const before = fileState(sentinel), attempts = [];
    let injected = false, leafReads = 0;
    const move = () => { fs.renameSync(parent,displaced); fs.symlinkSync(displaced,parent); injected = true; };
    const boundary = sourceReadBoundary(link,outside,attempts);
    boundary.readlinkSync = (file,...args) => {
      const bytes = fs.readlinkSync(file,...args);
      if (file === link) { leafReads++; if (boundaryAt === 'after-readlink') move(); }
      return bytes;
    };
    const reader = boundaryTooling({'node:fs':boundary,'node:child_process':afterSourceTree(() => {
      if (boundaryAt === 'before-leaf') move();
    })});
    assert.throws(() => reader.sourceSnapshot(dir),/MODEL_PACK_SOURCE_LINK_ANCESTOR/);
    assert.equal(injected,true);
    assert.equal(leafReads,boundaryAt === 'before-leaf' ? 0 : 1);
    assert.deepEqual(attempts,[]);
    assert.deepEqual(fileState(sentinel),before);
    assert.deepEqual(fs.readdirSync(outside).sort(),['displaced','sentinel']);
  });
}

for (const relative of ['.venv-copy','.venv/child','apps/ios/Sources/VoicePracticeCore/Other.swift',
  'apps/desktop/link.cjs','apps/web/link.js','resources/link.json']) {
  test(`source descriptor policy rejects unsupported committed link ${relative}`, t => {
    const {dir,link} = fixtureSourceLink(t,relative), before = fileState(link);
    assert.throws(() => tooling().sourceSnapshot(dir),/^Error: MODEL_PACK_SOURCE_TYPE$/);
    assert.deepEqual(fileState(link),before);
  });
}

for (const change of ['unstaged','staged','assume-unchanged','skip-worktree']) {
  test(`source descriptor retains clean/index rejection for ${change} links`, t => {
    const {dir,git,link} = fixtureSourceLink(t);
    if (change === 'assume-unchanged' || change === 'skip-worktree') git(['update-index','--'+change,'.venv']);
    fs.unlinkSync(link); fs.symlinkSync('changed-descriptor-fixture',link);
    if (change === 'staged') git(['add','--','.venv']);
    const before = fileState(link);
    assert.throws(() => tooling().sourceSnapshot(dir),/MODEL_PACK_SOURCE_(DIRTY|INDEX_FLAGS)/);
    assert.deepEqual(fileState(link),before);
  });
}

test('source descriptor rejects a preexisting hardlinked leaf before readlink', t => {
  const {dir,git,link} = fixtureSourceLink(t), outside = temporary(t), alias = path.join(outside,'alias');
  execFileSync('/bin/ln',['-P',link,alias]);
  assert.equal(fs.lstatSync(link).nlink,2);
  assert.equal(git(['status','--porcelain=v1']), '');
  let reads = 0;
  const reader = boundaryTooling({'node:fs':{...fs,readlinkSync(...args) { reads++; return fs.readlinkSync(...args); }}});
  assert.throws(() => reader.sourceSnapshot(dir),/^Error: MODEL_PACK_SOURCE_LINK_TYPE$/);
  assert.equal(reads,0);
});

test('source descriptor exception does not admit a submodule Git entry', t => {
  const {dir,git} = fixtureRepo(t), commit = git(['rev-parse','HEAD']).trim();
  fs.mkdirSync(path.join(dir,'.venv'));
  git(['update-index','--add','--cacheinfo','160000,'+commit+',.venv']);
  git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null',
    '-c','commit.gpgsign=false','commit','-qm','NON_NATIVE_GITLINK_FIXTURE']);
  assert.equal(git(['status','--porcelain=v1']), '');
  assert.match(git(['ls-tree','HEAD','--','.venv']),/^160000 commit /);
  assert.throws(() => tooling().sourceSnapshot(dir),/^Error: MODEL_PACK_SOURCE_TYPE$/);
});

for (const kind of ['hardlink','bytes','mode','fifo','symlink']) {
  test(`source descriptor exception keeps regular-source ${kind} rejection`, t => {
    const {dir,git} = fixtureSourceLink(t), source = path.join(dir,'source.cjs'), outside = temporary(t);
    const sentinel = path.join(outside,'sentinel'), alias = path.join(outside,'alias');
    fs.writeFileSync(sentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
    const before = fileState(sentinel);
    git(['config','core.filemode','false']);
    const reader = boundaryTooling({'node:child_process':afterSourceTree(() => {
      if (kind === 'hardlink') fs.linkSync(source,alias);
      else if (kind === 'bytes') fs.appendFileSync(source,'tamper');
      else if (kind === 'mode') fs.chmodSync(source,0o700);
      else {
        fs.unlinkSync(source);
        if (kind === 'fifo') execFileSync('/usr/bin/mkfifo',[source]);
        else fs.symlinkSync(sentinel,source);
      }
    })});
    assert.throws(() => reader.sourceSnapshot(dir),/MODEL_PACK_(UNSAFE_FILE|UNSAFE_LINK|SOURCE_BYTES)/);
    assert.deepEqual(fileState(sentinel),before);
    assert.deepEqual(fs.readdirSync(outside).sort(),kind === 'hardlink' ? ['alias','sentinel'] : ['sentinel']);
  });
}

test('source descriptors grant neither a source token nor permission for preexisting trust edits', async t => {
  const {dir} = fixtureSourceLink(t), reader = tooling(), baseline = reader.sourceSnapshot(dir);
  const generated = reader.compiledTrustBytes(reader.deriveStageMetadata(catalog(),fixtureInventory()).trust);
  assert.throws(() => reader.sourceSnapshot(dir,{}),/^Error: MODEL_PACK_SOURCE_TOKEN$/);
  await reader.withCompiledTrust(dir,generated,async ({assertSourceUnchanged}) => { assertSourceUnchanged(); });
  assert.deepEqual(reader.sourceSnapshot(dir),baseline);
  const trustFile = path.join(dir,'apps/desktop/bundled-voice-trust.cjs');
  fs.appendFileSync(trustFile,'// PREEXISTING_EDIT\n');
  const before = fileState(trustFile);
  await assert.rejects(reader.withCompiledTrust(dir,generated,async () => { assert.fail('dirty source cannot run work'); }),/SOURCE_DIRTY/);
  assert.deepEqual(fileState(trustFile),before);
});

for (const relative of SOURCE_LINK_PATHS) {
  for (const type of ['file','link','directory','unpacked']) {
    test(`source descriptor asar readback rejects ${type} at ${relative}`, async t => {
      const {dir,link,target} = fixtureSourceLink(t,relative), {sourceSnapshot,verifyPackagedPayload} = tooling();
      const source = sourceSnapshot(dir), before = fileState(link), fixture = fixtureAsarPayload(t,dir,source);
      const asar = require('@electron/asar'), entry = path.join(fixture.input,relative);
      await asar.createPackage(fixture.input,fixture.archive);
      assert.equal(verifyPackagedPayload(fixture.app,fixture.admitted).appAcceptance,'NOT_RUN');
      fs.mkdirSync(path.dirname(entry),{recursive:true,mode:0o700});
      if (type === 'link') {
        fs.symlinkSync(path.relative(path.dirname(entry),path.join(fixture.input,'apps/desktop/bundled-voice-trust.cjs')),entry);
      } else if (type === 'directory') {
        fs.mkdirSync(entry,{mode:0o700}); fs.writeFileSync(path.join(entry,'child'),target,{mode:0o600});
      } else fs.writeFileSync(entry,target,{mode:0o600});
      await asar.createPackageWithOptions(fixture.input,fixture.archive,type === 'unpacked' ? {unpack:entry} : {});
      asar.uncache(fixture.archive);
      const actual = asar.statFile(fixture.archive,relative,false);
      if (type === 'link') assert.equal(typeof actual.link,'string');
      if (type === 'unpacked') assert.equal(actual.unpacked,true);
      assert.ok(asar.listPackage(fixture.archive).includes('/'+relative));
      assert.throws(() => verifyPackagedPayload(fixture.app,fixture.admitted),/^Error: MODEL_PACK_PACKAGED_SOURCE_LINK$/);
      assert.deepEqual(fileState(link),before);
      assert.deepEqual(sourceSnapshot(dir),source);
    });
  }
}

test('source descriptor stage metadata preserves mode 120000 and rejects reanchored type tampering', t => {
  const {dir,link} = fixtureSourceLink(t), {sourceSnapshot,verifyStage} = tooling();
  const source = sourceSnapshot(dir), before = fileState(link), staged = fixtureStage(t,source);
  const metadata = JSON.parse(fs.readFileSync(path.join(staged.dir,'source.json')));
  assert.deepEqual(metadata,source);
  assert.equal(metadata.files.find(file => file.path === '.venv').mode,'120000');
  verifyStage(staged.dir,staged.sha256,source);
  metadata.files.find(file => file.path === '.venv').mode = '100644';
  staged.json('source.json',metadata);
  assert.throws(() => verifyStage(staged.dir,staged.seal(),source),/^Error: MODEL_PACK_SOURCE_MISMATCH$/);
  assert.deepEqual(fileState(link),before);
});

test('source descriptor exception does not admit a symlink as a receipted runtime leaf', t => {
  const {dir} = fixtureSourceLink(t), {sourceSnapshot,verifyStage} = tooling();
  const source = sourceSnapshot(dir), staged = fixtureStage(t,source), outside = temporary(t);
  const sentinel = path.join(outside,'sentinel'), entry = path.join(staged.dir,'resources/voice-assets/runtime/bin/voice-runtime');
  fs.writeFileSync(sentinel,'EXTERNAL_SENTINEL_UNCHANGED',{mode:0o600});
  const before = fileState(sentinel);
  fs.unlinkSync(entry); fs.symlinkSync(sentinel,entry);
  assert.throws(() => verifyStage(staged.dir,staged.sha256,source),/^Error: MANAGED_PATH_LINK$/);
  assert.deepEqual(fileState(sentinel),before);
  assert.deepEqual(fs.readdirSync(outside),['sentinel']);
});

for (const relative of ['.venv','runtime/bin/voice-runtime','models/whisper/config.json']) {
  test(`source descriptor exception leaves ordinary asset inventory no-link rules intact for ${relative}`, t => {
    const root = temporary(t), outside = temporary(t), sentinel = path.join(outside,'sentinel');
    const bytes = Buffer.from('EXTERNAL_SENTINEL_UNCHANGED'), entry = path.join(root,relative);
    const {canonicalInventory,verifyInventorySync} = require('../apps/desktop/tree-integrity.cjs');
    fs.writeFileSync(sentinel,bytes,{mode:0o600});
    fs.mkdirSync(path.dirname(entry),{recursive:true,mode:0o700}); fs.symlinkSync(sentinel,entry);
    const before = fileState(sentinel), linkBefore = fileState(entry);
    const inventory = canonicalInventory([{path:relative,bytes:bytes.length,sha256:sha(bytes)}]);
    assert.throws(() => verifyInventorySync(root,inventory),/^Error: MANAGED_PATH_LINK$/);
    assert.deepEqual(fileState(entry),linkBefore);
    assert.deepEqual(fileState(sentinel),before);
    assert.deepEqual(fs.readdirSync(outside),['sentinel']);
  });
}

test('source admission binds the current clean HEAD and detects staged, unstaged, untracked and hidden edits', t => {
  const {sourceSnapshot} = tooling();
  assert.equal(typeof sourceSnapshot, 'function', 'strict clean source snapshot is required');
  const {dir,git} = fixtureRepo(t);
  const clean = sourceSnapshot(dir);
  assert.equal(clean.commit, git(['rev-parse','HEAD']).trim());
  assert.equal(clean.gitTree, git(['rev-parse','HEAD^{tree}']).trim());
  assert.equal(clean.files.length, git(['ls-files','-z']).split('\0').filter(Boolean).length);
  assert.match(clean.treeSha256, /^[a-f0-9]{64}$/);
  const source = path.join(dir, 'source.cjs'), original = fs.readFileSync(source);
  for (const kind of ['unstaged','staged','assume-unchanged','skip-worktree','untracked']) {
    if (kind === 'assume-unchanged' || kind === 'skip-worktree') git(['update-index','--'+kind,'source.cjs']);
    if (kind === 'untracked') fs.writeFileSync(path.join(dir,'new.cjs'), 'fixture');
    else fs.appendFileSync(source, '// changed\n');
    if (kind === 'staged') git(['add','source.cjs']);
    assert.throws(() => sourceSnapshot(dir), /SOURCE_DIRTY|SOURCE_INDEX_FLAGS|SOURCE_BYTES/, kind);
    if (kind === 'assume-unchanged' || kind === 'skip-worktree') git(['update-index','--no-'+kind,'source.cjs']);
    if (kind === 'untracked') fs.unlinkSync(path.join(dir,'new.cjs'));
    else fs.writeFileSync(source, original);
    if (kind === 'staged') git(['add','source.cjs']);
  }
  assert.deepEqual(sourceSnapshot(dir), clean);
});

test('derive real runtime-only trust from the reviewed raw-file catalog, not invented ZIP identities', () => {
  const {deriveStageMetadata, compiledTrustBytes} = tooling();
  const input = catalog();
  const result = deriveStageMetadata(input, fixtureInventory());
  const {manifestDigest} = require('../apps/desktop/asset-manifest-trust.cjs');
  assert.equal(result.trust.schemaVersion, 2);
  assert.equal(result.trust.mode, 'runtime-only');
  assert.equal(result.trust.entrypoint, 'runtime/bin/voice-runtime');
  assert.equal(result.trust.runtimeProfile, 'macos-mlx-kokoro-v1');
  assert.deepEqual(result.trust.modelBindings, input.modelBindings);
  assert.deepEqual(result.trust.sttChoices, input.sttChoices);
  assert.equal(result.trust.modelManifestDigest, manifestDigest(input.modelManifest));
  assert.equal(result.trust.capabilitiesDigest, manifestDigest(input.capabilities));
  assert.deepEqual(result.modelManifest, input.modelManifest);
  assert.deepEqual(result.capabilities, input.capabilities);
  assert.equal(result.trust.fileCount, fixtureInventory().length);
  assert.equal(Object.hasOwn(result.trust, 'source'), false);
  assert.match(compiledTrustBytes(result.trust).toString(), /module\.exports = Object\.freeze\(/);
  const invalid = catalog();
  invalid.modelBindings.sttRoot.identity.treeDigest = sha('bad binding');
  // With sttChoices, a default that disagrees with its allow-list entry fails at trust parsing.
  assert.throws(() => deriveStageMetadata(invalid, fixtureInventory()), /MODEL_CATALOG_BINDING|BUNDLED_TRUST_INVALID/);
  const invalidChoice = catalog();
  invalidChoice.sttChoices[0].identity.treeDigest = sha('bad choice');
  assert.throws(() => deriveStageMetadata(invalidChoice, fixtureInventory()), /MODEL_CATALOG_BINDING/);
  const mutable = catalog();
  const artifact = mutable.modelManifest.models['whisper-large-v3-turbo-mlx'].artifacts['darwin-arm64'];
  artifact.sources['config.json'] = artifact.sources['config.json'].replace(artifact.provenance.sourceRevision, 'main');
  assert.throws(() => deriveStageMetadata(mutable, fixtureInventory()));
});

// win32 source admission (platform injection; real Git/filesystem). Darwin must stay strict.
function platformTooling(platform, toplevel = null) {
  const {createRequire} = require('node:module'), vm = require('node:vm');
  const actualRequire = createRequire(SCRIPT), cp = require('node:child_process');
  const child = {...cp, execFileSync(cmd,args,options) {
    const out = cp.execFileSync(cmd,args,options);
    return toplevel && args.join(' ') === 'rev-parse --show-toplevel' ? toplevel(out.trim())+'\n' : out;
  }};
  const req = name => name === 'node:child_process' ? child : actualRequire(name);
  req.resolve = actualRequire.resolve; req.cache = require.cache;
  const module = {exports:{}};
  vm.runInThisContext('(function(require,module,__filename,__dirname,process,Buffer,console){\n'
    + fs.readFileSync(SCRIPT,'utf8').replace(/^#![^\n]*\n/,'') + '\n})',{filename:SCRIPT})(
    req,module,SCRIPT,path.dirname(SCRIPT),{...process,platform},Buffer,console);
  return module.exports;
}
function windowsCheckout(t, {autocrlf = 'false', filemode = 'false', symlinks = 'false'} = {}) {
  const {dir,git} = fixtureRepo(t);
  const linkText = Buffer.from('../../VoicePractice/App/ScriptBridgeHandler.swift');
  const link = path.join(dir,SOURCE_LINK_PATHS[1]);
  fs.mkdirSync(path.dirname(link),{recursive:true,mode:0o700});
  fs.symlinkSync(linkText,link);
  fs.writeFileSync(path.join(dir,'tool.sh'),'#!/bin/sh\n',{mode:0o755});
  git(['add','.']);
  git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null',
    '-c','commit.gpgsign=false','commit','-qm','NON_NATIVE_WINDOWS_CHECKOUT_FIXTURE']);
  for (const [k,v] of Object.entries({'core.autocrlf':autocrlf,'core.filemode':filemode,'core.symlinks':symlinks})) git(['config',k,v]);
  // Emulate an NTFS checkout: no exec bit, the policy link materialized as its link text.
  fs.chmodSync(path.join(dir,'tool.sh'),0o644);
  fs.unlinkSync(link); fs.writeFileSync(link,linkText,{mode:0o644});
  assert.equal(git(['status','--porcelain=v1']),'','fixture must be a clean Windows-style checkout');
  return {dir,git,link,linkText};
}

test('win32 source snapshot: toplevel compares normalized exact path, case-insensitive, never prefix', t => {
  const {dir,git} = fixtureRepo(t);
  git(['config','core.autocrlf','false']);
  const variant = top => top.toUpperCase();
  assert.throws(() => platformTooling('darwin',variant).sourceSnapshot(dir),/^Error: MODEL_PACK_SOURCE_ROOT$/);
  assert.ok(platformTooling('win32',variant).sourceSnapshot(dir).files.length > 0);
  const winSlash = top => top.replaceAll(path.sep,'/').toUpperCase();
  assert.ok(platformTooling('win32',winSlash).sourceSnapshot(dir).files.length > 0);
  for (const wrong of [top => path.dirname(top), top => top+'/nested']) {
    assert.throws(() => platformTooling('win32',wrong).sourceSnapshot(dir),/^Error: MODEL_PACK_SOURCE_ROOT$/);
  }
});

test('win32 source snapshot requires core.autocrlf=false; darwin ignores it', t => {
  const {dir,git} = fixtureRepo(t);
  for (const value of ['true','input']) {
    git(['config','core.autocrlf',value]);
    assert.throws(() => platformTooling('win32').sourceSnapshot(dir),/^Error: MODEL_PACK_SOURCE_AUTOCRLF$/);
  }
  git(['config','--unset','core.autocrlf']);
  assert.throws(() => platformTooling('win32').sourceSnapshot(dir),/^Error: MODEL_PACK_SOURCE_AUTOCRLF$/,'unset defaults may convert');
  assert.ok(platformTooling('darwin').sourceSnapshot(dir).files.length > 0);
  git(['config','core.autocrlf','false']);
  assert.ok(platformTooling('win32').sourceSnapshot(dir).files.length > 0);
});

test('win32 Windows-style checkout: HEAD exec mode and plain-file policy links admitted; darwin refuses', t => {
  const {dir,git,link,linkText} = windowsCheckout(t);
  assert.throws(() => platformTooling('darwin').sourceSnapshot(dir),/^Error: MODEL_PACK_SOURCE_(BYTES|LINK_TYPE)/);
  assert.throws(() => tooling().sourceSnapshot(dir),/^Error: MODEL_PACK_SOURCE_(BYTES|LINK_TYPE)/);
  const source = platformTooling('win32').sourceSnapshot(dir);
  assert.equal(source.files.find(f => f.path === 'tool.sh').mode,'100755','Git HEAD mode is recorded');
  assert.deepEqual(source.files.find(f => f.path === SOURCE_LINK_PATHS[1]),{path:SOURCE_LINK_PATHS[1],mode:'120000',
    blob:git(['rev-parse','HEAD:'+SOURCE_LINK_PATHS[1]]).trim(),bytes:linkText.length,sha256:sha(linkText)});
  // Blob comparison is not skipped.
  git(['config','core.filemode','true']);
  assert.throws(() => platformTooling('win32').sourceSnapshot(dir),/MODEL_PACK_SOURCE_(DIRTY|BYTES)/);
  git(['config','core.filemode','false']);
  fs.writeFileSync(link,'../../Elsewhere.swift');
  assert.throws(() => platformTooling('win32').sourceSnapshot(dir),/MODEL_PACK_SOURCE_(DIRTY|BYTES)/);
});

test('win32 plain-file link exception is limited to core.symlinks=false and the policy paths', t => {
  const {dir,git} = windowsCheckout(t);
  git(['config','core.symlinks','true']);
  assert.throws(() => platformTooling('win32').sourceSnapshot(dir),/^Error: MODEL_PACK_SOURCE_(LINK_TYPE|DIRTY)/);
  git(['config','core.symlinks','false']);
  const other = path.join(dir,'other-link');
  fs.symlinkSync('source.cjs',other);
  git(['add','other-link']);
  git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null',
    '-c','commit.gpgsign=false','commit','-qm','NON_NATIVE_OTHER_LINK']);
  fs.unlinkSync(other); fs.writeFileSync(other,'source.cjs');
  assert.throws(() => platformTooling('win32').sourceSnapshot(dir),/^Error: MODEL_PACK_SOURCE_(TYPE|DIRTY)/);
});

test('win32 plain-file link exception never follows a real link at a policy path', t => {
  const {dir,link,linkText} = windowsCheckout(t);
  const target = path.join(dir,'ignored'); fs.mkdirSync(target);
  fs.writeFileSync(path.join(target,'t'),linkText);
  fs.unlinkSync(link); fs.symlinkSync(path.join(target,'t'),link);
  assert.throws(() => platformTooling('win32').sourceSnapshot(dir),/MODEL_PACK_(UNSAFE_FILE|SOURCE_DIRTY|UNSAFE_LINK)/);
});
