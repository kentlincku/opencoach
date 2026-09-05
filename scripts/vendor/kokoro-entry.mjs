import { env } from "@huggingface/transformers";
import { phonemize as rawPhonemize } from "phonemizer";
export { KokoroTTS } from "kokoro-js";

export function configureKokoroRevision(revision) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("INVALID_KOKORO_REVISION");
  env.remotePathTemplate = `{model}/resolve/${revision}/`;
  env.allowRemoteModels = true;
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.backends.onnx.wasm.wasmPaths = new URL("./ort/", import.meta.url).href;
  env.backends.onnx.wasm.proxy = false;
}

function normalizeEnglishText(text) {
  return String(text || "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, "Doctor")
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, "Mister")
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, "Miss")
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, "Mrs")
    .replace(/\betc\.(?! [A-Z])/gi, "etc")
    .replace(/\s+/g, " ")
    .trim();
}

export async function phonemizeForKokoro(text, voiceId = "af_heart") {
  if (!/^[ab][fm]_[a-z]+$/.test(voiceId)) throw new Error("INVALID_KOKORO_VOICE_ID");
  const normalized = normalizeEnglishText(text);
  if (!normalized) throw new Error("EMPTY_KOKORO_TEXT");
  const language = voiceId.startsWith("a") ? "en-us" : "en";
  const parts = await rawPhonemize(normalized, language);
  return parts.join(" ")
    .replace(/ʲ/g, "j")
    .replace(/r/g, "ɹ")
    .replace(/x/g, "k")
    .replace(/ɬ/g, "l")
    .replace(/ z(?=[;:,.!? ]|$)/g, "z")
    .trim();
}
