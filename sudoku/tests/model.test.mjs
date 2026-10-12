import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  SCHEMA_VERSION, VARIANT_LABELS, DIFFICULTY_LABELS, MODE_LABELS,
  validateRecord, validateImport, makeExport, localDateAt, summarize, filterRecords, toCsv,
} from '../extension/shared/model.js';

function record(overrides = {}) {
  return {
    id: 'record-1', site: 'sudoku.com', variant: 'classic', difficulty: 'extreme',
    mode: 'regular', completedAt: '2024-03-10T12:34:56.000Z', localDate: '2024-03-10',
    timeZone: 'Asia/Shanghai', durationSeconds: 125, source: 'automatic', puzzleKey: null,
    note: '', ...overrides,
  };
}

function onDate(date, id = date, overrides = {}) {
  return record({ id, localDate: date, completedAt: `${date}T12:00:00.000Z`, ...overrides });
}

function backup(records, overrides = {}) {
  return { app: 'sudoku-journal', schemaVersion: SCHEMA_VERSION, records, ...overrides };
}

test('the public labels cover every supported enum and are immutable', () => {
  assert.deepEqual(Object.keys(VARIANT_LABELS), ['classic', 'killer', 'unknown']);
  assert.deepEqual(Object.keys(DIFFICULTY_LABELS), ['easy', 'medium', 'hard', 'expert', 'master', 'extreme', 'unknown']);
  assert.deepEqual(Object.keys(MODE_LABELS), ['regular', 'daily', 'postcards', 'storybook', 'croco', 'unknown']);
  assert.ok(Object.isFrozen(VARIANT_LABELS));
});

test('event modes remain distinguishable in records, filters and CSV', () => {
  for (const mode of ['postcards', 'storybook', 'croco']) {
    const value = record({ mode });
    assert.equal(validateRecord(value).mode, mode);
    assert.equal(filterRecords([value], { mode }).length, 1);
    assert.ok(toCsv([value]).includes(MODE_LABELS[mode]));
  }
});

test('record validation clones and normalizes UTC instants without changing inputs', () => {
  const original = Object.freeze(record({ completedAt: '2024-03-10T12:34:56Z' }));
  const result = validateRecord(original);
  assert.notEqual(result, original);
  assert.equal(result.completedAt, '2024-03-10T12:34:56.000Z');
  assert.equal(original.completedAt, '2024-03-10T12:34:56Z');
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.deepEqual(Object.keys(result), Object.keys(record()));
});

test('manual date-only records preserve uncertainty; automatic records require a time', () => {
  const historical = record({ source: 'manual', completedAt: null, localDate: '1999-12-31', durationSeconds: null });
  assert.equal(validateRecord(historical).completedAt, null);
  assert.equal(validateRecord(historical).localDate, '1999-12-31');
  assert.throws(() => validateRecord(record({ completedAt: null })), /自动记录/u);
  // A known historic instant does not overwrite a date chosen in another timezone.
  assert.equal(validateRecord(record({ source: 'manual', localDate: '2024-03-11' })).localDate, '2024-03-11');
});

test('real calendar dates reject impossible leap days and out-of-range fields', () => {
  for (const localDate of ['2023-02-29', '1900-02-29', '2024-02-30', '2024-04-31', '2024-13-01', '2024-00-10', '2024-01-00', '0000-01-01', '24-01-01']) {
    assert.throws(() => validateRecord(record({ localDate })), undefined, localDate);
  }
  for (const localDate of ['2000-02-29', '2024-02-29', '0001-01-01']) {
    assert.equal(validateRecord(record({ source: 'manual', completedAt: null, localDate })).localDate, localDate);
  }
  for (const completedAt of ['2023-02-29T12:00:00.000Z', '2024-03-10T24:00:00Z', '2024-03-10T12:60:00Z', '2024-03-10T12:00:60Z', '2024-03-10T12:00:00+08:00', '2024-03-10', 'invalid', 0, NaN, Infinity]) {
    assert.throws(() => validateRecord(record({ completedAt })), undefined, String(completedAt));
  }
});

