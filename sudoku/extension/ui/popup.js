import { $, api, feedback, number, label, download, exportName, VARIANT_LABELS, DIFFICULTY_LABELS, MODE_LABELS } from './common.js';

const state = { tabId: null, paused: false, capture: null, retrying: false, exporting: false };

async function captureMessage(type) {
  if (!Number.isInteger(state.tabId)) throw new Error('没有连接到目标标签页，请回到数独网页后重新打开扩展。');
  let timer;
  try {
    const result = await Promise.race([
      chrome.tabs.sendMessage(state.tabId, { type }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('页面尚未回应。请保留数独标签页，稍后重新打开扩展查看。')), 8000); }),
    ]);
    if (!result || typeof result !== 'object') throw new Error('没有收到有效的页面回应。');
    return result;
  } catch (error) {
    if (/Receiving end|Could not establish|context invalidated/i.test(error.message)) {
      throw new Error('原数独标签页的连接已失效。若网页仍开着，请先保留它；未导出的暂存数据可能需要在刷新前检查。');
    }
    throw error;
  } finally { clearTimeout(timer); }
}

async function readCapture() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { supported: false, phase: 'unsupported', message: '打开 sudoku.com 后，可以在这里查看连接状态。' };
  if (tab.url) {
    try {
      const url = new URL(tab.url);
      if (url.hostname !== 'sudoku.com' && url.hostname !== 'www.sudoku.com') {
        return { supported: false, phase: 'unsupported', message: '当前页面不是 sudoku.com。打开数独网页后，再来查看。' };
      }
    } catch { /* The content-script connection below remains the source of truth. */ }
  }
  state.tabId = tab.id;
  try {
    const status = await captureMessage('SJ_CAPTURE_STATUS');
    if (!status || typeof status !== 'object' || typeof status.phase !== 'string') throw new Error('invalid status');
    return status;
  } catch {
    return { supported: false, phase: 'error', message: '尚未连接到数独页面。请刷新网页，并检查扩展是否允许访问 sudoku.com。' };
  }
}

function renderCapture(status, paused) {
  state.capture = status;
  const recoveryWarning = status?.rejected > 0 || !!status?.recoveryWarning;
  const needsRecovery = status?.pending > 0 || recoveryWarning;
  $('#recoveryBox').hidden = !needsRecovery;
  $('#retryPending').disabled = state.retrying || !Number.isInteger(state.tabId);
  $('#exportRecovery').disabled = state.exporting || !Number.isInteger(state.tabId);
  if (paused && !recoveryWarning) status = { ...status, phase: 'paused', message: '历史记录会保留。到统计页中重新开启，之后的新完成才会继续记录。已有待处理数据可先导出保留。' };
  const titles = {
    playing: '游戏进行中',
    saved: '记录已保存',
    waiting: '等待可识别的新一局',
    paused: '自动记录已暂停',
    error: '这次连接需要检查',
    unsupported: '当前页面尚未连接',
  };
  const defaults = {
    playing: '成功完成后会自动保存，无需一直打开这个窗口。',
    saved: '已保存到本机，可以到统计页中查看。',
    waiting: '开始或继续游玩后再查看。已有的旧成功页面不会自动补记。',
    unsupported: '此页面尚未识别。可以到统计页中手动补记。',
  };
  const phase = Object.hasOwn(titles, status?.phase) ? status.phase : 'error';
  $('#captureDot').className = `status-dot ${phase}`;
  $('#captureTitle').textContent = recoveryWarning ? '有暂存数据需要检查' : status?.pending && phase === 'error' ? '有记录尚未保存' : status?.pending && phase !== 'paused' ? '正在保存这一局' : titles[phase];
  const warning = status?.sessionPersistence === false ? ' 此标签页的恢复缓存不可用，确认保存前请保留这个标签页。' : '';
  $('#captureMessage').textContent = (status?.message || defaults[phase] || '没有得到有效的检测状态，请刷新数独页面再试。') + warning;
  const parts = [];
  if (status?.variant && status.variant !== 'unknown') parts.push(label(VARIANT_LABELS, status.variant));
  if (status?.difficulty && status.difficulty !== 'unknown') parts.push(label(DIFFICULTY_LABELS, status.difficulty));
  if (status?.mode && status.mode !== 'regular' && status.mode !== 'unknown') parts.push(label(MODE_LABELS, status.mode));
  $('#captureLabels').textContent = parts.join(' · ');
  $('#captureLabels').hidden = !parts.length;
}

