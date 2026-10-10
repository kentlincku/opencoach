#!/usr/bin/env bash
# TEST_ONLY / NON_NATIVE Darwin arm64 candidate producer and consumer.
# No download, model acquisition, manifest publication, signing, or native
# execution is performed. The output is an untrusted private candidate.

set -euo pipefail

if [ "$#" -ne 6 ]; then
  echo "Usage: $0 <input_root> <output_json> <source_revision> <source_url> <license_spdx> <license_url>" >&2
  exit 1
fi

INPUT_ROOT="$1"
OUTPUT_JSON="$2"
SOURCE_REVISION="$3"
SOURCE_URL="$4"
LICENSE_SPDX="$5"
LICENSE_URL="$6"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

python3 -I -B "${SCRIPT_DIR}/darwin_candidate.py" \
  --input-root "${INPUT_ROOT}" \
  --output "${OUTPUT_JSON}" \
  --source-revision "${SOURCE_REVISION}" \
  --source-url "${SOURCE_URL}" \
  --license-spdx "${LICENSE_SPDX}" \
  --license-url "${LICENSE_URL}"

# A successful Python write is only an inventory. The actual candidate status
# is established by this shared-rule consumer and strict real-tree readback.
node "${REPO_ROOT}/scripts/validate-darwin-candidate-r23.cjs" \
  --input-root "${INPUT_ROOT}" \
  --candidate "${OUTPUT_JSON}"
