import { summarize, filterRecords, toCsv, makeExport, validateImport } from '../shared/model.js';
import {
  $, api, node, feedback, toast, number, label, shortDate, dayShift, duration,
  completedTime, fillOptions, download, exportName, localDateAt,
  VARIANT_LABELS, DIFFICULTY_LABELS, MODE_LABELS, SOURCE_LABELS,
} from './common.js';

const PAGE_SIZE = 50;
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const state = {
  snapshot: null,
  filtered: [],
  filters: {},
  page: 1,
  trashPage: 1,
  request: 0,
  lastRefresh: 0,
  manualId: null,
  savingManual: false,
  updatingPaused: false,
  exportingCsv: false,
  purgingAll: false,
};

function setText(selector, text) { $(selector).textContent = text; }

function setLoading(loading) {
  $('#refreshData').disabled = loading;
  $('#refreshData').textContent = loading ? '读取中…' : '刷新';
}

function renderSummary(summary) {
  setText('#totalCount', number(summary.total));
  setText('#todayCount', number(summary.todayCount));
  setText('#sevenCount', number(summary.last7Count));
  setText('#activeDays', number(summary.activeDays));
  setText('#totalDetail', `自动 ${number(summary.automatic)} 局 · 手动 ${number(summary.manual)} 局`);
  $('#onboarding').hidden = summary.total !== 0;
  renderCalendar(summary);
  renderGroups(summary);
}

function renderCalendar(summary) {
  const today = localDateAt();
  const first = dayShift(today, -89);
  const days = new Map(summary.byDay.map(({ date, count }) => [date, count]));
  const counts = Array.from({ length: 90 }, (_, i) => days.get(dayShift(first, i)) || 0);
  const maximum = Math.max(1, ...counts);
  const total = counts.reduce((sum, value) => sum + value, 0);
  const offset = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < offset; i += 1) fragment.append(node('span', 'heatmap-cell heatmap-padding'));
  for (let i = 0; i < 90; i += 1) {
    const date = dayShift(first, i);
    const count = counts[i];
    const level = count ? Math.max(1, Math.ceil((count / maximum) * 4)) : 0;
    const cell = node('span', `heatmap-cell level-${level}`);
    cell.title = `${date} · 完成 ${number(count)} 局`;
    fragment.append(cell);
  }
  const heatmap = $('#heatmap');
  heatmap.style.setProperty('--heatmap-columns', Math.ceil((90 + offset) / 7));
  heatmap.setAttribute('aria-label', `${first} 至 ${today}，共完成 ${number(total)} 局，有 ${counts.filter(Boolean).length} 个日期包含完成记录。可以用下方按钮查看这些记录。`);
  heatmap.replaceChildren(fragment);
  setText('#calendarStart', shortDate(first));
  setText('#calendarEnd', shortDate(today));
  setText('#calendarTotal', `${number(total)} 局`);
}

function renderGroups(summary) {
  const container = $('#groupList');
  if (!summary.byGroup.length) {
    container.replaceChildren(node('p', 'panel-empty', '暂无完成记录'));
    return;
  }
  const fragment = document.createDocumentFragment();
  const maximum = Math.max(1, ...summary.byGroup.map(({ count }) => count));
  for (const group of summary.byGroup) {
    const row = node('div', 'group-row');
    const top = node('div', 'group-row-top');
    const title = node('span', '', label(DIFFICULTY_LABELS, group.difficulty));
    title.append(node('span', 'group-type', label(VARIANT_LABELS, group.variant)));
    top.append(title, node('strong', '', `${number(group.count)} 局`));
    const track = node('div', 'group-track');
    track.setAttribute('aria-hidden', 'true');
    const fill = node('div', 'group-fill');
    fill.style.width = `${(group.count / maximum) * 100}%`;
    track.append(fill);
    row.append(top, track);
    fragment.append(row);
  }
  container.replaceChildren(fragment);
}