async function refreshSummary() {
  const data = await api('SJ_POPUP');
  const summary = data?.summary;
  if (!summary || !['total', 'todayCount', 'last7Count'].every((key) => Number.isSafeInteger(summary[key]) && summary[key] >= 0)) {
    throw new Error('暂时无法读取有效的汇总数字，请重新打开扩展。');
  }
  $('#popupTotal').textContent = number(summary.total);
  $('#popupToday').textContent = number(summary.todayCount);
  $('#popupSeven').textContent = number(summary.last7Count);
  state.paused = data.settings?.paused === true;
}

$('#retryPending').addEventListener('click', async () => {
  if (state.retrying) return;
  state.retrying = true;
  $('#retryPending').disabled = true;
  feedback('#recoveryFeedback', '正在请求重试。请暂时保留数独标签页。', 'info');
  try {
    const initial = await captureMessage('SJ_RETRY_PENDING');
    if (typeof initial.phase !== 'string') throw new Error('页面没有返回有效的保存状态。');
    renderCapture(initial, state.paused);
    // One bounded follow-up only: no periodic polling or background heartbeat.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const updated = await captureMessage('SJ_CAPTURE_STATUS');
    if (typeof updated.phase !== 'string') throw new Error('页面没有返回有效的保存状态。');
    renderCapture(updated, state.paused);
    const pending = Number(updated.pending) || 0;
    const rejected = Number(updated.rejected) || 0;
    feedback('#recoveryFeedback', pending || rejected || updated.recoveryWarning
      ? `重试请求已发出；仍有 ${number(pending)} 条待保存、${number(rejected)} 条待检查。请先导出待恢复数据保留，是否成功以统计页中的记录为准。`
      : '这次检查未发现待处理暂存。请到统计页确认实际记录；没有捕获到的成绩仍需手动补记。', 'info');
    try { await refreshSummary(); renderCapture(updated, state.paused); }
    catch (error) { feedback('#popupFeedback', `统计尚未刷新：${error.message}`); }
  } catch (error) {
    feedback('#recoveryFeedback', `未能确认重试结果：${error.message}`);
  } finally {
    state.retrying = false;
    $('#retryPending').disabled = !Number.isInteger(state.tabId);
  }
});

$('#exportRecovery').addEventListener('click', async () => {
  if (state.exporting) return;
  state.exporting = true;
  $('#exportRecovery').disabled = true;
  feedback('#recoveryFeedback');
  try {
    const backup = await captureMessage('SJ_RECOVERY_EXPORT');
    if (backup.app !== 'sudoku-journal-recovery' || backup.version !== 1 || !Array.isArray(backup.pending) || !Array.isArray(backup.quarantined)) {
      throw new Error('页面未返回有效的待恢复数据，请保留原数独标签页。');
    }
    download(JSON.stringify(backup, null, 2), exportName('json').replace(/\.json$/u, '-待恢复.json'), 'application/json;charset=utf-8');
    feedback('#recoveryFeedback', '已发起诊断备份下载，请确认文件已保存。这份文件供后续修复使用，不能直接导入统计页，也不表示这些记录已保存成功。', 'info');
  } catch (error) {
    feedback('#recoveryFeedback', `无法导出待恢复数据：${error.message}`);
  } finally {
    state.exporting = false;
    $('#exportRecovery').disabled = !Number.isInteger(state.tabId);
  }
});

$('#openDashboard').addEventListener('click', async () => {
  const button = $('#openDashboard');
  if (button.disabled) return;
  button.disabled = true;
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    window.close();
  } catch (error) {
    feedback('#popupFeedback', `无法打开统计页：${error.message || error}`);
  } finally {
    button.disabled = false;
  }
});

async function init() {
  const [snapshotResult, captureResult] = await Promise.allSettled([refreshSummary(), readCapture()]);
  if (snapshotResult.status !== 'fulfilled') {
    feedback('#popupFeedback', snapshotResult.reason.message);
  }
  renderCapture(captureResult.status === 'fulfilled' ? captureResult.value : { phase: 'error', message: '当前页面状态无法读取，请刷新数独网页。' }, state.paused);
}

init().catch((error) => feedback('#popupFeedback', error.message));
