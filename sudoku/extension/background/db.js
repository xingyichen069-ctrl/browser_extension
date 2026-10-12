import { SCHEMA_VERSION, filterRecords, localDateAt, validateImport, validateRecord } from '../shared/model.js';

const DATABASE = 'sudoku-journal-v1';
const DATABASE_VERSION = 2;
const STORES = ['records', 'trash', 'meta', 'tombstones'];
const MAX_RECORDS = 50_000;
const DAY_MS = 86_400_000;
const TRASH_DAYS = 7;
const TOMBSTONE_DAYS = 30;
let opening;

function storageError(error) {
  if (error?.name === 'QuotaExceededError') {
    return new Error('本地存储空间不足，操作已全部取消。请先导出备份，再清理回收站或释放磁盘空间后重试。');
  }
  if (error?.name === 'AbortError') return new Error('本地数据库操作中止，未保存部分修改。请重试。');
  if (error?.name === 'ConstraintError') return new Error('记录 ID 冲突，操作已全部取消。');
  return error instanceof Error ? error : new Error('本地数据库操作失败，请重试。');
}

function openDatabase() {
  if (opening) return opening;
  const pending = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('当前环境不支持本地数据库，请在 Microsoft Edge 扩展页面中使用。'));
      return;
    }
    const request = indexedDB.open(DATABASE, DATABASE_VERSION);
    let blocked = false;
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) {
        db.createObjectStore('records', { keyPath: 'id' });
        const trash = db.createObjectStore('trash', { keyPath: 'id' });
        const tombstones = db.createObjectStore('tombstones', { keyPath: 'id' });
        const meta = db.createObjectStore('meta', { keyPath: 'key' });
        trash.createIndex('expiresAt', 'expiresAt');
        tombstones.createIndex('expiresAt', 'expiresAt');
        meta.put({ key: 'settings', paused: false });
        meta.put({ key: 'state', installedAt: new Date().toISOString(), lastExportAt: null, revision: 0 });
      }
      // IDB backfills this index transactionally without rewriting user records.
      const records = request.transaction.objectStore('records');
      if (!records.indexNames.contains('localDate')) records.createIndex('localDate', 'localDate');
    };
    request.onerror = () => reject(storageError(request.error));
    request.onblocked = () => {
      blocked = true;
      reject(new Error('本地数据库正被另一个页面占用。请关闭旧的扩展页面后重试。'));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); if (opening === pending) opening = undefined; };
      db.onclose = () => { if (opening === pending) opening = undefined; };
      resolve(db);
    };
  });
  opening = pending;
  pending.catch(() => { if (opening === pending) opening = undefined; });
  return pending;
}

function stateValue(row, now) {
  if (!row) return { installedAt: now, lastExportAt: null, revision: 0 };
  if (typeof row.installedAt !== 'string' || !Number.isFinite(Date.parse(row.installedAt))
      || (row.lastExportAt !== null && (typeof row.lastExportAt !== 'string' || !Number.isFinite(Date.parse(row.lastExportAt))))
      || !Number.isSafeInteger(row.revision) || row.revision < 0) {
    throw new Error('本地数据库元信息损坏，未修改原有记录。');
  }
  return { installedAt: row.installedAt, lastExportAt: row.lastExportAt, revision: row.revision };
}

function settingsValue(row) {
  if (row && typeof row.paused !== 'boolean') throw new Error('本地记录开关数据损坏，未修改原有记录。');
  return { paused: row?.paused ?? false };
}

