(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define([], factory);
  else root.DesktopVoiceOperationContract = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function fail() { throw new Error('INVALID_VOICE_OPERATION_CONTRACT'); }
  function record(value) {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      const d = descriptors[key];
      if (typeof key !== 'string' || !Object.hasOwn(d, 'value') || !d.enumerable) fail();
      result[key] = d.value;
    }
    return result;
  }
  function exact(value, keys) {
    if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
  }
  function id(value) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 96 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) fail();
    return value;
  }
  function ids(value) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail();
    const d = Object.getOwnPropertyDescriptors(value);
    const length = d.length.value;
    if (length < 1 || length > 32 || Reflect.ownKeys(d).length !== length + 1) fail();
    const result = [];
    for (let i = 0; i < length; i++) {
      const item = d[i];
      if (!item || !Object.hasOwn(item, 'value') || !item.enumerable) fail();
      const itemId = id(item.value);
      if (!result.includes(itemId)) result.push(itemId);
    }
    return result;
  }
  function member(value, choices) { if (!choices.includes(value)) fail(); return value; }
  function counter(value) { if (!Number.isInteger(value) || value < 1 || value > 2147483647) fail(); return value; }
  function failureFields(v) {
    const code = member(v.code, ['backend-error', 'termination-unconfirmed', 'cleanup-failed', 'admission-closed', 'quota-exceeded']);
    if (typeof v.message !== 'string' || v.message.length < 1 || v.message.length > 256 || !/^[\x20-\x7e]+$/.test(v.message)) fail();
    return { code, message: v.message };
  }
  function state(v) {
    const base = { version: 1, type: 'state', requestId: id(v.requestId), knowledge: member(v.knowledge, ['unknown', 'retired', 'known']) };
    if (v.knowledge !== 'known') { exact(v, ['version', 'type', 'requestId', 'knowledge']); return base; }
    exact(v, ['version', 'type', 'requestId', 'knowledge', 'revision', 'logical', 'revocation', 'receipt', 'cleanup', 'failure']);
    const logical = member(v.logical, ['accepted', 'preparing', 'dispatched', 'settled']);
    const revocation = member(v.revocation, ['live', 'revoked']);
    const cleanup = member(v.cleanup, ['pending', 'retained', 'released']);
    const r = record(v.receipt); exact(r, ['status', 'binding']);
    const status = member(r.status, ['not-dispatched', 'starting', 'running', 'completed', 'stopping', 'confirmed', 'unconfirmed']);
    let binding = null;
    if (status === 'not-dispatched') { if (r.binding !== null) fail(); }
    else {
      const b = record(r.binding); exact(b, ['clientId', 'intentId', 'generation']);
      binding = { clientId: id(b.clientId), intentId: id(b.intentId), generation: b.generation === null ? null : counter(b.generation) };

      if ((['running', 'completed'].includes(status) || logical === 'dispatched') && binding.generation === null) fail();
    }
    let failure = null;
    if (v.failure !== null) {
      const f = record(v.failure); exact(f, ['code', 'message']); failure = failureFields(f);
      if (logical !== 'settled') fail();
    }
    if (status === 'completed' && logical !== 'settled') fail();
    if (logical === 'accepted' && status !== 'not-dispatched') fail();
    if (logical === 'preparing' && status === 'running') fail();
    if (logical === 'dispatched' && ['not-dispatched', 'starting'].includes(status)) fail();
    if (logical === 'settled' && status === 'starting') fail();
    if ((status === 'unconfirmed') !== (failure?.code === 'termination-unconfirmed')) fail();
    if (failure?.code === 'cleanup-failed' && cleanup !== 'retained') fail();
    if (cleanup === 'retained' && !['stopping', 'unconfirmed'].includes(status) && failure?.code !== 'cleanup-failed') fail();
    if (cleanup === 'released' && (logical !== 'settled' || !['not-dispatched', 'completed', 'confirmed'].includes(status))) fail();
    return { ...base, revision: counter(v.revision), logical, revocation, receipt: { status, binding }, cleanup, failure };
  }
  function bindingValue(value) {
    if (value === null) return null;
    const b = record(value); exact(b, ['clientId', 'intentId', 'generation']);
    return { clientId: id(b.clientId), intentId: id(b.intentId), generation: b.generation === null ? null : counter(b.generation) };
  }
  function sameBinding(a, b) {
    return a === null || b === null ? a === b : a.clientId === b.clientId && a.intentId === b.intentId && a.generation === b.generation;
  }
  function operationFailure(v) {
    exact(v, ['version', 'type', 'requestId', 'code', 'message', 'binding', 'completion']);
    const result = { version: 1, type: 'failure', requestId: id(v.requestId), ...failureFields(v), binding: bindingValue(v.binding), completion: null };
    if (v.completion !== null) {
      const c = record(v.completion);
      if (c.version !== 1 || c.type !== 'state') fail();
      const s = state(c);
      if (result.code !== 'backend-error' || s.knowledge !== 'known' || s.logical !== 'settled' || s.revocation !== 'live' || s.cleanup !== 'released' ||
          !['not-dispatched', 'completed', 'confirmed'].includes(s.receipt.status) || s.failure?.code !== result.code ||
          s.failure.message !== result.message || s.requestId !== result.requestId || !sameBinding(s.receipt.binding, result.binding)) fail();
      result.completion = s;
    }
    return result;
  }
  // Pure eligibility only. Context must come from the current owned local operation;
  // neither these booleans nor a validated DTO establish Main/IPC authority.
  function canFallback(input, context) {
    try {
      const result = normalize(input), c = record(context);
      exact(c, ['requestId', 'epoch', 'currentEpoch', 'stopped', 'ownerValid', 'admissionValid', 'domainFault', 'transportUncertain']);
      id(c.requestId); counter(c.epoch); counter(c.currentEpoch);
      for (const key of ['stopped', 'ownerValid', 'admissionValid', 'domainFault', 'transportUncertain']) if (typeof c[key] !== 'boolean') fail();
      return result.type === 'failure' && result.completion !== null && result.requestId === c.requestId &&
        c.epoch === c.currentEpoch && !c.stopped && c.ownerValid && c.admissionValid && !c.domainFault && !c.transportUncertain;
    } catch (_) { return false; }
  }
  function normalize(input) {
    try {
      const v = record(input);
      if (v.version !== 1) fail();
      if (v.type === 'state') return state(v);
      if (v.type === 'failure') return operationFailure(v);
      if (v.type === 'observe') {
        exact(v, ['version', 'type', 'requestId']);
        return { version: 1, type: 'observe', requestId: id(v.requestId) };
      }
      if (v.type === 'revoke' || v.type === 'revoked') {
        exact(v, ['version', 'type', 'requestIds']);
        return { version: 1, type: v.type, requestIds: ids(v.requestIds) };
      }
      return fail();
    } catch (_) { return fail(); }
  }
  function normalizeLegacyCancel(input) {
    try {
      const v = record(input);
      exact(v, ['requestId']);
      return { version: 1, type: 'revoke', requestIds: [id(v.requestId)] };
    } catch (_) { return fail(); }
  }
  return Object.freeze({ normalize, normalizeLegacyCancel, canFallback });
}));
