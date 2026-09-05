import { build } from "esbuild";
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(root, "apps", "web");
const vendorDir = path.join(webRoot, "vendor");
const ortDir = path.join(vendorDir, "ort");
const iconDir = path.join(webRoot, "icons");
const voiceDir = path.join(webRoot, "voices");
const voiceIds = ["af_heart", "af_bella", "af_nicole", "af_sky", "am_adam", "am_michael", "am_onyx", "am_fenrir"];

await rm(vendorDir, { recursive: true, force: true });
await mkdir(vendorDir, { recursive: true });
await mkdir(ortDir, { recursive: true });
await mkdir(iconDir, { recursive: true });
await mkdir(voiceDir, { recursive: true });

const common = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["safari17", "chrome120"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
};

await build({
  ...common,
  entryPoints: [path.join(root, "scripts/vendor/transformers-entry.mjs")],
  outfile: path.join(vendorDir, "transformers.bundle.js"),
});
await build({
  ...common,
  entryPoints: [path.join(root, "scripts/vendor/kokoro-entry.mjs")],
  outfile: path.join(vendorDir, "kokoro.bundle.js"),
});

async function forceSameOriginOrt(bundlePath) {
  let source = await readFile(bundlePath, "utf8");
  const remoteOrtDefault = /`https:\/\/cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers@\$\{[^}]+\}\/dist\/`/g;
  source = source.replace(remoteOrtDefault, 'new URL("./ort/",import.meta.url).href');
  if (/cdn\.jsdelivr\.net|unpkg\.com/.test(source)) {
    throw new Error(`REMOTE_RUNTIME_URL_REMAINS:${path.basename(bundlePath)}`);
  }
  await writeFile(bundlePath, source);
}

await forceSameOriginOrt(path.join(vendorDir, "transformers.bundle.js"));
await forceSameOriginOrt(path.join(vendorDir, "kokoro.bundle.js"));

await copyFile(path.join(root, "build/icons/256x256.png"), path.join(iconDir, "icon-256.png"));
await copyFile(path.join(root, "build/icons/512x512.png"), path.join(iconDir, "icon-512.png"));
for (const filename of [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
]) {
  await copyFile(
    path.join(root, "node_modules/onnxruntime-web/dist", filename),
    path.join(ortDir, filename),
  );
}
for (const voiceId of voiceIds) {
  await copyFile(
    path.join(root, "node_modules/kokoro-js/voices", `${voiceId}.bin`),
    path.join(voiceDir, `${voiceId}.bin`),
  );
}

const iosDir = path.join(root, "apps", "ios");
let iosExists = false;
try {
  const s = await stat(iosDir);
  iosExists = s.isDirectory();
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

if (iosExists) {
  const iosResourcesDir = path.join(iosDir, "VoicePractice", "Resources");
  const iosWebDir = path.join(iosResourcesDir, "web");
  await rm(iosWebDir, { recursive: true, force: true });
  await mkdir(iosWebDir, { recursive: true });
  await copyFile(path.join(webRoot, "index.html"), path.join(iosWebDir, "index.html"));
  await copyFile(path.join(webRoot, "offline.html"), path.join(iosWebDir, "offline.html"));
  await copyFile(path.join(webRoot, "manifest.webmanifest"), path.join(iosWebDir, "manifest.webmanifest"));
  await cp(path.join(webRoot, "runtime"), path.join(iosWebDir, "runtime"), { recursive: true });
  await cp(path.join(webRoot, "vendor"), path.join(iosWebDir, "vendor"), { recursive: true });
  await cp(path.join(webRoot, "icons"), path.join(iosWebDir, "icons"), { recursive: true });
  await cp(path.join(webRoot, "voices"), path.join(iosWebDir, "voices"), { recursive: true });
  console.log("Bundled web assets into iOS app bundle (apps/ios/VoicePractice/Resources/web).");
}

console.log("Built same-origin browser runtimes, PWA icons, and Kokoro voices.");