/** Every callback stays inside IDB's request queue; there is no unrelated awaited IO. */
async function writeTransaction(work) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES, 'readwrite');
    let failure;
    let result;
    let finished = false;
    let aborted = false;
    const nowMs = Date.now();
    const context = {
      tx, nowMs, now: new Date(nowMs).toISOString(), cleaned: false,
      store: (name) => tx.objectStore(name),
      abort(error) {
        if (aborted) return;
        failure = error;
        aborted = true;
        try { tx.abort(); } catch { reject(storageError(error)); }
      },
      request(request, callback) {
        request.onsuccess = () => {
          if (aborted) return;
          try { callback(request.result); } catch (error) { context.abort(error); }
        };
        return request;
      },
      finish(value, changed = false) {
        if (finished) throw new Error('数据库事务重复完成。');
        finished = true;
        if (changed || context.cleaned) {
          context.state.revision = Math.min(context.state.revision + 1, Number.MAX_SAFE_INTEGER);
          context.store('meta').put({ key: 'state', ...context.state });
        }
        result = typeof value === 'function' ? value() : value;
      },
    };
    tx.onerror = (event) => { failure ||= event.target.error; };
    tx.onabort = () => reject(storageError(failure || tx.error));
    tx.oncomplete = () => finished ? resolve(result) : reject(new Error('数据库操作未完成，请重试。'));
    let remaining = 2;
    function prepared() {
      if (--remaining) return;
      cleanupExpired(context, () => work(context));
    }
    context.request(context.store('meta').get('settings'), (row) => {
      context.settings = settingsValue(row);
      if (!row) context.store('meta').put({ key: 'settings', ...context.settings });
      prepared();
    });
    context.request(context.store('meta').get('state'), (row) => {
      context.state = stateValue(row, context.now);
      if (!row) context.store('meta').put({ key: 'state', ...context.state });
      prepared();
    });
  });
}

function cleanupExpired(ctx, ready) {
  let remaining = 2;
  const finish = () => { if (--remaining === 0) ready(); };
  const range = IDBKeyRange.upperBound(ctx.now);
  ctx.request(ctx.store('tombstones').index('expiresAt').openCursor(range), (cursor) => {
    if (!cursor) { finish(); return; }
    cursor.delete();
    ctx.cleaned = true;
    cursor.continue();
  });
  ctx.request(ctx.store('trash').index('expiresAt').openCursor(range), (cursor) => {
    if (!cursor) { finish(); return; }
    const deleted = cursor.value;
    const expiresAt = new Date(Date.parse(deleted.expiresAt) + TOMBSTONE_DAYS * DAY_MS).toISOString();
    if (expiresAt > ctx.now) ctx.store('tombstones').put({ id: deleted.id, expiresAt });
    cursor.delete();
    ctx.cleaned = true;
    cursor.continue();
  });
}

function validateIds(ids) {
  if (!Array.isArray(ids) || ids.length > MAX_RECORDS) throw new Error('请选择不超过 50000 个记录 ID。');
  const result = new Set();
  for (let index = 0; index < ids.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(ids, String(index));
    const id = descriptor?.value;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(id)) {
      throw new Error('记录 ID 无效，未修改任何记录。');
    }
    result.add(id);
  }
  return [...result];
}

function sameRecord(left, right) {
  return JSON.stringify(validateRecord(left)) === JSON.stringify(right);
}

function conflict(id) {
  throw new Error(`记录 ID ${id} 已存在，但内容不同；操作已全部取消。`);
}

function capacityError() {
  throw new Error('记录和回收站合计最多保存 50000 条。请先导出备份并清理回收站，再添加或导入。');
}

function checkCapacity(ctx, extra, ready) {
  ctx.request(ctx.store('records').count(), (active) => {
    ctx.request(ctx.store('trash').count(), (trashed) => {
      if (active + trashed + extra > MAX_RECORDS) capacityError();
      ready();
    });
  });
}

export async function getSettings() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly');
    let settings;
    let failure;
    const request = tx.objectStore('meta').get('settings');
    request.onsuccess = () => {
      try { settings = settingsValue(request.result); }
      catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(settings);
    tx.onabort = () => reject(storageError(failure || tx.error));
    tx.onerror = (event) => { failure ||= event.target.error; };
  });
}

function popupDateBounds(today) {
  if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(today)) {
    throw new Error('统计日期必须使用 YYYY-MM-DD 格式。');
  }
  const [year, month, day] = today.split('-').map(Number);
  const midnight = new Date(0);
  midnight.setUTCFullYear(year, month - 1, day);
  midnight.setUTCHours(0, 0, 0, 0);
  if (year < 1 || midnight.getUTCFullYear() !== year || midnight.getUTCMonth() !== month - 1 || midnight.getUTCDate() !== day) {
    throw new Error('统计日期不是实际存在的日期。');
  }
  return { today, from: new Date(midnight.getTime() - 6 * DAY_MS).toISOString().slice(0, 10) };
}

