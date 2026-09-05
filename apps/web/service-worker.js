const APP_CACHE = "voice-practice-app-v25-20260903";
const CORE_ASSETS = Object.freeze([
  "./",
  "./index.html",
  "./offline.html",
  "./manifest.webmanifest",
  "./model-manifest.json",
  "./runtime/llm-provider-contract.js",
  "./runtime/runtime-contract.js",
  "./runtime/browser-runtime.js",
  "./runtime/electron-runtime.js",
  "./runtime/android-runtime.js",
  "./runtime/create-runtime.js",
  "./runtime/tts-preference.js",
  "./runtime/language-policy.js",
  "./runtime/model-cache.js",
  "./runtime/lesson-library.js",
  "./runtime/direct-api-presets.js",
  "./runtime/local-endpoint-policy.js",
  "./vendor/transformers.bundle.js",
  "./vendor/kokoro.bundle.js",
  "./vendor/ort/ort-wasm-simd-threaded.wasm",
  "./vendor/ort/ort-wasm-simd-threaded.mjs",
  "./vendor/ort/ort-wasm-simd-threaded.jsep.wasm",
  "./vendor/ort/ort-wasm-simd-threaded.jsep.mjs",
  "./voices/af_heart.bin",
  "./voices/af_bella.bin",
  "./voices/af_nicole.bin",
  "./voices/af_sky.bin",
  "./voices/am_adam.bin",
  "./voices/am_michael.bin",
  "./voices/am_onyx.bin",
  "./voices/am_fenrir.bin",
  "./icons/icon-256.png",
  "./icons/icon-512.png"
]);

const CORE_URLS = new Set(CORE_ASSETS.map(asset => new URL(asset, self.registration.scope).href));
const UPDATE_MARKER_URL = new URL("./__sw-update-state__", self.registration.scope).href;
const VERSIONED_APP_CACHE = /^voice-practice-app-v\d+-\d{8}$/;

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await cache.addAll(CORE_ASSETS);
    await cache.put(UPDATE_MARKER_URL, new Response(self.registration.active ? "upgrade" : "first-install"));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    const marker = await cache.match(UPDATE_MARKER_URL);
    const isUpgrade = marker ? (await marker.text()) === "upgrade" : false;
    await cache.delete(UPDATE_MARKER_URL);
    const keys = await caches.keys();
    const oldAppCaches = keys.filter(key => VERSIONED_APP_CACHE.test(key) && key !== APP_CACHE);
    await Promise.all(oldAppCaches.map(key => caches.delete(key)));
    await self.clients.claim();
    if (!isUpgrade) return;

    const scope = new URL(self.registration.scope);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    await Promise.all(windows.map(async client => {
      const url = new URL(client.url);
      if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
      try {
        await client.navigate(client.url);
      } catch {
        // A closing tab can reject navigation; it must not fail activation for other clients.
      }
    }));
  })());
});

function hasSensitiveHeaders(request) {
  return request.headers.has("authorization") || request.headers.has("range");
}

function isCoreAsset(request, url) {
  return request.method === "GET"
    && !hasSensitiveHeaders(request)
    && !url.search
    && CORE_URLS.has(url.href);
}

function isShellNavigation(request, url) {
  if (request.mode !== "navigate" || request.method !== "GET") return false;
  if (url.origin !== self.location.origin) return false;
  const scopePath = new URL(self.registration.scope).pathname;
  return url.pathname === scopePath || url.pathname === `${scopePath}index.html`;
}

async function cacheFirst(request) {
  const cache = await caches.open(APP_CACHE);
  const cached = await cache.match(request, { ignoreSearch: false });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function shellNavigation(request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(request, { signal: controller.signal });
    if (response.ok && !hasSensitiveHeaders(request)) {
      const cache = await caches.open(APP_CACHE);
      await cache.put(new URL("./index.html", self.registration.scope), response.clone());
    }
    return response;
  } catch {
    return (await caches.match(new URL("./index.html", self.registration.scope)))
      || caches.match(new URL("./offline.html", self.registration.scope));
  } finally {
    clearTimeout(timeout);
  }
}

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (isShellNavigation(request, url)) {
    event.respondWith(shellNavigation(request));
    return;
  }
  if (isCoreAsset(request, url)) {
    event.respondWith(cacheFirst(request));
  }
});