test('UTC fractions are normalized and ancient years do not become 1900s', () => {
  assert.equal(validateRecord(record({ completedAt: '2024-01-01T00:00:00.1Z' })).completedAt, '2024-01-01T00:00:00.100Z');
  assert.equal(validateRecord(record({ completedAt: '0001-01-01T00:00:00Z' })).completedAt, '0001-01-01T00:00:00.000Z');
});

test('future instants and distant future dates are rejected', () => {
  const future = new Date(Date.now() + 4 * 86_400_000);
  assert.throws(() => validateRecord(record({ completedAt: future.toISOString() })), /24 小时/u);
  assert.throws(() => validateRecord(record({ source: 'manual', completedAt: null, localDate: future.toISOString().slice(0, 10) })), /完成日期/u);
});

test('all enums, IDs, field limits, and numeric boundaries are enforced', () => {
  const invalid = [
    { id: '' }, { id: 'a'.repeat(101) }, { id: 'bad id' }, { id: '=formula' },
    { site: 'other.com' }, { variant: 'constructor' }, { difficulty: 'insane' }, { mode: 'marathon' }, { source: 'external' },
    { timeZone: '' }, { timeZone: 'a'.repeat(81) }, { timeZone: ' UTC' },
    { durationSeconds: -1 }, { durationSeconds: 604801 }, { durationSeconds: 1.5 }, { durationSeconds: Infinity }, { durationSeconds: NaN }, { durationSeconds: '5' },
    { puzzleKey: '' }, { puzzleKey: 'x'.repeat(129) }, { note: 'x'.repeat(201) }, { note: '\0' }, { note: {} },
  ];
  for (const values of invalid) assert.throws(() => validateRecord(record(values)), undefined, JSON.stringify(values));
  assert.equal(validateRecord(record({ durationSeconds: 0 })).durationSeconds, 0);
  assert.equal(validateRecord(record({ durationSeconds: 604800 })).durationSeconds, 604800);
  assert.equal(validateRecord(record({ durationSeconds: null })).durationSeconds, null);
  assert.equal(validateRecord(record({ id: 'a'.repeat(100), note: 'x'.repeat(200), puzzleKey: 'x'.repeat(128) })).id.length, 100);
  const missing = record();
  delete missing.note;
  assert.throws(() => validateRecord(missing), /缺少/u);
});

test('timezone metadata accepts ASCII IANA names and fallbacks but rejects Unicode or unexpected encoding', () => {
  for (const timeZone of ['Asia/Shanghai', 'America/Argentina/Buenos_Aires', 'America/Port-au-Prince', 'Etc/GMT+8', 'UTC+08:00', 'UTC', 'unknown']) {
    assert.equal(validateRecord(record({ timeZone })).timeZone, timeZone);
  }
  for (const timeZone of ['亚洲/上海', 'Europe/París', 'Asia／Shanghai', 'UTC 08', 'UTC\\8', 'UTC"', ' UTC', 'UTC\n', 'UTC@8', 'UTC.0']) {
    assert.throws(() => validateRecord(record({ timeZone })), /时区/u, timeZone);
  }
});

test('puzzle metadata follows the production ASCII identifier format', () => {
  for (const puzzleKey of ['classic:regular:extreme:123', 'killer:daily:hard:ab12-cd34', 'A_z.9:-', 'p'.repeat(128), null]) {
    assert.equal(validateRecord(record({ puzzleKey })).puzzleKey, puzzleKey);
  }
  for (const puzzleKey of ['经典:极限:123', 'classic：regular', 'game/123', 'game%20123', 'game 123', '=evil()', 'game\\123']) {
    assert.throws(() => validateRecord(record({ puzzleKey })), /题目标识/u, puzzleKey);
  }
});

test('notes retain Chinese, complete emoji and safe multiline text while rejecting broken surrogate units', () => {
  for (const note of ['中文备注\n第二行\r\n第三行\t末尾', '汉'.repeat(200), '😀'.repeat(100), '"'.repeat(200), '\\'.repeat(200), '\r\n'.repeat(100), '\u2028'.repeat(200)]) {
    assert.equal(validateRecord(record({ note })).note, note);
    assert.equal(validateImport(makeExport([record({ note })]))[0].note, note);
  }
  for (const note of ['前缀\ud800', '\udc00后缀', '\ud800a\udc00', '\ud800'.repeat(200)]) {
    assert.throws(() => validateRecord(record({ note })), /不完整的 Unicode/u);
    assert.throws(() => validateImport(backup([record({ note })])), /不完整的 Unicode/u);
  }
});