/** Small popup reads never materialize game records or inspect the recycle bin. */
export async function getPopupSummary(today = localDateAt()) {
  const dates = popupDateBounds(today);
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['records', 'meta'], 'readonly');
    const result = { summary: { total: 0, todayCount: 0, last7Count: 0 }, settings: { paused: false } };
    let failure;
    const records = tx.objectStore('records');
    const index = records.index('localDate');
    const total = records.count();
    const onDay = index.count(IDBKeyRange.only(dates.today));
    const lastSeven = index.count(IDBKeyRange.bound(dates.from, dates.today));
    const settings = tx.objectStore('meta').get('settings');
    total.onsuccess = () => { result.summary.total = total.result; };
    onDay.onsuccess = () => { result.summary.todayCount = onDay.result; };
    lastSeven.onsuccess = () => { result.summary.last7Count = lastSeven.result; };
    settings.onsuccess = () => {
      try { result.settings = settingsValue(settings.result); }
      catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(storageError(failure || tx.error));
    tx.onerror = (event) => { failure ||= event.target.error; };
  });
}

export async function getSnapshot() {
  return writeTransaction((ctx) => {
    ctx.request(ctx.store('records').getAll(), (records) => {
      ctx.request(ctx.store('trash').getAll(), (trash) => {
        const valid = filterRecords(records);
        const deleted = trash.map((row) => {
          const record = validateRecord(row.record);
          if (record.id !== row.id || !Number.isFinite(Date.parse(row.deletedAt)) || !Number.isFinite(Date.parse(row.expiresAt))) {
            throw new Error('回收站记录损坏，未修改原有数据。');
          }
          return { record, deletedAt: row.deletedAt, expiresAt: row.expiresAt };
        }).sort((left, right) => right.deletedAt.localeCompare(left.deletedAt) || left.record.id.localeCompare(right.record.id));
        ctx.finish(() => ({ records: valid, trash: deleted, settings: { ...ctx.settings }, meta: { ...ctx.state } }));
      });
    });
  });
}

export async function addRecord(record, { automatic = false } = {}) {
  const normalized = validateRecord(record);
  if (typeof automatic !== 'boolean' || (automatic && normalized.source !== 'automatic')) {
    throw new Error('自动记录参数无效。');
  }
  return writeTransaction((ctx) => {
    const duplicate = () => ctx.finish({ added: false, duplicate: true, id: normalized.id });
    if (automatic && ctx.settings.paused) {
      ctx.finish({ added: false, duplicate: false, id: normalized.id, paused: true });
      return;
    }
    ctx.request(ctx.store('records').get(normalized.id), (existing) => {
      if (existing) {
        if (!automatic && !sameRecord(existing, normalized)) conflict(normalized.id);
        duplicate();
        return;
      }
      ctx.request(ctx.store('trash').get(normalized.id), (trashed) => {
        if (trashed) {
          if (!automatic && !sameRecord(trashed.record, normalized)) conflict(normalized.id);
          duplicate();
          return;
        }
        ctx.request(ctx.store('tombstones').get(normalized.id), (tombstone) => {
          if (tombstone) { duplicate(); return; }
          checkCapacity(ctx, 1, () => {
            ctx.store('records').add(normalized);
            ctx.finish({ added: true, duplicate: false, id: normalized.id }, true);
          });
        });
      });
    });
  });
}

export async function deleteRecords(ids) {
  const selected = validateIds(ids);
  return writeTransaction((ctx) => {
    let remaining = selected.length;
    let deleted = 0;
    if (!remaining) { ctx.finish({ deleted }); return; }
    for (const id of selected) {
      ctx.request(ctx.store('records').get(id), (record) => {
        if (record) {
          ctx.store('trash').put({ id, record: validateRecord(record), deletedAt: ctx.now, expiresAt: new Date(ctx.nowMs + TRASH_DAYS * DAY_MS).toISOString() });
          ctx.store('records').delete(id);
          ctx.store('tombstones').delete(id);
          deleted += 1;
        }
        if (--remaining === 0) ctx.finish({ deleted }, deleted > 0);
      });
    }
  });
}

