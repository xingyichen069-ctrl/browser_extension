import { VARIANT_LABELS, DIFFICULTY_LABELS, MODE_LABELS, localDateAt } from '../shared/model.js';

export { VARIANT_LABELS, DIFFICULTY_LABELS, MODE_LABELS, localDateAt };
export const SOURCE_LABELS = Object.freeze({ automatic: '自动记录', manual: '手动补记' });
export const $ = (selector, root = document) => root.querySelector(selector);
const numberFormatter = new Intl.NumberFormat('zh-CN');
export const number = (value) => numberFormatter.format(value ?? 0);
export const label = (labels, value) => labels[value] || '未识别';

export function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== '') element.textContent = String(text);
  return element;
}

export async function api(type, payload = {}) {
  let timer;
  const timeout = type === 'SJ_IMPORT' || type === 'SJ_SNAPSHOT' ? 60000 : 20000;
  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage({ type, ...payload }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('本次操作可能仍在处理中，请先刷新确认结果，再决定是否重试。')), timeout); }),
    ]);
    if (!response || response.ok !== true) throw new Error(response?.error || '未收到有效响应，请在扩展管理页重载数独手记。');
    return response.data;
  } catch (error) {
    const message = error?.message || String(error);
    if (/Extension context invalidated|Receiving end does not exist|Could not establish connection/i.test(message)) {
      throw new Error('扩展连接已更新，请关闭此页面后重新打开；数独网页也请刷新一次。');
    }
    throw new Error(message);
  } finally {
    clearTimeout(timer);
  }
}

export function feedback(target, message = '', kind = 'error') {
  const element = typeof target === 'string' ? $(target) : target;
  if (!element) return;
  element.textContent = message;
  element.className = `feedback feedback-${kind}`;
  element.hidden = !message;
}

let toastTimer;
export function toast(message, { action, onAction, kind = 'success' } = {}) {
  const container = $('#toast');
  if (!container) return;
  clearTimeout(toastTimer);
  container.className = `toast toast-${kind}`;
  container.replaceChildren(node('span', '', message));
  if (action && onAction) {
    const button = node('button', 'toast-action', action);
    button.type = 'button';
    button.addEventListener('click', onAction, { once: true });
    container.append(button);
  }
  container.hidden = false;
  const dismiss = () => {
    if (container.contains(document.activeElement)) {
      toastTimer = setTimeout(dismiss, 4000);
      return;
    }
    container.hidden = true;
  };
  toastTimer = setTimeout(dismiss, action ? 10000 : 6000);
}

export function shortDate(value) {
  return typeof value === 'string' ? value.replaceAll('-', '.') : '—';
}

export function dayShift(value, days) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function duration(value) {
  if (value === null || value === undefined) return '—';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = value % 60;
  return hours ? `${hours}时 ${minutes}分` : minutes ? `${minutes}分 ${seconds}秒` : `${seconds}秒`;
}

export function completedTime(record) {
  if (!record.completedAt) return '只记录日期';
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: record.timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(record.completedAt));
  } catch {
    return `${record.completedAt.slice(11, 16)} UTC`;
  }
}

export function fillOptions(select, labels, allLabel) {
  const fragment = document.createDocumentFragment();
  if (allLabel) {
    const option = node('option', '', allLabel);
    option.value = '';
    fragment.append(option);
  }
  for (const [value, text] of Object.entries(labels)) {
    const option = node('option', '', text);
    option.value = value;
    fragment.append(option);
  }
  select.replaceChildren(fragment);
}

export function download(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function exportName(extension) {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  return `数独手记-${localDateAt(now)}-${time}.${extension}`;
}
