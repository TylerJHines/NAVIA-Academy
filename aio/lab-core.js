/* NAVIA lab core: a small simulated Linux shell shared by the three NCP-AIO practice labs.
 * Everything here is a simulation for training. Nothing touches a real system.
 * Exposes window.NaviaLab (or globalThis.NaviaLab under Node for tests). */
(function (G) {
  'use strict';
  const NL = (G.NaviaLab = G.NaviaLab || {});
  NL.labs = NL.labs || {};

  /* ---------- random helpers (seeded so a scenario can be replayed) ---------- */
  NL.rng = function (seed) {
    let a = (seed >>> 0) ^ 0x9e3779b9;
    const next = function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < 8; i++) next(); // warm up so nearby seeds diverge
    return next;
  };
  NL.pick = (r, arr) => arr[Math.floor(r() * arr.length)];
  NL.int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  NL.hex = (r, n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('');
  NL.alnum = (r, n) => Array.from({ length: n }, () => 'bcdfghjklmnpqrstvwxz2456789'[Math.floor(r() * 27)]).join('');

  /* ---------- formatting helpers ---------- */
  NL.padR = (s, n) => { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); };
  NL.padL = (s, n) => { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };
  /* table(headers, rows, {sep:'  ', rule:false, align:{col:'r'}}) – columns sized to content */
  NL.table = function (headers, rows, opt) {
    opt = opt || {};
    const sep = opt.sep == null ? '  ' : opt.sep;
    const w = headers.map((h, i) => Math.max(String(h).length, ...rows.map(r => String(r[i] == null ? '' : r[i]).length)));
    const cell = (v, i) => (opt.align && opt.align[i] === 'r' ? NL.padL(v, w[i]) : NL.padR(v, w[i]));
    const lines = [headers.map(cell).join(sep).replace(/\s+$/, '')];
    if (opt.rule) lines.push(w.map(n => '-'.repeat(n)).join(sep));
    rows.forEach(r => lines.push(r.map((v, i) => cell(v == null ? '' : v, i)).join(sep).replace(/\s+$/, '')));
    return lines.join('\n');
  };
  const two = n => String(n).padStart(2, '0');
  NL.isoTime = t => { const d = new Date(t); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };
  NL.logTime = t => { const d = new Date(t); const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]; return `${m} ${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };
  NL.tz = (function () { try { const p = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date()).find(x => x.type === 'timeZoneName'); return p && /^[A-Z]{2,5}$/.test(p.value) ? p.value : 'UTC'; } catch (e) { return 'UTC'; } })();
  /* like `date`: Tue Nov 24 20:30:00 CST 2026 */
  NL.dateCmd = t => { const d = new Date(t); const s = d.toString(); return `${s.slice(0, 3)} ${s.slice(4, 7)} ${String(d.getDate()).padStart(2, ' ')} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${NL.tz} ${d.getFullYear()}`; };
  NL.dur = ms => { let s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600); s -= h * 3600; const m = Math.floor(s / 60); s -= m * 60; return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`; };
  NL.elapsed = ms => { let s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600); s -= h * 3600; const m = Math.floor(s / 60); s -= m * 60; return `${two(h)}:${two(m)}:${two(s)}`; };
  NL.age = ms => { const s = Math.floor(ms / 1000); if (s < 120) return s + 's'; const m = Math.floor(s / 60); if (m < 120) return m + 'm'; const h = Math.floor(m / 60); if (h < 48) return h + 'h'; return Math.floor(h / 24) + 'd'; };

  /* ---------- results ---------- */
  NL.ok = (out = '') => ({ out: out, err: '', code: 0 });
  NL.fail = (err, code = 1, out = '') => ({ out: out, err: err, code: code });

  /* ---------- tokenizer ----------
   * Supports quotes, backslash escapes, ; && || | > >> 2> 2>&1 << heredoc, $VAR and ~ expansion. */
  NL.tokenize = function (line, env) {
    const toks = [];
    let i = 0, cur = null;
    const push = () => { if (cur !== null) { toks.push(cur); cur = null; } };
    const word = () => { if (cur === null) cur = { t: 'w', v: '', q: false, glob: false }; return cur; };
    while (i < line.length) {
      const c = line[i];
      if (c === ' ' || c === '\t') { push(); i++; continue; }
      if (c === '#' && cur === null) break; // comment
      if (c === "'") {
        const j = line.indexOf("'", i + 1);
        if (j < 0) return { error: 'unexpected EOF while looking for matching `\'\'' };
        word().v += line.slice(i + 1, j); cur.q = true; i = j + 1; continue;
      }
      if (c === '"') {
        let j = i + 1, s = '';
        while (j < line.length && line[j] !== '"') {
          if (line[j] === '\\' && j + 1 < line.length && '"\\$`'.includes(line[j + 1])) { s += line[j + 1]; j += 2; continue; }
          if (line[j] === '$') { const m = /^\$(\{(\w+)\}|(\w+))/.exec(line.slice(j)); if (m) { s += env[m[2] || m[3]] || ''; j += m[0].length; continue; } }
          s += line[j]; j++;
        }
        if (j >= line.length) return { error: 'unexpected EOF while looking for matching `"\'' };
        word().v += s; cur.q = true; i = j + 1; continue;
      }
      if (c === '\\' && i + 1 < line.length) { word().v += line[i + 1]; i += 2; continue; }
      if (c === '$') {
        const m = /^\$(\{(\w+)\}|(\w+)|\?)/.exec(line.slice(i));
        if (m) { word().v += m[0] === '$?' ? String(env['?'] || 0) : (env[m[2] || m[3]] || ''); i += m[0].length; continue; }
      }
      const rest = line.slice(i);
      let op = null;
      for (const o of ['2>&1', '&&', '||', '>>', '<<', '2>', ';', '|', '>', '<', '&']) if (rest.startsWith(o)) { op = o; break; }
      if (op === '2>' && cur !== null) op = null; // e.g. "file2>x" is unusual; keep it simple
      if (op) { push(); toks.push({ t: 'op', v: op }); i += op.length; continue; }
      if (c === '~' && cur === null && (i + 1 === line.length || line[i + 1] === '/' || line[i + 1] === ' ')) { word().v += env.HOME; i++; continue; }
      if (c === '*' || c === '?') word().glob = true;
      word().v += c; i++;
    }
    push();
    return { toks: toks };
  };

  /* Parse tokens into a list of {pipeline:[cmd...], join:';'|'&&'|'||'} */
  NL.parse = function (toks) {
    const list = [];
    let pipeline = [], cmd = { argv: [], redir: [], heredoc: null, globs: [] }, join = ';';
    const endCmd = () => { if (cmd.argv.length || cmd.redir.length || cmd.heredoc) pipeline.push(cmd); cmd = { argv: [], redir: [], heredoc: null, globs: [] }; };
    const endPipe = (j) => { endCmd(); if (pipeline.length) list.push({ pipeline: pipeline, join: join }); pipeline = []; join = j; };
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.t === 'w') { cmd.argv.push(t.v); cmd.globs.push(t.glob && !t.q); continue; }
      switch (t.v) {
        case ';': case '&': endPipe(';'); break;
        case '&&': endPipe('&&'); break;
        case '||': endPipe('||'); break;
        case '|':
          if (!cmd.argv.length) return { error: "syntax error near unexpected token `|'" };
          endCmd(); break;
        case '>': case '>>': case '2>': case '<': {
          const n = toks[i + 1];
          if (!n || n.t !== 'w') return { error: 'syntax error near unexpected token `newline\'' };
          cmd.redir.push({ op: t.v, path: n.v }); i++; break;
        }
        case '2>&1': cmd.redir.push({ op: '2>&1' }); break;
        case '<<': {
          const n = toks[i + 1];
          if (!n || n.t !== 'w') return { error: 'syntax error near unexpected token `newline\'' };
          cmd.heredoc = n.v.replace(/^-/, ''); i++; break;
        }
      }
    }
    endPipe(';');
    return { list: list };
  };

  /* ---------- path helpers ---------- */
  NL.normPath = function (p, cwd, home) {
    if (p === '~') p = home; else if (p.startsWith('~/')) p = home + p.slice(1);
    if (!p.startsWith('/')) p = (cwd === '/' ? '' : cwd) + '/' + p;
    const out = [];
    p.split('/').forEach(seg => { if (!seg || seg === '.') return; if (seg === '..') out.pop(); else out.push(seg); });
    return '/' + out.join('/');
  };
  const dirname = p => p.replace(/\/[^/]*$/, '') || '/';
  const basename = p => p.replace(/^.*\//, '');
  NL.dirname = dirname; NL.basename = basename;

  /* ---------- the shell ---------- */
  class Shell {
    constructor(o) {
      this.mode = o.mode || 'practice';
      this.user = o.user || 'student';
      this.host = o.host || 'headnode';
      this.home = o.home || '/home/' + this.user;
      this.cwd = this.home;
      this.fs = new Map(); // path -> {dir:true} | {data:string, mtime}
      this.clockOffset = 0;
      this.realNow = o.now || (() => Date.now());
      this.stack = []; // ssh / sudo -i frames
      this.histList = [];
      this.hints = [];
      this.editor = null; // {path, content, prog}
      this.heredoc = null;
      this.interactive = null; // lab-provided {prompt(), input(line)} e.g. cmsh, wizard
      this.lastCode = 0;
      this.cleared = false;
      this.lab = null;
      this.env = {};
      ['/', '/home', '/tmp', '/etc', '/var', '/var/log', '/root', this.home].forEach(d => this.mkdirp(d));
    }
    now() { return this.realNow() + this.clockOffset; }
    advance(ms) { this.clockOffset += ms; }
    hint(msg) { if (this.mode === 'practice' && !this.hints.includes(msg)) this.hints.push(msg); }
    isRoot(ctx) { return this.user === 'root' || (ctx && ctx.sudo); }

    /* filesystem */
    mkdirp(p) { const parts = p.split('/').filter(Boolean); let cur = ''; this.fs.set('/', { dir: true }); parts.forEach(s => { cur += '/' + s; if (!this.fs.has(cur)) this.fs.set(cur, { dir: true }); }); }
    isDir(p) { const e = this.fs.get(p); return !!(e && e.dir); }
    exists(p) { return this.fs.has(p) || this.virtual(p) !== undefined; }
    virtual(p) { return this.lab && this.lab.virtualFile ? this.lab.virtualFile(p, this) : undefined; }
    read(p) { const v = this.virtual(p); if (v !== undefined) return v; const e = this.fs.get(p); return e && !e.dir ? e.data : undefined; }
    write(p, data, append) {
      const parent = dirname(p);
      if (!this.isDir(parent)) return 'No such file or directory';
      if (this.isDir(p)) return 'Is a directory';
      if (this.lab && this.lab.writeGuard) { const g = this.lab.writeGuard(p, this); if (g) return g; }
      const prev = this.fs.get(p);
      this.fs.set(p, { data: (append && prev && !prev.dir ? prev.data : '') + data, mtime: this.now() });
      if (this.lab && this.lab.onWrite) this.lab.onWrite(p, this);
      return '';
    }
    listDir(p) {
      const pre = p === '/' ? '/' : p + '/';
      const names = new Set();
      for (const k of this.fs.keys()) if (k !== p && k.startsWith(pre) && !k.slice(pre.length).includes('/')) names.add(k.slice(pre.length));
      if (this.lab && this.lab.virtualList) (this.lab.virtualList(p, this) || []).forEach(n => names.add(n));
      return [...names].sort();
    }
    resolve(p) { return NL.normPath(p, this.cwd, this.home); }
    expandGlob(arg) {
      const abs = this.resolve(arg), dir = dirname(abs), pat = basename(abs);
      const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      const hits = this.listDir(dir).filter(n => re.test(n) && !n.startsWith('.'));
      if (!hits.length) return [arg];
      const rel = arg.includes('/') ? arg.slice(0, arg.lastIndexOf('/') + 1) : '';
      return hits.map(h => rel + h);
    }

    /* editor support (nano / vi panel in the UI) */
    saveEditor(text) {
      const e = this.editor; if (!e) return { ok: false, msg: '', hints: [] };
      if (text && !text.endsWith('\n')) text += '\n';
      this.hints = [];
      const err = this.write(e.path, text);
      if (this.lab && this.lab.editorSaved) this.lab.editorSaved(e.path, err);
      if (err) return { ok: false, msg: `[ Error writing ${e.display}: ${err} ]`, hints: this.hints.slice() };
      e.content = text; e.saved = true; e.isNew = false;
      const n = text ? text.replace(/\n$/, '').split('\n').length : 0;
      return { ok: true, msg: e.prog === 'nano' ? `[ Wrote ${n} line${n === 1 ? '' : 's'} ]` : `"${e.display}" ${n}L, ${text.length}B written`, hints: this.hints.slice() };
    }
    closeEditor() { this.editor = null; }

    prompt() {
      if (this.heredoc) return this.heredoc.delim === null ? '' : '> ';
      if (this.interactive) return this.interactive.prompt();
      const d = this.cwd === this.home ? '~' : this.cwd.startsWith(this.home + '/') ? '~' + this.cwd.slice(this.home.length) : this.cwd;
      return `${this.user}@${this.host}:${d}${this.user === 'root' ? '#' : '$'} `;
    }

    /* main entry: one line typed by the user. Returns {out, hints} */
    input(line) {
      this.hints = [];
      this.cleared = false;
      line = String(line).replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
      let out;
      if (this.heredoc && this.heredoc.delim === null) { this.heredoc.body.push(line); out = ''; }
      else if (this.heredoc) {
        const h = this.heredoc;
        if (line.trim() === h.delim) { this.heredoc = null; out = this.runParsed(h.list, h.body.join('\n') + (h.body.length ? '\n' : '')); }
        else { h.body.push(line); out = ''; }
      } else if (this.interactive) {
        out = this.interactive.input(line);
      } else {
        if (line.trim()) this.histList.push(line);
        out = this.runLine(line);
      }
      return { out: out, hints: this.hints.slice() };
    }

    /* Ctrl+D: end a "cat > file" capture (or a heredoc, as bash does at end-of-file) */
    endInput() {
      this.hints = []; this.cleared = false;
      if (!this.heredoc) return { out: '', hints: [], ended: false };
      const h = this.heredoc; this.heredoc = null;
      const warn = h.delim !== null ? `-bash: warning: here-document delimited by end-of-file (wanted \`${h.delim}')\n` : '';
      const out = this.runParsed(h.list, h.body.join('\n') + (h.body.length ? '\n' : ''));
      return { out: (warn + out).replace(/\n$/, ''), hints: this.hints.slice(), ended: true };
    }

    runLine(line) {
      if (!line.trim()) return '';
      const env = Object.assign({ HOME: this.home, USER: this.user, HOSTNAME: this.host, PWD: this.cwd, '?': this.lastCode }, this.env);
      const tk = NL.tokenize(line, env);
      if (tk.error) return '-bash: ' + tk.error;
      const ps = NL.parse(tk.toks);
      if (ps.error) return '-bash: ' + ps.error;
      const hd = ps.list.flatMap(p => p.pipeline).find(c => c.heredoc);
      if (hd) { this.heredoc = { delim: hd.heredoc, body: [], list: ps.list }; return ''; }
      // "cat > file" (or bare cat) with no file and no input reads the terminal until Ctrl+D
      const first = ps.list[0] && ps.list[0].pipeline[0];
      if (first && first.argv[0] === 'cat' && first.argv.slice(1).every(x => /^-[nAvE]+$/.test(x)) && !first.redir.some(r => r.op === '<')) {
        first.heredoc = '\u0004';
        this.heredoc = { delim: null, body: [], list: ps.list };
        return '';
      }
      return this.runParsed(ps.list, null);
    }

    runParsed(list, heredocBody) {
      const shown = [];
      let code = 0;
      for (const item of list) {
        if (item.join === '&&' && code !== 0) continue;
        if (item.join === '||' && code === 0) continue;
        let stdin = null, res = NL.ok('');
        for (let k = 0; k < item.pipeline.length; k++) {
          const c = item.pipeline[k];
          let argv = [];
          c.argv.forEach((a, i) => { if (c.globs[i]) argv.push(...this.expandGlob(a)); else argv.push(a); });
          let input = stdin;
          if (c.heredoc && heredocBody != null) input = heredocBody;
          const inR = c.redir.find(r => r.op === '<');
          if (inR) { const d = this.read(this.resolve(inR.path)); if (d === undefined) { res = NL.fail(`-bash: ${inR.path}: No such file or directory`); break; } input = d; }
          res = argv.length ? this.exec(argv, input, k < item.pipeline.length - 1) : NL.ok('');
          if (res.interrupt) { shown.push(res.err || ''); return shown.filter(Boolean).join('\n'); }
          // redirections
          let errToOut = c.redir.some(r => r.op === '2>&1');
          for (const r of c.redir) {
            if (r.op === '>' || r.op === '>>') {
              const p = this.resolve(r.path);
              const data = res.out ? (res.out.endsWith('\n') ? res.out : res.out + '\n') : '';
              const e = this.write(p, data + (errToOut && res.err ? res.err + '\n' : ''), r.op === '>>');
              if (e) { res = NL.fail(`-bash: ${r.path}: ${e}`); break; }
              res = { out: '', err: errToOut ? '' : res.err, code: res.code };
            } else if (r.op === '2>') {
              const p = this.resolve(r.path);
              if (p !== '/dev/null') this.write(p, res.err ? res.err + '\n' : '');
              res = { out: res.out, err: '', code: res.code };
            }
          }
          if (k < item.pipeline.length - 1) { if (res.err) shown.push(res.err); stdin = res.out || ''; }
        }
        code = res.code;
        const text = [res.err, res.out].filter(Boolean).join('\n');
        if (res.out && this.lab && this.lab.onDisplay) this.lab.onDisplay(res.out, this);
        if (text) shown.push(text.replace(/\n+$/, ''));
      }
      this.lastCode = code;
      return shown.join('\n');
    }

    /* run one command (argv) with optional stdin */
    exec(argv, stdin, piped) {
      let ctx = { sudo: false, stdin: stdin, piped: piped, shell: this };
      if (/^\w+=/.test(argv[0]) && argv.length === 1) { const [k, ...v] = argv[0].split('='); this.env[k] = v.join('='); return NL.ok(); }
      if (argv[0] === 'sudo') {
        argv = argv.slice(1);
        if (!argv.length) return NL.fail('usage: sudo -h | -K | -k | -V\nusage: sudo [-u user] command');
        const suToRoot = argv[0] === 'su' && !argv.includes('-c') && !argv.some(x => x.startsWith('--command')) && argv.slice(1).every(x => ['-', '-l', '--login', 'root'].includes(x));
        if (argv[0] === 'su' && !suToRoot) return B.su.call(this, argv, { sudo: true });
        if (argv[0] === '-i' || argv[0] === '-s' || suToRoot || (argv[0] === '-u' && argv[1] === 'root' && argv.length === 2)) {
          if (this.user === 'root') return NL.ok();
          this.stack.push({ kind: 'su', user: this.user, host: this.host, cwd: this.cwd, home: this.home });
          this.user = 'root'; this.home = '/root'; this.cwd = '/root';
          return NL.ok();
        }
        if (argv[0] === '-u' && argv[1] && argv[1] !== 'root' && argv.length > 2) return B.su.call(this, ['su', argv[1], '-c', argv.slice(2).map(x => /\s/.test(x) ? `"${x}"` : x).join(' ')], { sudo: true });
        if (argv[0] === '-u') argv = argv.slice(2);
        ctx.sudo = true;
      }
      const name = argv[0];
      // The lab sees every command first and returns undefined for anything it does not own.
      if (this.lab && this.lab.exec) { const r = this.lab.exec(argv, ctx, this); if (r) return r; }
      const builtin = this.builtins[name];
      if (builtin) return builtin.call(this, argv, ctx);
      return NL.fail(`${name}: command not found`, 127);
    }
  }

  /* ---------- builtins ---------- */
  const B = {};
  const readArgsOrStdin = function (sh, files, ctx, cmd) {
    if (!files.length) return { text: ctx.stdin == null ? '' : ctx.stdin };
    let text = '', errs = [];
    for (const f of files) {
      const p = sh.resolve(f);
      if (sh.isDir(p)) { errs.push(`${cmd}: ${f}: Is a directory`); continue; }
      const g = sh.lab && sh.lab.readGuard ? sh.lab.readGuard(p, ctx, sh) : '';
      if (g) { errs.push(`${cmd}: ${f}: ${g}`); continue; }
      const d = sh.read(p);
      if (d === undefined) { errs.push(`${cmd}: ${f}: No such file or directory`); continue; }
      text += d.endsWith('\n') || !d ? d : d + '\n';
    }
    return { text: text, err: errs.join('\n') };
  };
  const linesOf = t => { const l = t.replace(/\n$/, '').split('\n'); return t ? l : []; };

  B.cat = function (a, ctx) {
    const files = a.slice(1).filter(x => !/^-[nAvE]+$/.test(x));
    const r = readArgsOrStdin(this, files, ctx, 'cat');
    if (a.includes('-n')) r.text = linesOf(r.text).map((l, i) => NL.padL(i + 1, 6) + '\t' + l).join('\n');
    return { out: r.text.replace(/\n$/, ''), err: r.err || '', code: r.err ? 1 : 0 };
  };
  B.echo = function (a) { let args = a.slice(1), nl = true; if (args[0] === '-n') { nl = false; args = args.slice(1); } if (args[0] === '-e') args = args.slice(1); return NL.ok(args.join(' ') + (nl ? '' : '')); };
  B.printf = function (a) { return NL.ok((a[1] || '').replace(/\\n/g, '\n').replace(/%s/g, () => a[2] || '')); };
  B.pwd = function () { return NL.ok(this.cwd); };
  B.whoami = function (a, ctx) { return NL.ok(ctx.sudo ? 'root' : this.user); };
  B.id = function (a, ctx) { return NL.ok(ctx.sudo || this.user === 'root' ? 'uid=0(root) gid=0(root) groups=0(root)' : `uid=1001(${this.user}) gid=1001(${this.user}) groups=1001(${this.user}),27(sudo)`); };
  B.hostname = function () { return NL.ok(this.host); };
  B.date = function () { return NL.ok(NL.dateCmd(this.now())); };
  B.true = () => NL.ok(); B.false = () => NL.fail('', 1);
  B.clear = function () { this.cleared = true; return NL.ok(); };
  B.reset = B.clear;
  B.history = function () { return NL.ok(this.histList.map((h, i) => NL.padL(i + 1, 5) + '  ' + h).join('\n')); };
  B.sleep = function (a) { const n = parseFloat(a[1]); if (isNaN(n)) return NL.fail('sleep: missing operand'); this.advance(n * 1000); return NL.ok(); };
  B.export = function (a) { a.slice(1).forEach(kv => { const [k, ...v] = kv.split('='); if (v.length) this.env[k] = v.join('='); }); return NL.ok(); };
  B.env = function () { return NL.ok(Object.entries(Object.assign({ HOME: this.home, USER: this.user, HOSTNAME: this.host, PWD: this.cwd, SHELL: '/bin/bash' }, this.env)).map(([k, v]) => k + '=' + v).join('\n')); };
  B.uname = function (a) { return NL.ok(a.includes('-a') ? `Linux ${this.host} 5.15.0-1063-nvidia #64-Ubuntu SMP x86_64 x86_64 x86_64 GNU/Linux` : a.includes('-r') ? '5.15.0-1063-nvidia' : 'Linux'); };
  B.which = function (a) {
    const outs = [], errs = [];
    a.slice(1).forEach(n => { const p = this.lab && this.lab.which ? this.lab.which(n, this) : null; if (p) outs.push(p); else if (B[n]) outs.push('/usr/bin/' + n); else errs.push(''); });
    return { out: outs.join('\n'), err: '', code: errs.length ? 1 : 0 };
  };
  B.cd = function (a) {
    const t = a[1] == null || a[1] === '~' ? this.home : a[1] === '-' ? (this.oldpwd || this.cwd) : this.resolve(a[1]);
    if (!this.exists(t) && !this.isDir(t)) return NL.fail(`-bash: cd: ${a[1]}: No such file or directory`);
    if (!this.isDir(t)) return NL.fail(`-bash: cd: ${a[1]}: Not a directory`);
    this.oldpwd = this.cwd; this.cwd = t; return NL.ok();
  };
  B.ls = function (a, ctx) {
    const flags = a.slice(1).filter(x => x.startsWith('-')).join('');
    const targets = a.slice(1).filter(x => !x.startsWith('-'));
    const long = flags.includes('l'), all = flags.includes('a');
    const outs = [], errs = [];
    const fmt = (p, n) => {
      if (!long) return n;
      const e = n === '.' || n === '..' ? { dir: true, mtime: (this.fs.get(p) || {}).mtime } : (this.fs.get(p) || {});
      const size = e.dir ? 4096 : (this.read(p) || '').length;
      const t = new Date(e.mtime || this.now());
      const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][t.getMonth()];
      const owner = p.startsWith('/home/') ? this.user : 'root';
      return `${e.dir ? 'drwxr-xr-x' : '-rw-r--r--'} 1 ${NL.padR(owner, 7)} ${NL.padR(owner, 7)} ${NL.padL(size, 6)} ${m} ${NL.padL(t.getDate(), 2)} ${two(t.getHours())}:${two(t.getMinutes())} ${n}`;
    };
    (targets.length ? targets : ['.']).forEach(t => {
      const p = this.resolve(t);
      if (!this.exists(p) && !this.isDir(p)) { errs.push(`ls: cannot access '${t}': No such file or directory`); return; }
      if (!this.isDir(p)) { outs.push(fmt(p, t)); return; }
      let names = this.listDir(p).filter(n => all || !n.startsWith('.'));
      if (all) names = ['.', '..'].concat(names);
      const body = long ? (names.length ? 'total ' + names.length * 4 + '\n' : 'total 0') + names.map(n => fmt(n === '.' ? p : n === '..' ? NL.dirname(p) : (p === '/' ? '/' + n : p + '/' + n), n)).join('\n') : names.join('  ');
      outs.push((targets.length > 1 ? t + ':\n' : '') + body);
    });
    return { out: outs.join('\n\n'), err: errs.join('\n'), code: errs.length ? 2 : 0 };
  };
  B.mkdir = function (a) {
    const p = a.includes('-p'), errs = [];
    a.slice(1).filter(x => !x.startsWith('-')).forEach(d => {
      const t = this.resolve(d);
      if (this.isDir(t)) { if (!p) errs.push(`mkdir: cannot create directory '${d}': File exists`); return; }
      if (!p && !this.isDir(dirname(t))) { errs.push(`mkdir: cannot create directory '${d}': No such file or directory`); return; }
      if (this.lab && this.lab.writeGuard) { const g = this.lab.writeGuard(t, this); if (g) { errs.push(`mkdir: cannot create directory '${d}': ${g}`); return; } }
      this.mkdirp(t);
    });
    if (a.length < 2) return NL.fail('mkdir: missing operand');
    return { out: '', err: errs.join('\n'), code: errs.length ? 1 : 0 };
  };
  B.touch = function (a) {
    const errs = [];
    a.slice(1).forEach(f => { const p = this.resolve(f); if (this.exists(p)) return; const e = this.write(p, ''); if (e) errs.push(`touch: cannot touch '${f}': ${e}`); });
    return { out: '', err: errs.join('\n'), code: errs.length ? 1 : 0 };
  };
  B.rm = function (a) {
    const flags = a.slice(1).filter(x => x.startsWith('-')).join(''), errs = [];
    a.slice(1).filter(x => !x.startsWith('-')).forEach(f => {
      const p = this.resolve(f);
      if (!this.fs.has(p)) { if (!flags.includes('f')) errs.push(`rm: cannot remove '${f}': No such file or directory`); return; }
      if (this.isDir(p) && !/r/i.test(flags)) { errs.push(`rm: cannot remove '${f}': Is a directory`); return; }
      for (const k of [...this.fs.keys()]) if (k === p || k.startsWith(p + '/')) this.fs.delete(k);
    });
    return { out: '', err: errs.join('\n'), code: errs.length ? 1 : 0 };
  };
  B.rmdir = function (a) { const p = this.resolve(a[1] || ''); if (!this.isDir(p)) return NL.fail(`rmdir: failed to remove '${a[1]}': No such file or directory`); if (this.listDir(p).length) return NL.fail(`rmdir: failed to remove '${a[1]}': Directory not empty`); this.fs.delete(p); return NL.ok(); };
  B.cp = function (a) {
    const args = a.slice(1).filter(x => !x.startsWith('-'));
    if (args.length < 2) return NL.fail("cp: missing destination file operand after '" + (args[0] || '') + "'");
    const src = this.resolve(args[0]); let dst = this.resolve(args[1]);
    const d = this.read(src); if (d === undefined) return NL.fail(`cp: cannot stat '${args[0]}': No such file or directory`);
    if (this.isDir(dst)) dst = dst + '/' + basename(src);
    const e = this.write(dst, d); return e ? NL.fail(`cp: cannot create regular file '${args[1]}': ${e}`) : NL.ok();
  };
  B.mv = function (a) {
    const r = B.cp.call(this, a); if (r.code) return { out: '', err: r.err.replace(/^cp/, 'mv'), code: 1 };
    this.fs.delete(this.resolve(a.slice(1).filter(x => !x.startsWith('-'))[0])); return NL.ok();
  };
  B.head = function (a, ctx) {
    let n = 10; const files = [];
    for (let i = 1; i < a.length; i++) { if (a[i] === '-n') n = parseInt(a[++i], 10); else if (/^-\d+$/.test(a[i])) n = parseInt(a[i].slice(1), 10); else if (/^-n\d+$/.test(a[i])) n = parseInt(a[i].slice(2), 10); else files.push(a[i]); }
    const r = readArgsOrStdin(this, files, ctx, 'head');
    return { out: linesOf(r.text).slice(0, n).join('\n'), err: r.err || '', code: r.err ? 1 : 0 };
  };
  B.tail = function (a, ctx) {
    let n = 10; const files = [];
    for (let i = 1; i < a.length; i++) { if (a[i] === '-n') n = parseInt(a[++i], 10); else if (/^-\d+$/.test(a[i])) n = parseInt(a[i].slice(1), 10); else if (/^-n\d+$/.test(a[i])) n = parseInt(a[i].slice(2), 10); else if (a[i] === '-f' || a[i] === '-F') { /* follow not simulated */ } else files.push(a[i]); }
    const r = readArgsOrStdin(this, files, ctx, 'tail');
    const l = linesOf(r.text);
    return { out: l.slice(Math.max(0, l.length - n)).join('\n'), err: r.err || '', code: r.err ? 1 : 0 };
  };
  B.grep = function (a, ctx) {
    let flags = '', pat = null; const files = [];
    for (let i = 1; i < a.length; i++) {
      if (a[i] === '-e') { pat = a[++i]; continue; }
      if (/^-[a-zA-Z]+$/.test(a[i]) && pat === null) { flags += a[i].slice(1); continue; }
      if (pat === null) pat = a[i]; else files.push(a[i]);
    }
    if (pat === null) return NL.fail("Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.", 2);
    let re;
    try {
      let src = flags.includes('E') ? pat : pat.replace(/\\\|/g, '\u0000').replace(/[+?(){}|]/g, '\\$&').replace(/\u0000/g, '|');
      if (flags.includes('F')) src = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (flags.includes('w')) src = '\\b(?:' + src + ')\\b';
      re = new RegExp(src, flags.includes('i') ? 'i' : '');
    } catch (e) { return NL.fail('grep: Invalid regular expression', 2); }
    const r = readArgsOrStdin(this, files, ctx, 'grep');
    let hits = linesOf(r.text).map((l, i) => [l, i + 1]).filter(([l]) => re.test(l) !== flags.includes('v'));
    if (flags.includes('c')) return NL.ok(String(hits.length));
    const out = hits.map(([l, i]) => (flags.includes('n') ? i + ':' : '') + l).join('\n');
    return { out: out, err: r.err || '', code: hits.length ? 0 : 1 };
  };
  B.wc = function (a, ctx) {
    const files = a.slice(1).filter(x => !x.startsWith('-'));
    const r = readArgsOrStdin(this, files, ctx, 'wc');
    const l = (r.text.match(/\n/g) || []).length, w = (r.text.match(/\S+/g) || []).length, c = r.text.length;
    if (a.includes('-l')) return NL.ok(String(l) + (files[0] ? ' ' + files[0] : ''));
    if (a.includes('-w')) return NL.ok(String(w));
    return NL.ok(`${NL.padL(l, 7)} ${NL.padL(w, 7)} ${NL.padL(c, 7)}${files[0] ? ' ' + files[0] : ''}`);
  };
  B.sort = function (a, ctx) { const r = readArgsOrStdin(this, a.slice(1).filter(x => !x.startsWith('-')), ctx, 'sort'); let l = linesOf(r.text).sort(); if (a.includes('-r')) l.reverse(); return NL.ok(l.join('\n')); };
  B.uniq = function (a, ctx) { const r = readArgsOrStdin(this, a.slice(1).filter(x => !x.startsWith('-')), ctx, 'uniq'); return NL.ok(linesOf(r.text).filter((l, i, arr) => i === 0 || arr[i - 1] !== l).join('\n')); };
  B.less = function (a, ctx) { const files = a.slice(1).filter(x => !x.startsWith('-')); const r = readArgsOrStdin(this, files, ctx, a[0]); return { out: r.text.replace(/\n$/, ''), err: r.err || '', code: r.err ? 1 : 0 }; };
  B.more = B.less;
  B.tee = function (a, ctx) {
    const app = a.includes('-a'); const text = ctx.stdin || '';
    for (const f of a.slice(1).filter(x => !x.startsWith('-'))) { const e = this.write(this.resolve(f), text, app); if (e) return NL.fail(`tee: ${f}: ${e}`, 1, text.replace(/\n$/, '')); }
    return NL.ok(text.replace(/\n$/, ''));
  };
  const openEditor = function (a, ctx) {
    const f = a.slice(1).filter(x => !x.startsWith('-') && !x.startsWith('+'))[0];
    if (!f) return NL.fail(a[0] === 'nano' ? 'nano: no file name given (this simulator needs one: nano /path/file.yaml)' : `${a[0]}: give a file name (this simulator needs one)`);
    const p = this.resolve(f);
    if (this.isDir(p)) return NL.fail(`${a[0]}: ${f}: Is a directory`);
    this.editor = { path: p, display: f, content: this.read(p) || '', prog: a[0], isNew: !this.exists(p), saved: true };
    return NL.ok();
  };
  B.nano = openEditor; B.vi = openEditor; B.vim = openEditor;
  B.exit = function () {
    const f = this.stack.pop();
    if (!f) { this.hint('There is nothing to log out of here. Use the lab tabs or Reset to start over.'); return NL.ok('logout'); }
    const wasHost = this.host;
    this.user = f.user; this.host = f.host; this.cwd = f.cwd; this.home = f.home;
    return NL.ok(f.kind === 'ssh' ? `logout\nConnection to ${wasHost} closed.` : 'logout');
  };
  B.logout = B.exit;
  B.man = function (a) {
    const page = this.lab && this.lab.man ? this.lab.man(a[1], this) : null;
    return page ? NL.ok(page) : NL.fail(`No manual entry for ${a[1] || ''}`.trim(), 16);
  };
  B.ssh = function (a, ctx) {
    let ti = 1;
    while (ti < a.length && a[ti].startsWith('-')) ti += /^-[bcDEeFIiJLlmOopQRSWw]$/.test(a[ti]) ? 2 : 1; // skip ssh options (and their values)
    const target = (a[ti] || '').replace(/^.*@/, '');
    if (!target) return NL.fail('usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] destination [command]', 255);
    const hosts = this.lab && this.lab.hosts ? this.lab.hosts(this) : [];
    if (!hosts.includes(target)) return NL.fail(`ssh: Could not resolve hostname ${target}: Name or service not known`, 255);
    const rest = a.slice(ti + 1);
    this.stack.push({ kind: 'ssh', user: this.user, host: this.host, cwd: this.cwd, home: this.home });
    this.host = target;
    if (this.user === 'root') { this.home = '/root'; this.cwd = '/root'; } else this.cwd = this.home;
    if (rest.length) {
      // like real ssh, the remote command is one string run by the remote shell: ssh node002 "systemctl status slurmd"
      const remote = rest.map(x => rest.length > 1 && /\s/.test(x) ? `"${x}"` : x).join(' ');
      let out;
      if (ctx && ctx.stdin != null) {
        // local pipe into the remote command: munge -n | ssh node002 unmunge
        const env = Object.assign({ HOME: this.home, USER: this.user, HOSTNAME: this.host, PWD: this.cwd, '?': this.lastCode }, this.env);
        const tk = NL.tokenize(remote, env); const ps = tk.error ? null : NL.parse(tk.toks);
        if (ps && !ps.error && ps.list.length) { ps.list[0].pipeline[0].heredoc = '\u0004'; out = this.runParsed(ps.list, ctx.stdin); }
        else out = this.runLine(remote);
      } else out = this.runLine(remote);
      const code = this.lastCode;
      const f = this.stack.pop(); this.user = f.user; this.host = f.host; this.cwd = f.cwd; this.home = f.home;
      return { out: out, err: '', code: code };
    }
    const banner = this.lab && this.lab.sshBanner ? this.lab.sshBanner(target, this) : '';
    return NL.ok(banner || `Last login: ${NL.dateCmd(this.now() - 86400000)} from headnode`);
  };
  B.su = function (a, ctx) {
    let login = false, target = 'root', cmd = null;
    for (let i = 1; i < a.length; i++) {
      const x = a[i];
      if (x === '-' || x === '-l' || x === '--login') login = true;
      else if (x === '-c' || x === '--command') cmd = a[++i];
      else if (x.startsWith('--command=')) cmd = x.slice(10);
      else if (/^-[^-]/.test(x)) {
        // short options like real su (util-linux): -l -m -p -f -P take no value; -c -g -G -s -w take one
        for (let j = 1; j < x.length; j++) {
          const ch = x[j];
          if ('lmpfP'.includes(ch)) { if (ch === 'l') login = true; continue; }
          if ('cgGsw'.includes(ch)) { const v = x.slice(j + 1) || a[++i]; if (ch === 'c') cmd = v; break; }
          return NL.fail(`su: invalid option -- '${ch}'\nTry 'su --help' for more information.`);
        }
      }
      else if (!x.startsWith('-')) target = x;
    }
    const known = this.lab && this.lab.users ? this.lab.users(this) : ['root', this.user];
    if (!known.includes(target)) return NL.fail(`su: user ${target} does not exist or the user entry does not contain all the required fields`);
    if (!(this.user === 'root' || (ctx && ctx.sudo)) && target !== this.user) return NL.fail('Password: \nsu: Authentication failure');
    const home = target === 'root' ? '/root' : '/home/' + target;
    if (cmd == null) {
      this.stack.push({ kind: 'su', user: this.user, host: this.host, cwd: this.cwd, home: this.home });
      this.user = target; this.home = home; if (login) this.cwd = this.isDir(home) ? home : '/';
      return NL.ok();
    }
    const saved = { user: this.user, home: this.home, cwd: this.cwd };
    this.user = target; this.home = home; if (login) this.cwd = this.isDir(home) ? home : '/';
    const out = this.runLine(cmd);
    const code = this.lastCode;
    this.user = saved.user; this.home = saved.home; this.cwd = saved.cwd;
    return { out: out, err: '', code: code };
  };
  B.bash = function (a) {
    const ci = a.indexOf('-c');
    if (ci < 0) return NL.ok(); // an interactive subshell is not simulated
    return { out: this.runLine(a[ci + 1] || ''), err: '', code: this.lastCode };
  };
  B.sh = B.bash;
  Shell.prototype.builtins = B;
  NL.builtinNames = () => Object.keys(B);
  NL.Shell = Shell;

  /* ---------- tab completion ---------- */
  NL.complete = function (sh, line) {
    if (sh.interactive && sh.interactive.complete) return sh.interactive.complete(line);
    const m = /(\S*)$/.exec(line); const word = m[1]; const before = line.slice(0, line.length - word.length);
    const first = !before.trim() || /(\||;|&&|sudo)\s*$/.test(before);
    let cands;
    if (first && !word.includes('/')) {
      cands = [...new Set(NL.builtinNames().concat(sh.lab && sh.lab.commands ? sh.lab.commands(sh) : []))].filter(c => c.startsWith(word));
      cands = cands.map(c => c + ' ');
    } else {
      const dirPart = word.includes('/') ? word.slice(0, word.lastIndexOf('/') + 1) : '';
      const base = word.slice(dirPart.length);
      const dir = sh.resolve(dirPart || '.');
      if (!sh.isDir(dir)) return { line: line, options: [] };
      cands = sh.listDir(dir).filter(n => n.startsWith(base) && (base.startsWith('.') || !n.startsWith('.'))).map(n => dirPart + n + (sh.isDir(NL.normPath(n, dir, sh.home)) ? '/' : ' '));
    }
    if (!cands.length) return { line: line, options: [] };
    if (cands.length === 1) return { line: before + cands[0], options: [] };
    let pre = cands[0];
    cands.forEach(c => { while (!c.startsWith(pre)) pre = pre.slice(0, -1); });
    return { line: before + pre, options: cands.map(c => c.trim().replace(/^.*\/(?=.)/, '')) };
  };

  /* ---------- tiny YAML subset parser (enough for Kubernetes manifests and setup configs) ----------
   * Supports: mappings, sequences (incl. "- key: v" items and same-indent sequences), quoted/plain scalars,
   * flow sequences/maps, block scalars (| and >), comments, multiple documents (---).
   * Errors are phrased like go-yaml so kubectl-style messages look familiar. */
  NL.yaml = (function () {
    class YErr extends Error { constructor(line, msg) { super(`yaml: line ${line}: ${msg}`); this.line = line; } }
    function scalar(s, ln) {
      s = s.trim();
      if (s === '' || s === '~' || s === 'null') return null;
      if (s.startsWith('"')) { if (!s.endsWith('"') || s.length < 2) throw new YErr(ln, 'found unexpected end of stream'); return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n'); }
      if (s.startsWith("'")) { if (!s.endsWith("'") || s.length < 2) throw new YErr(ln, 'found unexpected end of stream'); return s.slice(1, -1).replace(/''/g, "'"); }
      if (s.startsWith('[')) return flow(s, ln);
      if (s.startsWith('{')) return flow(s, ln);
      if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
      if (/^-?\d+$/.test(s)) return parseInt(s, 10);
      if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
      if (/^[&*!]/.test(s)) return s;
      if (/:\s/.test(s) || /:$/.test(s)) throw new YErr(ln, 'mapping values are not allowed in this context');
      return s;
    }
    function flow(s, ln) {
      let i = 0;
      const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
      function val() {
        ws();
        if (s[i] === '[') { i++; const arr = []; ws(); if (s[i] === ']') { i++; return arr; } for (;;) { arr.push(val()); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === ']') { i++; return arr; } throw new YErr(ln, "did not find expected ',' or ']'"); } }
        if (s[i] === '{') { i++; const obj = {}; ws(); if (s[i] === '}') { i++; return obj; } for (;;) { ws(); let k = ''; while (i < s.length && s[i] !== ':') k += s[i++]; if (s[i] !== ':') throw new YErr(ln, "did not find expected ',' or '}'"); i++; obj[k.trim().replace(/^["']|["']$/g, '')] = val(); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === '}') { i++; return obj; } throw new YErr(ln, "did not find expected ',' or '}'"); } }
        if (s[i] === '"' || s[i] === "'") { const q = s[i]; let j = i + 1, out = ''; while (j < s.length && s[j] !== q) { if (s[j] === '\\' && q === '"') { out += s[j + 1]; j += 2; continue; } out += s[j++]; } if (j >= s.length) throw new YErr(ln, 'found unexpected end of stream'); i = j + 1; return out; }
        let t = ''; while (i < s.length && !',]}'.includes(s[i])) t += s[i++];
        return scalar(t, ln);
      }
      const v = val(); ws();
      if (i < s.length) throw new YErr(ln, 'did not find expected <document start>');
      return v;
    }
    function stripComment(l) {
      let q = null;
      for (let i = 0; i < l.length; i++) { const c = l[i]; if (q) { if (c === q) q = null; continue; } if (c === '"' || c === "'") { if (i === 0 || /[\s:\-\[,{]/.test(l[i - 1])) q = c; continue; } if (c === '#' && (i === 0 || /\s/.test(l[i - 1]))) return l.slice(0, i); }
      return l;
    }
    function splitKey(text) {
      // returns [key, rest] if text is "key: rest" / "key:" (outside quotes), else null
      let q = null;
      for (let i = 0; i < text.length; i++) { const c = text[i]; if (q) { if (c === q) q = null; continue; } if ((c === '"' || c === "'") && i === 0) { q = c; continue; } if (c === '[' || c === '{') return null; if (c === ':' && (i + 1 === text.length || text[i + 1] === ' ')) return [text.slice(0, i).trim().replace(/^["']|["']$/g, ''), text.slice(i + 1)]; }
      return null;
    }
    function parseDoc(raw, lineOffset) {
      const src = raw.split('\n');
      const lines = [];
      src.forEach((l, i) => {
        const ln = i + 1 + lineOffset;
        if (/^\s*\t/.test(l) || /^ *\t/.test(l)) throw new YErr(ln, 'found character that cannot start any token');
        lines.push({ ln: ln, raw: l, text: stripComment(l).replace(/\s+$/, ''), ind: l.length - l.replace(/^ +/, '').length });
      });
      let p = 0;
      const skip = () => { while (p < lines.length && !lines[p].text.trim()) p++; };
      function block(ind) {
        skip();
        if (p >= lines.length) return null;
        const L = lines[p];
        if (L.ind < ind) return null;
        if (L.text.trim().startsWith('- ') || L.text.trim() === '-') return seq(L.ind);
        if (splitKey(L.text.trim())) return map(L.ind);
        p++;
        const v = scalar(L.text, L.ln);
        skip();
        if (p < lines.length && lines[p].ind > L.ind) throw new YErr(lines[p].ln, 'mapping values are not allowed in this context');
        return v;
      }
      function blockScalar(style, parentInd) {
        const out = []; let bi = null;
        while (p < lines.length) {
          const L = lines[p];
          if (L.raw.trim() === '') { out.push(''); p++; continue; }
          if (L.ind <= parentInd) break;
          if (bi === null) bi = L.ind;
          out.push(L.raw.slice(bi)); p++;
        }
        while (out.length && out[out.length - 1] === '') out.pop();
        return style.startsWith('|') ? out.join('\n') + '\n' : out.join(' ') + '\n';
      }
      function value(rest, keyInd, ln) {
        const r = rest.trim();
        if (r === '') {
          skip();
          if (p < lines.length && (lines[p].ind > keyInd || (lines[p].ind === keyInd && /^- |^-$/.test(lines[p].text.trim())))) {
            const ind = lines[p].ind;
            if (lines[p].ind === keyInd) return seq(ind);
            return block(ind);
          }
          return null;
        }
        if (/^[|>][-+]?$/.test(r)) return blockScalar(r, keyInd);
        const v = scalar(r, ln);
        return v;
      }
      function map(ind) {
        const obj = {};
        while (true) {
          skip();
          if (p >= lines.length) break;
          const L = lines[p];
          if (L.ind < ind) break;
          if (L.ind > ind) throw new YErr(L.ln, 'mapping values are not allowed in this context');
          const t = L.text.trim();
          if (t.startsWith('- ')) { throw new YErr(L.ln, 'did not find expected key'); }
          const kv = splitKey(t);
          if (!kv) throw new YErr(L.ln, 'could not find expected \':\'');
          p++;
          if (Object.prototype.hasOwnProperty.call(obj, kv[0])) throw new YErr(L.ln, `key "${kv[0]}" already set in map`);
          obj[kv[0]] = value(kv[1], ind, L.ln);
          skip();
          if (p < lines.length && lines[p].ind > ind && lines[p].ind !== ind) {
            // over-indented line after a scalar value
            throw new YErr(lines[p].ln, 'mapping values are not allowed in this context');
          }
          if (p < lines.length && lines[p].ind < ind && lines[p].ind > 0) {
            // check dedent lands on a known level is handled by callers
          }
        }
        return obj;
      }
      function seq(ind) {
        const arr = [];
        while (true) {
          skip();
          if (p >= lines.length) break;
          const L = lines[p];
          if (L.ind < ind) break;
          const t = L.text.trim();
          if (L.ind > ind) throw new YErr(L.ln, 'did not find expected \'-\' indicator');
          if (!(t.startsWith('- ') || t === '-')) { if (splitKey(t)) break; throw new YErr(L.ln, 'did not find expected \'-\' indicator'); }
          const rest = t === '-' ? '' : t.slice(2);
          const itemInd = L.ind + 2 + (rest.length - rest.replace(/^ +/, '').length);
          if (rest.trim() === '') { p++; arr.push(block(ind + 1)); continue; }
          const kv = splitKey(rest.trim());
          if (kv) {
            // rewrite this line as a mapping line at itemInd
            lines[p] = { ln: L.ln, raw: ' '.repeat(itemInd) + rest.trim(), text: ' '.repeat(itemInd) + rest.trim(), ind: itemInd };
            arr.push(map(itemInd));
          } else if (rest.trim().startsWith('- ')) {
            lines[p] = { ln: L.ln, raw: ' '.repeat(itemInd) + rest.trim(), text: ' '.repeat(itemInd) + rest.trim(), ind: itemInd };
            arr.push(seq(itemInd));
          } else { p++; arr.push(scalar(rest, L.ln)); }
        }
        return arr;
      }
      skip();
      if (p >= lines.length) return null;
      const startInd = lines[p].ind;
      const v = block(startInd);
      skip();
      if (p < lines.length) {
        const L = lines[p];
        throw new YErr(L.ln, L.ind > startInd ? 'mapping values are not allowed in this context' : 'did not find expected key');
      }
      return v;
    }
    function parseAll(text) {
      const docs = []; const parts = text.split(/^---[ \t]*$/m);
      let offset = 0;
      parts.forEach(part => { const d = parseDoc(part, offset); offset += part.split('\n').length; if (d !== null && d !== undefined) docs.push(d); });
      return docs;
    }
    function dump(v, ind) {
      ind = ind || 0; const sp = ' '.repeat(ind);
      const sc = x => x === null ? 'null' : typeof x === 'string' ? (/^[\w./:@-][\w ./:@=-]*$/.test(x) && !/^(true|false|null|\d+)$/i.test(x) && !/: /.test(x) ? x : JSON.stringify(x)) : String(x);
      if (Array.isArray(v)) {
        if (!v.length) return sp + '[]';
        return v.map(x => {
          if (x && typeof x === 'object' && !Array.isArray(x)) { const body = dump(x, ind + 2).replace(/^ +/, ''); return sp + '- ' + body; }
          return sp + '- ' + (Array.isArray(x) ? JSON.stringify(x) : sc(x));
        }).join('\n');
      }
      if (v && typeof v === 'object') {
        return Object.keys(v).map(k => {
          const x = v[k];
          if (x && typeof x === 'object' && !(Array.isArray(x) && !x.length) && !(Object.keys(x).length === 0)) return sp + k + ':\n' + dump(x, Array.isArray(x) ? ind : ind + 2);
          if (x && typeof x === 'object') return sp + k + ': ' + (Array.isArray(x) ? '[]' : '{}');
          return sp + k + ': ' + sc(x);
        }).join('\n');
      }
      return sp + sc(v);
    }
    return { parse: parseAll, dump: dump, YErr: YErr };
  })();
})(typeof window !== 'undefined' ? window : globalThis);
