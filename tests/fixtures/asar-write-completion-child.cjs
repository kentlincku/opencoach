'use strict';

// Run only in a child process: ASAR 3 copies fs exports on import, while ASAR 4
// also uses ESM builtin bindings. Never import package-private implementation paths.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire, syncBuiltinESMExports } = require('node:module');
const { pathToFileURL } = require('node:url');
const { Readable } = require('node:stream');
const { setImmediate: checkpoint } = require('node:timers/promises');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function probe(api, mode, fixture) {
  assert.ok(['createPackage', 'createPackageFromStreams'].includes(api));
  assert.ok(['finish', 'error'].includes(mode));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-write-completion-'));
  const source = fixture ? fixture.source : path.join(root, 'source');
  const destination = fixture ? fixture.destination : path.join(root, 'app.asar');
  const filename = fixture ? fixture.filename : 'last.txt';
  // The standalone control has one small payload. Product callers supply a
  // full admitted tree and identify its final required source entry instead.
  const payload = fixture ? fs.readFileSync(path.join(source, filename))
    : Buffer.from('ASAR final payload: real bytes held behind a controlled output-write gate.\n');
  if (!fixture) {
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, filename), payload);
  }

  const originalCreateWriteStream = fs.createWriteStream;
  const writeReached = deferred();
  const closed = deferred();
  let output;
  let release;
  let gateHits = 0;
  let targetStreams = 0;
  let emittedError;
  let asar;
  let state = 'pending';
  let atResolution;
  let rejection;
  const injectedError = Object.assign(new Error('controlled ASAR output write failure'), {
    code: 'ASAR_TEST_WRITE_FAILURE',
  });

  fs.createWriteStream = function (file, ...args) {
    const stream = originalCreateWriteStream.call(this, file, ...args);
    if (file !== destination) return stream;
    targetStreams += 1;
    output = stream;
    const originalWrite = stream._write;
    // Make write batching immaterial; headers and the payload still use the
    // real fs.WriteStream implementation, on this one test-owned archive only.
    stream._writev = undefined;
    stream._write = function (chunk, encoding, callback) {
      const bytes = Buffer.from(chunk);
      if (bytes.length < payload.length || !bytes.subarray(-payload.length).equals(payload)) {
        return originalWrite.call(this, chunk, encoding, callback);
      }
      gateHits += 1;
      assert.equal(gateHits, 1, 'the last payload must hit the gate exactly once');
      const holdLastPayload = () => {
        release = () => {
          release = undefined;
          if (mode === 'error') callback(injectedError);
          else originalWrite.call(this, payload, encoding, callback);
        };
        writeReached.resolve();
      };
      // ASAR 4 may batch small files. Write the entire prefix for real before
      // holding only the final source entry, not unrelated trust/source bytes.
      const prefix = bytes.subarray(0, bytes.length - payload.length);
      if (prefix.length) originalWrite.call(this, prefix, encoding,
        error => error ? callback(error) : holdLastPayload());
      else holdLastPayload();
    };
    stream.on('error', (error) => { emittedError = error; });
    stream.once('close', closed.resolve);
    return stream;
  };
  syncBuiltinESMExports();

  function snapshot() {
    // Read real on-disk bytes and independently exercise the public extractor.
    // Explicitly uncache so header caching cannot explain a short read.
    asar.uncache(destination);
    const { headerSize } = asar.getRawHeader(destination);
    const entry = asar.statFile(destination, filename);
    const start = 8 + headerSize + Number(entry.offset);
    const bytes = fs.readFileSync(destination);
    let extractedMatches = false;
    let extractionError;
    try { extractedMatches = asar.extractFile(destination, filename).equals(payload); }
    catch (error) { extractionError = error.message; }
    return {
      writableFinished: output.writableFinished,
      archiveSize: bytes.length,
      expectedSize: start + payload.length,
      rawMatches: bytes.subarray(start, start + payload.length).equals(payload),
      extractedMatches,
      extractionError,
    };
  }

  try {
    const builderRequire = createRequire(require.resolve('app-builder-lib'));
    const rootEntry = require.resolve('@electron/asar');
    const builderEntry = builderRequire.resolve('@electron/asar');
    assert.equal(builderEntry, rootEntry, 'electron-builder and root must resolve the same ASAR');
    asar = await import(pathToFileURL(rootEntry).href);
    const builderAsar = await import(pathToFileURL(builderEntry).href);
    assert.strictEqual(builderAsar, asar, 'electron-builder and root must share the ASAR instance');
    const rootCjs = require('@electron/asar'), builderCjs = builderRequire('@electron/asar');
    assert.strictEqual(rootCjs, builderCjs, 'CommonJS consumers must share the ASAR instance');
    assert.strictEqual(rootCjs.createPackage, asar.createPackage);
    assert.strictEqual(builderCjs.createPackageFromStreams, asar.createPackageFromStreams);

    const filenames = fs.readdirSync(source, { recursive: true })
      .filter(relative => fs.statSync(path.join(source, relative)).isFile()).sort();
    assert.equal(filenames.at(-1), filename, 'the gated source entry must be last');

    const packaging = api === 'createPackage'
      ? asar.createPackage(source, destination)
      : builderAsar.createPackageFromStreams(destination, filenames.map(relative => ({
        path: relative,
        type: 'file',
        unpacked: false,
        stat: fs.statSync(path.join(source, relative)),
        streamGenerator: () => Readable.from([fs.readFileSync(path.join(source, relative))]),
      })));
    const settled = packaging.then(() => {
      state = 'fulfilled';
      atResolution = snapshot();
    }, (error) => {
      state = 'rejected';
      rejection = { code: error.code, message: error.message, isInjectedError: error === injectedError };
    });

    await writeReached.promise;
    // ASAR 4 may wait for a buffered write before even calling end(). Nothing
    // can finish the held write; drain microtasks without requiring end() first.
    await checkpoint();
    const whileGated = { state, ...snapshot() };
    assert.equal(targetStreams, 1);
    assert.equal(gateHits, 1);
    release();
    await closed.promise;
    await settled;
    return {
      api, mode, filename, sharedInstance: builderAsar === asar, cjsRequireSucceeded: true, gateHits,
      whileGated, state, atResolution, rejection,
      emittedErrorCode: emittedError && emittedError.code,
      afterClose: snapshot(),
    };
  } finally {
    fs.createWriteStream = originalCreateWriteStream;
    syncBuiltinESMExports();
    if (output && !output.closed) {
      output.destroy();
      if (release) release();
      await closed.promise;
    }
    if (asar) asar.uncache(destination);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Deadline is only a deadlock guard, never the write gate or a passing criterion.
const watchdog = setTimeout(() => {
  console.error('ASAR child did not reach/release its controlled write gate');
  process.exit(2);
}, 10000);
probe(process.argv[2], process.argv[3], process.argv[4] && JSON.parse(process.argv[4])).then((result) => {
  console.log(JSON.stringify(result));
}, (error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => clearTimeout(watchdog));
