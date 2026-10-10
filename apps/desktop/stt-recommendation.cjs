'use strict';
// Device-based STT tier recommendation (spec docs/contracts/stt-model-choice.md,
// thresholds from the 2026-10-08 maintainer benchmark; see docs/contracts/stt-model-choice.md).
// Pure: Main passes hardware facts it read itself; nothing comes from the renderer.
// A recommendation is only a default suggestion; the user may pick any tier.

const GiB = 1024 ** 3;
const TIERS = Object.freeze(['ultrafast', 'fast', 'balanced', 'accurate']);

// Measured warm per-sentence medians (3.3 s English clips) and the host they came from.
const MEASURED = Object.freeze({
  darwin: Object.freeze({ host: 'Apple Silicon (maintainer benchmark)', sec: { ultrafast: 0.045, fast: 0.057, balanced: 0.101, accurate: 0.217 } }),
  win32: Object.freeze({ host: 'Intel desktop CPU, 4 threads (maintainer benchmark)', sec: { ultrafast: 0.243, fast: 0.447, balanced: 1.298, accurate: 6.296 } }),
});

function recommendSttTier({ platform, arch, totalMemBytes, avx2 }) {
  if (!Number.isSafeInteger(totalMemBytes) || totalMemBytes <= 0) {
    return Object.freeze({ tier: 'ultrafast', reason: 'MEMORY_UNKNOWN' });
  }
  // OS-reported totals are slightly under the marketed size (8 GB -> ~7.9 GiB).
  const gib = totalMemBytes / GiB;
  if (platform === 'darwin' && arch === 'arm64') {
    if (gib >= 15) return Object.freeze({ tier: 'accurate', reason: 'MAC_16GB_OR_MORE' });
    return Object.freeze({ tier: 'fast', reason: 'MAC_UNDER_16GB' });
  }
  if (platform === 'win32' && arch === 'x64') {
    if (avx2 !== true) return Object.freeze({ tier: 'ultrafast', reason: 'WIN_NO_AVX2' });
    if (gib >= 15) return Object.freeze({ tier: 'balanced', reason: 'WIN_AVX2_16GB_OR_MORE' });
    if (gib >= 7.5) return Object.freeze({ tier: 'fast', reason: 'WIN_AVX2_8GB_OR_MORE' });
    return Object.freeze({ tier: 'ultrafast', reason: 'WIN_UNDER_8GB' });
  }
  return Object.freeze({ tier: 'ultrafast', reason: 'PLATFORM_UNKNOWN' });
}

// Windows CPU: the accurate tier measured 5-6 s per sentence; warn when chosen.
function tierWarning(platform, tier) {
  return platform === 'win32' && tier === 'accurate' ? 'CPU_SLOW_ACCURATE' : null;
}

// AVX2 heuristic from the CPU model name (Node has no CPUID access without native code).
// Only families known to have AVX2 return true; anything unrecognised returns false,
// which yields the conservative 'ultrafast' recommendation. The user can still pick any tier.
const AVX2_FAMILIES = Object.freeze([
  /Intel\(R\) Core\(TM\) i[3579]-(?:[4-9]\d{3}|1\d{4})/i, // Haswell (4th gen) and later i-series
  /Intel\(R\) Core\(TM\) (?:Ultra )?[3579] /i,               // Core 3/5/7/9 and Core Ultra naming
  /AMD Ryzen/i,
]);
function detectAvx2(cpus) {
  if (!Array.isArray(cpus) || !cpus.length) return null;
  const model = String(cpus[0]?.model || '');
  if (!model) return null;
  return AVX2_FAMILIES.some(re => re.test(model));
}

module.exports = { recommendSttTier, tierWarning, detectAvx2, TIERS, MEASURED };
