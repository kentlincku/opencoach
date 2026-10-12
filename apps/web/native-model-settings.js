const MODEL_STATES = {
  missing: '缺模型',
  installed: '已安裝',
  active: '已安裝／使用中',
  unavailable: '不可用',
};
const MODE_LABELS = {
  'runtime-only': '執行環境已內建；模型分包按需下載。',
  bundled: '使用 App 內建模型。',
  managed: '使用已下載的外置模型。',
  unavailable: '此環境的原生語音模型不可用。',
};
// Tier cards: a short title plus one line on the speed/accuracy trade-off.
const TIER_TITLES = { ultrafast: '極速', fast: '快速', balanced: '平衡', accurate: '精準' };
const TIER_LINES = {
  ultrafast: '反應最快、最省記憶體，辨識較容易出錯',
  fast: '反應快，準確度略低',
  balanced: '速度與準確度兼顧',
  accurate: '辨識最準確，需要較多記憶體',
};
const TIER_ORDER = ['ultrafast', 'fast', 'balanced', 'accurate'];
const WARNING_LABELS = {
  CPU_SLOW_ACCURATE: '此電腦以 CPU 執行，每句約需 5 秒以上',
};
const REASON_LABELS = {
  MAC_16GB_OR_MORE: '此 Mac 記憶體 16 GB 以上',
  MAC_UNDER_16GB: '此 Mac 記憶體少於 16 GB',
  WIN_AVX2_16GB_OR_MORE: '此電腦記憶體 16 GB 以上',
  WIN_AVX2_8GB_OR_MORE: '此電腦記憶體 8 GB 以上',
  WIN_UNDER_8GB: '此電腦記憶體少於 8 GB',
  WIN_NO_AVX2: '無法確認 CPU 支援 AVX2',
  MEMORY_UNKNOWN: '無法讀取記憶體大小',
  PLATFORM_UNKNOWN: '無法辨識此裝置',
};
const ACTIVE_PHASES = new Set(['confirming', 'downloading', 'verifying', 'cancelling']);
const PHASE_LABELS = {
  confirming: '準備下載',
  downloading: '下載中',
  verifying: '驗證中',
  installed: '已安裝',
  cancelling: '取消中，等待原始作業結束',
  cancelled: '已取消；可重新按下安裝。',
  failed: '安裝失敗；可重新按下安裝。',
  removing: '移除中',
};

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '大小未知';
  const unit = bytes >= 1024 ** 3 ? 'GiB' : 'MiB';
  return `${(bytes / (unit === 'GiB' ? 1024 ** 3 : 1024 ** 2)).toFixed(1)} ${unit}`;
}

/**
 * Renderer-only observer of Main's cached nativeModelOverview() projection.
 * Mount performs one read, never consent or installation. The host must dispose
 * before remounting the same root; disposal does not cancel Main-owned work.
 *
 * @param {object} options
 * @param {HTMLElement} options.root Dedicated settings container.
 * @param {object|undefined} options.api Electron preload API; absent on the web.
 * @param {Function} [options.setIntervalImpl] Injectable 500 ms observer clock.
 * @param {Function} [options.clearIntervalImpl] Matching observer cleanup.
 * @returns {{refresh: function(): Promise<object|undefined>, dispose: function(): void}}
 */
