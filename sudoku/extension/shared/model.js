/**
 * Shared, dependency-free data model for Sudoku Journal.
 * Dates are stored as both an actual UTC instant (when known) and the player's
 * calendar date. Calendar arithmetic deliberately avoids local-midnight/DST math.
 */

export const SCHEMA_VERSION = 1;

export const VARIANT_LABELS = Object.freeze({
  classic: '经典数独',
  killer: '杀手数独',
  unknown: '未知类型',
});

export const DIFFICULTY_LABELS = Object.freeze({
  easy: '简单',
  medium: '中等',
  hard: '困难',
  expert: '专家',
  master: '大师',
  extreme: '极限',
  unknown: '未知难度',
});

export const MODE_LABELS = Object.freeze({
  regular: '普通游玩',
  daily: '每日挑战',
  postcards: '明信片活动',
  storybook: '故事活动',
  croco: '首次挑战',
  unknown: '未知模式',
});

const APP = 'sudoku-journal';
const MAX_RECORDS = 50_000;
const DAY_MS = 86_400_000;
const SOURCE_LABELS = Object.freeze({ automatic: '自动记录', manual: '手动补记' });
const RECORD_FIELDS = Object.freeze([
  'id', 'site', 'variant', 'difficulty', 'mode', 'completedAt', 'localDate',
  'timeZone', 'durationSeconds', 'source', 'puzzleKey', 'note',
]);
const FILTER_FIELDS = Object.freeze(['variant', 'difficulty', 'source', 'from', 'to', 'mode']);
const VARIANT_ORDER = Object.keys(VARIANT_LABELS);
const DIFFICULTY_ORDER = Object.keys(DIFFICULTY_LABELS);

function fail(message) {
  throw new TypeError(message);
}

/** Read only own data properties: never invoke an imported object's getters. */
function readObject(raw, label, allowedFields, requiredFields = allowedFields) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${label}必须是对象。`);
  }
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label}包含不支持的对象原型。`);
  }
  const allowed = new Set(allowedFields);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const values = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      fail(`${label}包含不支持的字段。`);
    }
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      fail(`${label}只能包含普通数据字段。`);
    }
    values[key] = descriptor.value;
  }
  for (const key of requiredFields) {
    if (!Object.hasOwn(values, key)) fail(`${label}缺少字段 ${key}。`);
  }
  return values;
}

function textValue(value, label, maximum, { empty = false, multiline = false } = {}) {
  if (typeof value !== 'string' || value.length > maximum || (!empty && value.length === 0)) {
    fail(`${label}必须是${empty ? '不超过' : '1 至'} ${maximum} 个字符的文本。`);
  }
  // Notes may contain ordinary tabs/newlines. Other control characters are not data.
  const prohibited = multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u : /[\u0000-\u001F\u007F]/u;
  if (prohibited.test(value)) fail(`${label}包含不可用的控制字符。`);
  return value;
}

function enumValue(value, labels, label) {
  if (typeof value !== 'string' || !Object.hasOwn(labels, value)) {
    fail(`${label}不是支持的选项。`);
  }
  return value;
}

function calendarDate(value, label = '日期') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    fail(`${label}必须使用 YYYY-MM-DD 格式。`);
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    fail(`${label}不是实际存在的日期。`);
  }
  const midnight = new Date(0);
  // Date.UTC(1, ...) would silently interpret year 1 as 1901.
  midnight.setUTCFullYear(year, month - 1, day);
  midnight.setUTCHours(0, 0, 0, 0);
  return { value, ordinal: midnight.getTime() / DAY_MS };
}

function utcInstant(value, label, now, limitFuture = true) {
  if (typeof value !== 'string') fail(`${label}必须是 UTC 时间文本。`);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u.exec(value);
  if (!match) fail(`${label}必须是以 Z 结尾的 ISO UTC 时间。`);
  const date = calendarDate(match[1], label);
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  const milliseconds = Number((match[5] || '').padEnd(3, '0'));
  if (hours > 23 || minutes > 59 || seconds > 59) fail(`${label}不是有效时间。`);
  const timestamp = date.ordinal * DAY_MS + hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + milliseconds;
  if (limitFuture && timestamp > now + DAY_MS) fail(`${label}不能超过当前时间 24 小时。`);
  return new Date(timestamp).toISOString();
}