test('50,000 maximal legal records fit the 64 MiB compact backup and import-message limit', () => {
  const longestKey = (labels) => Object.keys(labels).reduce((longest, key) => key.length > longest.length ? key : longest, '');
  // Every other field is unescaped ASCII. Well-formed note text needs at most
  // three UTF-8 bytes per UTF-16 unit; allowed JSON escapes need at most two.
  const maximum = validateRecord(record({
    id: 'i'.repeat(100), variant: longestKey(VARIANT_LABELS), difficulty: longestKey(DIFFICULTY_LABELS),
    mode: longestKey(MODE_LABELS), timeZone: 'T'.repeat(80), puzzleKey: 'p'.repeat(128),
    durationSeconds: 604800, source: 'automatic', note: '汉'.repeat(200),
  }));
  const recordBytes = Buffer.byteLength(JSON.stringify(maximum), 'utf8');
  const emptyBackup = makeExport([]);
  const backupOverhead = Buffer.byteLength(JSON.stringify(emptyBackup), 'utf8');
  const messageOverhead = Buffer.byteLength(JSON.stringify({ type: 'SJ_IMPORT', backup: emptyBackup }), 'utf8');
  const recordsBytes = recordBytes * 50_000 + 49_999; // Array commas; brackets are already in the envelope.
  assert.equal(recordBytes, 1150);
  assert.ok(recordsBytes + backupOverhead < 64 * 1024 * 1024);
  assert.ok(recordsBytes + messageOverhead < 64 * 1024 * 1024);
  assert.deepEqual(validateImport(JSON.parse(JSON.stringify(makeExport([maximum])))), [maximum]);
});

test('prototype pollution, extra executable properties, accessors and symbols are rejected', () => {
  const polluted = JSON.parse(JSON.stringify(record()).replace(/\}$/u, ',"__proto__":{"polluted":true}}'));
  assert.throws(() => validateRecord(polluted), /不支持的字段/u);
  assert.equal({}.polluted, undefined);
  assert.throws(() => validateRecord(Object.assign(Object.create({ polluted: true }), record())), /原型/u);
  assert.throws(() => validateRecord({ ...record(), toJSON() { throw new Error('must not run'); } }), /不支持的字段/u);
  let invoked = false;
  const accessor = record();
  Object.defineProperty(accessor, 'note', { enumerable: true, get() { invoked = true; return ''; } });
  assert.throws(() => validateRecord(accessor), /普通数据/u);
  assert.equal(invoked, false);
  assert.throws(() => validateRecord({ ...record(), [Symbol('hidden')]: 1 }), /不支持的字段/u);
  assert.deepEqual(validateRecord(Object.assign(Object.create(null), record())), record());
});

test('import merges semantically identical IDs and rejects an entire conflicting import', () => {
  const input = backup([record(), record({ completedAt: '2024-03-10T12:34:56Z' }), record({ id: 'other' })]);
  const snapshot = structuredClone(input);
  assert.deepEqual(validateImport(input).map(({ id }) => id), ['record-1', 'other']);
  assert.deepEqual(input, snapshot);
  const conflicted = backup([record({ id: 'first' }), record(), record({ note: 'different' })]);
  assert.throws(() => validateImport(conflicted), /重复.*内容不同/u);
  assert.equal(conflicted.records.length, 3);
  const cloned = validateImport(backup([record()]));
  cloned[0].note = 'changed';
  assert.equal(input.records[0].note, '');
});

test('unknown and damaged import schemas fail before any data is returned', () => {
  for (const input of [null, [], {}, backup([], { app: 'other' }), backup([], { schemaVersion: 2 }), backup([], { schemaVersion: '1' }), backup(null), backup([], { extra: 'script' }), backup([], { exportedAt: 'not-a-date' })]) {
    assert.throws(() => validateImport(input));
  }
  assert.throws(() => validateImport(backup(new Array(50_001))), /50000/u);
  assert.throws(() => validateImport(backup(new Array(1))), /普通数据/u);
  let invoked = false;
  const records = [record()];
  Object.defineProperty(records, '0', { get() { invoked = true; return record(); } });
  assert.throws(() => validateImport(backup(records)), /普通数据/u);
  assert.equal(invoked, false);
  const customized = [record()];
  customized.toJSON = () => 'no';
  assert.throws(() => validateImport(backup(customized)), /不支持的字段/u);
});

