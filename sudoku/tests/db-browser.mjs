/**
 * Real IndexedDB integration tests in an isolated headless Edge profile.
 * Run: node --test tests/db-browser.mjs
 * Playwright must be available to require(), e.g. through the bundled NODE_PATH.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const files = new Map([
  ['/extension/background/db.js', new URL('../extension/background/db.js', import.meta.url)],
  ['/extension/shared/model.js', new URL('../extension/shared/model.js', import.meta.url)],
]);
let server;
let browser;
let origin;

before(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('<!doctype html><meta charset="utf-8"><title>Offline Sudoku Journal DB Test</title>');
      return;
    }
    const file = files.get(url.pathname);
    if (!file) { response.writeHead(404); response.end(); return; }
    try {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(await readFile(file));
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function isolated(run) {
  const context = await browser.newContext();
  await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  try {
    await page.goto(origin);
    await page.evaluate(async () => {
      const db = await import('/extension/background/db.js');
      const assert = (value, message = 'assertion failed') => { if (!value) throw new Error(message); };
      const equal = (actual, expected) => assert(JSON.stringify(actual) === JSON.stringify(expected), `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      const rejects = async (work, message) => {
        try { await work(); }
        catch (error) { assert(error.message.includes(message), `Wrong rejection: ${error.message}`); return error; }
        throw new Error(`Expected rejection containing: ${message}`);
      };
      const record = (id, overrides = {}) => ({
        id, site: 'sudoku.com', variant: 'classic', difficulty: 'extreme', mode: 'regular',
        completedAt: '2024-03-10T12:34:56.000Z', localDate: '2024-03-10', timeZone: 'Asia/Shanghai',
        durationSeconds: 125, source: 'automatic', puzzleKey: 'game-1', note: 'private note', ...overrides,
      });
      const raw = async (work, mode = 'readwrite') => {
        const connection = await new Promise((resolve, reject) => {
          const request = indexedDB.open('sudoku-journal-v1');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return new Promise((resolve, reject) => {
          const tx = connection.transaction(['records', 'trash', 'meta', 'tombstones'], mode);
          let result;
          tx.oncomplete = () => { connection.close(); resolve(result); };
          tx.onabort = () => { connection.close(); reject(tx.error); };
          work(tx, (value) => { result = value; });
        });
      };
      const rows = (name) => raw((tx, done) => {
        const request = tx.objectStore(name).getAll();
        request.onsuccess = () => done(request.result);
      }, 'readonly');
      const count = (name) => raw((tx, done) => {
        const request = tx.objectStore(name).count();
        request.onsuccess = () => done(request.result);
      }, 'readonly');
      const clock = (milliseconds) => { Date.now = () => milliseconds; };
      window.dbTest = { db, assert, equal, rejects, record, raw, rows, count, clock, DAY: 86_400_000 };
    });
    return await run(page);
  } finally { await context.close(); }
}

test('first open initializes settings and metadata without an install event', async () => {
  const result = await isolated((page) => page.evaluate(async () => {
    const { db, equal, assert, rows } = window.dbTest;
    equal(await db.getSettings(), { paused: false });
    const snapshot = await db.getSnapshot();
    equal(snapshot.records, []);
    equal(snapshot.trash, []);
    equal(snapshot.settings, { paused: false });
    assert(Number.isFinite(Date.parse(snapshot.meta.installedAt)));
    equal(snapshot.meta.lastExportAt, null);
    equal(snapshot.meta.revision, 0);
    assert((await rows('meta')).length === 2);
    return Object.keys(db);
  }));
  assert.deepEqual(result.sort(), ['addRecord', 'deleteRecords', 'getSettings', 'getPopupSummary', 'getSnapshot', 'markExport', 'mergeRecords', 'purgeRecords', 'restoreRecords', 'setPaused'].sort());
});

test('popup summary initializes an empty database without materializing records', async () => {
  await isolated((page) => page.evaluate(async () => {
    const { db, equal } = window.dbTest;
    const replacements = [];
    for (const prototype of [IDBObjectStore.prototype, IDBIndex.prototype]) {
      for (const method of ['getAll', 'getAllKeys', 'openCursor', 'openKeyCursor']) {
        const original = prototype[method];
        replacements.push(() => { prototype[method] = original; });
        prototype[method] = () => { throw new Error('Popup must not materialize records or scan a cursor.'); };
      }
    }
    try {
      equal(await db.getPopupSummary(), { summary: { total: 0, todayCount: 0, last7Count: 0 }, settings: { paused: false } });
    } finally { replacements.forEach((restore) => restore()); }
  }));
});

test('popup summary counts inclusive seven-day boundaries across DST and year changes, and includes paused state', async () => {
  for (const dates of [
    ['2024-03-03', '2024-03-04', '2024-03-09', '2024-03-10', '2024-03-11'],
    ['2023-12-25', '2023-12-26', '2023-12-31', '2024-01-01', '2024-01-02'],
  ]) {
    await isolated((page) => page.evaluate(async (dates) => {
      const { db, record, equal } = window.dbTest;
      await db.mergeRecords(dates.map((localDate, index) => record(`day-${index}`, { localDate, timeZone: 'America/New_York' })));
      equal(await db.getPopupSummary(dates[3]), { summary: { total: 5, todayCount: 1, last7Count: 3 }, settings: { paused: false } });
      await db.setPaused(true);
      equal(await db.getPopupSummary(dates[3]), { summary: { total: 5, todayCount: 1, last7Count: 3 }, settings: { paused: true } });
      await db.deleteRecords(['day-1']);
      equal(await db.getPopupSummary(dates[3]), { summary: { total: 4, todayCount: 1, last7Count: 2 }, settings: { paused: true } });
    }, dates));
  }
});

test('popup summary rejects malformed and impossible calendar dates', async () => {
  await isolated((page) => page.evaluate(async () => {
    const { db, equal, rejects } = window.dbTest;
    for (const today of ['2024-02-30', '2023-02-29', '1900-02-29', '2024-13-01', '2024-00-01', '2024-01-00', '0000-01-01', '2024-1-01', '2024-01-01T00:00:00Z', '', null, 42, {}]) {
      await rejects(() => db.getPopupSummary(today), '统计日期');
    }
    for (const today of ['2000-02-29', '2024-02-29', '0001-01-01']) {
      equal((await db.getPopupSummary(today)).summary, { total: 0, todayCount: 0, last7Count: 0 });
    }
  }));
});

test('upgrading a version-1 database backfills the date index and preserves every store and metadata', async () => {
  await isolated((page) => page.evaluate(async () => {
    const { db, record, equal, assert, rows, raw, DAY } = window.dbTest;
    const legacyRecords = [record('legacy-a'), record('legacy-b', { localDate: '2024-03-03' })];
    const legacyTrash = { id: 'legacy-trash', record: record('legacy-trash'), deletedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * DAY).toISOString() };
    const legacyTombstone = { id: 'legacy-tombstone', expiresAt: new Date(Date.now() + 30 * DAY).toISOString() };
    const legacyMeta = [
      { key: 'settings', paused: true },
      { key: 'state', installedAt: '2024-01-01T00:00:00.000Z', lastExportAt: '2024-02-01T00:00:00.000Z', revision: 17 },
    ];
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('sudoku-journal-v1', 1);
      request.onupgradeneeded = () => {
        const old = request.result;
        const active = old.createObjectStore('records', { keyPath: 'id' });
        const trash = old.createObjectStore('trash', { keyPath: 'id' });
        const tombstones = old.createObjectStore('tombstones', { keyPath: 'id' });
        const meta = old.createObjectStore('meta', { keyPath: 'key' });
        trash.createIndex('expiresAt', 'expiresAt');
        tombstones.createIndex('expiresAt', 'expiresAt');
        legacyRecords.forEach((value) => active.add(value));
        trash.add(legacyTrash);
        tombstones.add(legacyTombstone);
        legacyMeta.forEach((value) => meta.add(value));
      };
      request.onsuccess = () => {
        const old = request.result;
        assert(old.version === 1);
        assert(!old.transaction('records').objectStore('records').indexNames.contains('localDate'));
        old.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    equal(await db.getPopupSummary('2024-03-10'), { summary: { total: 2, todayCount: 1, last7Count: 1 }, settings: { paused: true } });
    const version = await raw((tx, done) => done({ version: tx.db.version, index: tx.objectStore('records').index('localDate').keyPath }), 'readonly');
    equal(version, { version: 2, index: 'localDate' });
    equal(await rows('records'), legacyRecords);
    equal(await rows('trash'), [legacyTrash]);
    equal(await rows('tombstones'), [legacyTombstone]);
    equal(await rows('meta'), legacyMeta);
    await db.addRecord(record('after-upgrade', { source: 'manual', completedAt: null }));
    equal((await db.getPopupSummary('2024-03-10')).summary, { total: 3, todayCount: 2, last7Count: 2 });
  }));
});

test('adds resolve only after commit, and concurrent retries produce one record', async () => {
  await isolated((page) => page.evaluate(async () => {
    const { db, record, equal, assert, count } = window.dbTest;
    await db.getSettings();
    const native = IDBDatabase.prototype.transaction;
    let completed = 0;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = native.apply(this, args);
      if (args[1] === 'readwrite') tx.addEventListener('complete', () => { completed += 1; });
      return tx;
    };
    equal(await db.addRecord(record('one')), { added: true, duplicate: false, id: 'one' });
    assert(completed === 1, 'returned before transaction complete');
    IDBDatabase.prototype.transaction = native;
    const results = await Promise.all(Array.from({ length: 12 }, () => db.addRecord(record('race'), { automatic: true })));
    equal(results.filter((result) => result.added).length, 1);
    equal(results.filter((result) => result.duplicate).length, 11);
    equal(await count('records'), 2);
  }));
});

test('pause is checked atomically and still permits intentional manual entries', async () => {
  await isolated((page) => page.evaluate(async () => {
    const { db, record, equal, rejects } = window.dbTest;
    equal(await db.setPaused(true), { paused: true });
    equal(await db.getSettings(), { paused: true });
    equal(await db.addRecord(record('auto'), { automatic: true }), { added: false, duplicate: false, id: 'auto', paused: true });
    equal((await db.addRecord(record('manual', { source: 'manual', completedAt: null }))).added, true);
    await db.setPaused(false);
    equal((await db.addRecord(record('auto'), { automatic: true })).added, true);
    await rejects(() => db.setPaused('false'), '布尔值');
    equal((await db.getSnapshot()).records.length, 2);
  }));
});

test('soft deletion is idempotent, blocks retry resurrection, and can be restored', async () => {
  await isolated((page) => page.evaluate(async () => {
    const { db, record, equal, rows, DAY } = window.dbTest;
    await db.addRecord(record('one'));
    equal(await db.deleteRecords(['one', 'one', 'missing']), { deleted: 1 });
    const snapshot = await db.getSnapshot();
    equal(snapshot.records.length, 0);
    equal(snapshot.trash.length, 1);
    equal(Date.parse(snapshot.trash[0].expiresAt) - Date.parse(snapshot.trash[0].deletedAt), 7 * DAY);
    equal(await db.addRecord(record('one', { durationSeconds: 126 }), { automatic: true }), { added: false, duplicate: true, id: 'one' });
    equal(await db.deleteRecords(['one']), { deleted: 0 });
    equal(await db.restoreRecords(['one', 'missing']), { restored: 1, skipped: 1 });
    equal((await rows('trash')).length, 0);
    equal((await rows('tombstones')).length, 0);
    equal((await db.getSnapshot()).records[0].durationSeconds, 125);
  }));
});

test('permanent deletion leaves only a short-lived ID, and never purges active rows', async () => {
  await isolated((page) => page.evaluate(async () => {
    const { db, record, equal, rows, assert } = window.dbTest;
    await db.mergeRecords([record('deleted'), record('active')]);
    await db.deleteRecords(['deleted']);
    equal(await db.purgeRecords(['deleted', 'active']), { removed: 1 });
    equal((await rows('records')).map(({ id }) => id), ['active']);
    const tombstones = await rows('tombstones');
    equal(Object.keys(tombstones[0]).sort(), ['expiresAt', 'id']);
    assert(!JSON.stringify(tombstones).includes('private note'));
    equal((await db.addRecord(record('deleted'), { automatic: true })).duplicate, true);
    equal(await db.mergeRecords([record('deleted')]), { added: 1, duplicates: 0 });
    equal((await rows('tombstones')).length, 0);
    equal((await db.getSnapshot()).records.length, 2);
  }));
});

test('imports normalize duplicates and roll back all work on any content conflict', async () => {
  await isolated((page) => page.evaluate(async () => {
    const { db, record, equal, rejects, rows } = window.dbTest;
    const input = [record('same'), record('same', { completedAt: '2024-03-10T12:34:56Z' })];
    const unchanged = JSON.stringify(input);
    equal(await db.mergeRecords(input), { added: 1, duplicates: 1 });
    equal(JSON.stringify(input), unchanged);
    equal(await db.mergeRecords([record('same')]), { added: 0, duplicates: 1 });
    await rejects(() => db.mergeRecords([record('new'), record('same', { note: 'changed' })]), '内容不同');
    equal((await rows('records')).map(({ id }) => id), ['same']);
    await db.deleteRecords(['same']);
    await rejects(() => db.mergeRecords([record('new'), record('same', { note: 'changed' })]), '内容不同');
    equal((await rows('records')).length, 0);
    equal((await rows('trash')).length, 1);
    equal(await db.mergeRecords([record('same')]), { added: 1, duplicates: 0 });
    equal((await rows('trash')).length, 0);
  }));
});

test('trash and tombstone expiration uses exact boundaries and does not run a timer', async () => {
  await isolated((page) => page.evaluate(async () => {
    const { db, record, equal, rows, clock, DAY } = window.dbTest;
    const start = Date.now();
    clock(start);
    await db.addRecord(record('expired'));
    await db.deleteRecords(['expired']);
    clock(start + 7 * DAY - 1);
    equal((await db.getSnapshot()).trash.length, 1);
    clock(start + 7 * DAY);
    equal((await db.getSnapshot()).trash.length, 0);
    const tombstone = (await rows('tombstones'))[0];
    equal(tombstone.expiresAt, new Date(start + 37 * DAY).toISOString());
    equal((await db.addRecord(record('expired'), { automatic: true })).duplicate, true);
    clock(start + 37 * DAY);
    equal((await db.getSnapshot()).trash.length, 0);
    equal((await rows('tombstones')).length, 0);
    equal((await db.addRecord(record('expired'), { automatic: true })).added, true);
  }));
});

test('opening after a long absence does not restart a deleted record retention window', async () => {
  await isolated((page) => page.evaluate(async () => {
    const { db, record, equal, rows, clock, DAY } = window.dbTest;
    const start = Date.now();
    clock(start);
    await db.addRecord(record('old'));
    await db.deleteRecords(['old']);
    clock(start + 50 * DAY);
    equal((await db.getSnapshot()).trash.length, 0);
    equal((await rows('tombstones')).length, 0);
  }));
});

test('permanent tombstones expire after 30 days and repeated purge does not extend them', async () => {
  await isolated((page) => page.evaluate(async () => {
    const { db, record, equal, rows, clock, DAY } = window.dbTest;
    const start = Date.now();
    clock(start);
    await db.addRecord(record('gone'));
    await db.deleteRecords(['gone']);
    await db.purgeRecords(['gone']);
    const expiry = (await rows('tombstones'))[0].expiresAt;
    equal(expiry, new Date(start + 30 * DAY).toISOString());
    clock(start + 10 * DAY);
    equal(await db.purgeRecords(['gone']), { removed: 0 });
    equal((await rows('tombstones'))[0].expiresAt, expiry);
    clock(start + 30 * DAY);
    equal((await db.addRecord(record('gone'), { automatic: true })).added, true);
  }));
});

test('capacity includes trash, cannot be bypassed by deletion, and fails imports atomically', async () => {
  await isolated((page) => page.evaluate(async () => {
    const { db, record, equal, rejects, raw, count, DAY } = window.dbTest;
    await db.getSettings();
    const now = Date.now();
    await raw((tx) => {
      const active = tx.objectStore('records');
      for (let index = 0; index < 49_999; index += 1) active.add(record(`seed-${index}`));
      tx.objectStore('trash').add({ id: 'trashed', record: record('trashed'), deletedAt: new Date(now).toISOString(), expiresAt: new Date(now + 7 * DAY).toISOString() });
    });
    await rejects(() => db.addRecord(record('overflow')), '回收站合计最多保存 50000');
    await rejects(() => db.mergeRecords([record('seed-0'), record('overflow')]), '回收站合计最多保存 50000');
    equal(await count('records'), 49_999);
    equal(await db.restoreRecords(['trashed']), { restored: 1, skipped: 0 });
    equal(await count('records'), 50_000);
    await db.deleteRecords(['seed-0']);
    await rejects(() => db.addRecord(record('overflow')), '回收站合计最多保存 50000');
    await db.purgeRecords(['seed-0']);
    equal((await db.addRecord(record('overflow'))).added, true);
    equal(await count('records'), 50_000);
  }));
});

test('quota failures report Chinese guidance and roll back already queued inserts', async () => {
  await isolated((page) => page.evaluate(async () => {
    const { db, record, equal, rejects, rows } = window.dbTest;
    await db.getSettings();
    const native = IDBObjectStore.prototype.add;
    let calls = 0;
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'records' && ++calls === 2) throw new DOMException('Simulated quota failure', 'QuotaExceededError');
      return native.apply(this, args);
    };
    try { await rejects(() => db.mergeRecords([record('first'), record('second')]), '本地存储空间不足'); }
    finally { IDBObjectStore.prototype.add = native; }
    equal((await rows('records')).length, 0);
    equal((await db.getSnapshot()).meta.revision, 0);
  }));
});

test('request failures after the result is prepared still reject and roll back the transaction', async () => {
  await isolated((page) => page.evaluate(async () => {
    const { db, record, equal, rejects, rows } = window.dbTest;
    await db.getSettings();
    const native = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args) {
      const request = native.apply(this, args);
      if (this.name === 'records') native.apply(this, args);
      return request;
    };
    try { await rejects(() => db.addRecord(record('late-abort')), '记录 ID 冲突'); }
    finally { IDBObjectStore.prototype.add = native; }
    equal((await rows('records')).length, 0);
    equal((await db.getSnapshot()).meta.revision, 0);
  }));
});

test('a failed import also rolls back lazy cleanup performed in that transaction', async () => {
  await isolated((page) => page.evaluate(async () => {
    const { db, record, equal, rejects, rows, clock, DAY } = window.dbTest;
    const start = Date.now();
    clock(start);
    await db.mergeRecords([record('expired'), record('existing')]);
    await db.deleteRecords(['expired']);
    clock(start + 8 * DAY);
    await rejects(() => db.mergeRecords([record('new'), record('existing', { note: 'conflict' })]), '内容不同');
    equal((await rows('trash')).length, 1);
    equal((await rows('tombstones')).length, 0);
    equal((await rows('records')).map(({ id }) => id), ['existing']);
    equal((await db.getSnapshot()).trash.length, 0);
    equal((await rows('tombstones')).length, 1);
  }));
});

test('export metadata persists, snapshots are independent, and invalid batches do not partly delete', async () => {
  await isolated((page) => page.evaluate(async () => {
    const { db, record, equal, rejects, assert } = window.dbTest;
    await db.addRecord(record('safe'));
    const before = await db.getSnapshot();
    const mark = await db.markExport();
    const after = await db.getSnapshot();
    equal(after.meta.lastExportAt, mark.lastExportAt);
    assert(after.meta.revision > before.meta.revision);
    before.records[0].note = 'changed externally';
    equal(after.records[0].note, 'private note');
    await rejects(() => db.deleteRecords(['safe', '=invalid']), '记录 ID 无效');
    equal((await db.getSnapshot()).records.length, 1);
  }));
});