export async function restoreRecords(ids) {
  const selected = validateIds(ids);
  return writeTransaction((ctx) => {
    checkCapacity(ctx, 0, () => {
      let remaining = selected.length;
      let restored = 0;
      let skipped = 0;
      let changed = false;
      const next = () => { if (--remaining === 0) ctx.finish({ restored, skipped }, changed); };
      if (!remaining) { ctx.finish({ restored, skipped }); return; }
      for (const id of selected) {
        ctx.request(ctx.store('trash').get(id), (row) => {
          if (!row) { skipped += 1; next(); return; }
          const record = validateRecord(row.record);
          if (record.id !== id) throw new Error('回收站记录 ID 不匹配，未恢复任何记录。');
          ctx.request(ctx.store('records').get(id), (existing) => {
            if (existing && !sameRecord(existing, record)) conflict(id);
            if (existing) skipped += 1;
            else { ctx.store('records').add(record); restored += 1; }
            ctx.store('trash').delete(id);
            ctx.store('tombstones').delete(id);
            changed = true;
            next();
          });
        });
      }
    });
  });
}

export async function purgeRecords(ids) {
  const selected = validateIds(ids);
  return writeTransaction((ctx) => {
    let remaining = selected.length;
    let removed = 0;
    if (!remaining) { ctx.finish({ removed }); return; }
    for (const id of selected) {
      ctx.request(ctx.store('trash').get(id), (row) => {
        if (row) {
          ctx.store('trash').delete(id);
          ctx.store('tombstones').put({ id, expiresAt: new Date(ctx.nowMs + TOMBSTONE_DAYS * DAY_MS).toISOString() });
          removed += 1;
        }
        if (--remaining === 0) ctx.finish({ removed }, removed > 0);
      });
    }
  });
}

export async function mergeRecords(records) {
  const incoming = validateImport({ app: 'sudoku-journal', schemaVersion: SCHEMA_VERSION, records });
  const inputDuplicates = records.length - incoming.length;
  return writeTransaction((ctx) => {
    ctx.request(ctx.store('records').getAll(), (activeRows) => {
      ctx.request(ctx.store('trash').getAll(), (trashRows) => {
        const active = new Map(activeRows.map((row) => [row.id, row]));
        const trash = new Map(trashRows.map((row) => [row.id, row.record]));
        const additions = [];
        let duplicates = inputDuplicates;
        let newIds = 0;
        for (const record of incoming) {
          const existing = active.get(record.id);
          const trashed = trash.get(record.id);
          if (existing) {
            if (!sameRecord(existing, record)) conflict(record.id);
            duplicates += 1;
          } else {
            if (trashed && !sameRecord(trashed, record)) conflict(record.id);
            if (!trashed) newIds += 1;
            additions.push(record);
          }
        }
        if (activeRows.length + trashRows.length + newIds > MAX_RECORDS) capacityError();
        for (const record of additions) {
          ctx.store('records').add(record);
          ctx.store('trash').delete(record.id);
          ctx.store('tombstones').delete(record.id);
        }
        ctx.finish({ added: additions.length, duplicates }, additions.length > 0);
      });
    });
  });
}

export async function setPaused(paused) {
  if (typeof paused !== 'boolean') throw new Error('记录开关必须为布尔值。');
  return writeTransaction((ctx) => {
    const changed = ctx.settings.paused !== paused;
    ctx.settings.paused = paused;
    if (changed) ctx.store('meta').put({ key: 'settings', paused });
    ctx.finish({ paused }, changed);
  });
}

export async function markExport() {
  return writeTransaction((ctx) => {
    ctx.state.lastExportAt = ctx.now;
    ctx.finish({ lastExportAt: ctx.now }, true);
  });
}