function renderSettings() {
  const { settings = {}, meta = {} } = state.snapshot;
  const used = state.snapshot.records.length + state.snapshot.trash.length;
  feedback('#capacityNotice', used >= 45000
    ? `当前保存 ${number(used)} / 50,000 条记录（含回收站），${used >= 50000 ? '已达到' : '接近'}容量上限。建议先导出 JSON 备份，再整理记录。移入回收站不会释放名额；确认备份后，可永久清理不需要的回收站记录。`
    : '', 'info');
  const paused = settings.paused === true;
  if (!state.updatingPaused) $('#pausedToggle').checked = paused;
  $('#pausedToggle').disabled = state.updatingPaused;
  setText('#pauseLabel', state.updatingPaused ? '正在更新…' : paused ? '已暂停' : '已开启');
  setText('#pauseDescription', paused ? '历史记录仍然保留；暂停期间的新完成不会补抓。' : '在已支持的数独页面捕获新完成；连接状态请在工具栏中查看。');
  const date = meta.lastExportAt ? new Date(meta.lastExportAt) : null;
  setText('#lastExport', date && Number.isFinite(date.getTime())
    ? `上次发起备份下载：${date.toLocaleString('zh-CN', { hour12: false })}`
    : '尚未发起过备份下载');
}

function recordDescription(record) {
  return `${record.localDate} 的${label(VARIANT_LABELS, record.variant)} · ${label(DIFFICULTY_LABELS, record.difficulty)}`;
}

function dateCell(record) {
  const cell = node('td');
  cell.append(node('div', 'cell-main', shortDate(record.localDate)), node('div', 'cell-sub', completedTime(record)));
  return cell;
}

function typeCell(record) {
  const cell = node('td');
  cell.append(node('div', 'cell-main', `${label(VARIANT_LABELS, record.variant)} · ${label(DIFFICULTY_LABELS, record.difficulty)}`));
  if (record.mode && record.mode !== 'regular') cell.append(node('div', 'cell-sub mode-tag', label(MODE_LABELS, record.mode)));
  return cell;
}

function emptyTable(body, columns, message) {
  const row = node('tr');
  const cell = node('td', 'table-empty', message);
  cell.colSpan = columns;
  row.append(cell);
  body.replaceChildren(row);
}

function applyFilters({ resetPage = false } = {}) {
  if (!state.snapshot) return;
  try {
    state.filtered = filterRecords(state.snapshot.records, state.filters);
    if (resetPage) state.page = 1;
    feedback('#filterFeedback');
    renderRecords();
  } catch (error) {
    feedback('#filterFeedback', error.message);
  }
}

function renderRecords() {
  const total = state.filtered.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  state.page = Math.min(pages, Math.max(1, state.page));
  setText('#recordCount', number(total));
  const body = $('#recordRows');
  if (!total) {
    emptyTable(body, 6, state.snapshot.records.length ? '没有符合当前筛选条件的记录。' : '暂无完成记录。完成一局后将自动记录，也可手动补记。');
  } else {
    const fragment = document.createDocumentFragment();
    for (const record of state.filtered.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE)) {
      const row = node('tr');
      const time = node('td', '', duration(record.durationSeconds));
      const source = node('td');
      source.append(node('span', `source-tag ${record.source}`, label(SOURCE_LABELS, record.source)));
      const note = node('td');
      const text = node('span', 'record-note', record.note || '—');
      if (record.note) text.title = record.note;
      note.append(text);
      const action = node('td');
      const button = node('button', 'text-button', '删除');
      button.type = 'button';
      button.setAttribute('aria-label', `将 ${recordDescription(record)} 移到回收站`);
      button.addEventListener('click', () => deleteRecord(record, button));
      action.append(button);
      row.append(dateCell(record), typeCell(record), time, source, note, action);
      fragment.append(row);
    }
    body.replaceChildren(fragment);
  }
  setText('#pageInfo', total ? `共 ${number(total)} 条 · 第 ${state.page} / ${pages} 页` : '每页最多显示 50 条');
  $('#prevPage').disabled = state.page <= 1;
  $('#nextPage').disabled = state.page >= pages;
  $('#exportCsv').disabled = state.exportingCsv || !total;
}

