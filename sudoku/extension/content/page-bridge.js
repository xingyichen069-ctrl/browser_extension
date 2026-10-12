/* Runs in the page's MAIN world. Read-only public metadata and small DOM snapshots;
 * no private webpack APIs, game modification, cookies, history or solution reads. */
(() => {
  'use strict';
  if (window !== window.top || window.__sudokuJournalBridgeV1) return;
  window.__sudokuJournalBridgeV1 = true;
  const CHANNEL = 'sudoku-journal-v1';
  const DIFFICULTIES = new Set(['easy', 'medium', 'hard', 'expert', 'master', 'extreme']);
  const MODES = new Set(['daily', 'postcards', 'storybook', 'croco']);
  let observers = [], bootObserver = null, scheduled = null, lastJson = '', boundGame = null, boundWin = null;

  function timerSeconds() {
    const text = document.getElementById('timer')?.textContent?.replace(/\s/g, '') || '';
    if (!/^\d{1,3}:\d{2}(:\d{2})?$/.test(text)) return null;
    const parts = text.split(':').map(Number);
    if (parts.slice(1).some(n => n > 59)) return null;
    const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    return seconds <= 604800 ? seconds : null;
  }

  function snapshot() {
    const data = window.gameData;
    const game = document.getElementById('game');
    const win = document.getElementById('win-screen');
    if (!data || !game?.querySelector('canvas')) return { available: false };
    const rawId = data.content_id;
    if (!['string', 'number'].includes(typeof rawId)) return { available: false };
    const id = String(rawId);
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(id)) return { available: false };
    const variant = ['classic', 'killer'].includes(data.content_type) ? data.content_type : 'unknown';
    const rawMode = typeof window.mode === 'string' ? window.mode : data.mode;
    const mode = ['classic', 'killer', 'main'].includes(rawMode) ? 'regular' : MODES.has(rawMode) ? rawMode : 'unknown';
    const rawDifficulty = data.difficulty || window.difficulty;
    const difficulty = rawDifficulty === 'evil' ? 'master' : DIFFICULTIES.has(rawDifficulty) ? rawDifficulty : 'unknown';
    let restartEvidence = false;
    // Only a matching current save can establish a restart; it never establishes a win.
    if (mode === 'regular' && variant !== 'unknown') {
      try {
        const raw = localStorage.getItem(variant === 'killer' ? 'main_game_killer' : 'main_game');
        if (raw && raw.length < 100_000) {
          const saved = JSON.parse(raw);
          const savedDifficulty = saved.difficulty === 'evil' ? 'master' : saved.difficulty;
          restartEvidence = String(saved.id) === id && saved.mode === variant && savedDifficulty === difficulty
            && saved.loaded === false && saved.timer === 0;
        }
      } catch { /* Optional restart evidence may be unavailable; core capture still works. */ }
    }
    const won = !!(win?.classList.contains('show-win') && win.childElementCount > 0 && !win.hidden
      && getComputedStyle(win).display !== 'none' && getComputedStyle(win).visibility !== 'hidden');
    return { available: true, puzzleKey: `${variant}:${mode}:${difficulty}:${id}`, variant, mode, difficulty,
      won, seconds: timerSeconds(), restartEvidence };
  }

  function emit(interaction = false, force = false) {
    const state = snapshot();
    const json = JSON.stringify(state);
    if (!interaction && !force && json === lastJson) return;
    lastJson = json;
    window.postMessage({ channel: CHANNEL, type: 'snapshot', interaction, state }, location.origin);
    bind();
  }

  function schedule() {
    if (scheduled !== null) return;
    scheduled = setTimeout(() => { scheduled = null; emit(); }, 70);
  }

  function bind() {
    const game = document.getElementById('game'), win = document.getElementById('win-screen');
    if (!game || !win) return;
    if (boundGame === game && boundWin === win) return;
    observers.forEach(observer => observer.disconnect());
    observers = [];
    boundGame = game; boundWin = win;
    const winObserver = new MutationObserver(schedule);
    winObserver.observe(win, { attributes: true, attributeFilter: ['class', 'style', 'hidden'], childList: true, subtree: true });
    observers.push(winObserver);
    const gameObserver = new MutationObserver(schedule);
    gameObserver.observe(game, { attributes: true, attributeFilter: ['class'], childList: true });
    observers.push(gameObserver);
    if (game.parentElement) {
      const replacementObserver = new MutationObserver(schedule);
      replacementObserver.observe(game.parentElement, { childList: true });
      observers.push(replacementObserver);
    }
    bootObserver?.disconnect(); bootObserver = null;
  }

  document.addEventListener('pointerdown', event => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    if (event.target.closest('#game, .numpad, .game-controls')) emit(true, true);
  }, true);
  document.addEventListener('keydown', event => {
    if (!event.isTrusted || !/^[1-9]$|^(Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(event.key)) return;
    if (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"]')) return;
    if (document.getElementById('game')) emit(true, true);
  }, true);
  window.addEventListener('message', event => {
    if (event.source === window && event.origin === location.origin && event.data?.channel === CHANNEL && event.data.type === 'request') emit(false, true);
  });
  window.addEventListener('pageshow', () => { bind(); emit(false, true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { bind(); emit(false, true); } });
  // A short bootstrap observation tolerates late game mounting; it is not a poll.
  bootObserver = new MutationObserver(schedule);
  bootObserver.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => { bootObserver?.disconnect(); bootObserver = null; }, 15_000);
  bind();
  emit(false, true);
})();