export function mountNativeModelSettings({ root, api, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
  const supported = ['nativeModelOverview', 'installNativeModel', 'cancelNativeModelInstallAction']
    .every(method => typeof api?.[method] === 'function');
  if (!supported) {
    root.hidden = true;
    return { async refresh() {}, dispose() {} };
  }
  const document = root.ownerDocument;
  let disposed = false;
  let snapshot = null;
  // Model ids whose install IPC is still pending in this view; others stay clickable.
  // modelId -> actionId Main showed for that model when the click happened (null if none).
  const installing = new Map();
  let removing = false;
  let selecting = false;
  let operationError = '';
  let overviewError = '';
  let cancelError = null;
  const cancelling = new Set();
  let readsInFlight = 0;
  let readSequence = 0;
  let timer = null;
  let listeners = [];
  const buttons = new Map();

  function element(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function classed(node, ...names) {
    node.setAttribute('class', names.join(' '));
    return node;
  }

  function clearListeners() {
    for (const remove of listeners) remove();
    listeners = [];
  }

  function actionButton(label, disabled, onClick, key = label) {
    const button = element('button', label);
    button.type = 'button';
    button.disabled = disabled;
    button.setAttribute('data-native-model-action', key);
    buttons.set(key, button);
    const listener = () => { if (!disposed && !button.disabled) onClick(); };
    button.addEventListener('click', listener);
    listeners.push(() => button.removeEventListener('click', listener));
    return button;
  }

  // Per-model actions from Main; older Mains only expose the single `installation`.
  function actionsOf(overview) {
    if (Array.isArray(overview?.installations)) return overview.installations;
    return overview?.installation ? [overview.installation] : [];
  }
  function actionFor(modelId) {
    return actionsOf(snapshot).find(action => action.modelId === modelId) || null;
  }
  function isActive(action) {
    return action === undefined ? actionsOf(snapshot).some(item => ACTIVE_PHASES.has(item.phase))
      : ACTIVE_PHASES.has(action?.phase);
  }

  function canInstall(model) {
    return !overviewError && snapshot?.version === 1 && snapshot.mode !== 'unavailable'
      && snapshot.runtime?.state === 'embedded' && snapshot.targetLanguage === 'en'
      && snapshot.enabledLanguages?.includes('en') && model?.languages?.includes('en')
      && model.state === 'missing' && typeof model.modelId === 'string' && model.modelId.length > 0;
  }

  function canSelect(model) {
    return !overviewError && typeof api.selectNativeSttModel === 'function' && model?.kind === 'stt'
      && typeof model.tier === 'string' && model.selected !== true;
  }

  function canRemove(model) {
    // Installation state is not removal permission: Main owns active leases.
    return !overviewError && typeof api.removeNativeModel === 'function' && model?.canRemove === true
      && (model.state === 'installed' || model.state === 'active');
  }

  function syncPolling() {
    const observe = !disposed && (installing.size > 0 || isActive());
    if (observe && timer === null) {
      timer = setIntervalImpl(() => {
        if (!disposed && readsInFlight === 0) void refresh();
      }, 500);
    } else if (!observe && timer !== null) {
      clearIntervalImpl(timer);
      timer = null;
    }
  }

  function render(overview) {
    const focusedKey = root.contains(document.activeElement)
      ? document.activeElement?.getAttribute('data-native-model-action') : null;
    // The 500 ms download observer re-renders the whole panel; keep user-opened
    // <details> open and ancestor scroll positions stable across re-renders.
    const openDetails = new Set();
    (function collectOpen(node) {
      const key = node.getAttribute?.('data-native-model-details');
      if (key !== null && key !== undefined && node.open) openDetails.add(key);
      for (const child of node.children || []) collectOpen(child);
    })(root);
    const scrollers = [];
    for (let node = root; node; node = node.parentElement) {
      if (node.scrollTop) scrollers.push([node, node.scrollTop]);
    }
    clearListeners();
    buttons.clear();
    // Main's projection names the host; anything other than win32 keeps the macOS wording.
    const windows = overview?.platform === 'win32';
    const osName = windows ? 'Windows' : 'macOS';
    const title = classed(element('h3', `${osName} 原生語音模型`), 'native-model-title');
    const boundary = classed(element('p', '目前原生語音練習僅啟用英文（en）。其他語言僅為模型能力資訊（metadata），不代表已開放練習。'), 'native-model-note');
    const reuse = classed(element('p', `語音辨識（STT）有四檔可選，只需下載選用的那一檔。各模型分包安裝，按下下載即開始，可同時下載多個，用不到的可以再刪掉。已安裝模型可離線重用；缺少一包不會刪除其他有效模型。原生語音對話需 STT 與 TTS 兩包都就緒，文字練習仍可使用。${windows ? '此版本語音以 CPU 執行。' : ''}`), 'native-model-note');
    function progressFor(model) {
      const action = actionsOf(overview).find(item => item.modelId === model.modelId) || null;
      const clicked = installing.has(model.modelId);
      // A terminal projection for a NEW action while our promise is open means Main is still
      // unwinding the cancellation; the old terminal action must not look like the new one.
      const unwinding = clicked && !isActive(action) && action?.phase === 'cancelled'
        && action.actionId !== installing.get(model.modelId);
      const pending = clicked && !isActive(action) && !unwinding;
      const nodes = [];
      if (action && (action.phase === 'downloading' || action.phase === 'verifying')) {
        const progress = element('progress');
        progress.setAttribute('aria-label', `${model.name} 下載進度`);
        progress.setAttribute('class', 'native-model-progress');
        const total = Number.isFinite(action.total) && action.total > 0 ? action.total : null;
        const received = Number.isFinite(action.bytes) && action.bytes >= 0 ? action.bytes : 0;
        const bytes = total === null ? received : Math.min(received, total);
        let amount = `${formatBytes(bytes)} / 總大小未知`;
        if (total !== null) {
          progress.max = total;
          progress.value = bytes;
          amount = `${formatBytes(bytes)} / ${formatBytes(total)}（${Math.round(bytes / total * 100)}%）`;
        }
        nodes.push(progress, classed(element('p', `${PHASE_LABELS[action.phase]} · ${amount}`), 'native-model-amount'));
      } else if (pending || action?.phase === 'confirming') {
        nodes.push(classed(element('p', '準備下載…'), 'native-model-amount'));
      } else if (action?.phase === 'cancelling' || unwinding) {
        nodes.push(classed(element('p', PHASE_LABELS.cancelling), 'native-model-amount'));
      }
      if (isActive(action) && typeof action.actionId === 'string' && action.actionId) {
        const actionId = action.actionId;
        const busy = cancelling.has(actionId) || action.cancelled === true || action.phase === 'cancelling';
        const cancel = actionButton(busy ? '取消中…' : '取消', busy,
          () => { void cancelInstall(actionId); }, `cancel:${actionId}`);
        cancel.setAttribute('aria-label', `取消安裝 ${model.name}`);
        nodes.push(cancel);
      }
      return { action, nodes, active: pending || unwinding || isActive(action) };
    }

    // One row per model. STT tiers render as a pick-one group (title, one line, tags);
    // TTS keeps the plain row. Actions: progress+取消 | 下載/重試 | 使用 | 移除 (short labels;
    // the full action stays in aria-label for assistive tech and tests).
    // Downloads are per model and only lock their own row; removal waits for all downloads (Main enforces it too).
    const anyDownload = installing.size > 0 || isActive();
    function modelRow(model) {
      const tier = model.kind === 'stt' && TIER_TITLES[model.tier] ? model.tier : null;
      const row = classed(element('li'), 'native-model-row', ...(tier ? ['native-model-tier'] : []),
        ...(model.selected ? ['is-selected'] : []));
      const info = classed(element('div'), 'native-model-info');
      const here = progressFor(model);
      const busyHere = here.active;
      const failedHere = here.action?.phase === 'failed' && !installing.has(model.modelId);
      const heading = classed(element('div'), 'native-model-heading');
      heading.appendChild(classed(element('h4', tier ? TIER_TITLES[tier] : model.name), 'native-model-name'));
      if (model.selected) heading.appendChild(classed(element('span', '使用中'), 'native-model-tag', 'is-selected'));
      if (model.recommended) heading.appendChild(classed(element('span', '推薦'), 'native-model-tag', 'is-recommended'));
      info.appendChild(heading);
      if (tier) info.appendChild(classed(element('p', TIER_LINES[tier]), 'native-model-line'));
      info.appendChild(classed(element('p', `${tier ? `${model.name} · ` : ''}${formatBytes(model.bytes)} · ${model.license.spdx}${tier && model.state !== 'missing' ? ' · 已下載' : ''}`), 'native-model-meta'));
      if (model.warning && WARNING_LABELS[model.warning]) {
        const warn = classed(element('p', WARNING_LABELS[model.warning]), 'native-model-warning');
        warn.setAttribute('role', 'note');
        info.appendChild(warn);
      }
      // License URL and languages stay in a collapsed <details> as plain text (no opener).
      const details = classed(element('details'), 'native-model-details');
      details.setAttribute('data-native-model-details', String(model.modelId));
      if (openDetails.has(String(model.modelId))) details.open = true;
      details.append(
        element('summary', '詳情'),
        classed(element('p', `${model.kind === 'stt' ? 'STT：將語音辨識為文字' : 'TTS：將文字合成為語音'} · 模型語言能力：${model.languages.join('、')}`), 'native-model-kind'),
        classed(element('p', `授權：${model.license.spdx} ${model.license.url}`), 'native-model-license'),
      );
      info.appendChild(details);
      const actions = classed(element('div'), 'native-model-actions');
      const stateClasses = ['native-model-state', `is-${model.state}`];
      // Tier cards already say 使用中 in the heading and show 下載 when missing; the
      // state pill stays for assistive tech only so each card has at most two visible actions.
      if (model.state === 'missing' || tier) stateClasses.push('visually-hidden');
      actions.appendChild(classed(element('span', MODEL_STATES[model.state] || '不可用'), ...stateClasses));
      if (failedHere) actions.appendChild(classed(element('span', '安裝失敗'), 'native-model-row-error'));
      if (!busyHere && here.action?.phase === 'cancelled' && model.state === 'missing') {
        actions.appendChild(classed(element('span', '已取消'), 'native-model-row-note'));
      }
      if (model.state === 'missing') {
        const install = actionButton(failedHere ? '重試' : '下載', busyHere || removing || !canInstall(model),
          () => { void installModel(model.modelId); }, `install:${model.modelId}`);
        install.setAttribute('aria-label', `安裝 ${model.name}`);
        install.setAttribute('class', 'native-model-install');
        install.hidden = busyHere;
        actions.appendChild(install);
      }
      if (canSelect(model)) {
        const select = classed(actionButton('使用', removing || selecting, () => { void selectModel(model.modelId); },
          `select:${model.modelId}`), 'native-model-select');
        select.setAttribute('aria-label', `選用 ${model.name}`);
        actions.appendChild(select);
      }
      if (canRemove(model)) {
        const remove = classed(actionButton('移除', anyDownload || removing || selecting, () => { void removeModel(model.modelId); },
          `remove:${model.modelId}`), 'link-btn', 'native-model-remove');
        remove.setAttribute('aria-label', `移除 ${model.name}`);
        actions.appendChild(remove);
      }
      row.append(info, actions);
      // Progress gets its own full-width line under the card instead of squeezing the action column.
      if (busyHere && here.nodes.length) row.appendChild(classed(element('div'), 'native-model-row-progress')).append(...here.nodes);
      return row;
    }
    const allModels = overview?.models || [];
    const tiers = allModels.filter(model => model.kind === 'stt' && TIER_TITLES[model.tier])
      .sort((x, y) => TIER_ORDER.indexOf(x.tier) - TIER_ORDER.indexOf(y.tier));
    const others = allModels.filter(model => !tiers.includes(model));
    const groups = [];
    function group(titleText, hintText, members, extra = []) {
      if (!members.length) return;
      const wrap = classed(element('div'), 'native-model-group');
      const head = classed(element('div'), 'native-model-group-head');
      head.appendChild(classed(element('h4', titleText), 'native-model-group-title'));
      if (hintText) head.appendChild(classed(element('p', hintText), 'native-model-group-hint'));
      const list = classed(element('ul'), 'native-model-list');
      for (const model of members) list.appendChild(modelRow(model));
      wrap.append(head, ...extra, list);
      groups.push(wrap);
    }
    const sttNotes = [];
    if (overview?.stt?.preferenceError) {
      const bad = classed(element('p', `語音辨識設定無法讀取（${overview.stt.preferenceError}），請重新選一檔。`), 'native-model-banner', 'is-error');
      bad.setAttribute('role', 'alert');
      sttNotes.push(bad);
    } else {
      const selectedModel = tiers.find(model => model.modelId === overview?.stt?.selectedModelId);
      if (selectedModel && selectedModel.state === 'missing') {
        sttNotes.push(classed(element('p', `「${TIER_TITLES[selectedModel.tier]}」尚未下載，下載後才能使用語音對話。`), 'native-model-banner'));
      }
    }
    const recommended = tiers.find(model => model.modelId === overview?.stt?.recommendedModelId);
    const sttHint = recommended
      ? `推薦「${TIER_TITLES[recommended.tier]}」：${REASON_LABELS[overview.stt.recommendationReason] || '依此裝置硬體'}。可改選任何一檔。`
      : '選一檔使用，只需下載選用的那一檔。';
    group('語音辨識', sttHint, tiers, sttNotes);
    group(tiers.length ? '語音合成' : '模型', '', others);
    const status = classed(element('div'), 'native-model-status');
    status.setAttribute('role', 'status');
    const running = actionsOf(overview).filter(item => isActive(item)).length;
    if (removing) status.appendChild(element('p', PHASE_LABELS.removing));
    else if (running > 1) status.appendChild(element('p', `${running} 個模型下載中`));
    const failures = actionsOf(overview).filter(item => item.phase === 'failed' && item.errorCode && !installing.has(item.modelId))
      .map(item => item.errorCode);
    const cancelMessage = cancelError && actionsOf(overview).some(item => item.actionId === cancelError.actionId) ? cancelError.message : '';
    const error = classed(element('p', [...new Set(failures), operationError, overviewError, cancelMessage]
      .filter(Boolean).join('：')), 'native-model-error');
    error.setAttribute('role', 'alert');
    status.appendChild(error);
    const restart = classed(element('p'), 'native-model-banner', 'native-model-restart');
    if (overview?.restartRequired || actionsOf(overview).some(item => item.restartRequired) || overview?.models.some(model => model.restartRequired)) {
      restart.textContent = '請完整結束 App（Quit）再開啟，新的模型才會生效；只關閉視窗不算。';
      restart.setAttribute('role', 'status');
    }
    const reloadOverview = classed(actionButton('重新整理模型狀態', false, () => { void refresh(); }), 'link-btn', 'native-model-reload');
    const mode = !overview ? '尚未取得模型狀態。' : overview.runtime?.state !== 'embedded'
      ? '原生語音執行環境不可用；仍可使用文字練習及其他可用功能。'
      : MODE_LABELS[overview.mode] || MODE_LABELS.unavailable;
    const summary = classed(element('p', '語音辨識與語音合成各裝好一個，即可語音對話；安裝後請完整結束 App 再開啟。'), 'native-model-summary');
    const more = classed(element('details'), 'native-model-more');
    more.setAttribute('data-native-model-details', '__more__');
    if (openDetails.has('__more__')) more.open = true;
    more.append(element('summary', '更多說明'), classed(element('p', mode), 'native-model-note'), boundary, reuse);
    root.replaceChildren(title, restart, status, ...groups, summary, more, reloadOverview);
    for (const [node, top] of scrollers) node.scrollTop = top;
    const focusedButton = buttons.get(focusedKey);
    if (focusedButton && !focusedButton.disabled) focusedButton.focus();
    syncPolling();
  }

  async function cancelInstall(actionId) {
    const action = actionsOf(snapshot).find(item => item.actionId === actionId);
    if (disposed || !isActive(action) || action.cancelled || action.phase === 'cancelling' || cancelling.has(actionId)) return;
    cancelling.add(actionId);
    cancelError = null;
    render(snapshot);
    try {
      await api.cancelNativeModelInstallAction(actionId);
    } catch (error) {
      if (!disposed && actionsOf(snapshot).some(item => item.actionId === actionId)) {
        cancelError = { actionId, message: `取消失敗：${String(error?.message || error)}` };
      }
    } finally {
      cancelling.delete(actionId);
      if (!disposed) await refresh();
    }
  }

  async function selectModel(modelId) {
    const model = snapshot?.models.find(candidate => candidate.modelId === modelId);
    if (disposed || removing || selecting || !canSelect(model)) return;
    selecting = true;
    operationError = '';
    render(snapshot);
    try {
      await api.selectNativeSttModel(modelId);
    } catch (error) {
      if (!disposed) operationError = `選用失敗：${String(error?.message || error)}`;
    } finally {
      if (!disposed) await refresh();
      selecting = false;
      if (!disposed) render(snapshot);
    }
  }

  async function removeModel(modelId) {
    const model = snapshot?.models.find(candidate => candidate.modelId === modelId);
    if (disposed || installing.size || removing || isActive() || !canRemove(model)) return;
    removing = true;
    operationError = '';
    render(snapshot);
    try {
      await api.removeNativeModel(modelId);
    } catch (error) {
      if (!disposed) operationError = `移除失敗：${String(error?.message || error)}`;
    } finally {
      if (!disposed) await refresh();
      removing = false;
      if (!disposed) render(snapshot);
    }
  }

  async function installModel(modelId) {
    const model = snapshot?.models.find(candidate => candidate.modelId === modelId);
    if (disposed || installing.has(modelId) || removing || isActive(actionFor(modelId)) || !canInstall(model)) return;
    installing.set(modelId, actionFor(modelId)?.actionId ?? null);
    operationError = '';
    render(snapshot);
    try {
      // Main owns the entire installation action; the click is the consent.
      await api.installNativeModel(modelId);
    } catch (error) {
      if (!disposed) operationError = `${model.name} 安裝失敗：${String(error?.message || error)}`;
    } finally {
      if (!disposed) await refresh();
      installing.delete(modelId);
      if (!disposed) render(snapshot);
    }
  }

  async function refresh() {
    if (disposed) return;
    readsInFlight += 1;
    const sequence = ++readSequence;
    try {
      const overview = await api.nativeModelOverview();
      // Manual refreshes may overlap; only the newest request owns the view.
      if (!disposed && sequence === readSequence) {
        snapshot = overview;
        overviewError = '';
        render(snapshot);
      }
      return overview;
    } catch (error) {
      if (!disposed && sequence === readSequence) {
        overviewError = `讀取模型狀態失敗：${String(error?.message || error)}`;
        render(snapshot);
      }
    } finally {
      readsInFlight -= 1;
    }
  }

  root.hidden = false;
  render(snapshot);
  void refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      clearListeners();
      buttons.clear();
      syncPolling();
    },
  };
}
