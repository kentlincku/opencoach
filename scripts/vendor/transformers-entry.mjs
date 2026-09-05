import { env, pipeline } from "@huggingface/transformers";

env.backends.onnx.wasm.wasmPaths = new URL("./ort/", import.meta.url).href;
env.backends.onnx.wasm.proxy = false;

export { env, pipeline };