function validateRecordAt(raw, now) {
  const record = readObject(raw, '记录', RECORD_FIELDS);
  const id = textValue(record.id, '记录 ID', 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(id)) {
    fail('记录 ID 只能包含字母、数字、点、下划线、冒号和连字符，且以字母或数字开头。');
  }
  if (record.site !== 'sudoku.com') fail('记录网站必须是 sudoku.com。');
  const variant = enumValue(record.variant, VARIANT_LABELS, '数独类型');
  const difficulty = enumValue(record.difficulty, DIFFICULTY_LABELS, '难度');
  const mode = enumValue(record.mode, MODE_LABELS, '游玩模式');
  const source = enumValue(record.source, SOURCE_LABELS, '记录来源');
  let completedAt;
  if (record.completedAt === null) {
    if (source !== 'manual') fail('自动记录必须包含完成时间。');
    completedAt = null;
  } else {
    completedAt = utcInstant(record.completedAt, '完成时间', now);
  }
  const date = calendarDate(record.localDate, '完成日期');
  // Allow the 24-hour clock-skew window in every civil timezone (UTC-12 to UTC+14).
  // Historical localDate remains independent from the current machine's timezone.
  if (date.ordinal > Math.floor((now + DAY_MS + 14 * 3_600_000) / DAY_MS)) {
    fail('完成日期不能远晚于今天。');
  }
  const timeZone = textValue(record.timeZone, '时区', 80);
  if (!/^[A-Za-z0-9_+/:\-]{1,80}$/u.test(timeZone)) {
    fail('时区只能包含 ASCII 字母、数字、下划线、加减号、斜杠和冒号。');
  }
  const durationSeconds = record.durationSeconds;
  if (durationSeconds !== null && (!Number.isSafeInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 604_800)) {
    fail('用时必须为 0 至 604800 的整数秒，或 null（未知）。');
  }
  const puzzleKey = record.puzzleKey === null ? null : textValue(record.puzzleKey, '题目标识', 128);
  if (puzzleKey !== null && !/^[A-Za-z0-9_.:\-]{1,128}$/u.test(puzzleKey)) {
    fail('题目标识只能包含 ASCII 字母、数字、下划线、点、冒号和连字符。');
  }
  const note = textValue(record.note, '备注', 200, { empty: true, multiline: true });
  // Unicode mode treats a valid surrogate pair as one code point, preserving emoji.
  // Reject lone surrogates: JSON escapes each as six bytes, unlike valid user text.
  if (/[\uD800-\uDFFF]/u.test(note)) fail('备注包含不完整的 Unicode 字符，请重新输入该字符。');

  // Explicit whitelist, including property order, makes equality and exports stable.
  return {
    id, site: 'sudoku.com', variant, difficulty, mode, completedAt,
    localDate: date.value, timeZone, durationSeconds, source, puzzleKey, note,
  };
}

/** Validate one record and return a fresh, normalized whitelist object. */
export function validateRecord(raw) {
  return validateRecordAt(raw, Date.now());
}

function normalizeRecords(raw, now = Date.now()) {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) {
    fail('记录列表必须是普通数组。');
  }
  if (raw.length > MAX_RECORDS) fail(`记录列表最多支持 ${MAX_RECORDS} 条记录。`);
  for (const key of Reflect.ownKeys(raw)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= raw.length) {
      fail('记录列表包含不支持的字段。');
    }
  }
  const byId = new Map();
  const result = [];
  for (let index = 0; index < raw.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`第 ${index + 1} 条记录不是普通数据。`);
    let record;
    try {
      record = validateRecordAt(descriptor.value, now);
    } catch (error) {
      fail(`第 ${index + 1} 条记录无效：${error.message}`);
    }
    const previous = byId.get(record.id);
    if (previous) {
      if (RECORD_FIELDS.some((key) => previous[key] !== record[key])) {
        fail(`记录 ID ${record.id} 重复，但内容不同；未导入任何记录。`);
      }
      continue;
    }
    byId.set(record.id, record);
    result.push(record);
  }
  return result;
}