function trashRecords() {
  return [...(state.snapshot?.trash || [])].sort((left, right) => new Date(right.deletedAt).getTime() - new Date(left.deletedAt).getTime());
}

function renderTrash() {
  const entries = trashRecords();
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  state.trashPage = Math.min(pages, Math.max(1, state.trashPage));
  setText('#trashCount', number(entries.length));
  $('#purgeAll').disabled = state.purgingAll || !entries.length;
  const body = $('#trashRows');
  if (!entries.length) {
    emptyTable(body, 4, '回收站是空的。误删的记录会在这里暂存 7 天。');
  } else {
    const fragment = document.createDocumentFragment();
    for (const entry of entries.slice((state.trashPage - 1) * PAGE_SIZE, state.trashPage * PAGE_SIZE)) {
      const record = entry.record;
      const row = node('tr');
      const expires = new Date(entry.expiresAt);
      const expired = Number.isFinite(expires.getTime()) && expires.getTime() <= Date.now();
      const expiryCell = node('td', 'muted small', Number.isFinite(expires.getTime()) ? shortDate(localDateAt(expires)) : '删除后 7 天');
      const actions = node('td');
      const group = node('div', 'button-row');
      const restore = node('button', 'text-button', expired ? '已到期' : '恢复');
      restore.type = 'button';
      restore.disabled = expired;
      restore.setAttribute('aria-label', `恢复 ${recordDescription(record)}`);
      restore.addEventListener('click', () => restoreRecords([record.id], restore));
      const purge = node('button', 'text-button danger-text', '永久删除');
      purge.type = 'button';
      purge.setAttribute('aria-label', `永久删除 ${recordDescription(record)}`);
      purge.addEventListener('click', () => purgeRecords([record.id], purge));
      group.append(restore, purge);
      actions.append(group);
      row.append(dateCell(record), typeCell(record), expiryCell, actions);
      fragment.append(row);
    }
    body.replaceChildren(fragment);
  }
  setText('#trashPageInfo', entries.length ? `共 ${number(entries.length)} 条 · 第 ${state.trashPage} / ${pages} 页` : '记录恢复后会重新加入统计。');
  $('#trashPrevPage').disabled = state.trashPage <= 1;
  $('#trashNextPage').disabled = state.trashPage >= pages;
}

async function loadSnapshot() {
  const request = ++state.request;
  setLoading(true);
  try {
    const data = await api('SJ_SNAPSHOT');
    if (!data || !Array.isArray(data.records) || !Array.isArray(data.trash)) throw new Error('历史数据格式不完整，请先保留现有备份并重载扩展。');
    if (request !== state.request) return;
    const summary = summarize(data.records);
    if (request !== state.request) return;
    state.snapshot = data;
    state.lastRefresh = Date.now();
    renderSummary(summary);
    renderSettings();
    applyFilters();
    renderTrash();
    feedback('#mainFeedback');
  } finally {
    if (request === state.request) setLoading(false);
  }
}

async function afterMutation(message, options = {}) {
  try {
    await loadSnapshot();
  } catch (error) {
    feedback('#mainFeedback', `操作已保存，但刷新视图失败：${error.message} 请点击“刷新”。`);
  }
  toast(message, options);
}