test('exports round-trip and sort deterministically without mutating the input', () => {
  const records = [onDate('2024-01-01', 'b'), onDate('2024-01-02', 'a')];
  const before = structuredClone(records);
  const result = makeExport(records);
  assert.equal(result.app, 'sudoku-journal');
  assert.equal(result.schemaVersion, 1);
  assert.match(result.exportedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.deepEqual(result.records.map(({ id }) => id), ['a', 'b']);
  assert.deepEqual(validateImport(JSON.parse(JSON.stringify(result))), result.records);
  assert.deepEqual(records, before);
});

test('empty summaries have zeros and no phantom streaks or timing samples', () => {
  assert.deepEqual(summarize([], '2024-01-01'), {
    total: 0, automatic: 0, manual: 0, activeDays: 0, todayCount: 0, last7Count: 0,
    currentStreak: 0, bestStreak: 0, byDay: [], byGroup: [], totalDurationSeconds: 0, timedCount: 0,
  });
});

test('summaries count games, active dates, groups, inclusive weeks and known durations separately', () => {
  const records = [
    onDate('2023-12-25', 'old', { durationSeconds: null }),
    onDate('2023-12-26', 'edge', { durationSeconds: 10, difficulty: 'easy' }),
    onDate('2023-12-31', 'eve', { source: 'manual', completedAt: null, durationSeconds: null }),
    onDate('2024-01-01', 'first', { variant: 'killer', difficulty: 'hard', mode: 'daily', durationSeconds: 0 }),
    onDate('2024-01-01', 'second', { durationSeconds: 30 }),
  ];
  const result = summarize(records, '2024-01-01');
  assert.equal(result.total, 5);
  assert.equal(result.automatic, 4);
  assert.equal(result.manual, 1);
  assert.equal(result.activeDays, 4);
  assert.equal(result.todayCount, 2);
  assert.equal(result.last7Count, 4);
  assert.equal(result.currentStreak, 2);
  assert.equal(result.bestStreak, 2);
  assert.equal(result.totalDurationSeconds, 40);
  assert.equal(result.timedCount, 3);
  assert.deepEqual(result.byGroup, [
    { variant: 'classic', difficulty: 'easy', count: 1 },
    { variant: 'classic', difficulty: 'extreme', count: 3 },
    { variant: 'killer', difficulty: 'hard', count: 1 },
  ]);
  assert.deepEqual(result.byDay.map(({ date }) => date), ['2023-12-25', '2023-12-26', '2023-12-31', '2024-01-01']);
});

test('a streak can end yesterday, crosses years and leap days, but expires after a gap', () => {
  const year = [onDate('2023-12-30'), onDate('2023-12-31'), onDate('2024-01-01')];
  assert.equal(summarize(year, '2024-01-01').currentStreak, 3);
  assert.equal(summarize(year, '2024-01-02').currentStreak, 3);
  assert.equal(summarize(year, '2024-01-03').currentStreak, 0);
  assert.equal(summarize(year, '2024-01-03').bestStreak, 3);
  const leap = ['2024-02-28', '2024-02-29', '2024-03-01'].map((date) => onDate(date));
  assert.equal(summarize(leap, '2024-03-01').currentStreak, 3);
});

test('DST changes do not split a consecutive calendar streak', () => {
  for (const dates of [
    ['2024-03-09', '2024-03-10', '2024-03-11'],
    ['2024-11-02', '2024-11-03', '2024-11-04'],
  ]) {
    const result = summarize(dates.map((date) => onDate(date, date, { timeZone: 'America/New_York' })), dates[2]);
    assert.equal(result.currentStreak, 3);
    assert.equal(result.bestStreak, 3);
  }
});

test('future dates relative to the report cannot inflate streaks or the last seven days', () => {
  const records = ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04'].map((date) => onDate(date));
  const result = summarize(records, '2024-01-02');
  assert.equal(result.total, 4);
  assert.equal(result.last7Count, 2);
  assert.equal(result.currentStreak, 2);
  assert.equal(result.bestStreak, 2);
  assert.equal(summarize([onDate('2024-01-04')], '2024-01-02').currentStreak, 0);
});

test('localDateAt uses the local date on both sides of UTC midnight and validates input', () => {
  const date = new Date(2024, 1, 29, 23, 59, 59);
  assert.equal(localDateAt(date), '2024-02-29');
  assert.throws(() => localDateAt(new Date(NaN)), /无效日期/u);
  assert.throws(() => localDateAt('2024-01-01'), /无效日期/u);
  const moduleUrl = new URL('../extension/shared/model.js', import.meta.url).href;
  const script = `import { localDateAt } from ${JSON.stringify(moduleUrl)}; process.stdout.write(localDateAt(new Date('2024-01-01T01:00:00Z')));`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(output, '2023-12-31');
});

test('filters combine fields with inclusive date bounds and stable date-only ordering', () => {
  const records = [
    onDate('2024-01-02', 'manual-z', { source: 'manual', completedAt: null }),
    onDate('2024-01-01', 'old'),
    onDate('2024-01-02', 'manual-a', { source: 'manual', completedAt: null }),
    onDate('2024-01-02', 'late', { completedAt: '2024-01-02T20:00:00.000Z' }),
    onDate('2024-01-02', 'early', { mode: 'daily' }),
    onDate('2024-01-03', 'killer', { variant: 'killer', difficulty: 'hard' }),
  ];
  const before = structuredClone(records);
  assert.deepEqual(filterRecords(records).map(({ id }) => id), ['killer', 'late', 'early', 'manual-a', 'manual-z', 'old']);
  assert.deepEqual(filterRecords(records, { variant: 'classic', difficulty: 'extreme', source: 'automatic', mode: 'daily', from: '2024-01-02', to: '2024-01-02' }).map(({ id }) => id), ['early']);
  assert.equal(filterRecords(records, { from: '', source: null }).length, 6);
  assert.deepEqual(records, before);
  assert.throws(() => filterRecords(records, { from: '2024-02-30' }));
  assert.throws(() => filterRecords(records, { from: '2024-02-01', to: '2024-01-01' }));
  assert.throws(() => filterRecords(records, { variant: 'all' }));
});

test('CSV uses a BOM and CRLF, escapes quotes/newlines, and retains unknown time as an empty cell', () => {
  const csv = toCsv([record({ source: 'manual', completedAt: null, durationSeconds: null, note: '一行, "引号"\n第二行' })]);
  assert.ok(csv.startsWith('\uFEFF完成日期,完成时间（UTC）,数独类型'));
  assert.ok(csv.endsWith('\r\n'));
  assert.ok(csv.includes('\r\n2024-03-10,,经典数独,极限,普通游玩,,手动补记,'));
  assert.ok(csv.includes('"一行, ""引号""\n第二行"'));
  assert.equal(toCsv([]).split('\r\n').length, 2);
});

test('CSV guards Excel formulas including whitespace, fullwidth signs, and puzzle keys', () => {
  for (const note of ['=1+1', '+SUM(1)', '-1+2', '@SUM(A1)', '  =1+1', '\t=1+1', '\r=1+1', '\ntext', '＝1+1', '＋1+1', '－1+1', '＠SUM(A1)']) {
    const csv = toCsv([record({ note, puzzleKey: '-1' })]);
    const escapedNote = /[",\r\n]/u.test(`'${note}`) ? `"'${note.replace(/"/gu, '""')}"` : `'${note}`;
    assert.ok(csv.includes(escapedNote), JSON.stringify(note));
    assert.ok(csv.includes(",'-1\r\n"));
  }
});

test('the 50,000-record boundary is enforced before duplicate merging', () => {
  const one = record();
  assert.equal(validateImport(backup(Array(50_000).fill(one))).length, 1);
  assert.throws(() => validateImport(backup(Array(50_001).fill(one))), /50000/u);
});
