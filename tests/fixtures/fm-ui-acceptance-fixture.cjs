'use strict';
// NODE_NOT_NATIVE: reuse original Main/preload/DOM fixture, retaining its owned child cleanup.
// The HTML factory and browser UMD scripts are real; only Electron/DOM/OS are doubles.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const file = path.resolve(__dirname, '../fm-ui-diagnostic-fixture.cjs');
function replace(source, before, after) {
  if (source.split(before).length !== 2) throw Error('ACCEPTANCE_FIXTURE_SOURCE_BOUNDARY');
  return source.replace(before, after);
}
async function runFixture(options) {
  let source = fs.readFileSync(file, 'utf8');
  source = replace(source, 'legacyOrder = false })', 'legacyOrder = false, setup = () => {}, afterInit = async () => {}, acceptance = false })');
  source = replace(source, 'else boot = bootstrap(options);', "else boot = acceptance && fs.existsSync(path.join(root, 'scripts/fm-ui-acceptance-bootstrap.cjs')) ? require('../scripts/fm-ui-acceptance-bootstrap.cjs').bootstrap(options) : bootstrap(options);");
  source = replace(source, 'const sample = () =>', `
    const trace = { factories: 0, labels: [] };
    const factory = page.context.window.VoiceRuntimeFactory.createRuntime;
    page.context.window.VoiceRuntimeFactory = { createRuntime(...args) { trace.factories++; return Reflect.apply(factory, this, args); } };
    page.context.setTTSEngineStatus = label => trace.labels.push(label);
    await setup(page, boot);
    const sample = () =>`);
  source = replace(source, "const capability = page.run('foundationModelsCapability?.state || \"null\"');", `const capability = page.run('foundationModelsCapability?.state || "null"');
    const exercise = await afterInit(page, boot);`);
  source = replace(source, "capability, generations: 0, helpersClosed", "capability, trace, exercise, stats: { ...boot.hooks.stats }, generations: boot.hooks.stats.generations, helpersClosed");
  if (options.acceptance) source = replace(source, "tests/fm-ui-diagnostic-child.cjs", 'tests/fixtures/fm-ui-acceptance-child.cjs');
  if (options.unavailable) source = replace(source, "args: [path.join(root, 'tests/fixtures/fm-ui-acceptance-child.cjs')]", "args: [path.join(root, 'tests/fixtures/fm-ui-acceptance-child.cjs'), '--unavailable']");
  const loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(source, file);
  return loaded.exports.runFixture({ ...options, browserGlobals: true });
}
module.exports = { runFixture };