async function deleteRecord(record, button) {
  button.disabled = true;
  try {
    const data = await api('SJ_DELETE', { ids: [record.id] });
    const count = data?.deleted || 0;
    await afterMutation(count ? '已移到回收站，7 天内可以恢复。' : '这条记录已不在当前列表中。', count ? {
      action: '撤销',
      onAction: () => restoreRecords([record.id]),
    } : {});
  } catch (error) {
    feedback('#mainFeedback', `未能确认删除：${error.message}`);
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

async function restoreRecords(ids, button) {
  if (button) button.disabled = true;
  try {
    const data = await api('SJ_RESTORE', { ids });
    feedback('#trashFeedback');
    const restored = data?.restored || 0;
    const skipped = data?.skipped || 0;
    await afterMutation(`已恢复 ${number(restored)} 条记录${skipped ? `；${number(skipped)} 条已存在或已到期` : ''}。`);
  } catch (error) {
    feedback('#trashFeedback', `未能确认恢复：${error.message}`);
    toast(`未能确认恢复：${error.message}`, { kind: 'error' });
    $('#trashSection').open = true;
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

function confirmAction({ title, description, accept = '确认', danger = false }) {
  const dialog = $('#confirmDialog');
  if (dialog.open) return Promise.resolve(false);
  setText('#confirmTitle', title);
  setText('#confirmDescription', description);
  const confirm = $('#confirmAccept');
  const cancel = $('#confirmCancel');
  confirm.textContent = accept;
  confirm.className = `button ${danger ? 'danger' : 'primary'}`;
  dialog.returnValue = '';
  return new Promise((resolve) => {
    const acceptClick = () => dialog.close('accepted');
    const cancelClick = () => dialog.close('cancelled');
    confirm.addEventListener('click', acceptClick);
    cancel.addEventListener('click', cancelClick);
    dialog.addEventListener('close', () => {
      confirm.removeEventListener('click', acceptClick);
      cancel.removeEventListener('click', cancelClick);
      resolve(dialog.returnValue === 'accepted');
    }, { once: true });
    dialog.showModal();
    cancel.focus();
  });
}

async function purgeRecords(ids, button) {
  if (!ids.length) return;
  const confirmed = await confirmAction({
    title: ids.length === 1 ? '永久删除这条记录？' : `永久删除 ${number(ids.length)} 条记录？`,
    description: '永久删除后无法从回收站恢复。已有的备份文件不会被修改；如果还想保留这些记录，请取消并先恢复、导出。',
    accept: '确认永久删除', danger: true,
  });
  if (!confirmed) return;
  if (button.id === 'purgeAll') state.purgingAll = true;
  button.disabled = true;
  try {
    const data = await api('SJ_PURGE', { ids });
    feedback('#trashFeedback');
    await afterMutation(`已永久删除 ${number(data?.removed || 0)} 条记录。`);
  } catch (error) {
    feedback('#trashFeedback', `未能确认永久删除：${error.message}`);
  } finally {
    if (button.id === 'purgeAll') state.purgingAll = false;
    if (button.isConnected) button.disabled = button.id === 'purgeAll' && !state.snapshot?.trash?.length;
  }
}

function openManual() {
  const dialog = $('#manualDialog');
  $('#manualForm').reset();
  feedback('#manualFeedback');
  $('#manualDate').value = localDateAt();
  $('#manualDate').max = localDateAt();
  $('#manualVariant').value = 'classic';
  $('#manualDifficulty').value = 'extreme';
  $('#manualMode').value = 'regular';
  state.manualId = crypto.randomUUID();
  dialog.showModal();
  $('#manualDate').focus();
}

async function saveManual(event) {
  event.preventDefault();
  if (state.savingManual) return;
  const button = $('#saveManual');
  for (const control of $('#manualForm').querySelectorAll('input, select, textarea, button')) control.disabled = true;
  button.textContent = '保存中…';
  state.savingManual = true;
  feedback('#manualFeedback');
  try {
    const record = {
      id: state.manualId,
      site: 'sudoku.com',
      variant: $('#manualVariant').value,
      difficulty: $('#manualDifficulty').value,
      mode: $('#manualMode').value,
      completedAt: null,
      localDate: $('#manualDate').value,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      durationSeconds: null,
      source: 'manual',
      puzzleKey: null,
      note: $('#manualNote').value.trim(),
    };
    await api('SJ_ADD_MANUAL', { record });
    $('#manualDialog').close();
    await afterMutation('记录已保存。');
  } catch (error) {
    feedback('#manualFeedback', `未能确认保存：${error.message}`);
  } finally {
    for (const control of $('#manualForm').querySelectorAll('input, select, textarea, button')) control.disabled = false;
    button.textContent = '保存记录';
    state.savingManual = false;
  }
}

async function exportJson() {
  const button = $('#exportJson');
  button.disabled = true;
  try {
    const snapshot = await api('SJ_SNAPSHOT');
    const backup = makeExport(snapshot.records);
    download(JSON.stringify(backup), exportName('json'), 'application/json;charset=utf-8');
    try {
      await api('SJ_EXPORT_MARK');
      if (state.snapshot) {
        state.snapshot.meta = { ...state.snapshot.meta, lastExportAt: new Date().toISOString() };
        renderSettings();
      }
    } catch (error) {
      feedback('#mainFeedback', `备份下载已发起，但未能记下备份时间：${error.message}`);
    }
    toast(`已发起 ${number(backup.records.length)} 条记录的备份下载，请确认文件已保存。`);
  } catch (error) {
    feedback('#mainFeedback', `无法导出备份：${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function exportCsv() {
  if (state.exportingCsv || !state.filtered.length) return;
  const button = $('#exportCsv');
  state.exportingCsv = true;
  button.disabled = true;
  try {
    const records = state.filtered;
    download(toCsv(records), exportName('csv'), 'text/csv;charset=utf-8');
    toast(`已发起 ${number(records.length)} 条筛选记录的 CSV 下载。完整恢复请使用 JSON 备份。`);
  } catch (error) {
    feedback('#mainFeedback', `无法导出 CSV：${error.message}`);
  } finally {
    state.exportingCsv = false;
    button.disabled = !state.filtered.length;
  }
}

async function importFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  const button = $('#importJson');
  button.disabled = true;
  feedback('#importFeedback');
  let backup;
  try {
    if (file.size > MAX_IMPORT_BYTES) throw new Error('文件超过 64 MB，请选择较小的数独手记 JSON 备份。');
    if (file.size === 0) throw new Error('这个文件是空的，请重新选择备份。');
    try { backup = JSON.parse(await file.text()); }
    catch { throw new Error('文件不是完整有效的 JSON，请检查是否选中了原始备份。'); }
    const count = validateImport(backup).length;
    const confirmed = await confirmAction({
      title: '将这份备份加入手记？',
      description: `文件：${file.name}\n包含 ${number(count)} 条有效记录。\n\n将与现有记录合并，重复项会跳过。现有记录不会被直接清空。建议先为现有记录导出一份 JSON 备份。`,
      accept: '确认合并导入',
    });
    if (!confirmed) return;
    button.textContent = '正在导入…';
    feedback('#importFeedback', '正在合并备份，较大文件可能需要几十秒。请保持此页面打开，不要重复提交。', 'info');
    const result = await api('SJ_IMPORT', { backup });
    const message = `已新增 ${number(result?.added || 0)} 条，跳过 ${number(result?.duplicates || 0)} 条重复记录。`;
    feedback('#importFeedback', message, 'success');
    await afterMutation(message);
  } catch (error) {
    feedback('#importFeedback', `未能确认导入：${error.message} 现有记录不会因无效文件而清空。`);
  } finally {
    backup = null;
    button.disabled = false;
    button.textContent = '导入 JSON 备份';
  }
}

async function togglePaused() {
  if (state.updatingPaused) return;
  const toggle = $('#pausedToggle');
  const paused = toggle.checked;
  state.updatingPaused = true;
  toggle.disabled = true;
  setText('#pauseLabel', '正在更新…');
  try {
    await api('SJ_SET_PAUSED', { paused });
    if (state.snapshot) state.snapshot.settings = { ...state.snapshot.settings, paused };
    await afterMutation(paused ? '已暂停自动记录，已有历史会保留。' : '自动记录已开启；请在工具栏确认数独页面的连接状态。');
  } catch (error) {
    toggle.checked = state.snapshot?.settings?.paused === true;
    feedback('#mainFeedback', `无法更改记录设置：${error.message}`);
  } finally {
    state.updatingPaused = false;
    if (state.snapshot) renderSettings();
    else toggle.disabled = true;
  }
}

function connectEvents() {
  $('#addManual').addEventListener('click', openManual);
  $('#manualForm').addEventListener('submit', saveManual);
  for (const selector of ['#closeManual', '#cancelManual']) $(selector).addEventListener('click', () => {
    if (!state.savingManual) $('#manualDialog').close();
  });
  $('#manualDialog').addEventListener('cancel', (event) => { if (state.savingManual) event.preventDefault(); });
  $('#filterForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const next = {
      from: $('#filterFrom').value, to: $('#filterTo').value,
      variant: $('#filterVariant').value, difficulty: $('#filterDifficulty').value,
      mode: $('#filterMode').value,
      source: $('#filterSource').value,
    };
    try {
      if (!state.snapshot) throw new Error('记录尚未加载完成，请稍后重试。');
      const filtered = filterRecords(state.snapshot.records, next);
      state.filters = next;
      state.filtered = filtered;
      state.page = 1;
      feedback('#filterFeedback');
      renderRecords();
    } catch (error) { feedback('#filterFeedback', error.message); }
  });
  $('#resetFilters').addEventListener('click', () => {
    $('#filterForm').reset();
    state.filters = {};
    applyFilters({ resetPage: true });
  });
  $('#view90Days').addEventListener('click', () => {
    $('#filterForm').reset();
    $('#filterFrom').value = dayShift(localDateAt(), -89);
    $('#filterTo').value = localDateAt();
    $('#filterForm').requestSubmit();
    $('#records').scrollIntoView();
    $('#filterFrom').focus({ preventScroll: true });
  });
  $('#prevPage').addEventListener('click', () => { state.page -= 1; renderRecords(); });
  $('#nextPage').addEventListener('click', () => { state.page += 1; renderRecords(); });
  $('#trashPrevPage').addEventListener('click', () => { state.trashPage -= 1; renderTrash(); });
  $('#trashNextPage').addEventListener('click', () => { state.trashPage += 1; renderTrash(); });
  $('#purgeAll').addEventListener('click', () => purgeRecords((state.snapshot?.trash || []).map(({ record }) => record.id), $('#purgeAll')));
  $('#refreshData').addEventListener('click', () => loadSnapshot().catch((error) => feedback('#mainFeedback', error.message)));
  $('#exportJson').addEventListener('click', exportJson);
  $('#exportCsv').addEventListener('click', exportCsv);
  $('#importJson').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', importFile);
  $('#pausedToggle').addEventListener('change', togglePaused);
  const onVisible = () => {
    if (document.hidden || $('#manualDialog').open || $('#confirmDialog').open || Date.now() - state.lastRefresh < 1000) return;
    loadSnapshot().catch((error) => feedback('#mainFeedback', `刷新记录失败：${error.message}`));
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  let changeTimer;
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'SJ_DATA_CHANGED' || document.hidden) return false;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      loadSnapshot().catch((error) => feedback('#mainFeedback', `记录有更新，但刷新失败：${error.message}`));
    }, 150);
    return false;
  });
}

function init() {
  fillOptions($('#filterVariant'), VARIANT_LABELS, '全部类型');
  fillOptions($('#filterDifficulty'), DIFFICULTY_LABELS, '全部难度');
  fillOptions($('#filterMode'), MODE_LABELS, '全部模式');
  fillOptions($('#filterSource'), SOURCE_LABELS, '全部来源');
  fillOptions($('#manualVariant'), VARIANT_LABELS);
  fillOptions($('#manualDifficulty'), DIFFICULTY_LABELS);
  fillOptions($('#manualMode'), MODE_LABELS);
  setText('#todayLabel', new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date()));
  try { setText('#appVersion', `v${chrome.runtime.getManifest().version} · 仅存本机`); } catch { /* The static privacy label is sufficient. */ }
  connectEvents();
  loadSnapshot().catch((error) => feedback('#mainFeedback', `无法读取记录：${error.message}`));
}

init();
