/* NAVIA Lab 3 – Base Command Manager (cmsh): clone a software image and a category, assign the image,
 * add a physical node, save a cm-kubernetes-setup configuration and deploy from it.
 * Simulation for training only. Prompts and staged/committed behaviour follow cmsh conventions;
 * the setup wizard is a text approximation of the real ncurses dialog. */
(function (G) {
  'use strict';
  const NL = G.NaviaLab;
  const { ok, fail, padR } = NL;
  const MAC = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
  const IP = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
  const HOST = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/i;
  const center8 = t => { const l = Math.floor((8 - t.length) / 2); return '[' + ' '.repeat(l) + t + ' '.repeat(8 - t.length - l) + ']'; };

  function create(cfg) {
    const mode = cfg.mode || 'practice', practice = mode === 'practice';
    const seed = cfg.seed >>> 0, r = NL.rng(seed);
    const sh = new NL.Shell({ mode: mode, user: 'root', host: 'headnode', home: '/root', now: cfg.now });
    const hx = () => NL.hex(r, 2).toUpperCase();
    const P = practice ? { image: 'dgx-training', category: 'gpu-training', node: 'gpu004', ip: '10.141.0.44', mac: '02:00:00:00:04:04', cfgPath: '/root/cm-kubernetes-setup.conf', seed: seed } : {
      image: NL.pick(r, ['ai-image', 'gpu-image', 'dgx-image-v2', 'train-img']), category: NL.pick(r, ['gpu-nodes', 'dgx-workers', 'ai-compute', 'k8s-workers']),
      node: NL.pick(r, ['gpu005', 'dgx007', 'gpu012', 'dgx003']), ip: `10.141.${NL.int(r, 0, 3)}.${NL.int(r, 50, 250)}`, mac: `FA:16:3E:${hx()}:${hx()}:${hx()}`,
      cfgPath: NL.pick(r, ['/root/cm-kubernetes-setup.conf', '/root/k8s-setup.conf', '/root/configs/kubernetes.conf']), seed: seed
    };
    ['/cm', '/cm/images', '/cm/shared', '/cm/local'].forEach(d => sh.mkdirp(d));
    const t0 = sh.now();

    /* ---- objects: {data, stage (uncommitted copy or null), isNew, from} ---- */
    const obj = (data, extra) => Object.assign({ data: data, stage: null, isNew: false }, extra || {});
    const store = {
      softwareimage: { 'default-image': obj({ name: 'default-image', path: '/cm/images/default-image', kernelversion: '5.15.0-1063-nvidia', kernelparameters: '', locked: 'no', notes: '', created: t0 - 86400e3 * 40 }) },
      category: { default: obj({ name: 'default', softwareimage: 'default-image', installmode: 'AUTO', newnodeinstallmode: 'FULL', defaultgateway: '10.141.255.254', nameservers: '', roles: '', notes: '' }) },
      device: {
        headnode: obj({ type: 'HeadNode', hostname: 'headnode', mac: 'FA:16:3E:0A:11:01', ip: '10.141.255.254', network: 'internalnet', category: '', softwareimage: '', status: 'UP', notes: '' }),
        node001: obj({ type: 'PhysicalNode', hostname: 'node001', mac: 'FA:16:3E:5C:21:0A', ip: '10.141.0.1', network: 'internalnet', category: 'default', softwareimage: '', status: 'UP', notes: '' }),
        node002: obj({ type: 'PhysicalNode', hostname: 'node002', mac: 'FA:16:3E:5C:21:0B', ip: '10.141.0.2', network: 'internalnet', category: 'default', softwareimage: '', status: 'UP', notes: '' }),
        node003: obj({ type: 'PhysicalNode', hostname: 'node003', mac: 'FA:16:3E:5C:21:0C', ip: '10.141.0.3', network: 'internalnet', category: 'default', softwareimage: '', status: 'UP', notes: '' })
      }
    };
    const ev = { quitDirty: false, wrongClone: [] };
    let k8s = null; // deployed cluster {configPath, workers, controlPlane, version, name, method}
    let moduleLoaded = false;
    const view = o => o.stage || o.data;
    const committed = (mode, name) => { const o = store[mode][name]; return o && !o.isNew ? o : null; };
    const modified = mode => Object.values(store[mode]).some(o => o.stage);
    const nodesInCategory = c => Object.values(store.device).filter(o => !o.isNew && o.data.category === c).length;
    const nodesUsingImage = img => Object.values(store.device).filter(o => !o.isNew && o.data.type === 'PhysicalNode' && (o.data.softwareimage || (committed('category', o.data.category) || { data: {} }).data.softwareimage) === img).length;

    /* ---- cmsh ---- */
    const MODES = ['softwareimage', 'category', 'device', 'network', 'partition', 'kubernetes', 'main'];
    const PROPS = {
      softwareimage: [['name', 'Name'], ['path', 'Path'], ['kernelversion', 'Kernel version'], ['kernelparameters', 'Kernel parameters'], ['locked', 'Locked'], ['notes', 'Notes']],
      category: [['name', 'Name'], ['softwareimage', 'Software image'], ['defaultgateway', 'Default gateway'], ['nameservers', 'Name servers'], ['installmode', 'Install mode'], ['newnodeinstallmode', 'New node install mode'], ['roles', 'Roles'], ['notes', 'Notes']],
      device: [['hostname', 'Hostname'], ['type', 'Type'], ['category', 'Category'], ['softwareimage', 'Software image'], ['mac', 'MAC'], ['ip', 'IP'], ['network', 'Network'], ['provisioninginterface', 'Provisioning interface'], ['installmode', 'Install mode'], ['notes', 'Notes']]
    };
    function newSession() { return { mode: '', sel: null }; }
    let cs = null; // interactive cmsh session
    const pfx = s => `[headnode${s.mode ? '->' + s.mode + (store[s.mode] && modified(s.mode) ? '*' : '') : ''}${s.sel ? `[${s.sel}${store[s.mode][s.sel] && store[s.mode][s.sel].stage ? '*' : ''}]` : ''}]% `;
    const notice = text => `${NL.dateCmd(sh.now())} [notice] headnode: ${text}`;
    const stage = o => { if (!o.stage) o.stage = JSON.parse(JSON.stringify(o.data)); return o.stage; };

    function showTable(rows) {
      const w = Math.max(32, ...rows.map(x => x[0].length));
      return [padR('Parameter', w) + ' ' + 'Value', '-'.repeat(w) + ' ' + '-'.repeat(48)].concat(rows.map(x => padR(x[0], w) + ' ' + (x[1] === '' || x[1] == null ? '' : x[1]))).join('\n');
    }
    function show(s, name) {
      const m = s.mode; const o = store[m] && store[m][name];
      if (!o) return fail(`Unable to find ${m} object: ${name}`);
      const d = view(o);
      if (m === 'softwareimage') return ok(showTable([['Name', d.name], ['Revision', ''], ['Path', d.path], ['Kernel version', d.kernelversion], ['Kernel parameters', d.kernelparameters || 'rdblacklist=nouveau'], ['Locked', d.locked], ['Creation time', NL.dateCmd(d.created || t0)], ['Nodes', String(nodesUsingImage(d.name))], ['Enable SOL', 'no'], ['Boot FSPart', '98784247810'], ['Notes', d.notes ? '<' + d.notes.length + 'B>' : '<0B>']]));
      if (m === 'category') return ok(showTable([['Name', d.name], ['Revision', ''], ['Software image', d.softwareimage], ['Nodes', String(nodesInCategory(d.name))], ['Default gateway', d.defaultgateway], ['Name servers', d.nameservers], ['Install mode', d.installmode], ['New node install mode', d.newnodeinstallmode], ['Roles', d.roles], ['Management network', 'internalnet'], ['Notes', d.notes ? '<' + d.notes.length + 'B>' : '<0B>']]));
      if (m === 'device') return ok(showTable([['Hostname', d.hostname], ['Type', d.type], ['Category', d.category], ['Software image', d.softwareimage || (d.category ? `(${d.category}->${(committed('category', d.category) || { data: {} }).data.softwareimage || ''})` : '')], ['MAC', d.mac], ['IP', d.ip], ['Network', d.network], ['Provisioning interface', d.type === 'HeadNode' ? '' : 'BOOTIF'], ['Install mode', d.installmode || ''], ['Status', d.status || 'DOWN'], ['Rack', ''], ['Notes', d.notes ? '<' + d.notes.length + 'B>' : '<0B>']]));
      return ok('');
    }
    function list(s) {
      const m = s.mode;
      if (m === 'softwareimage') return ok(NL.table(['Name (key)', 'Path (key)', 'Kernel version', 'Nodes'], Object.values(store.softwareimage).map(o => { const d = view(o); return [d.name, d.path, d.kernelversion, String(nodesUsingImage(d.name))]; }), { rule: true, sep: ' ' }));
      if (m === 'category') return ok(NL.table(['Name (key)', 'Software image', 'Nodes'], Object.values(store.category).map(o => { const d = view(o); return [d.name, d.softwareimage, String(nodesInCategory(d.name))]; }), { rule: true, sep: ' ' }));
      if (m === 'device') return ok(NL.table(['Type', 'Hostname (key)', 'MAC', 'Category', 'IP', 'Network', 'Status'], Object.values(store.device).map(o => { const d = view(o); return [d.type, d.hostname, d.mac, d.category, d.ip, d.network, center8(d.status || 'DOWN')]; }), { rule: true, sep: ' ' }));
      if (m === 'network') return ok(NL.table(['Name (key)', 'Type', 'Netmask bits', 'Base address', 'Domain name', 'IPv6'], [['externalnet', 'External', '24', '192.168.200.0', 'cm.cluster', 'no'], ['globalnet', 'Global', '0', '0.0.0.0', 'cm.cluster', ''], ['internalnet', 'Internal', '16', '10.141.0.0', 'eth.cluster', 'no'], ['ipminet', 'Internal', '16', '10.148.0.0', 'ipmi.cluster', 'no']], { rule: true, sep: ' ' }));
      if (m === 'partition') return ok(NL.table(['Name (key)', 'Cluster name'], [['base', 'BCM 10.0 Cluster']], { rule: true, sep: ' ' }));
      if (m === 'kubernetes') return ok(NL.table(['Name (key)', 'Version', 'Nodes'], k8s ? [[k8s.name, 'v' + k8s.version, String(k8sNodes().length)]] : [], { rule: true, sep: ' ' }));
      return ok('');
    }
    function cmshLine(s, line) {
      const tk = NL.tokenize(line, {});
      if (tk.error) return fail('Syntax error: ' + tk.error);
      // split on ';'
      const cmds = [[]];
      tk.toks.forEach(t => { if (t.t === 'op' && t.v === ';') cmds.push([]); else if (t.t === 'w') cmds[cmds.length - 1].push(t.v); else cmds[cmds.length - 1].push(t.v); });
      const outs = [];
      for (const a of cmds) { if (!a.length) continue; const r2 = cmshCmd(s, a); if (r2.quit) { outs.push(r2.out); return { out: outs.filter(Boolean).join('\n'), quit: true }; } const t = [r2.err, r2.out].filter(Boolean).join('\n'); if (t) outs.push(t); }
      return { out: outs.join('\n') };
    }
    function cmshCmd(s, a) {
      let c = a[0];
      const m = s.mode;
      if (MODES.includes(c)) {
        s.mode = c === 'main' ? 'main' : c; s.sel = null;
        if (a.length > 1) return cmshCmd(s, a.slice(1));
        return ok('');
      }
      if (c === 'ds') return cmshCmd({ mode: 'device', sel: null }, ['status'].concat(a.slice(1)));
      switch (c) {
        case 'quit': {
          const dirty = ['softwareimage', 'category', 'device'].some(modified);
          if (dirty) { ev.quitDirty = true; ['softwareimage', 'category', 'device'].forEach(mm => Object.keys(store[mm]).forEach(k => { const o = store[mm][k]; if (o.isNew) delete store[mm][k]; else o.stage = null; })); if (practice) sh.hint('You left cmsh with uncommitted changes, so they were discarded. Always run commit before you leave a mode.'); }
          return { out: '', quit: true };
        }
        case 'exit': case '..':
          if (s.sel) { s.sel = null; return ok(''); }
          if (s.mode) { s.mode = ''; return ok(''); }
          return cmshCmd(s, ['quit']);
        case 'home': case 'top': case '/': s.mode = ''; s.sel = null; return ok('');
        case 'help': return ok(['================================== Top ===================================', 'alias ......................... Set aliases', 'category ...................... Enter category mode', 'commit ........................ Commit local changes', 'device ........................ Enter device mode', 'exit .......................... Exit from current object or mode', 'help .......................... Display this help', 'kubernetes .................... Enter kubernetes mode', 'list .......................... List objects in current mode', 'modified ...................... List modified objects', 'network ....................... Enter network mode', 'partition ..................... Enter partition mode', 'quit .......................... Quit shell', 'refresh ....................... Revert local changes', 'softwareimage ................. Enter softwareimage mode', '', '=============================== Object mode ===============================', 'add ........................... Create a new object', 'clone ......................... Clone an object', 'get ........................... Get a property', 'remove ........................ Remove an object', 'set ........................... Set a property', 'show .......................... Show object properties', 'use ........................... Use the specified object', 'status ........................ (device mode) Show device status'].join('\n'));
        case 'modified': {
          const rows = [];
          ['softwareimage', 'category', 'device'].forEach(mm => Object.values(store[mm]).filter(o => o.stage).forEach(o => rows.push([o.isNew ? '+' : '', mm[0].toUpperCase() + mm.slice(1), view(o).name || view(o).hostname])));
          return ok(rows.length ? NL.table(['State', 'Type', 'Name'], rows, { rule: true, sep: ' ' }) : 'No modified objects of type: ' + (m || 'any'));
        }
      }
      if (!m || m === 'main') {
        if (['list', 'ls', 'show', 'use', 'set', 'get', 'clone', 'add', 'commit', 'remove', 'refresh', 'status'].includes(c)) {
          if (c === 'commit') return ok('');
          if (practice) sh.hint('You are at the top level of cmsh. Enter a mode first: softwareimage, category or device.');
          return fail(`Unknown command: ${c}. Enter a mode first (softwareimage, category, device, ...)`);
        }
        return fail(`Unknown command: ${a.join(' ')}`);
      }
      const coll = store[m];
      const editable = !!PROPS[m];
      switch (c) {
        case 'list': case 'ls': return list(s);
        case 'use': {
          const n = a[1];
          if (!n) return fail('use requires an object name');
          if (m === 'network' || m === 'partition' || m === 'kubernetes') { s.sel = n; return ok(''); }
          if (!coll[n]) return fail(`Unable to find ${m}: ${n}`);
          s.sel = n; return ok('');
        }
        case 'show': {
          const n = a[1] || s.sel;
          if (!n) return fail('show: no object selected. Use "use <name>" or "show <name>"');
          if (!editable) return ok(showTable([['Name', n]]));
          return show(s, n);
        }
        case 'status': {
          if (m !== 'device') return fail('Unknown command: status');
          const ni = a.indexOf('-n'); const only = ni >= 0 ? (a[ni + 1] || '').split(',') : (a[1] && !a[1].startsWith('-') ? [a[1]] : s.sel ? [s.sel] : null);
          const lines = Object.values(store.device).filter(o => !only || only.includes(view(o).hostname)).map(o => { const d = view(o); return `${padR(d.hostname, 16)} ${center8(d.status || 'DOWN')}${o.isNew ? ' (uncommitted)' : ''}`; });
          return ok(lines.join('\n'));
        }
        case 'get': {
          if (!editable) return fail('get is not available in this mode');
          let n = s.sel, prop = a[1];
          if (a.length >= 3) { n = a[1]; prop = a[2]; }
          if (!n) return fail('get: no object selected');
          const o = coll[n]; if (!o) return fail(`Unable to find ${m}: ${n}`);
          const key = (prop || '').toLowerCase();
          if (!PROPS[m].some(p => p[0] === key)) return fail(`Invalid property: ${prop || ''}`);
          return ok(String(view(o)[key] || ''));
        }
        case 'set': {
          if (!editable) return fail('set is not available in this mode');
          let n = s.sel, prop = a[1], val = a.slice(2);
          if (a.length >= 4 && coll[a[1]]) { n = a[1]; prop = a[2]; val = a.slice(3); }
          if (!n) { if (practice) sh.hint(`Select the object first: use <name> (for example use ${m === 'category' ? P.category : m === 'device' ? P.node : P.image}).`); return fail('set: no object selected. Use "use <name>" first'); }
          const o = coll[n]; if (!o) return fail(`Unable to find ${m}: ${n}`);
          const key = (prop || '').toLowerCase();
          if (!PROPS[m].some(p => p[0] === key) || key === 'type') return fail(`Invalid property: ${prop || ''}`);
          let v = val.join(' ');
          if (!val.length) return fail(`set ${key}: missing value`);
          if (key === 'softwareimage') {
            if (!store.softwareimage[v]) return fail(`Unable to find softwareimage: ${v}`);
            if (!committed('softwareimage', v)) { if (practice) sh.hint(`${v} exists only as an uncommitted clone. Commit it in softwareimage mode before other objects can reference it.`); return fail(`Unable to find softwareimage: ${v} (object is not committed)`); }
          }
          if (key === 'category') {
            if (!store.category[v]) return fail(`Unable to find category: ${v}`);
            if (!committed('category', v)) { if (practice) sh.hint(`${v} has not been committed yet. Commit it in category mode first.`); return fail(`Unable to find category: ${v} (object is not committed)`); }
          }
          if (key === 'mac') { if (!MAC.test(v)) return fail(`Invalid MAC address: ${v}`); v = v.toUpperCase(); }
          if (key === 'ip' && !IP.test(v)) return fail(`Invalid IP address: ${v}`);
          if (key === 'name' || key === 'hostname') return fail('Renaming objects is not supported in this simulator; clone or add with the new name instead');
          if (key === 'installmode' || key === 'newnodeinstallmode') { v = v.toUpperCase(); if (!['AUTO', 'FULL', 'MAIN', 'NOSYNC'].includes(v)) return fail(`Invalid value for ${key}: ${v}`); }
          stage(o)[key] = v;
          return ok('');
        }
        case 'clone': {
          if (!editable || m === 'device' && false) return fail('clone is not available in this mode');
          const src = a[1], dst = a[2];
          if (!src || !dst) return fail('Usage: clone <source> <new name>');
          if (!coll[src]) return fail(`Unable to find ${m}: ${src}`);
          if (coll[dst]) return fail(`Object with name ${dst} already exists`);
          if (!HOST.test(dst)) return fail(`Invalid name: ${dst}`);
          const d = JSON.parse(JSON.stringify(view(coll[src])));
          if (m === 'device') { d.hostname = dst; d.mac = '00:00:00:00:00:00'; d.ip = ''; d.status = 'DOWN'; }
          else d.name = dst;
          if (m === 'softwareimage') { d.path = '/cm/images/' + dst; d.created = sh.now(); }
          coll[dst] = { data: d, stage: JSON.parse(JSON.stringify(d)), isNew: true, from: src };
          s.sel = dst;
          if (m === 'softwareimage' && src !== 'default-image') ev.wrongClone.push(dst);
          return ok('');
        }
        case 'add': {
          if (m === 'device') {
            const type = (a[1] || '').toLowerCase(), name = a[2], ip = a[3];
            if (!['physicalnode', 'virtualnode', 'switch', 'genericdevice', 'powerdistributionunit'].includes(type)) return fail(`Usage: add <type> <hostname> [ip] [interface]\nTypes: physicalnode, virtualnode, switch, genericdevice, ...`);
            if (type !== 'physicalnode') return fail('Only physicalnode is simulated in this lab');
            if (!name) return fail('add physicalnode: missing hostname');
            if (!HOST.test(name)) return fail(`Invalid hostname: ${name}`);
            if (coll[name]) return fail(`Object with name ${name} already exists`);
            if (ip && !IP.test(ip)) return fail(`Invalid IP address: ${ip}`);
            const d = { type: 'PhysicalNode', hostname: name, mac: '00:00:00:00:00:00', ip: ip || '', network: 'internalnet', category: 'default', softwareimage: '', status: 'DOWN', notes: '', provisioninginterface: a[4] || 'BOOTIF' };
            coll[name] = { data: d, stage: JSON.parse(JSON.stringify(d)), isNew: true };
            s.sel = name;
            if (practice && !ip) sh.hint(`You can give the IP straight away: add physicalnode ${name} ${P.ip}. Otherwise set ip later.`);
            return ok('');
          }
          if (!editable) return fail('add is not available in this mode');
          const name = a[1];
          if (!name) return fail('add: missing name');
          if (coll[name]) return fail(`Object with name ${name} already exists`);
          const d = m === 'category' ? { name: name, softwareimage: 'default-image', installmode: 'AUTO', newnodeinstallmode: 'FULL', defaultgateway: '10.141.255.254', nameservers: '', roles: '', notes: '' } : { name: name, path: '/cm/images/' + name, kernelversion: '5.15.0-1063-nvidia', kernelparameters: '', locked: 'no', notes: '', created: sh.now() };
          coll[name] = { data: d, stage: JSON.parse(JSON.stringify(d)), isNew: true, from: null };
          s.sel = name;
          return ok('');
        }
        case 'remove': {
          const n = a[1] || s.sel; const o = coll[n];
          if (!o) return fail(`Unable to find ${m}: ${n || ''}`);
          if (['default', 'default-image', 'headnode', 'node001', 'node002', 'node003'].includes(n)) return fail(`Removing ${n} is blocked in this lab`);
          delete coll[n]; if (s.sel === n) s.sel = null; return ok('');
        }
        case 'refresh': {
          const targets = s.sel ? [s.sel] : Object.keys(coll);
          targets.forEach(n => { const o = coll[n]; if (!o) return; if (o.isNew) { delete coll[n]; if (s.sel === n) s.sel = null; } else o.stage = null; });
          return ok('');
        }
        case 'commit': {
          if (!editable) return ok('');
          const targets = (s.sel ? [s.sel] : Object.keys(coll)).filter(n => coll[n] && coll[n].stage);
          if (!targets.length) return ok('');
          const outs = [], errs = [];
          for (const n of targets) {
            const o = coll[n], d = o.stage;
            if (m === 'device') {
              const clash = Object.values(store.device).find(x => x !== o && !x.isNew && ((d.ip && x.data.ip === d.ip) || (d.mac !== '00:00:00:00:00:00' && x.data.mac === d.mac)));
              if (clash) { errs.push(`Commit failed for ${n}\nField: ${clash.data.ip === d.ip ? 'ip' : 'mac'}, value: ${clash.data.ip === d.ip ? d.ip : d.mac}, message: already in use by ${clash.data.hostname}`); continue; }
              if (!d.ip) { errs.push(`Commit failed for ${n}\nField: ip, message: an IP address on the provisioning network is required`); if (practice) sh.hint(`Set the IP first: set ip ${P.ip}`); continue; }
              if (d.category && !committed('category', d.category)) { errs.push(`Commit failed for ${n}\nField: category, value: ${d.category}, message: category not found`); continue; }
            }
            if (m === 'category' && !committed('softwareimage', d.softwareimage)) { errs.push(`Commit failed for ${n}\nField: softwareimage, value: ${d.softwareimage}, message: software image not found`); continue; }
            const wasNew = o.isNew;
            o.data = d; o.stage = null; o.isNew = false;
            if (m === 'softwareimage' && wasNew) {
              outs.push(notice(`Started to copy: /cm/images/${o.from || 'default-image'} -> ${d.path} (${NL.int(r, 100, 999)})`), notice(`Copied: /cm/images/${o.from || 'default-image'} -> ${d.path} (${NL.int(r, 100, 999)})`), notice(`Initial ramdisk for image ${d.name} is being generated`), notice(`Initial ramdisk for image ${d.name} was generated successfully`));
              sh.mkdirp(d.path);
            }
            if (m === 'device' && wasNew) outs.push(notice(`Check node ${n}: ${d.type} added`));
          }
          if (practice && !errs.length) {
            if (m === 'softwareimage' && targets.includes(P.image)) sh.hint(`Image committed. Next: category mode, clone default ${P.category}, commit.`);
            if (m === 'category' && targets.includes(P.category) && view(store.category[P.category]).softwareimage !== P.image) sh.hint(`Category committed. Now point it at the new image: use ${P.category}, set softwareimage ${P.image}, commit.`);
          }
          return { out: outs.join('\n'), err: errs.join('\n'), code: errs.length ? 1 : 0 };
        }
      }
      return fail(`Unknown command: ${c}`);
    }
    function startCmsh() {
      const s = newSession();
      cs = s;
      sh.interactive = {
        prompt: () => pfx(s),
        input(line) {
          if (!line.trim()) return '';
          sh.histList.push(line);
          const r2 = cmshLine(s, line);
          if (r2.quit) { sh.interactive = null; cs = null; }
          if (r2.out && lab.onDisplay) lab.onDisplay(r2.out);
          return r2.out || '';
        },
        complete(line) {
          const m = /(\S*)$/.exec(line), word = m[1], before = line.slice(0, line.length - word.length);
          const first = !before.trim() || /;\s*$/.test(before);
          const cmds = MODES.concat(['list', 'use', 'show', 'set', 'get', 'clone', 'add', 'commit', 'remove', 'refresh', 'exit', 'quit', 'help', 'modified', 'status']);
          let cands = [];
          const prev = before.trim().split(/\s+/);
          if (first) cands = cmds;
          else if (/^(use|show|remove|clone)$/.test(prev[prev.length - 1]) && store[s.mode]) cands = Object.keys(store[s.mode]);
          else if (prev[prev.length - 1] === 'set' && PROPS[s.mode]) cands = PROPS[s.mode].map(p => p[0]);
          else if (prev[prev.length - 1] === 'add') cands = ['physicalnode'];
          else if (prev[prev.length - 2] === 'set' && prev[prev.length - 1] === 'softwareimage') cands = Object.keys(store.softwareimage);
          else if (prev[prev.length - 2] === 'set' && prev[prev.length - 1] === 'category') cands = Object.keys(store.category);
          cands = cands.filter(c => c.startsWith(word));
          if (cands.length === 1) return { line: before + cands[0] + ' ', options: [] };
          if (!cands.length) return { line: line, options: [] };
          let p = cands[0]; cands.forEach(c => { while (!c.startsWith(p)) p = p.slice(0, -1); });
          return { line: before + p, options: cands };
        }
      };
    }

    /* ---- cm-kubernetes-setup ---- */
    function k8sNodes() {
      if (!k8s) return [];
      const names = new Set(k8s.controlPlane.concat(k8s.nodes));
      Object.values(store.device).forEach(o => { if (!o.isNew && k8s.workers.includes(o.data.category)) names.add(o.data.hostname); });
      return [...names];
    }
    function configText(c) {
      return `# Configuration saved by cm-kubernetes-setup (NAVIA simulation; the real file uses a similar YAML layout)
modules:
  kubernetes:
    cluster_name: ${c.name}
    version: "${c.version}"
    container_runtime: containerd
    pod_network: ${c.podNet}
    service_network: ${c.svcNet}
    control_plane:
      nodes: [${c.controlPlane.join(', ')}]
    etcd:
      nodes: [${c.etcd.join(', ')}]
    workers:
      categories: [${c.workers.join(', ')}]
      nodes: [${c.nodes.join(', ')}]
    addons:
      calico: true
      nvidia_gpu_operator: ${c.gpuOperator ? 'true' : 'false'}
`;
    }
    function parseConfig(text) {
      const d = NL.yaml.parse(text)[0];
      const k = d && d.modules && d.modules.kubernetes;
      if (!k) throw new Error('missing modules.kubernetes section');
      const arr = x => Array.isArray(x) ? x.map(String) : x ? [String(x)] : [];
      return { name: String(k.cluster_name || 'default'), version: String(k.version || '1.30'), podNet: k.pod_network, svcNet: k.service_network, controlPlane: arr(k.control_plane && k.control_plane.nodes), etcd: arr(k.etcd && k.etcd.nodes), workers: arr(k.workers && k.workers.categories), nodes: arr(k.workers && k.workers.nodes), gpuOperator: !!(k.addons && k.addons.nvidia_gpu_operator) };
    }
    function deploy(c, path, method) {
      if (k8s) return fail(`Error: a Kubernetes cluster named '${k8s.name}' is already deployed. Uninstall it first.`);
      if (!c.controlPlane.length) return fail('Error: the configuration has no control plane nodes');
      const unknownCat = c.workers.filter(x => !committed('category', x));
      if (unknownCat.length) return fail(`Error: category ${unknownCat[0]} does not exist`);
      const unknownNode = c.controlPlane.concat(c.nodes).filter(x => !committed('device', x));
      if (unknownNode.length) return fail(`Error: node ${unknownNode[0]} does not exist`);
      k8s = Object.assign({}, c, { configPath: path, method: method });
      const stages = ['Search Pre Existing Kubernetes Installation', `Create Kubernetes Cluster ${c.name}`, 'Prepare Software Images', 'Install Packages', 'Create Kubernetes Configuration Overlays', 'Assign Kubernetes Roles', 'Configure Etcd Cluster', 'Configure Kubernetes Control Plane', 'Deploy Calico Network Plugin'].concat(c.gpuOperator ? ['Deploy NVIDIA GPU Operator'] : []).concat(['Wait For Nodes To Become Ready', 'Finalize Kubernetes Setup']);
      const lines = [`Executing ${stages.length * 3} stages`, `################### Starting execution for 'Kubernetes Setup'`, 'Connecting to CMDaemon', '- kubernetes'];
      stages.forEach((st, i) => { lines.push(`## Progress: ${Math.round(i * 100 / stages.length)}`, `#### stage: kubernetes: ${st}`); });
      lines.push('## Progress: 100', '', `Took: 0${NL.int(r, 5, 9)}:${String(NL.int(r, 0, 59)).padStart(2, '0')} min.`, 'Progress: 100/100', `################### Finished execution for 'Kubernetes Setup', status: completed`, '', 'Kubernetes Setup finished!');
      sh.advance(6 * 60e3);
      if (practice) sh.hint('Verify the cluster: module load kubernetes, then kubectl get nodes.');
      return ok(lines.join('\n'));
    }
    function startWizard() {
      const c = { name: 'default', version: '1.30', podNet: '172.29.0.0/16', svcNet: '10.150.0.0/16', controlPlane: [], etcd: [], workers: [], nodes: [], gpuOperator: true };
      const nodeNames = () => Object.values(store.device).filter(o => !o.isNew).map(o => o.data.hostname);
      const catNames = () => Object.values(store.category).filter(o => !o.isNew).map(o => o.data.name);
      const box = (title, body) => { const w = Math.max(64, ...body.map(b => b.length + 4), title.length + 8); const line = s => '│ ' + padR(s, w - 4) + ' │'; return ['┌─ ' + title + ' ' + '─'.repeat(Math.max(0, w - title.length - 5)) + '┐'].concat(body.map(line), ['└' + '─'.repeat(w - 2) + '┘']).join('\n'); };
      const pickList = s => { const t = s.trim(); if (!t) return []; return t.split(/[,\s]+/).filter(Boolean).map(x => parseInt(x, 10)); };
      let i = 0, deployAfter = false;
      const steps = [
        { show: () => box('Kubernetes Setup', ['Select an operation:', '', '  1) Deploy      Install Kubernetes on this cluster', '  2) Uninstall   Remove a Kubernetes cluster', '  3) Exit']) , ask: 'Select [1-3]: ', on: v => { if (v === '1') return 1; if (v === '2') return { end: k8s ? 'Uninstall is disabled in this lab.' : 'No Kubernetes cluster is installed.' }; if (v === '3' || v === 'q') return { end: 'Exiting cm-kubernetes-setup.' }; return { err: 'Please enter 1, 2 or 3.' }; } },
        { show: () => box('Kubernetes version', ['  1) v1.31', '  2) v1.30   (recommended)', '  3) v1.29']), ask: 'Select [2]: ', on: v => { const m = { '': '1.30', '1': '1.31', '2': '1.30', '3': '1.29' }[v]; if (!m) return { err: 'Please enter 1, 2 or 3.' }; c.version = m; return 1; } },
        { show: () => box('Cluster name', ['Name of the Kubernetes cluster as shown in cmsh kubernetes mode.']), ask: 'Cluster name [default]: ', on: v => { if (v && !HOST.test(v)) return { err: 'Invalid name.' }; c.name = v || 'default'; return 1; } },
        { show: () => box('Kubernetes networks', [`Pod network:      ${c.podNet}`, `Service network:  ${c.svcNet}`, 'These must not overlap with existing cluster networks.']), ask: 'Accept these networks? [Y/n]: ', on: v => /^(|y|yes)$/i.test(v) ? 1 : { err: 'Custom networks are not simulated; press Enter to accept.' } },
        { show: () => box('Kubernetes control plane', ['Select the node(s) that run the Kubernetes control plane'].concat(nodeNames().map((n, k) => `  ${k + 1}) ${n}`)).concat(['', 'Enter one or more numbers separated by commas.'])), ask: 'Control plane nodes: ', on: v => { const n = nodeNames(); const ids = pickList(v); if (!ids.length || ids.some(x => !n[x - 1])) return { err: 'Select at least one node by number.' }; c.controlPlane = ids.map(x => n[x - 1]); c.etcd = c.controlPlane.slice(); return 1; } },
        { show: () => box('Worker node categories', ['Nodes in the selected categories become Kubernetes workers.'].concat(catNames().map((n, k) => `  ${k + 1}) ${n}   (${nodesInCategory(n)} nodes)`)).concat(['', 'Enter numbers separated by commas, or press Enter for none.'])), ask: 'Worker categories: ', on: v => { const n = catNames(); const ids = pickList(v); if (ids.some(x => !n[x - 1])) return { err: 'Unknown selection.' }; c.workers = ids.map(x => n[x - 1]); return 1; } },
        { show: () => box('Additional worker nodes', ['Optionally add individual nodes as workers.'].concat(nodeNames().filter(n => !c.controlPlane.includes(n)).map((n, k) => `  ${k + 1}) ${n}`)).concat(['', 'Enter numbers, or press Enter to skip.'])), ask: 'Worker nodes: ', on: v => { const n = nodeNames().filter(x => !c.controlPlane.includes(x)); const ids = pickList(v); if (ids.some(x => !n[x - 1])) return { err: 'Unknown selection.' }; c.nodes = ids.map(x => n[x - 1]); if (!c.workers.length && !c.nodes.length && practice) sh.hint('You selected no workers. The task wants the new category as the worker category; type b to go back.'); return 1; } },
        { show: () => box('Etcd', [`Etcd will run on: ${c.etcd.join(', ')}`]), ask: 'Accept? [Y/n]: ', on: v => /^(|y|yes)$/i.test(v) ? 1 : { err: 'Press Enter to accept.' } },
        { show: () => box('Operators', ['Install the NVIDIA GPU Operator? (manages drivers, device plugin, DCGM)']), ask: 'Install NVIDIA GPU Operator? [Y/n]: ', on: v => { c.gpuOperator = /^(|y|yes)$/i.test(v); return 1; } },
        { show: () => box('Summary', [`Version:          v${c.version}`, `Cluster name:     ${c.name}`, `Control plane:    ${c.controlPlane.join(', ')}`, `Worker categories:${c.workers.length ? ' ' + c.workers.join(', ') : ' (none)'}`, `Worker nodes:     ${c.nodes.join(', ') || '(none)'}`, `GPU Operator:     ${c.gpuOperator ? 'yes' : 'no'}`, '', '  1) Save config & deploy', '  2) Save config & exit', '  3) Exit without saving']), ask: 'Select [1-3]: ', on: v => { if (v === '1') { deployAfter = true; return 1; } if (v === '2') { deployAfter = false; return 1; } if (v === '3') return { end: 'Exiting without saving.' }; return { err: 'Please enter 1, 2 or 3.' }; } },
        { show: () => '', ask: 'Save configuration to [/root/cm-kubernetes-setup.conf]: ', on: v => {
          const path = NL.normPath(v || '/root/cm-kubernetes-setup.conf', sh.cwd, sh.home);
          const e = sh.write(path, configText(c));
          if (e) { if (practice) sh.hint(`The directory ${NL.dirname(path)} does not exist. Type q to leave, mkdir -p ${NL.dirname(path)}, and run the wizard again (or pick another path).`); return { err: `Error: cannot write ${path}: ${e}` }; }
          const saved = `Configuration saved to ${path}`;
          if (!deployAfter) { if (practice) sh.hint(`Deploy from the saved file with: cm-kubernetes-setup -c ${path}`); return { end: saved + `\nTo deploy later, run: cm-kubernetes-setup -c ${path}` }; }
          const d = deploy(c, path, 'wizard');
          return { end: saved + '\n' + (d.err || d.out) };
        } }
      ];
      let pending = '';
      const render = () => [steps[i].show(), pending].filter(Boolean).join('\n');
      sh.interactive = {
        prompt: () => steps[i].ask,
        input(line) {
          const v = line.trim();
          if (v === 'q' && i > 0) { sh.interactive = null; return 'Setup aborted.'; }
          if (v === 'b' && i > 1) { i--; return render(); }
          const res = steps[i].on(v);
          if (res === 1) { i++; return render(); }
          if (res.err) return res.err;
          if (res.end) { sh.interactive = null; return res.end; }
          return '';
        }
      };
      return render() + '\n(Type b to go back, q to abort.)';
    }

    /* ---- bash-level commands on the head node ---- */
    const lab = {
      id: 'bcm', params: P, shell: sh,
      title: 'Lab 3 · BCM',
      intro: 'You are root on the BCM head node. Use cmsh for cluster objects and cm-kubernetes-setup for Kubernetes.',
      tasks: () => [
        { id: 'image', text: `Create a software image named ${P.image} by cloning default-image.` },
        { id: 'category', text: `Create a category named ${P.category} by cloning the default category.` },
        { id: 'assign', text: `Configure category ${P.category} to use software image ${P.image}.` },
        { id: 'node', text: `Add a physical node ${P.node} with IP ${P.ip} and MAC ${P.mac}, in category ${P.category}.` },
        { id: 'config', text: `Run cm-kubernetes-setup with the head node as the control plane and ${P.category} as the worker category. Save the configuration to ${P.cfgPath} without deploying.` },
        { id: 'deploy', text: `Deploy Kubernetes from the saved file ${P.cfgPath}.` }
      ],
      commands: () => ['cmsh', 'cm-kubernetes-setup', 'module', 'ml'].concat(moduleLoaded && k8s ? ['kubectl'] : []),
      hosts: () => ['headnode', 'node001', 'node002', 'node003'],
      users: () => ['root'],
      which: n => ({ cmsh: '/cm/local/apps/cmd/bin/cmsh', 'cm-kubernetes-setup': '/cm/local/apps/cm-setup/bin/cm-kubernetes-setup' })[n] || null,
      man: p => p === 'cmsh' ? 'CMSH(8)\n  cmsh [-c "command; command"]\n  Modes: softwareimage, category, device, network, partition, kubernetes\n  In a mode: list, use <name>, show, get <prop>, set <prop> <value>, clone <src> <dst>, add <type> <name> [ip], commit, refresh, exit, quit' : p === 'cm-kubernetes-setup' ? 'cm-kubernetes-setup [-c <config file>]\n  Without -c: interactive setup wizard. With -c: deploy from a saved configuration file.' : null,
      virtualList(p) { if (p === '/cm/images') return Object.values(store.softwareimage).filter(o => !o.isNew).map(o => o.data.name); return []; },
      exec(argv, ctx) {
        const c = argv[0];
        if (c === 'cmsh') {
          const ci = argv.indexOf('-c');
          if (ci >= 0) {
            const s = newSession(); const r2 = cmshLine(s, argv.slice(ci + 1).join(' '));
            // non-interactive cmsh drops uncommitted changes at exit
            ['softwareimage', 'category', 'device'].forEach(mm => Object.keys(store[mm]).forEach(k => { const o = store[mm][k]; if (o.stage) { if (o.isNew) delete store[mm][k]; else o.stage = null; ev.quitDirty = true; } }));
            return ok(r2.out || '');
          }
          if (argv.length > 1 && !/^-/.test(argv[1])) return fail(`cmsh: unexpected argument: ${argv[1]}. Use cmsh -c "..." for one-off commands.`);
          startCmsh();
          return ok('');
        }
        if (c === 'cm-kubernetes-setup') {
          const a = argv.slice(1);
          if (a.includes('-h') || a.includes('--help')) return ok('usage: cm-kubernetes-setup [-h] [-c CONFIG] [--remove] [--skip-packages]\n\noptions:\n  -c CONFIG    Load configuration from file and deploy\n  --remove     Remove a Kubernetes setup');
          const ci = a.indexOf('-c');
          if (ci >= 0) {
            const f = a[ci + 1]; if (!f) return fail('cm-kubernetes-setup: error: argument -c: expected one argument', 2);
            const path = sh.resolve(f); const text = sh.read(path);
            if (text === undefined) return fail(`Error: configuration file ${f} not found`);
            let conf; try { conf = parseConfig(text); } catch (e) { return fail(`Error: invalid configuration file ${f}: ${e.message}`); }
            return deploy(conf, path, 'file');
          }
          if (a.length) return fail(`cm-kubernetes-setup: error: unrecognized arguments: ${a.join(' ')}`, 2);
          return ok(startWizard());
        }
        if (c === 'module' || c === 'ml') {
          const sub = argv[1];
          if (sub === 'avail' || sub === 'av') return ok('------------------------- /cm/local/modulefiles -------------------------\ncluster-tools/10.0  cmd  dot  module-git  null  shared\n------------------------- /cm/shared/modulefiles ------------------------\n' + (k8s ? `kubernetes/${k8s.name}/${k8s.version}.4  ` : '') + 'slurm/slurm/24.05.4');
          if (sub === 'list') return ok('Currently Loaded Modulefiles:\n 1) shared  2) cmd' + (moduleLoaded ? `  3) kubernetes/${k8s.name}/${k8s.version}.4` : ''));
          if (sub === 'load' || sub === 'add') { if (/^kubernetes/.test(argv[2] || '') && k8s) { moduleLoaded = true; return ok(); } return fail(`ERROR: Unable to locate a modulefile for '${argv[2] || ''}'`); }
          return ok();
        }
        if (c === 'kubectl') {
          if (!moduleLoaded || !k8s) return fail('kubectl: command not found', 127);
          if (argv[1] === 'cluster-info') return ok('Kubernetes control plane is running at https://10.141.255.254:10443\nCoreDNS is running at https://10.141.255.254:10443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy\n\nTo further debug and diagnose cluster problems, use \'kubectl cluster-info dump\'.');
          if (argv[1] === 'get' && /^(nodes?|no)$/.test(argv[2] || '')) {
            const rows = k8sNodes().map(n => [n, 'Ready', k8s.controlPlane.includes(n) ? 'control-plane' : '<none>', '2m', 'v' + k8s.version + '.4']);
            return ok(NL.table(['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION'], rows, { sep: '   ' }));
          }
          if (argv[1] === 'get' && /^(pods?|po)$/.test(argv[2] || '')) return ok(argv.includes('-A') ? 'NAMESPACE      NAME                                       READY   STATUS    RESTARTS   AGE\nkube-system    calico-kube-controllers-7c9f5d6b8-x2mpl   1/1     Running   0          2m\nkube-system    coredns-76f75df574-8lwgk                  1/1     Running   0          2m' : 'No resources found in default namespace.');
          return fail('This lab only simulates kubectl get nodes / get pods after deployment.');
        }
        return undefined;
      },
      onDisplay() {},
      grade() {
        const res = [];
        const img = store.softwareimage[P.image];
        res.push({ id: 'image', pass: !!img && !img.isNew && !img.stage && img.from === 'default-image', detail: !img ? `There is no software image named ${P.image}.` : img.isNew ? `${P.image} was cloned but never committed.` : img.from !== 'default-image' ? `${P.image} was not cloned from default-image.` : `${P.image} was cloned from default-image and committed.` });
        const cat = store.category[P.category];
        res.push({ id: 'category', pass: !!cat && !cat.isNew && cat.from === 'default', detail: !cat ? `There is no category named ${P.category}.` : cat.isNew ? `${P.category} was cloned but never committed.` : cat.from !== 'default' ? `${P.category} was not cloned from the default category.` : `${P.category} was cloned from default and committed.` });
        const catImg = cat && !cat.isNew ? cat.data.softwareimage : null;
        res.push({ id: 'assign', pass: catImg === P.image, detail: catImg === P.image ? `${P.category} uses ${P.image}.` : cat && cat.stage && cat.stage.softwareimage === P.image ? `softwareimage was set to ${P.image} but the change was not committed.` : `${P.category} uses ${catImg || '(nothing)'}, not ${P.image}.` });
        const nd = store.device[P.node];
        let nerr = '';
        if (!nd) nerr = `There is no device named ${P.node}.`;
        else if (nd.isNew) nerr = `${P.node} was added but never committed.`;
        else {
          const d = nd.data;
          const probs = [];
          if (d.type !== 'PhysicalNode') probs.push('type is not PhysicalNode');
          if (d.ip !== P.ip) probs.push(`IP is ${d.ip || 'empty'} (expected ${P.ip})`);
          if ((d.mac || '').toUpperCase() !== P.mac.toUpperCase()) probs.push(`MAC is ${d.mac} (expected ${P.mac.toUpperCase()})`);
          if (d.category !== P.category) probs.push(`category is ${d.category} (expected ${P.category})`);
          if (nd.stage) probs.push('it has uncommitted changes');
          if (probs.length) nerr = `${P.node}: ` + probs.join('; ') + '.';
        }
        res.push({ id: 'node', pass: !nerr, detail: nerr || `${P.node} is committed with IP ${P.ip}, MAC ${P.mac.toUpperCase()}, category ${P.category}.` });
        const ct = sh.read(P.cfgPath);
        let cerr = '';
        if (ct === undefined) cerr = `No configuration file at ${P.cfgPath}.`;
        else { try { const conf = parseConfig(ct); if (!conf.workers.includes(P.category)) cerr = `The saved configuration does not use ${P.category} as a worker category (it has: ${conf.workers.join(', ') || 'none'}).`; else if (!conf.controlPlane.includes('headnode')) cerr = `The saved configuration does not use the head node as the control plane (${conf.controlPlane.join(', ')}).`; } catch (e) { cerr = `${P.cfgPath} is not a valid setup configuration: ${e.message}`; } }
        res.push({ id: 'config', pass: !cerr, detail: cerr || `${P.cfgPath} has control plane headnode and worker category ${P.category}.` });
        let derr = '';
        if (!k8s) derr = 'Kubernetes was not deployed.';
        else if (k8s.configPath !== P.cfgPath) derr = `Kubernetes was deployed from ${k8s.configPath}, not ${P.cfgPath}.`;
        else if (!k8s.workers.includes(P.category)) derr = `The deployed cluster does not include worker category ${P.category}.`;
        res.push({ id: 'deploy', pass: !derr, detail: derr || `Kubernetes was deployed from ${P.cfgPath}${k8s.method === 'wizard' ? ' (using "Save config & deploy" in the wizard; the task wording suggests saving first, then cm-kubernetes-setup -c)' : ' with cm-kubernetes-setup -c'}.` });
        const notes = [];
        if (ev.quitDirty) notes.push('At some point you left cmsh with uncommitted changes, which were discarded.');
        if (ev.wrongClone.length) notes.push(`Image(s) ${ev.wrongClone.join(', ')} were cloned from something other than default-image.`);
        return { results: res, notes: notes };
      },
      solution() {
        const dir = NL.dirname(P.cfgPath);
        return ['cmsh', 'softwareimage', `clone default-image ${P.image}`, 'commit', 'category', `clone default ${P.category}`, 'commit', `use ${P.category}`, `set softwareimage ${P.image}`, 'commit', 'device', `add physicalnode ${P.node} ${P.ip}`, `set category ${P.category}`, `set mac ${P.mac}`, 'commit', 'quit']
          .concat(dir !== '/root' ? [`mkdir -p ${dir}`] : [])
          .concat(['cm-kubernetes-setup', '#  Deploy → version → name → accept networks → control plane: headnode', `#  worker categories: ${P.category} → Enter → Enter → GPU operator → "Save config & exit"`, `#  save to ${P.cfgPath}`, `cm-kubernetes-setup -c ${P.cfgPath}`, 'module load kubernetes', 'kubectl get nodes']);
      }
    };
    sh.lab = lab;
    return lab;
  }
  NL.labs.bcm = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
