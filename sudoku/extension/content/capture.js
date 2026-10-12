/* Isolated content world: successful attempts -> idempotent local transactions. */
(() => {
  'use strict';
  if (window !== window.top) return;
  const CHANNEL = 'sudoku-journal-v1';
  const SESSION_KEY = '__sudoku_journal_session_v1';
  const VARIANTS = new Set(['classic', 'killer', 'unknown']);
  const DIFFICULTIES = new Set(['easy', 'medium', 'hard', 'expert', 'master', 'extreme', 'unknown']);
  const MODES = new Set(['regular', 'daily', 'postcards', 'storybook', 'croco', 'unknown']);
  let attempt = null, pending = [], paused = false, ready = false, broken = false;
  let latest = null, flushing = false, retryTimer = null, retryCount = 0, writeWarning = false;
  let phase = 'waiting', message = '正在连接数独页面…';
  let ownerTabId = null, quarantined = [], invalidSession = false, earlyInteraction = null;
  let unrecognizedRaw = null, sessionRaw = null;

  function validAttempt(value) {
    if (!value || typeof value.id !== 'string' || !/^auto:[\w-]{1,90}$/.test(value.id)
      || typeof value.puzzleKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.puzzleKey)
      || value.armed !== true || typeof value.saved !== 'boolean' || typeof value.completed !== 'boolean'
      || (value.saved && !value.completed) || !(value.winningSeconds === null || (Number.isInteger(value.winningSeconds) && value.winningSeconds >= 0 && value.winningSeconds <= 604800))) return null;
    return { id: value.id, puzzleKey: value.puzzleKey, armed: true, saved: value.saved, completed: value.completed,
      winningSeconds: value.winningSeconds, restartSeen: value.restartSeen === true };
  }

  function safePending(value) {
    const fields = ['id','site','variant','difficulty','mode','completedAt','localDate','timeZone','durationSeconds','source','puzzleKey','note'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length
      || fields.some(field => !Object.hasOwn(value, field)) || typeof value.id !== 'string' || !/^auto:[\w-]{1,90}$/.test(value.id)
      || value.site !== 'sudoku.com' || value.source !== 'automatic' || !VARIANTS.has(value.variant)
      || !DIFFICULTIES.has(value.difficulty) || !MODES.has(value.mode) || typeof value.completedAt !== 'string'
      || !Number.isFinite(Date.parse(value.completedAt)) || typeof value.localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.localDate)
      || typeof value.timeZone !== 'string' || value.timeZone.length > 80 || typeof value.note !== 'string' || value.note.length > 200
      || !(value.puzzleKey === null || (typeof value.puzzleKey === 'string' && value.puzzleKey.length <= 128))
      || !(value.durationSeconds === null || (Number.isInteger(value.durationSeconds) && value.durationSeconds >= 0 && value.durationSeconds <= 604800))) return null;
    return Object.fromEntries(fields.map(field => [field, value[field]]));
  }

  function quarantine(value, reason) {
    let record = value;
    try { if (JSON.stringify(value).length > 20000) record = { id: String(value?.id || '').slice(0, 100), truncated: true }; }
    catch { record = { unreadable: true }; }
    quarantined.push({ record, reason: String(reason).slice(0, 200) });
    if (quarantined.length > 20) { quarantined.shift(); invalidSession = true; }
  }

  try {
    const raw = sessionRaw = sessionStorage.getItem(SESSION_KEY);
    if (raw && raw.length <= 1_000_000) {
      const restored = JSON.parse(raw);
      if (restored?.version === 1) {
        ownerTabId = Number.isInteger(restored.tabId) ? restored.tabId : null;
        attempt = validAttempt(restored.attempt);
        invalidSession = restored.invalidSession === true || (!!restored.attempt && !attempt);
        if (Array.isArray(restored.quarantined)) quarantined = restored.quarantined.slice(0, 20);
        if (Array.isArray(restored.pending)) {
          if (restored.pending.length > 1000) invalidSession = true;
          for (const candidate of restored.pending.slice(0, 1000)) {
            const record = safePending(candidate);
            if (record) pending.push(record); else quarantine(candidate, '暂存记录格式损坏，已隔离。');
          }
        } else if (restored.pending !== undefined) { invalidSession = true; quarantine(restored.pending, '待保存队列格式损坏。'); }
      } else { unrecognizedRaw = raw; invalidSession = true; writeWarning = true; }
    } else if (raw) { unrecognizedRaw = raw; invalidSession = true; writeWarning = true; }
  } catch { unrecognizedRaw = sessionRaw; invalidSession = !!sessionRaw; writeWarning = true; }

  function persist() {
    // Preserve an unknown/newer/oversized session verbatim until the user exports it.
    if (unrecognizedRaw !== null) return;
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ version: 1, tabId: ownerTabId, attempt, pending, quarantined, invalidSession })); }
    catch { writeWarning = true; }
  }

  function status() {
    const recoveryWarning = quarantined.length || invalidSession;
    return { supported: !!latest?.available, phase: broken || recoveryWarning ? 'error' : paused ? 'paused' : phase,
      variant: latest?.variant, difficulty: latest?.difficulty, mode: latest?.mode,
      message: broken ? '扩展已更新或连接失效，请刷新数独页面。' : unrecognizedRaw !== null ? '暂存数据版本未知或已损坏，原文已保留。请先导出待恢复数据，再关闭此数独标签重新打开。' : recoveryWarning ? `已隔离 ${quarantined.length} 项损坏暂存数据，正常记录仍可保存。请导出待恢复数据检查，遗漏可手动补记。` : paused ? '自动统计已暂停，暂停期间的完成不会补记。' : message,
      pending: pending.length, rejected: quarantined.length, sessionPersistence: !writeWarning, recoveryWarning: !!recoveryWarning };
  }

  function setStatus(nextPhase, nextMessage) { phase = nextPhase; message = nextMessage; }

  async function call(payload) {
    if (!chrome.runtime?.id) { broken = true; throw new Error('扩展已更新，请刷新页面。'); }
    const response = await chrome.runtime.sendMessage(payload);
    if (!response?.ok) {
      const error = new Error(response?.error || '本地保存没有确认成功。');
      error.code = response?.code;
      throw error;
    }
    return response.data;
  }

  async function settings() {
    try {
      const value = await call({ type: 'SJ_GET_SETTINGS' });
      if (Number.isInteger(value.tabId) && ownerTabId !== value.tabId) {
        attempt = null; ownerTabId = value.tabId; persist();
      }
      const changed = paused !== value.paused;
      paused = value.paused; ready = true;
      if (changed && paused && attempt && !attempt.saved) { attempt = null; persist(); }
      window.postMessage({ channel: CHANNEL, type: 'request' }, location.origin);
      if (earlyInteraction && !paused) {
        const last = latest, early = earlyInteraction;
        earlyInteraction = null;
        process(early, true);
        if (last) process(last, false);
      }
      if (!paused) void flush();
    } catch (error) { setStatus('error', `${error.message} 请刷新页面重试。`); }
  }

  function scheduleRetry() {
    if (retryTimer !== null || retryCount >= 3 || broken || paused) return;
    const delay = [1000, 4000, 15000][retryCount++];
    retryTimer = setTimeout(() => { retryTimer = null; void flush(); }, delay);
  }

  async function flush() {
    if (flushing || !ready || paused || broken || !pending.length) return;
    flushing = true;
    try {
      while (pending.length && !paused) {
        const record = pending[0];
        let saved;
        try { saved = await call({ type: 'SJ_RECORD', record }); }
        catch (error) {
          if (error.code === 'INVALID_RECORD' || error.code === 'STALE_RECORD') {
            quarantine(record, error.message); pending.shift(); persist(); continue;
          }
          throw error;
        }
        if (!saved.added && !saved.duplicate) {
          if (saved.paused) {
            pending.shift(); paused = true; persist();
            setStatus('waiting', '这次完成发生在暂停期间，未计入记录。请开始下一局。');
            break;
          }
          throw new Error('记录尚未提交，请重试。');
        }
        pending.shift(); persist(); retryCount = 0;
        if (attempt?.id === record.id) {
          attempt.saved = true; persist();
          setStatus(saved.duplicate ? 'waiting' : 'saved', saved.duplicate ? '本次完成事件已处理，无需重复保存。请开始下一局。' : '记录已保存。下一局完成后将继续自动记录。');
        }
      }
    } catch (error) {
      if (/context invalidated|Extension context|receiving end/i.test(error.message)) broken = true;
      setStatus('error', `有 ${pending.length} 局尚未保存：${error.message} 请保留此标签页；整理记录后会重试。`);
      scheduleRetry();
    } finally { flushing = false; }
  }

  function validState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.available === false) return { available: false };
    if (raw.available !== true || !VARIANTS.has(raw.variant) || !DIFFICULTIES.has(raw.difficulty) || !MODES.has(raw.mode)
      || typeof raw.puzzleKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(raw.puzzleKey)
      || typeof raw.won !== 'boolean' || typeof raw.restartEvidence !== 'boolean'
      || !(raw.seconds === null || (Number.isInteger(raw.seconds) && raw.seconds >= 0 && raw.seconds <= 604800))) return null;
    return { available: true, puzzleKey: raw.puzzleKey, variant: raw.variant, difficulty: raw.difficulty,
      mode: raw.mode, won: raw.won, seconds: raw.seconds, restartEvidence: raw.restartEvidence };
  }

  function process(state, interaction) {
    latest = state;
    if (!ready && interaction && state.available && !state.won) earlyInteraction = state;
    if (!ready || paused || broken) return;
    if (!state.available) { if (!pending.length) setStatus('unsupported', '此页没有可识别的棋盘；请进入一局数独。'); return; }
    if (attempt && attempt.puzzleKey !== state.puzzleKey) { attempt = null; persist(); }
    if (!state.won && (attempt?.saved || attempt?.completed) && !attempt.restartSeen && (state.restartEvidence
      || (state.seconds !== null && attempt.winningSeconds !== null && state.seconds < attempt.winningSeconds && state.seconds <= 2))) {
      attempt.restartSeen = true; persist();
    }
    if (!state.won && interaction) {
      const canRestart = (attempt?.saved || attempt?.completed) && attempt.restartSeen;
      if (!attempt || canRestart) {
        if (pending.length >= 1000) { setStatus('error', '未保存队列已满。请保留此标签页，先恢复保存或手动备份。'); return; }
        attempt = { id: `auto:${crypto.randomUUID()}`, puzzleKey: state.puzzleKey, armed: true, saved: false, completed: false, winningSeconds: null, restartSeen: false };
        persist();
      }
      if (!attempt.saved && !attempt.completed) setStatus('playing', '已连接本局；胜利界面显示后会自动记录。');
    }
    if (state.won && attempt?.armed && !attempt.completed && !attempt.saved) {
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const record = { id: attempt.id, site: 'sudoku.com', variant: state.variant, difficulty: state.difficulty, mode: state.mode,
        completedAt: now.toISOString(), localDate: date, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
        durationSeconds: state.seconds, source: 'automatic', puzzleKey: state.puzzleKey, note: '' };
      attempt.completed = true; attempt.winningSeconds = state.seconds;
      pending.push(record); persist();
      setStatus('waiting', '已检测到成功，正在保存…');
      void flush();
    } else if (!attempt && !pending.length) {
      setStatus('waiting', state.won ? '这是已经结束的页面，不会追记旧局。下一局开始后自动统计。' : '已识别棋盘；在棋盘上开始操作即可自动记录。');
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== CHANNEL || event.data.type !== 'snapshot') return;
    const state = validState(event.data.state);
    if (state) process(state, event.data.interaction === true);
  });
  chrome.runtime.onMessage.addListener((request, _sender, respond) => {
    if (request?.type === 'SJ_CAPTURE_STATUS') { respond(status()); return false; }
    if (request?.type === 'SJ_SETTINGS_CHANGED') { void settings(); return false; }
    if (request?.type === 'SJ_RETRY_PENDING') { retryCount = 0; void settings(); respond(status()); return false; }
    if (request?.type === 'SJ_RECOVERY_EXPORT') {
      respond({ app: 'sudoku-journal-recovery', version: 1, exportedAt: new Date().toISOString(), pending, quarantined, invalidSession, originalSession: unrecognizedRaw }); return false;
    }
    return false;
  });
  window.addEventListener('online', () => { retryCount = 0; void flush(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { retryCount = 0; void settings(); } });
  void settings();
})();
