import { validateRecord, validateImport } from '../shared/model.js';
import * as db from './db.js';

const SITE_URLS = ['https://sudoku.com/*', 'https://www.sudoku.com/*'];
const WRITE_TYPES = new Set(['SJ_RECORD', 'SJ_ADD_MANUAL', 'SJ_DELETE', 'SJ_RESTORE', 'SJ_PURGE', 'SJ_IMPORT', 'SJ_SET_PAUSED', 'SJ_EXPORT_MARK']);
let writes = Promise.resolve();

function ownPage(sender) {
  return sender.id === chrome.runtime.id && typeof sender.url === 'string'
    && sender.url.startsWith(chrome.runtime.getURL(''));
}

function sitePage(sender) {
  try {
    const url = new URL(sender.url);
    return sender.id === chrome.runtime.id && Number.isInteger(sender.tab?.id)
      && url.protocol === 'https:' && ['sudoku.com', 'www.sudoku.com'].includes(url.hostname)
      && (sender.frameId === 0 || sender.frameId === undefined);
  } catch { return false; }
}

function ids(value) {
  if (!Array.isArray(value) || value.length > 50_000 || value.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(id))) {
    throw new Error('所选记录无效，请重新打开统计页。');
  }
  return [...new Set(value)];
}

async function notifyPages(type) {
  try {
    const tabs = await chrome.tabs.query({ url: SITE_URLS });
    await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type })));
  } catch { /* A tab may disappear while notifying it. */ }
}

async function dispatch(message, sender) {
  if (!message || typeof message !== 'object') throw new Error('请求无效。');
  const { type } = message;
  if (type === 'SJ_GET_SETTINGS') {
    if (!ownPage(sender) && !sitePage(sender)) throw new Error('来源不受支持。');
    const settings = await db.getSettings();
    return sitePage(sender) ? { ...settings, tabId: sender.tab.id } : settings;
  }
  if (type === 'SJ_RECORD') {
    if (!sitePage(sender)) throw new Error('仅允许目标站点记录完成。');
    let record;
    try {
      record = validateRecord(message.record);
      if (record.source !== 'automatic' || !record.id.startsWith('auto:')) throw new Error('自动记录格式无效。');
    } catch (error) { error.code = 'INVALID_RECORD'; throw error; }
    if (Date.now() - Date.parse(record.completedAt) >= 30 * 86400000) {
      const error = new Error('这条暂存已超过 30 天，请导出检查后手动恢复，避免迟到的重试恢复已删除记录。');
      error.code = 'STALE_RECORD'; throw error;
    }
    return db.addRecord(record, { automatic: true });
  }
  if (!ownPage(sender)) throw new Error('请从数独手记界面执行此操作。');
  switch (type) {
    case 'SJ_POPUP': return db.getPopupSummary();
    case 'SJ_SNAPSHOT': return db.getSnapshot();
    case 'SJ_ADD_MANUAL': {
      const record = validateRecord(message.record);
      if (record.source !== 'manual') throw new Error('补记来源无效。');
      return db.addRecord(record);
    }
    case 'SJ_DELETE': return db.deleteRecords(ids(message.ids));
    case 'SJ_RESTORE': return db.restoreRecords(ids(message.ids));
    case 'SJ_PURGE': return db.purgeRecords(ids(message.ids));
    case 'SJ_IMPORT': return db.mergeRecords(validateImport(message.backup));
    case 'SJ_SET_PAUSED': {
      if (typeof message.paused !== 'boolean') throw new Error('暂停设置无效。');
      const result = await db.setPaused(message.paused);
      await notifyPages('SJ_SETTINGS_CHANGED');
      return result;
    }
    case 'SJ_EXPORT_MARK': return db.markExport();
    default: throw new Error('不支持的请求，请更新扩展并刷新页面。');
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (typeof message?.type !== 'string' || !message.type.startsWith('SJ_') || ['SJ_DATA_CHANGED', 'SJ_CAPTURE_STATUS', 'SJ_RETRY_PENDING', 'SJ_SETTINGS_CHANGED'].includes(message.type)) return false;
  const execute = () => dispatch(message, sender);
  const result = WRITE_TYPES.has(message.type) ? writes.then(execute) : execute();
  if (WRITE_TYPES.has(message.type)) writes = result.catch(() => {});
  result.then(data => {
    respond({ ok: true, data });
    if (WRITE_TYPES.has(message.type)) {
      chrome.runtime.sendMessage({ type: 'SJ_DATA_CHANGED' }).catch(() => {});
      if (['SJ_DELETE', 'SJ_PURGE', 'SJ_SET_PAUSED'].includes(message.type)) void notifyPages('SJ_RETRY_PENDING');
    }
  }, error => respond({ ok: false, error: error?.message || '保存失败，请稍后重试或导出备份。', code: error?.code || 'STORAGE_ERROR' }));
  return true;
});

chrome.runtime.onInstalled.addListener(details => {
  void db.getSettings().catch(() => {});
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html#start') }).catch(() => {});
});
