/* NAVIA NCP-AIO three-lab simulator – page controller (practice and exam modes).
 * Lab engines live in lab-core.js, lab-slurm.js, lab-k8s.js and lab-bcm.js. */
(function () {
  'use strict';
  const NL = window.NaviaLab;
  const $ = id => document.getElementById(id);
  const LABS = ['slurm', 'k8s', 'bcm'];
  const MAX_LINES = 2500;
  let mode = 'practice', active = 'slurm';
  const sessions = { practice: {}, exam: {} };
  let timerId = null;
  let examLimit = 20; // minutes for new exam sessions; changed with the Time limit menu

  try { const m = localStorage.getItem('navia-aio-lab-mode'); if (m === 'exam' || m === 'practice') mode = m; } catch (e) { /* storage unavailable */ }

  function newSeed() {
    try { const a = new Uint32Array(1); crypto.getRandomValues(a); return 100000 + (a[0] % 900000); } catch (e) { return 100000 + Math.floor(Math.random() * 900000); }
  }
  function makeSession(m, id, seed) {
    const lab = NL.labs[id].create({ mode: m, seed: seed });
    return { id: id, lab: lab, seed: seed, lines: [], hist: [], hi: 0, draft: '', started: Date.now(), limit: m === 'exam' ? examLimit : 0, submitted: null, cmds: 0, report: null };
  }
  function cur() {
    let s = sessions[mode][active];
    if (!s) s = sessions[mode][active] = makeSession(mode, active, mode === 'practice' ? 1 : newSeed());
    return s;
  }

  /* ---------- terminal ---------- */
  const body = () => $('term-body');
  let inputEl = null, promptEl = null;
  function lineNode(e) {
    const d = document.createElement(e.k === 'hint' ? 'span' : 'div');
    if (e.k === 'cmd') { const p = document.createElement('span'); p.className = 'pr'; p.textContent = e.p; const c = document.createElement('span'); c.className = 'cmd'; c.textContent = e.t; d.append(p, c); }
    else { d.className = e.k; d.textContent = e.k === 'hint' ? 'Hint: ' + e.t : e.t; }
    return d;
  }
  function rebuildTerminal() {
    const s = cur(), b = body();
    b.textContent = '';
    if (!s.lines.length) s.lines.push({ k: 'sys', t: welcome(s) });
    s.lines.forEach(e => b.appendChild(lineNode(e)));
    const row = document.createElement('div'); row.className = 'inline';
    promptEl = document.createElement('span'); promptEl.className = 'pr';
    inputEl = document.createElement('input');
    inputEl.setAttribute('autocomplete', 'off'); inputEl.setAttribute('autocapitalize', 'off'); inputEl.setAttribute('spellcheck', 'false'); inputEl.setAttribute('aria-label', 'Terminal input');
    inputEl.addEventListener('keydown', onKey);
    row.append(promptEl, inputEl); b.appendChild(row);
    updatePrompt();
    b.scrollTop = b.scrollHeight;
  }
  function push(e) {
    const s = cur(); s.lines.push(e);
    if (s.lines.length > MAX_LINES) { s.lines.splice(0, s.lines.length - MAX_LINES); }
    body().insertBefore(lineNode(e), body().lastChild);
  }
  function updatePrompt() {
    const s = cur(), sh = s.lab.shell;
    promptEl.textContent = sh.prompt();
    inputEl.disabled = !!s.submitted || !!sh.editor;
    $('term-title').textContent = `${sh.user}@${sh.host}`;
  }
  function welcome(s) {
    const sh = s.lab.shell;
    return `${s.lab.title} — ${mode === 'exam' ? 'exam mode, scenario #' + s.seed : 'practice mode'}\nConnected to ${sh.host} as ${sh.user}. Type commands as you would on a real cluster.`;
  }
  function run(cmd) {
    const s = cur(), sh = s.lab.shell;
    const p = sh.prompt();
    push({ k: 'cmd', p: p, t: cmd });
    if (cmd.trim() && !sh.interactive && !sh.heredoc) { s.hist.push(cmd); }
    s.hi = s.hist.length; s.draft = '';
    let r;
    try { r = sh.input(cmd); } catch (err) { r = { out: 'simulator error: ' + err.message, hints: [] }; console.error(err); }
    s.cmds++;
    if (sh.cleared) { s.lines = []; rebuildTerminal(); }
    if (r.out) push({ k: 'out', t: r.out });
    (r.hints || []).forEach(h => push({ k: 'hint', t: h }));
    if (sh.editor) openEditor();
    if (sh.heredoc && sh.heredoc.delim === null && sh.heredoc.body.length === 0) push({ k: 'sys', t: '(cat is reading what you type or paste. Press Ctrl+D on an empty line to finish.)' });
    updatePrompt(); updateTasks();
    body().scrollTop = body().scrollHeight;
  }
  function onKey(e) {
    const s = cur(), sh = s.lab.shell;
    if (e.key === 'Enter') { e.preventDefault(); const v = inputEl.value; inputEl.value = ''; run(v); return; }
    if (e.key === 'ArrowUp') { if (!s.hist.length) return; e.preventDefault(); if (s.hi === s.hist.length) s.draft = inputEl.value; s.hi = Math.max(0, s.hi - 1); inputEl.value = s.hist[s.hi]; return; }
    if (e.key === 'ArrowDown') { if (!s.hist.length) return; e.preventDefault(); s.hi = Math.min(s.hist.length, s.hi + 1); inputEl.value = s.hi === s.hist.length ? s.draft : s.hist[s.hi]; return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const c = NL.complete(sh, inputEl.value);
      if (c.options && c.options.length > 1) { push({ k: 'cmd', p: sh.prompt(), t: inputEl.value }); push({ k: 'sys', t: c.options.join('  ') }); }
      inputEl.value = c.line; return;
    }
    if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); s.lines = []; rebuildTerminal(); inputEl.focus(); return; }
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && !window.getSelection().toString()) {
      e.preventDefault();
      push({ k: 'cmd', p: sh.prompt(), t: inputEl.value + '^C' }); inputEl.value = '';
      if (sh.heredoc) sh.heredoc = null;
      else if (sh.interactive && !/% $/.test(sh.prompt())) { sh.interactive = null; push({ k: 'out', t: 'Setup aborted.' }); }
      updatePrompt(); return;
    }
    if (e.ctrlKey && (e.key === 'd' || e.key === 'D') && !inputEl.value) {
      e.preventDefault();
      if (sh.heredoc) {
        const r = sh.endInput();
        if (r.out) push({ k: 'out', t: r.out });
        (r.hints || []).forEach(h => push({ k: 'hint', t: h }));
        updatePrompt(); updateTasks(); body().scrollTop = body().scrollHeight; return;
      }
      run(sh.interactive && /% $/.test(sh.prompt()) ? 'quit' : 'exit');
    }
  }

  /* ---------- editor (nano / vi) ---------- */
  let edDirty = false, edConfirm = false, viMode = null, viCmd = null, viPending = '';
  function openEditor() {
    const sh = cur().lab.shell, e = sh.editor;
    body().hidden = true; $('editor').hidden = false;
    const nano = e.prog === 'nano';
    $('ed-prog').textContent = nano ? 'GNU nano 6.2' : 'VIM 8.2 (simulated)';
    $('ed-file').textContent = e.display;
    $('ed-mod').textContent = '';
    $('ed-text').value = e.content;
    $('ed-status').textContent = e.isNew ? '[ New File ]' : `[ Read ${e.content ? e.content.replace(/\n$/, '').split('\n').length : 0} lines ]`;
    $('ed-foot').innerHTML = '';
    const items = nano ? [['^O', 'Write Out', save], ['^X', 'Exit', tryExit], ['^K', 'Cut line', null], ['Tab', 'inserts 2 spaces', null]] : [['i', 'insert', null], ['Esc', 'normal mode', null], [':w', 'save', null], [':wq', 'save and quit', null], [':q!', 'quit without saving', null], ['dd', 'delete line', null]];
    items.forEach(([k, label, fn]) => { const b = document.createElement(fn ? 'button' : 'span'); const kb = document.createElement('b'); kb.textContent = k; b.append(kb, document.createTextNode(label)); if (fn) b.addEventListener('click', fn); $('ed-foot').appendChild(b); });
    edDirty = false; edConfirm = false; viCmd = null; viPending = '';
    viMode = nano ? null : 'normal';
    $('ed-text').readOnly = viMode === 'normal';
    if (!nano) $('ed-status').textContent = e.isNew ? `"${e.display}" [New]` : `"${e.display}" ${e.content ? e.content.replace(/\n$/, '').split('\n').length : 0}L, ${e.content.length}B`;
    $('ed-text').focus();
    $('ed-text').setSelectionRange(0, 0);
  }
  function viSet(m) { viMode = m; viCmd = null; $('ed-text').readOnly = m !== 'insert'; $('ed-status').textContent = m === 'insert' ? '-- INSERT --' : ''; }
  function viRun(cmd) {
    const c = cmd.trim();
    if (c === 'w') { save(); viSet('normal'); if (!edDirty) $('ed-status').textContent = $('ed-status').textContent || 'written'; return; }
    if (c === 'wq' || c === 'x' || c === 'wq!' || c === 'x!') { if (save()) closeEditor(); else viMode = 'normal'; return; }
    if (c === 'q') { if (edDirty) { viSet('normal'); $('ed-status').textContent = 'E37: No write since last change (add ! to override)'; } else closeEditor(); return; }
    if (c === 'q!') { closeEditor(); return; }
    viSet('normal');
    $('ed-status').textContent = c ? `E492: Not an editor command: ${c}` : '';
  }
  function viNormalKey(e) {
    const t = $('ed-text'), v = t.value, a = t.selectionStart;
    const lineStart = v.lastIndexOf('\n', a - 1) + 1; let lineEnd = v.indexOf('\n', a); if (lineEnd < 0) lineEnd = v.length;
    const k = e.key;
    if (e.ctrlKey || e.metaKey || e.altKey || /^(Arrow|Page|Home|End)/.test(k) || k === 'Shift') return; // let navigation and paste shortcuts through
    e.preventDefault();
    const seq = viPending + k; viPending = '';
    const ins = pos => { viSet('insert'); t.selectionStart = t.selectionEnd = pos; };
    if (k === 'i') return ins(a);
    if (k === 'a') return ins(Math.min(a + 1, lineEnd));
    if (k === 'I') return ins(lineStart);
    if (k === 'A') return ins(lineEnd);
    if (k === 'o') { t.value = v.slice(0, lineEnd) + '\n' + v.slice(lineEnd); markDirty(); return ins(lineEnd + 1); }
    if (k === 'O') { t.value = v.slice(0, lineStart) + '\n' + v.slice(lineStart); markDirty(); return ins(lineStart); }
    if (k === ':') { viMode = 'cmd'; viCmd = ''; $('ed-status').textContent = ':'; return; }
    if (k === 'x') { if (a < lineEnd) { t.value = v.slice(0, a) + v.slice(a + 1); t.selectionStart = t.selectionEnd = a; markDirty(); } return; }
    if (seq === 'dd') { const end = lineEnd < v.length ? lineEnd + 1 : lineEnd; t.value = v.slice(0, lineStart) + v.slice(end); t.selectionStart = t.selectionEnd = Math.min(lineStart, t.value.length); markDirty(); return; }
    if (seq === 'ZZ') { viRun('x'); return; }
    if (seq === 'gg') { t.selectionStart = t.selectionEnd = 0; return; }
    if (k === 'G') { t.selectionStart = t.selectionEnd = v.length; return; }
    if (k === 'd' || k === 'Z' || k === 'g') { viPending = k; return; }
    if (k === 'Escape') { $('ed-status').textContent = ''; return; }
  }
  function markDirty() { edDirty = true; $('ed-mod').textContent = 'Modified'; }
  function save() {
    const s = cur(), sh = s.lab.shell; if (!sh.editor) return false;
    const r = sh.saveEditor($('ed-text').value);
    $('ed-status').textContent = r.msg;
    push({ k: 'sys', t: `${sh.editor.prog}: ${r.msg}` });
    (r.hints || []).forEach(h => push({ k: 'hint', t: h }));
    if (r.ok) { edDirty = false; $('ed-mod').textContent = ''; $('ed-text').value = sh.editor.content; }
    updateTasks();
    return r.ok;
  }
  function closeEditor() {
    const sh = cur().lab.shell; sh.closeEditor();
    $('editor').hidden = true; body().hidden = false; edConfirm = false;
    updatePrompt(); body().scrollTop = body().scrollHeight; inputEl.focus();
  }
  function tryExit() {
    if (!edDirty) { closeEditor(); return; }
    edConfirm = true;
    $('ed-status').textContent = 'Save modified buffer?   Y Yes   N No   ^C Cancel';
  }
  $('ed-text').addEventListener('input', () => { edDirty = true; $('ed-mod').textContent = 'Modified'; });
  $('ed-text').addEventListener('paste', e => { if (viMode === 'normal' || viMode === 'cmd') { e.preventDefault(); $('ed-status').textContent = 'Not in insert mode: press i first, then paste.'; } });
  $('ed-text').addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    if (viMode === 'cmd') {
      e.preventDefault();
      if (e.key === 'Enter') { viRun(viCmd); return; }
      if (e.key === 'Escape') { viSet('normal'); return; }
      if (e.key === 'Backspace') { if (!viCmd) { viSet('normal'); return; } viCmd = viCmd.slice(0, -1); }
      else if (e.key.length === 1) viCmd += e.key;
      $('ed-status').textContent = ':' + viCmd; return;
    }
    if (viMode === 'normal' && !(e.ctrlKey && /^[osx]$/.test(k))) { viNormalKey(e); return; }
    if (viMode === 'insert' && e.key === 'Escape') { e.preventDefault(); viSet('normal'); return; }
    if (edConfirm) {
      e.preventDefault();
      if (k === 'y') { if (save()) closeEditor(); else edConfirm = false; }
      else if (k === 'n') closeEditor();
      else if ((e.ctrlKey && k === 'c') || k === 'escape') { edConfirm = false; $('ed-status').textContent = '[ Cancelled ]'; }
      return;
    }
    if (e.ctrlKey && (k === 'o' || k === 's')) { e.preventDefault(); save(); return; }
    if (e.ctrlKey && k === 'x') { e.preventDefault(); tryExit(); return; }
    if (e.key === 'Tab') { e.preventDefault(); const t = e.target, a = t.selectionStart, b = t.selectionEnd; t.value = t.value.slice(0, a) + '  ' + t.value.slice(b); t.selectionStart = t.selectionEnd = a + 2; edDirty = true; $('ed-mod').textContent = 'Modified'; return; }
    if (e.ctrlKey && k === 'k') { e.preventDefault(); const t = e.target, v = t.value, a = t.selectionStart; const st = v.lastIndexOf('\n', a - 1) + 1; let en = v.indexOf('\n', a); en = en < 0 ? v.length : en + 1; t.value = v.slice(0, st) + v.slice(en); t.selectionStart = t.selectionEnd = st; edDirty = true; $('ed-mod').textContent = 'Modified'; }
  });

  /* ---------- tasks, grading, report ---------- */
  function updateTasks() {
    const s = cur(), lab = s.lab;
    const tasks = lab.tasks();
    let g = null;
    if (mode === 'practice' || s.submitted) { try { g = s.submitted ? s.submitted.grade : lab.grade(); } catch (err) { console.error(err); } }
    const pass = g ? Object.fromEntries(g.results.map(x => [x.id, x.pass])) : {};
    const ol = $('tasks'); ol.textContent = '';
    tasks.forEach(t => { const li = document.createElement('li'); li.textContent = t.text; if (pass[t.id] && mode === 'practice') li.className = 'done'; ol.appendChild(li); });
    $('progress').textContent = mode === 'practice' && g ? `${g.results.filter(x => x.pass).length}/${g.results.length} checks passing` : s.submitted ? '' : 'Graded on submit';
  }
  function report(g, final) {
    const s = cur(), el = $('report');
    el.hidden = false; el.textContent = '';
    const n = g.results.filter(x => x.pass).length, t = g.results.length;
    const h = document.createElement('h3'); h.textContent = final ? 'Lab result' : 'Progress check';
    const sc = document.createElement('div'); sc.className = 'score ' + (n === t ? 'pass' : 'fail'); sc.textContent = `${n} / ${t} checks passed`;
    el.append(h, sc);
    if (final) { const m = document.createElement('p'); m.className = 'small'; const used = Math.round((s.submitted.at - s.started) / 1000); m.textContent = `Time used ${Math.floor(used / 60)}:${String(used % 60).padStart(2, '0')} · ${s.cmds} commands · scenario #${s.seed}${s.submitted.timeout ? ' · time limit reached' : ''}`; el.appendChild(m); }
    const names = Object.fromEntries(s.lab.tasks().map((x, i) => [x.id, `Task ${i + 1}`]));
    g.results.forEach(x => { const d = document.createElement('div'); d.className = 'res ' + (x.pass ? 'ok' : 'no'); const b = document.createElement('b'); b.textContent = `${x.pass ? '✓' : '✗'} ${names[x.id] || x.id}`; const p = document.createElement('span'); p.textContent = x.detail; d.append(b, p); el.appendChild(d); });
    g.notes.forEach(nt => { const p = document.createElement('p'); p.className = 'note'; p.textContent = '⚠ ' + nt; el.appendChild(p); });
    if (final) {
      const row = document.createElement('div'); row.className = 'row';
      const again = document.createElement('button'); again.className = 'btn'; again.textContent = 'Retry this scenario'; again.addEventListener('click', () => resetLab(false));
      const fresh = document.createElement('button'); fresh.className = 'btn primary'; fresh.textContent = 'New scenario'; fresh.addEventListener('click', () => resetLab(true));
      row.append(again, fresh); el.appendChild(row);
    }
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function submit(timeout) {
    const s = cur(); if (s.submitted) return;
    const sh = s.lab.shell;
    if (sh.editor) closeEditor();
    s.submitted = { at: Date.now(), grade: s.lab.grade(), timeout: !!timeout };
    push({ k: 'sys', t: timeout ? '*** Time is up. The lab was submitted automatically. ***' : '*** Lab submitted. ***' });
    renderPanel(); updatePrompt();
    report(s.submitted.grade, true);
  }
  function resetLab(newScenario) {
    const s = cur();
    sessions[mode][active] = makeSession(mode, active, newScenario && mode === 'exam' ? newSeed() : s.seed);
    renderAll();
  }

  /* ---------- timer ---------- */
  function tick() {
    const s = cur();
    const w = $('timer-wrap'), t = $('timer');
    if (mode !== 'exam') { w.hidden = true; return; }
    w.hidden = false;
    const end = s.submitted ? s.submitted.at : Date.now();
    const el = Math.floor((end - s.started) / 1000);
    if (s.limit) {
      const left = Math.max(0, s.limit * 60 - el);
      t.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`;
      t.classList.toggle('low', left < 120);
      if (left === 0 && !s.submitted) submit(true);
    } else { t.textContent = `${Math.floor(el / 60)}:${String(el % 60).padStart(2, '0')}`; t.classList.remove('low'); }
  }

  /* ---------- panel ---------- */
  function renderPanel() {
    const s = cur(), lab = s.lab;
    $('lab-title').textContent = lab.title;
    $('intro').textContent = lab.intro;
    $('mode-pill').textContent = mode === 'exam' ? 'Exam' : 'Practice';
    $('mode-pill').className = 'pill ' + mode;
    $('scenario').textContent = mode === 'exam' ? `Scenario #${s.seed}` : '';
    $('exam-controls').hidden = mode !== 'exam' || !!s.submitted;
    if (mode === 'exam') $('time-limit').value = String(s.limit || 0);
    $('submit').hidden = mode !== 'exam'; $('submit').disabled = !!s.submitted;
    $('check').hidden = mode !== 'practice';
    $('new').hidden = mode !== 'exam';
    $('sol-wrap').hidden = mode === 'exam' && !s.submitted;
    $('solution').textContent = lab.solution().join('\n');
    $('mode-help').textContent = mode === 'exam'
      ? 'Exam mode: names, nodes and failure causes change with every scenario. There are no hints, the checklist stays hidden, and nothing is graded until you submit. The grader checks the final state of the simulated system, so verify your own work first.'
      : 'Practice mode: a fixed scenario with hints under your commands. Tasks tick off as the simulated system reaches the required state. Use Check my work for an explanation of each check.';
    document.querySelectorAll('[data-lab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.lab === active)));
    $('mode-practice').setAttribute('aria-pressed', String(mode === 'practice'));
    $('mode-exam').setAttribute('aria-pressed', String(mode === 'exam'));
    updateTasks(); tick();
  }
  function renderAll() {
    const s = cur();
    $('report').hidden = true;
    renderPanel();
    if (s.submitted) report(s.submitted.grade, true);
    $('editor').hidden = true; body().hidden = false;
    rebuildTerminal();
    if (s.lab.shell.editor) openEditor();
  }

  /* ---------- wiring ---------- */
  document.querySelectorAll('[data-lab]').forEach(b => b.addEventListener('click', () => { active = b.dataset.lab; renderAll(); inputEl.focus(); }));
  $('mode-practice').addEventListener('click', () => { mode = 'practice'; try { localStorage.setItem('navia-aio-lab-mode', mode); } catch (e) { /* ignore */ } renderAll(); });
  $('mode-exam').addEventListener('click', () => { mode = 'exam'; try { localStorage.setItem('navia-aio-lab-mode', mode); } catch (e) { /* ignore */ } renderAll(); });
  $('check').addEventListener('click', () => report(cur().lab.grade(), false));
  $('submit').addEventListener('click', () => { const s = cur(); if (window.confirm(`Submit ${s.lab.title}? You cannot change anything afterwards.`)) submit(false); });
  $('reset').addEventListener('click', () => { if (cur().cmds === 0 || window.confirm('Reset this lab? Your progress in it will be lost.')) resetLab(false); });
  $('new').addEventListener('click', () => { if (cur().cmds === 0 || cur().submitted || window.confirm('Start a new scenario? Your progress in this one will be lost.')) resetLab(true); });
  $('time-limit').addEventListener('change', () => { const s = cur(); examLimit = s.limit = +$('time-limit').value; if (s.cmds === 0) s.started = Date.now(); tick(); });
  $('term-body').addEventListener('click', () => { if (!window.getSelection().toString() && inputEl && !inputEl.disabled) inputEl.focus(); });
  timerId = setInterval(tick, 1000);
  renderAll();
})();