/** Validate the entire envelope before callers persist any part of an import. */
export function validateImport(raw) {
  const envelope = readObject(raw, '备份', ['app', 'schemaVersion', 'exportedAt', 'records'], ['app', 'schemaVersion', 'records']);
  if (envelope.app !== APP) fail('这不是 Sudoku Journal 的备份文件。');
  if (envelope.schemaVersion !== SCHEMA_VERSION) fail('不支持此备份的数据版本。');
  const now = Date.now();
  if (Object.hasOwn(envelope, 'exportedAt')) utcInstant(envelope.exportedAt, '备份导出时间', now);
  return normalizeRecords(envelope.records, now);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRecords(left, right) {
  const byDate = compareText(right.localDate, left.localDate);
  if (byDate) return byDate;
  if (left.completedAt === null && right.completedAt !== null) return 1;
  if (left.completedAt !== null && right.completedAt === null) return -1;
  return compareText(right.completedAt || '', left.completedAt || '') || compareText(left.id, right.id);
}

export function makeExport(records) {
  const now = Date.now();
  return {
    app: APP,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date(now).toISOString(),
    records: normalizeRecords(records, now).sort(compareRecords),
  };
}

/** The date in the device's current timezone, without UTC-date truncation. */
export function localDateAt(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) fail('无法读取无效日期。');
  const year = date.getFullYear();
  if (year < 1 || year > 9999) fail('年份必须介于 0001 与 9999。');
  return `${String(year).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function summarize(records, today = localDateAt()) {
  const reference = calendarDate(today, '统计日期').ordinal;
  const valid = normalizeRecords(records);
  const dayCounts = new Map();
  const groupCounts = new Map();
  let automatic = 0;
  let todayCount = 0;
  let last7Count = 0;
  let totalDurationSeconds = 0;
  let timedCount = 0;
  for (const record of valid) {
    const ordinal = calendarDate(record.localDate).ordinal;
    dayCounts.set(record.localDate, (dayCounts.get(record.localDate) || 0) + 1);
    const group = `${record.variant}:${record.difficulty}`;
    groupCounts.set(group, (groupCounts.get(group) || 0) + 1);
    if (record.source === 'automatic') automatic += 1;
    if (ordinal === reference) todayCount += 1;
    if (ordinal >= reference - 6 && ordinal <= reference) last7Count += 1;
    if (record.durationSeconds !== null) {
      totalDurationSeconds += record.durationSeconds;
      timedCount += 1;
    }
  }
  const byDay = [...dayCounts.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([date, count]) => ({ date, count }));
  const days = byDay.map(({ date }) => calendarDate(date).ordinal).filter((day) => day <= reference);
  const daySet = new Set(days);
  let currentStreak = 0;
  let cursor = daySet.has(reference) ? reference : reference - 1;
  while (daySet.has(cursor)) {
    currentStreak += 1;
    cursor -= 1;
  }
  let bestStreak = 0;
  let run = 0;
  let previous = null;
  for (const day of days) {
    run = previous !== null && day === previous + 1 ? run + 1 : 1;
    bestStreak = Math.max(bestStreak, run);
    previous = day;
  }
  const byGroup = [];
  for (const variant of VARIANT_ORDER) {
    for (const difficulty of DIFFICULTY_ORDER) {
      const count = groupCounts.get(`${variant}:${difficulty}`);
      if (count) byGroup.push({ variant, difficulty, count });
    }
  }
  return {
    total: valid.length,
    automatic,
    manual: valid.length - automatic,
    activeDays: dayCounts.size,
    todayCount,
    last7Count,
    currentStreak,
    bestStreak,
    byDay,
    byGroup,
    totalDurationSeconds,
    timedCount,
  };
}

export function filterRecords(records, filters = {}) {
  const options = readObject(filters, '筛选条件', FILTER_FIELDS, []);
  const enums = { variant: VARIANT_LABELS, difficulty: DIFFICULTY_LABELS, source: SOURCE_LABELS, mode: MODE_LABELS };
  const active = Object.create(null);
  for (const field of FILTER_FIELDS) {
    const value = options[field];
    if (value === undefined || value === null || value === '') continue;
    active[field] = field === 'from' || field === 'to'
      ? calendarDate(value, '筛选日期').value
      : enumValue(value, enums[field], '筛选条件');
  }
  if (active.from && active.to && active.from > active.to) fail('筛选开始日期不能晚于结束日期。');
  return normalizeRecords(records)
    .filter((record) => {
      for (const field of ['variant', 'difficulty', 'source', 'mode']) {
        if (active[field] && record[field] !== active[field]) return false;
      }
      return (!active.from || record.localDate >= active.from) && (!active.to || record.localDate <= active.to);
    })
    .sort(compareRecords);
}

function csvCell(value) {
  let text = value === null ? '' : String(value);
  // Spreadsheet programs may ignore leading whitespace before evaluating formulas.
  if (/^[\s\uFEFF]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u.test(text) || /^[\t\r\n]/u.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

/** UTF-8 BOM + CRLF, with RFC 4180 escaping and Excel formula protection. */
export function toCsv(records) {
  const rows = [[
    '完成日期', '完成时间（UTC）', '数独类型', '难度', '游玩模式', '用时（秒）',
    '记录方式', '时区', '备注', '记录 ID', '网站', '题目标识',
  ]];
  for (const record of filterRecords(records)) {
    rows.push([
      record.localDate, record.completedAt, VARIANT_LABELS[record.variant],
      DIFFICULTY_LABELS[record.difficulty], MODE_LABELS[record.mode], record.durationSeconds,
      SOURCE_LABELS[record.source], record.timeZone, record.note, record.id, record.site, record.puzzleKey,
    ]);
  }
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
