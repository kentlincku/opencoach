'use strict';

const { normalizeRuntimeCapabilities } = require('../web/runtime/runtime-contract.js');

function isHealthyRuntimeResponse(health) {
  return normalizeRuntimeCapabilities(health).ready === true;
}

module.exports = { isHealthyRuntimeResponse };
