/* NAVIA Lab 1 – Slurm: find a failed job with no job ID given, fix the node, submit a job, show output, drain a node.
 * Simulation for training only. Behaviour follows standard Slurm 24.x defaults where practical
 * (ReturnToService=0, MinJobAge=300, sacct --state needs -S to look back in time). */
(function (G) {
  'use strict';
  const NL = G.NaviaLab;
  const { padL, padR, isoTime, logTime, ok, fail } = NL;

  const STATE_CODES = { CA: 'CANCELLED', CD: 'COMPLETED', CF: 'CONFIGURING', CG: 'COMPLETING', DL: 'DEADLINE', F: 'FAILED', NF: 'NODE_FAIL', OOM: 'OUT_OF_MEMORY', PD: 'PENDING', PR: 'PREEMPTED', R: 'RUNNING', RQ: 'REQUEUED', RS: 'RESIZING', RV: 'REVOKED', S: 'SUSPENDED', TO: 'TIMEOUT', BF: 'BOOT_FAIL' };
  const STATE_NAMES = Object.values(STATE_CODES);
  const SHORT = Object.fromEntries(Object.entries(STATE_CODES).map(([k, v]) => [v, k]));
  const UIDS = { student: 1001, mlops: 1003, research: 1004, dana: 1005, lee: 1006, omar: 1007, priya: 1008, root: 0 };
  const BIN = '/cm/shared/apps/slurm/current/bin/';

  /* hostlist helpers: node[001-003,005] <-> [node001,...] */
  function compress(names) {
    if (!names.length) return '';
    const groups = {};
    names.forEach(n => { const m = /^(.*?)(\d+)$/.exec(n); if (!m) { groups[n] = null; return; } (groups[m[1]] = groups[m[1]] || []).push(m[2]); });
    return Object.entries(groups).map(([pre, nums]) => {
      if (!nums) return pre;
      if (nums.length === 1) return pre + nums[0];
      nums.sort(); const w = nums[0].length; const ints = nums.map(Number); const parts = []; let s = ints[0], p = ints[0];
      for (let i = 1; i <= ints.length; i++) { if (ints[i] === p + 1) { p = ints[i]; continue; } parts.push(s === p ? String(s).padStart(w, '0') : String(s).padStart(w, '0') + '-' + String(p).padStart(w, '0')); s = p = ints[i]; }
      return `${pre}[${parts.join(',')}]`;
    }).join(',');
  }
  function expand(list) {
    const out = [];
    (list || '').replace(/([^,\[]+)(\[[^\]]*\])?/g, (m, pre, br) => {
      pre = pre.replace(/^,/, '');
      if (!br) { if (pre) out.push(pre); return ''; }
      br.slice(1, -1).split(',').forEach(r => { const [a, b] = r.split('-'); const w = a.length; for (let i = +a; i <= +(b || a); i++) out.push(pre + String(i).padStart(w, '0')); });
      return '';
    });
    return out;
  }
  /* option parser that knows short/long forms and which take values */
  function opts(argv, spec) {
    const o = { _: [] }; const errs = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a.startsWith('--')) {
        const [k, v] = a.slice(2).split(/=(.*)/s);
        const s = spec[k];
        if (!s) { errs.push(`unrecognized option '--${k}'`); continue; }
        if (s.val) { const val = v !== undefined ? v : argv[++i]; if (val === undefined) { errs.push(`option '--${k}' requires an argument`); continue; } o[s.key] = val; } else o[s.key] = true;
      } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
        for (let j = 1; j < a.length; j++) {
          const s = spec[a[j]];
          if (!s) { errs.push(`invalid option -- '${a[j]}'`); break; }
          if (s.val) { const rest = a.slice(j + 1); const val = rest || argv[++i]; if (val === undefined) { errs.push(`option requires an argument -- '${a[j]}'`); } else o[s.key] = val; break; }
          o[s.key] = true;
        }
      } else o._.push(a);
    }
    return { o: o, errs: errs };
  }

  function create(cfg) {
    const mode = cfg.mode || 'practice', practice = mode === 'practice';
    const seed = cfg.seed >>> 0, r = NL.rng(seed);
    const asRoot = cfg.user !== 'student'; // the exam logs you in as root; 'student' is the sudo variant
    const sh = new NL.Shell({ mode: mode, user: asRoot ? 'root' : 'student', home: asRoot ? '/root' : '/home/student', host: 'headnode', now: cfg.now });
    const SUDO = asRoot ? '' : 'sudo ';
    const NODES = ['node001', 'node002', 'node003', 'node004'];
    const failNode = practice ? 'node002' : NL.pick(r, NODES);
    const rest = NODES.filter(n => n !== failNode);
    const drainNode = practice ? 'node001' : NL.pick(r, rest);
    const busyNode = rest.filter(n => n !== drainNode)[practice ? 1 : NL.int(r, 0, 1)];
    // node failure (crash / munge / stopped) or a job-level failure (oom)
    // Lab 1 is a node failure: practice uses a slurmd crash; exam picks one of three node causes.
    // (The out-of-memory job variant is kept in the code but switched off; add 'oom' here to bring it back.)
    const cause = practice ? 'crash' : NL.pick(r, ['crash', 'munge', 'stopped']);
    const nodeFail = cause !== 'oom';
    const base = practice ? 5817 : NL.int(r, 2100, 89000);
    const owner = practice ? 'dana' : NL.pick(r, ['dana', 'lee', 'omar', 'priya']);
    const script = practice ? 'train.sh' : NL.pick(r, ['train.sh', 'finetune.sh', 'pretrain.sh']);
    const failName = script;
    const ownerHome = '/home/' + owner, ownerScript = ownerHome + '/' + script;
    const reqMem = practice ? 16 : NL.pick(r, [16, 24, 32]);                                   // GB requested in the script
    const dataGiB = nodeFail ? 6 : reqMem + (practice ? 24 : NL.pick(r, [12, 20, 28]));      // GiB the job loads; more than reqMem means OOM
    const t0 = sh.now();
    const midnight = new Date(t0).setHours(0, 0, 0, 0);
    const span = t0 - midnight;
    const failT = t0 - Math.min(2 * 3600e3 + NL.int(r, 0, 3600) * 1000, Math.floor(span * 0.6));
    const at = frac => Math.round(midnight + (failT - midnight) * frac);
    const pid = () => NL.int(r, 1100, 9800);

    // Practice "both" drill: a second job, owned by someone else, ran out of memory on a healthy node
    const both = false; // the two-failure practice drill is switched off
    const M = both ? { id: base - 1, owner: 'lee', script: 'finetune.sh', path: '/home/lee/finetune.sh', home: '/home/lee', node: NODES.find(n => ![failNode, drainNode, busyNode].includes(n)), reqMem: 16, dataGiB: 40 } : null;
    const failedFor = p => p === ownerScript ? { owner: owner, script: script, oom: cause === 'oom', data: dataGiB } : M && p === M.path ? { owner: M.owner, script: M.script, oom: true, data: M.dataGiB } : null;
    const P = { failNode, drainNode, busyNode, cause, failId: base, failName, owner, script, ownerScript, reqMem, dataGiB, asRoot, seed, both, oomJob: M && { id: M.id, owner: M.owner, script: M.script, node: M.node } };

    /* ---- cluster state ---- */
    const nodes = {};
    NODES.forEach(n => nodes[n] = { name: n, down: false, noresp: false, drain: false, reason: '', reasonUser: '', reasonTime: 0, slurmd: 'active', slurmdEnabled: true, slurmdSince: midnight - 86400e3 * 3 + 7.2 * 3600e3, slurmdPid: pid(), munge: 'active', mungeSince: midnight - 86400e3 * 3, boot: midnight - 86400e3 * 3 + 7.2 * 3600e3 - 95e3, journal: [], slurmdLog: [] });
    const ctl = []; // slurmctld log lines {t, text}
    const ctlLog = (t, text) => ctl.push({ t: t, text: text });
    const jr = (n, t, unit, text, proc) => nodes[n].journal.push({ t: t, unit: unit, text: text, proc: proc || unit });
    const fn = nodes[failNode];
    if (nodeFail) { fn.down = true; fn.noresp = true; fn.reason = 'Not responding'; fn.reasonUser = 'slurm'; fn.reasonTime = failT; }
    const failPid = fn.slurmdPid;
    if (cause === 'oom') {
      const ppid = pid();
      jr(failNode, failT - 2e3, 'kernel', `python3 invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=0`, 'kernel');
      jr(failNode, failT - 1e3, 'kernel', `Memory cgroup out of memory: Killed process ${ppid} (python3) total-vm:${reqMem * 1048576 + 912340}kB, anon-rss:${reqMem * 1048576 - 4012}kB, file-rss:0kB, shmem-rss:0kB, UID:${UIDS[owner]} pgtables:33012kB oom_score_adj:0`, 'kernel');
      fn.slurmdLog.push({ t: failT - 1e3, text: `[${base}.batch] task/cgroup: _oom_event_monitor: oom-kill event count: 1` }, { t: failT, text: `[${base}.batch] error: Detected 1 oom_kill event in StepId=${base}.batch. Some of the step tasks have been OOM Killed.` });
    } else if (cause === 'crash') {
      fn.slurmd = 'failed:signal'; fn.slurmdSince = failT - 70e3;
      jr(failNode, failT - 70e3, 'kernel', `slurmd[${failPid}]: segfault at 0 ip 00007f3a9c2d1e4b sp 00007ffd3b1c2a10 error 4 in libslurmfull.so[7f3a9c200000+1a5000]`, 'kernel');
      jr(failNode, failT - 70e3, 'slurmd', `slurmd.service: Main process exited, code=killed, status=11/SEGV`, 'systemd[1]');
      jr(failNode, failT - 70e3, 'slurmd', `slurmd.service: Failed with result 'signal'.`, 'systemd[1]');
      fn.slurmdLog.push({ t: failT - 75e3, text: `debug:  _rpc_terminate_job: uid = ${UIDS.root} JobId=${base - 30}` });
    } else if (cause === 'munge') {
      fn.munge = 'failed:oom-kill'; fn.mungeSince = failT - 95e3; fn.slurmd = 'failed:exit-code'; fn.slurmdSince = failT - 70e3;
      jr(failNode, failT - 95e3, 'kernel', `Out of memory: Killed process ${pid()} (munged) total-vm:241356kB, anon-rss:8120kB`, 'kernel');
      jr(failNode, failT - 95e3, 'munge', `munge.service: A process of this unit has been killed by the OOM killer.`, 'systemd[1]');
      jr(failNode, failT - 95e3, 'munge', `munge.service: Failed with result 'oom-kill'.`, 'systemd[1]');
      ['error: If munged is up, restart with --num-threads=10', 'error: Munge encode failed: Failed to access "/run/munge/munge.socket.2": No such file or directory', 'error: auth_g_pack: plugin auth/munge failed to create credential', 'fatal: Unable to register with slurm controller'].forEach((m, i) => { jr(failNode, failT - 72e3 + i * 400, 'slurmd', m, `slurmd[${failPid}]`); fn.slurmdLog.push({ t: failT - 72e3 + i * 400, text: m }); });
      jr(failNode, failT - 70e3, 'slurmd', `slurmd.service: Main process exited, code=exited, status=1/FAILURE`, 'systemd[1]');
      jr(failNode, failT - 70e3, 'slurmd', `slurmd.service: Failed with result 'exit-code'.`, 'systemd[1]');
      ctlLog(failT - 80e3, `error: Munge decode failed: Invalid credential`);
      ctlLog(failT - 80e3, `error: auth_g_verify: REQUEST_COMPLETE_BATCH_SCRIPT has authentication error: Invalid authentication credential`);
    } else {
      fn.slurmd = 'inactive'; fn.slurmdEnabled = false; fn.slurmdSince = failT - 240e3; fn.boot = failT - 150e3;
      jr(failNode, failT - 240e3, 'slurmd', 'Stopping Slurm node daemon...', 'systemd[1]');
      jr(failNode, failT - 239e3, 'slurmd', 'slurmd.service: Deactivated successfully.', 'systemd[1]');
      jr(failNode, failT - 239e3, 'slurmd', 'Stopped Slurm node daemon.', 'systemd[1]');
      jr(failNode, failT - 238e3, 'system', 'Removed "/etc/systemd/system/multi-user.target.wants/slurmd.service".', 'systemd[1]');
      jr(failNode, failT - 200e3, 'system', 'Reached target Reboot.', 'systemd[1]');
      jr(failNode, failT - 150e3, 'boot', '-- Boot 3f2a9c1e7b4d4e0c9a61b2d57e8f0a11 --', '');
      jr(failNode, failT - 120e3, 'system', 'Startup finished in 6.122s (kernel) + 31.884s (userspace) = 38.006s.', 'systemd[1]');
      fn.slurmdLog.push({ t: failT - 240e3, text: 'Slurmd shutdown completing' });
    }
    // healthy nodes get a normal start line
    NODES.forEach(n => { if (n !== failNode || cause !== 'stopped') jr(n, nodes[n].slurmdSince > midnight - 86400e3 ? midnight - 86400e3 * 3 + 7.2 * 3600e3 : nodes[n].slurmdSince, 'slurmd', 'Started Slurm node daemon.', 'systemd[1]'); });

    /* ---- job history ---- */
    const jobs = [];
    const J = o => { const j = Object.assign({ partition: 'defq', cpus: 16, gpus: 8, exit: '0:0', mem: 32768, account: o.user === 'student' ? 'student' : o.user === 'research' ? 'research' : 'ml-team', workdir: `/home/${o.user}` }, o); if (j.maxrss === undefined) j.maxrss = j.end ? Math.round(j.mem * 1024 * (0.2 + 0.5 * r())) : null; if (!j.script) j.script = `/home/${j.user}/${j.name}.sh`; if (!j.stdout) j.stdout = `${j.workdir}/slurm-${j.id}.out`; jobs.push(j); };
    J({ id: base - 6, name: 'hpl-bench', user: 'student', state: 'TIMEOUT', node: busyNode, submit: midnight - 5.2 * 3600e3, start: midnight - 5 * 3600e3, end: midnight - 1 * 3600e3, cpus: 112 });
    J({ id: base - 4, name: 'data-sync', user: 'mlops', state: 'COMPLETED', node: drainNode, submit: at(0.30), start: at(0.31), end: at(0.45), cpus: 8, gpus: 0 });
    J({ id: base - 2, name: 'preprocess', user: 'student', state: 'COMPLETED', node: busyNode, submit: at(0.70), start: at(0.71), end: at(0.73), cpus: 4, gpus: 0 });
    if (M) J({ id: M.id, name: M.script, user: M.owner, state: 'OUT_OF_MEMORY', exit: '0:125', node: M.node, submit: at(0.55), start: at(0.56), end: at(0.62), cpus: 16, gpus: 1, mem: M.reqMem * 1024, maxrss: M.reqMem * 1048576 - 4012, script: M.path, workdir: M.home });
    J({ id: base, name: failName, user: owner, state: nodeFail ? 'NODE_FAIL' : 'OUT_OF_MEMORY', exit: nodeFail ? '0:0' : '0:125', node: failNode, submit: at(0.74), start: nodeFail ? at(0.75) : failT - 95e3, end: failT, cpus: 16, gpus: 1, mem: reqMem * 1024, maxrss: nodeFail ? Math.round(dataGiB * 1048576 * 1.04) : reqMem * 1048576 - 4012, script: ownerScript, workdir: ownerHome });
    J({ id: base + 1, name: 'sweep-07', user: 'research', state: 'CANCELLED', node: drainNode, submit: failT + (t0 - failT) * 0.1, start: failT + (t0 - failT) * 0.12, end: failT + (t0 - failT) * 0.3, cpus: 32 });
    J({ id: base + 2, name: 'llm-eval', user: 'research', state: 'RUNNING', node: busyNode, submit: failT + (t0 - failT) * 0.5, start: failT + (t0 - failT) * 0.52, end: null, cpus: 112, timelimit: 86400e3 });
    jobs.forEach(j => { if (j.start) ctlLog(j.start, `sched: Allocate JobId=${j.id} NodeList=${j.node} #CPUs=${j.cpus} Partition=defq`); if (j.end && j.state === 'COMPLETED') ctlLog(j.end, `_job_complete: JobId=${j.id} WEXITSTATUS 0`); if (j.end && j.state === 'FAILED') ctlLog(j.end, `_job_complete: JobId=${j.id} WEXITSTATUS 1`); if (j.state === 'CANCELLED') ctlLog(j.end, `_slurm_rpc_kill_job: REQUEST_KILL_JOB JobId=${j.id} uid ${UIDS.research}`); });
    if (nodeFail) {
      ctlLog(failT - 60e3, `error: Nodes ${failNode} not responding`);
      ctlLog(failT, `error: Nodes ${failNode} not responding, setting DOWN`);
      ctlLog(failT, `Killing JobId=${base} on failed node ${failNode}`);
    } else ctlLog(failT, `_job_complete: JobId=${base} OOM failure`);
    let nextId = base + 3 + (practice ? 2 : NL.int(r, 1, 9));

    const scriptText = (name, mem) => `#!/bin/bash
#SBATCH --partition=defq
#SBATCH --nodes=1
#SBATCH --gres=gpu:1
#SBATCH --mem=${mem}G
#SBATCH --time=00:10:00

echo "Starting ${name} on $(hostname) at $(date)"
python3 train.py --epochs 1
echo "Job $SLURM_JOB_ID finished on $(hostname) at $(date)"
`;
    const SCRIPT = scriptText(script, reqMem);
    ['/home/mlops', '/home/research', '/home/student', ownerHome].forEach(d => sh.mkdirp(d));
    sh.fs.set(ownerScript, { data: SCRIPT, mtime: midnight - 86400e3 * 2 });
    sh.fs.set(ownerHome + '/train.py', { data: '# training entry point (simulated)\n', mtime: midnight - 86400e3 * 2 });
    const failStart = jobs.find(x => x.id === base).start;
    sh.fs.set(`${ownerHome}/slurm-${base}.out`, { mtime: failT, data: [
      `Starting ${script} on ${failNode} at ${NL.dateCmd(failStart + 2000)}`,
      `Loading training shards into memory (${dataGiB}.0 GiB)...`
    ].concat(nodeFail
      ? ['Epoch 1/1: step 200/1000 loss=1.2841', `slurmstepd: error: *** JOB ${base} ON ${failNode} CANCELLED AT ${isoTime(failT)} DUE TO NODE FAILURE, SEE SLURMCTLD LOG FOR DETAILS ***`]
      : [`slurmstepd: error: Detected 1 oom_kill event in StepId=${base}.batch. Some of the step tasks have been OOM Killed.`]).join('\n') + '\n' });
    if (M) {
      const mj = jobs.find(x => x.id === M.id);
      sh.mkdirp(M.home);
      sh.fs.set(M.path, { data: scriptText(M.script, M.reqMem), mtime: midnight - 86400e3 * 2 });
      sh.fs.set(M.home + '/train.py', { data: '# training entry point (simulated)\n', mtime: midnight - 86400e3 * 2 });
      sh.fs.set(`${M.home}/slurm-${M.id}.out`, { mtime: mj.end, data: [`Starting ${M.script} on ${M.node} at ${NL.dateCmd(mj.start + 2000)}`, `Loading training shards into memory (${M.dataGiB}.0 GiB)...`, `slurmstepd: error: Detected 1 oom_kill event in StepId=${M.id}.batch. Some of the step tasks have been OOM Killed.`].join('\n') + '\n' });
      jr(M.node, mj.end - 1e3, 'kernel', `Memory cgroup out of memory: Killed process ${pid()} (python3) total-vm:${M.reqMem * 1048576 + 912340}kB, anon-rss:${M.reqMem * 1048576 - 4012}kB, file-rss:0kB, shmem-rss:0kB, UID:${UIDS[M.owner]} pgtables:33012kB oom_score_adj:0`, 'kernel');
      nodes[M.node].slurmdLog.push({ t: mj.end, text: `[${M.id}.batch] error: Detected 1 oom_kill event in StepId=${M.id}.batch. Some of the step tasks have been OOM Killed.` });
      ctlLog(mj.end, `_job_complete: JobId=${M.id} OOM failure`);
    }
    sh.mkdirp('/etc/slurm');

    /* ---- grading evidence ---- */
    const ev = { found: false, foundIds: {}, causeBase: false, causeM: false, cause: false, outputShown: {}, cancelledOthers: [], resumedWrong: [] };

    /* ---- helpers ---- */
    const running = n => jobs.filter(j => j.state === 'RUNNING' && j.node === n);
    function nstate(n) {
      const x = nodes[n], busy = running(n).length > 0;
      let s, long;
      if (x.down) { s = 'down'; long = 'DOWN'; }
      else if (x.drain) { s = busy ? 'drng' : 'drain'; long = (busy ? 'ALLOCATED' : 'IDLE') + '+DRAIN'; }
      else if (busy) { s = 'alloc'; long = 'ALLOCATED'; }
      else { s = 'idle'; long = 'IDLE'; }
      if (x.noresp) { s += '*'; long += '+NOT_RESPONDING'; }
      return { s: s, long: long };
    }
    function servicesUp(n) { const x = nodes[n]; return x.slurmd === 'active' && x.munge === 'active'; }
    function refreshResponding(n) {
      const x = nodes[n];
      if (servicesUp(n) && x.noresp) { x.noresp = false; ctlLog(sh.now(), `Node ${n} now responding`); }
    }
    function availableNodes(req) {
      return NODES.filter(n => !nodes[n].down && !nodes[n].drain && !nodes[n].noresp && running(n).length === 0 && (!req || req.includes(n)));
    }
    /* advance submitted jobs according to the clock */
    function sync() {
      const now = sh.now();
      jobs.filter(j => j.mine).forEach(j => {
        if (j.state === 'PENDING') {
          const av = availableNodes(j.reqNodes);
          if (av.length && !j.held) {
            j.node = av[0]; j.start = Math.max(j.submit + 1000, now - 1); j.state = 'RUNNING'; j.reason = 'None';
            j.end = null;
            ctlLog(j.start, `sched: Allocate JobId=${j.id} NodeList=${j.node} #CPUs=1 Partition=defq`);
            if (sh.isDir(NL.dirname(j.stdout))) sh.fs.set(j.stdout, { data: j.outLines.slice(0, 1).map(l => l.replace(/\{NODE\}/g, j.node).replace(/\{DATE\}/g, NL.dateCmd(j.start + 500))).join('\n') + '\n', mtime: j.start });
          } else j.reason = j.reqNodes && j.reqNodes.some(n => nodes[n].down || nodes[n].drain) ? 'ReqNodeNotAvail, UnavailableNodes:' + compress(j.reqNodes.filter(n => nodes[n].down || nodes[n].drain)) : 'Resources';
        }
        if (j.state === 'RUNNING' && now >= j.start + j.runtime) {
          j.end = j.start + j.runtime;
          if (j.oom) { j.state = 'OUT_OF_MEMORY'; j.exit = '0:125'; j.maxrss = j.mem * 1024 - 4012; ctlLog(j.end, `_job_complete: JobId=${j.id} OOM failure`); nodes[j.node].slurmdLog.push({ t: j.end, text: `[${j.id}.batch] error: Detected 1 oom_kill event in StepId=${j.id}.batch. Some of the step tasks have been OOM Killed.` }); }
          else { j.state = 'COMPLETED'; j.exit = '0:0'; j.maxrss = j.need ? Math.round(j.need * 1024 * 1.03) : 1840; ctlLog(j.end, `_job_complete: JobId=${j.id} WEXITSTATUS 0`); }
          ctlLog(j.end, `_job_complete: JobId=${j.id} done`);
          const text = j.outLines.map(l => l.replace(/\{NODE\}/g, j.node).replace(/\{DATE\}/g, NL.dateCmd(j.end - 500))).join('\n') + '\n';
          if (sh.isDir(NL.dirname(j.stdout))) sh.fs.set(j.stdout, { data: text, mtime: j.end });
          j.finalLine = text.trim().split('\n').pop();
        }
      });
    }
    const user = ctx => (ctx && ctx.sudo) || sh.user === 'root' ? 'root' : sh.user;
    const isRoot = ctx => user(ctx) === 'root';
    const compute = () => NODES.includes(sh.host);

    /* ---- sinfo ---- */
    function sinfo(argv) {
      const { o, errs } = opts(argv.slice(1), { R: { key: 'R' }, 'list-reasons': { key: 'R' }, N: { key: 'N' }, Node: { key: 'N' }, l: { key: 'l' }, long: { key: 'l' }, n: { key: 'n', val: 1 }, nodes: { key: 'n', val: 1 }, t: { key: 't', val: 1 }, states: { key: 't', val: 1 }, p: { key: 'p', val: 1 }, partition: { key: 'p', val: 1 }, h: { key: 'h' }, noheader: { key: 'h' }, s: { key: 's' }, summarize: { key: 's' }, a: { key: 'a' }, all: { key: 'a' }, d: { key: 'd' }, dead: { key: 'd' }, r: { key: 'r' }, responding: { key: 'r' }, help: { key: 'help' }, usage: { key: 'help' }, V: { key: 'V' }, version: { key: 'V' }, e: { key: 'e' }, exact: { key: 'e' }, i: { key: 'i', val: 1 }, iterate: { key: 'i', val: 1 }, o: { key: 'o', val: 1 }, format: { key: 'o', val: 1 }, O: { key: 'O', val: 1 }, Format: { key: 'O', val: 1 } });
      if (errs.length) return fail(`sinfo: ${errs[0]}\nTry "sinfo --help" for more information`);
      if (o.V) return ok('slurm 24.05.4');
      if (o.help) return ok('Usage: sinfo [OPTIONS]\n  -R, --list-reasons   list reason nodes are down or drained\n  -N, --Node           Node-centric format\n  -l, --long           long output\n  -n, --nodes=NODES    report on specific node(s)\n  -t, --states=STATES  list only nodes in these states\n  -p, --partition=PART report on specific partition\n  -s, --summarize      report state summary only');
      if (o.p && o.p !== 'defq') return ok(o.h ? '' : 'PARTITION AVAIL  TIMELIMIT  NODES  STATE NODELIST');
      const fmtList = () => { let l = NODES.slice(); if (o.n) { const want = expand(o.n); l = l.filter(n => want.includes(n)); } if (o.R) l = l.filter(n => nodes[n].reason); return l; };
      if (o.o || o.O) { let t; try { t = sinfoFormat(fmtList(), o); } catch (e) { return fail(`sinfo: error: Invalid node format specification: ${e.message}`); } return /^sinfo: error/.test(t) ? fail(t) : ok(t); }
      let list = NODES.slice();
      if (o.n) { const want = expand(o.n); list = list.filter(n => want.includes(n)); }
      if (o.d) list = list.filter(n => nodes[n].down || nodes[n].noresp);
      if (o.r) list = list.filter(n => !nodes[n].noresp);
      if (o.t) { const want = o.t.toLowerCase().split(','); list = list.filter(n => { const s = nstate(n).s.replace('*', ''); return want.some(w => s.startsWith(w.slice(0, 4)) || (w === 'drained' && s === 'drain') || (w === 'allocated' && s === 'alloc') || (w === 'draining' && s === 'drng')); }); }
      const hdr = l => o.h ? [] : [l];
      if (o.R) {
        const rows = list.filter(n => nodes[n].reason);
        const lines = hdr(`${padR('REASON', 20)} ${padR('USER', 9)} ${padR('TIMESTAMP', 19)} NODELIST`);
        const groups = {};
        rows.forEach(n => { const x = nodes[n]; const k = [x.reason, x.reasonUser, isoTime(x.reasonTime)].join('|'); (groups[k] = groups[k] || []).push(n); });
        Object.entries(groups).forEach(([k, ns]) => { const [rs, u, t] = k.split('|'); lines.push(`${padR(rs.slice(0, 20), 20)} ${padR(u.slice(0, 9), 9)} ${padR(t, 19)} ${compress(ns)}`); });
        return ok(lines.join('\n'));
      }
      if (o.s) {
        const a = list.filter(n => /alloc|drng|mix/.test(nstate(n).s)).length, i = list.filter(n => nstate(n).s === 'idle').length;
        return ok(hdr('PARTITION AVAIL  TIMELIMIT   NODES(A/I/O/T) NODELIST').concat([`defq*        up   infinite        ${a}/${i}/${list.length - a - i}/${list.length} ${compress(list)}`]).join('\n'));
      }
      const head = o.l ? [NL.dateCmd(sh.now())] : [];
      if (o.N) {
        if (o.l) {
          const lines = head.concat(hdr(`${padR('NODELIST', 10)} ${padL('NODES', 5)} ${padR('PARTITION', 9)} ${padR('STATE', 10)} ${padL('CPUS', 4)} ${padR('S:C:T', 8)} ${padL('MEMORY', 7)} ${padL('TMP_DISK', 8)} ${padL('WEIGHT', 6)} ${padR('AVAIL_FE', 8)} REASON`));
          list.forEach(n => { const st = nstate(n).s.replace('drng', 'draining').replace(/^drain(\*?)$/, 'drained$1').replace('alloc', 'allocated'); lines.push(`${padR(n, 10)} ${padL(1, 5)} ${padR('defq*', 9)} ${padR(st, 10)} ${padL(112, 4)} ${padR('2:56:1', 8)} ${padL(2063937, 7)} ${padL(0, 8)} ${padL(1, 6)} ${padR('(null)', 8)} ${nodes[n].reason || 'none'}`); });
          return ok(lines.join('\n'));
        }
        const lines = hdr('NODELIST   NODES PARTITION STATE ');
        list.forEach(n => lines.push(`${padR(n, 10)} ${padL(1, 5)} ${padL('defq*', 9)} ${padR(nstate(n).s, 6)}`));
        return ok(lines.join('\n'));
      }
      const groups = {};
      list.forEach(n => { const s = nstate(n).s; (groups[s] = groups[s] || []).push(n); });
      const order = Object.keys(groups).sort((a, b) => list.indexOf(groups[a][0]) - list.indexOf(groups[b][0]));
      if (o.l) {
        const lines = head.concat(hdr('PARTITION AVAIL  TIMELIMIT   JOB_SIZE ROOT OVERSUBS     GROUPS  NODES       STATE RESERVATION NODELIST'));
        order.forEach(s => { const st = s.replace('drng', 'draining').replace(/^drain(\*?)$/, 'drained$1').replace('alloc', 'allocated'); lines.push(`defq*        up   infinite 1-infinite   no       NO        all ${padL(groups[s].length, 6)} ${padL(st, 11)}             ${compress(groups[s])}`); });
        return ok(lines.join('\n'));
      }
      const lines = hdr('PARTITION AVAIL  TIMELIMIT  NODES  STATE NODELIST');
      order.forEach(s => lines.push(`defq*        up   infinite ${padL(groups[s].length, 6)} ${padL(s, 6)} ${compress(groups[s])}`));
      return ok(lines.join('\n'));
    }

    /* sinfo -o "%N %T %E" and -O NodeList,StateLong,Reason */
    function sinfoFormat(list, o) {
      const longState = n => { const s = nstate(n).s; const star = s.endsWith('*') ? '*' : ''; const b = s.replace('*', ''); return ({ idle: 'idle', alloc: 'allocated', drng: 'draining', drain: 'drained', down: 'down' })[b] + star; };
      const F = {
        N: ['NODELIST', ns => compress(ns)], n: ['HOSTNAMES', ns => ns.join(',')], T: ['STATE', ns => longState(ns[0])], t: ['STATE', ns => nstate(ns[0]).s],
        E: ['REASON', ns => nodes[ns[0]].reason || 'none'], P: ['PARTITION', () => 'defq*'], R: ['PARTITION', () => 'defq'], D: ['NODES', ns => String(ns.length)],
        a: ['AVAIL', () => 'up'], l: ['TIMELIMIT', () => 'infinite'], c: ['CPUS', () => '112'], m: ['MEMORY', () => '2063937'], G: ['GRES', () => 'gpu:h100:8(S:0-1)'],
        u: ['USER', ns => nodes[ns[0]].reasonUser || 'Unknown'], H: ['TIMESTAMP', ns => nodes[ns[0]].reasonTime ? isoTime(nodes[ns[0]].reasonTime) : 'Unknown'],
        C: ['CPUS(A/I/O/T)', ns => { const a = ns.reduce((x, n) => x + running(n).reduce((y, j) => y + j.cpus, 0), 0); const off = ns.filter(n => nodes[n].down || nodes[n].drain).length * 112; return `${a}/${ns.length * 112 - a - off}/${off}/${ns.length * 112}`; }],
        O: ['CPU_LOAD', ns => nodes[ns[0]].noresp ? 'N/A' : '0.03'], e: ['FREE_MEM', ns => nodes[ns[0]].noresp ? 'N/A' : '1987345'], f: ['AVAIL_FEATURES', () => '(null)'], b: ['ACTIVE_FEATURES', () => '(null)']
      };
      let parts = [];
      if (o.o) {
        const re = /%(\.)?(\d+)?([A-Za-z])/g; let last = 0, m;
        while ((m = re.exec(o.o))) { if (m.index > last) parts.push({ lit: o.o.slice(last, m.index) }); parts.push({ key: m[3], right: !!m[1], w: m[2] ? +m[2] : 0 }); last = re.lastIndex; }
        if (last < o.o.length) parts.push({ lit: o.o.slice(last) });
      } else {
        const ON = { nodelist: 'N', nodehost: 'n', statelong: 'T', statecompact: 't', reason: 'E', partition: 'P', partitionname: 'R', nodes: 'D', available: 'a', time: 'l', cpus: 'c', memory: 'm', gres: 'G', user: 'u', timestamp: 'H', cpusstate: 'C', cpusload: 'O', freemem: 'e' };
        o.O.split(',').filter(Boolean).forEach((f, i, arr) => { const [nm, w] = f.split(':'); const k = ON[nm.toLowerCase()]; if (!k) throw new Error(nm); parts.push({ key: k, right: false, w: w ? +w : (i === arr.length - 1 ? 0 : 20) }); if (i < arr.length - 1) parts.push({ lit: ' ' }); });
      }
      const bad = parts.find(p => p.key && !F[p.key]);
      if (bad) return `sinfo: error: Invalid format specification: %${bad.key}`;
      const cell = (p, v) => p.w ? (p.right ? padL(v.slice(0, p.w), p.w) : padR(v.slice(0, p.w), p.w)) : v;
      const render = ns => parts.map(p => p.lit !== undefined ? p.lit : cell(p, F[p.key][1](ns))).join('').replace(/\s+$/, '');
      const lines = o.h ? [] : [parts.map(p => p.lit !== undefined ? p.lit : cell(p, F[p.key][0])).join('').replace(/\s+$/, '')];
      if (o.N) list.forEach(n => lines.push(render([n])));
      else {
        // group nodes whose rows are identical apart from the node list / count
        const groups = [];
        list.forEach(n => { const key = parts.map(p => p.key && !'NnD'.includes(p.key) ? F[p.key][1]([n]) : '').join('|'); const g = groups.find(x => x.key === key); if (g) g.ns.push(n); else groups.push({ key: key, ns: [n] }); });
        groups.forEach(g => lines.push(render(g.ns)));
      }
      return lines.join('\n');
    }

    /* ---- squeue ---- */
    function fmtTime(ms) {
      let s = Math.max(0, Math.floor(ms / 1000)); const d = Math.floor(s / 86400); s -= d * 86400; const h = Math.floor(s / 3600); s -= h * 3600; const m = Math.floor(s / 60); s -= m * 60;
      const two = x => String(x).padStart(2, '0');
      return d ? `${d}-${two(h)}:${two(m)}:${two(s)}` : h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
    }
    function squeue(argv, ctx) {
      const { o, errs } = opts(argv.slice(1), { u: { key: 'u', val: 1 }, user: { key: 'u', val: 1 }, me: { key: 'me' }, t: { key: 't', val: 1 }, states: { key: 't', val: 1 }, j: { key: 'j', val: 1 }, jobs: { key: 'j', val: 1 }, p: { key: 'p', val: 1 }, partition: { key: 'p', val: 1 }, l: { key: 'l' }, long: { key: 'l' }, h: { key: 'h' }, noheader: { key: 'h' }, a: { key: 'a' }, all: { key: 'a' }, w: { key: 'w', val: 1 }, nodelist: { key: 'w', val: 1 }, help: { key: 'help' }, i: { key: 'i', val: 1 }, iterate: { key: 'i', val: 1 }, r: { key: 'r' }, o: { key: 'o', val: 1 }, format: { key: 'o', val: 1 }, start: { key: 'start' }, v: { key: 'v' } });
      if (errs.length) return fail(`squeue: ${errs[0]}\nTry "squeue --help" for more information`);
      if (o.help) return ok('Usage: squeue [-A account] [--clusters names] [-i seconds] [--job jobid]\n              [-n name] [-o format] [-p partitions] [--qos qos]\n              [--reservation reservation] [--sort fields] [--start]\n              [--step step_id] [-t states] [-u user_name] [--usage]\n              [-L licenses] [-w nodes] [--federation] [--local] [--sibling]\n              [-ahjlrsv]');
      let list = jobs.filter(j => j.state === 'RUNNING' || j.state === 'PENDING' || (j.mine && j.state === 'COMPLETING'));
      if (o.me) list = list.filter(j => j.user === user(ctx));
      if (o.u) list = list.filter(j => o.u.split(',').includes(j.user));
      if (o.j) list = list.filter(j => o.j.split(',').includes(String(j.id)));
      if (o.t) { const want = o.t.toUpperCase().split(',').map(s => STATE_CODES[s] || s); list = list.filter(j => want.includes(j.state) || want.includes('ALL')); }
      if (o.w) { const want = expand(o.w); list = list.filter(j => want.includes(j.node)); }
      if (o.j && !list.length && !jobs.some(j => String(j.id) === o.j && (sh.now() - (j.end || sh.now())) < 300e3)) return fail('slurm_load_jobs error: Invalid job id specified');
      if (o.o) {
        const F = {
          i: ['JOBID', j => String(j.id)], A: ['JOBID', j => String(j.id)], P: ['PARTITION', () => 'defq'], j: ['NAME', j => j.name], u: ['USER', j => j.user],
          t: ['ST', j => SHORT[j.state]], T: ['STATE', j => j.state], M: ['TIME', j => j.state === 'RUNNING' ? fmtTime(sh.now() - j.start) : '0:00'], l: ['TIME_LIMIT', j => fmtTime(j.timelimit || 300e3)],
          D: ['NODES', () => '1'], R: ['NODELIST(REASON)', j => j.state === 'PENDING' ? `(${j.reason || 'Priority'})` : j.node], N: ['NODELIST', j => j.node || ''], C: ['CPUS', j => String(j.cpus)],
          m: ['MIN_MEMORY', j => j.mem % 1024 === 0 ? (j.mem / 1024) + 'G' : j.mem + 'M'], b: ['TRES_PER_NODE', j => j.gpus ? `gres/gpu:${j.gpus}` : 'N/A'], V: ['SUBMIT_TIME', j => isoTime(j.submit)],
          S: ['START_TIME', j => j.start ? isoTime(j.start) : 'N/A'], e: ['END_TIME', j => j.end ? isoTime(j.end) : 'N/A'], r: ['REASON', j => j.state === 'PENDING' ? (j.reason || 'Priority') : 'None'],
          a: ['ACCOUNT', j => j.account], q: ['QOS', () => 'normal'], Q: ['PRIORITY', () => '1'], Z: ['WORK_DIR', j => j.workdir], o: ['COMMAND', j => j.script]
        };
        const parts = []; const re = /%(\.)?(\d+)?([A-Za-z])/g; let last = 0, m;
        while ((m = re.exec(o.o))) { if (m.index > last) parts.push({ lit: o.o.slice(last, m.index) }); if (!F[m[3]]) return fail(`squeue: error: Invalid job format specification: ${m[3]}`); parts.push({ key: m[3], right: !!m[1], w: m[2] ? +m[2] : 0 }); last = re.lastIndex; }
        if (last < o.o.length) parts.push({ lit: o.o.slice(last) });
        const cell = (p, v) => p.w ? (p.right ? padL(String(v).slice(0, p.w), p.w) : padR(String(v).slice(0, p.w), p.w)) : String(v);
        const row = f => parts.map(p => p.lit !== undefined ? p.lit : cell(p, f(p))).join('').replace(/\s+$/, '');
        const out = o.h ? [] : [row(p => F[p.key][0])];
        list.forEach(j => out.push(row(p => F[p.key][1](j))));
        return ok(out.join('\n'));
      }
      const lines = [];
      if (o.l) lines.push(NL.dateCmd(sh.now()));
      if (!o.h) lines.push(o.l ? '             JOBID PARTITION     NAME     USER    STATE       TIME TIME_LIMI  NODES NODELIST(REASON)' : '             JOBID PARTITION     NAME     USER ST       TIME  NODES NODELIST(REASON)');
      list.forEach(j => {
        const time = j.state === 'RUNNING' ? fmtTime(sh.now() - j.start) : '0:00';
        const where = j.state === 'PENDING' ? `(${j.reason || 'Priority'})` : j.node;
        if (o.l) lines.push(`${padL(j.id, 18)} ${padL('defq', 9)} ${padL(j.name.slice(0, 8), 8)} ${padL(j.user.slice(0, 8), 8)} ${padL(j.state.slice(0, 8), 8)} ${padL(time, 10)} ${padL(fmtTime(j.timelimit || 300e3), 9)} ${padL(1, 6)} ${where}`);
        else lines.push(`${padL(j.id, 18)} ${padL('defq', 9)} ${padL(j.name.slice(0, 8), 8)} ${padL(j.user.slice(0, 8), 8)} ${padL(SHORT[j.state], 2)} ${padL(time, 10)} ${padL(1, 6)} ${where}`);
      });
      return ok(lines.join('\n'));
    }

    /* ---- sacct ---- */
    function parseTime(s) {
      const now = sh.now(); const day = new Date(now).setHours(0, 0, 0, 0);
      let m;
      if (/^(today|midnight)$/i.test(s)) return day;
      if (/^tomorrow$/i.test(s)) return day + 86400e3;
      if (/^noon$/i.test(s)) return day + 12 * 3600e3;
      if ((m = /^now(?:([+-])(\d+)(seconds|minutes|hours|days|weeks|s|m|h|d|w)?)?$/i.exec(s))) {
        if (!m[1]) return now;
        const unit = (m[3] || 's').toLowerCase()[0]; const mult = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[unit];
        return now + (m[1] === '-' ? -1 : 1) * Number(m[2]) * mult;
      }
      if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s))) return new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
      if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s))) { const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : new Date(now).getFullYear(); return new Date(y, m[1] - 1, +m[2]).getTime(); }
      if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s))) return day + (+m[1]) * 3600e3 + (+m[2]) * 60e3 + (+(m[3] || 0)) * 1e3;
      return null;
    }
    const FIELDS = {
      jobid: ['JobID', 12, (j, st) => st ? j.id + '.' + st : String(j.id)], jobidraw: ['JobIDRaw', 12, (j, st) => st ? j.id + '.' + st : String(j.id)],
      jobname: ['JobName', 10, (j, st) => st || j.name], partition: ['Partition', 10, (j, st) => st ? '' : j.partition], account: ['Account', 10, j => j.account],
      alloccpus: ['AllocCPUS', 10, j => String(j.cpus)], state: ['State', 10, (j, st) => j.state === 'CANCELLED' && !st ? `CANCELLED by ${UIDS[j.user]}` : st && (j.state === 'NODE_FAIL' || j.state === 'OUT_OF_MEMORY') && st === 'extern' ? 'COMPLETED' : st && j.state === 'TIMEOUT' ? 'CANCELLED' : j.state],
      exitcode: ['ExitCode', 8, (j, st) => st === 'batch' && j.state === 'FAILED' ? '1:0' : st && j.state === 'TIMEOUT' ? '0:15' : j.exit],
      user: ['User', 9, (j, st) => st ? '' : j.user], nodelist: ['NodeList', 15, j => j.node || 'None assigned'], start: ['Start', 19, j => j.start ? isoTime(j.start) : 'Unknown'],
      end: ['End', 19, j => j.end ? isoTime(j.end) : 'Unknown'], submit: ['Submit', 19, j => isoTime(j.submit)], elapsed: ['Elapsed', 10, j => j.start ? NL.elapsed((j.end || sh.now()) - j.start) : '00:00:00'],
      nnodes: ['NNodes', 8, () => '1'], workdir: ['WorkDir', 20, (j, st) => st ? '' : j.workdir], reason: ['Reason', 10, j => j.state === 'NODE_FAIL' ? 'None' : 'None'],
      alloctres: ['AllocTRES', 30, j => `billing=${j.cpus},cpu=${j.cpus}${j.gpus ? ',gres/gpu=' + j.gpus : ''},node=1`], timelimit: ['Timelimit', 10, j => fmtTime(j.timelimit || 86400e3)],
      reqmem: ['ReqMem', 10, (j, st) => st ? '' : j.mem % 1024 === 0 ? (j.mem / 1024) + 'G' : (j.mem / 1024).toFixed(2) + 'G'],
      maxrss: ['MaxRSS', 10, (j, st) => !st || !j.end || j.maxrss == null ? '' : st === 'batch' ? j.maxrss + 'K' : st === 'extern' ? '1024K' : '0'],
      averss: ['AveRSS', 10, (j, st) => !st || !j.end || j.maxrss == null ? '' : st === 'batch' ? Math.round(j.maxrss * 0.92) + 'K' : st === 'extern' ? '1024K' : '0'],
      maxvmsize: ['MaxVMSize', 10, (j, st) => !st || !j.end || j.maxrss == null ? '' : st === 'batch' ? Math.round(j.maxrss * 1.21) + 'K' : '4364K'],
      reqcpus: ['ReqCPUS', 8, j => String(j.cpus)], reqnodes: ['ReqNodes', 8, () => '1'], allocnodes: ['AllocNodes', 10, () => '1'],
      cputime: ['CPUTime', 10, j => j.start ? NL.elapsed(((j.end || sh.now()) - j.start) * j.cpus) : '00:00:00'], group: ['Group', 9, j => j.user], qos: ['QOS', 10, () => 'normal'], priority: ['Priority', 10, () => '1'],
      submitline: ['SubmitLine', 20, (j, st) => st ? '' : j.submitLine || `sbatch ${NL.basename(j.script || '')}`],
      derivedexitcode: ['DerivedExitCode', 10, j => j.exit], uid: ['UID', 6, j => String(UIDS[j.user])], cluster: ['Cluster', 10, () => 'slurm'], comment: ['Comment', 10, () => '']
    };
    function sacct(argv, ctx) {
      const { o, errs } = opts(argv.slice(1), { a: { key: 'a' }, allusers: { key: 'a' }, S: { key: 'S', val: 1 }, starttime: { key: 'S', val: 1 }, E: { key: 'E', val: 1 }, endtime: { key: 'E', val: 1 }, s: { key: 's', val: 1 }, state: { key: 's', val: 1 }, X: { key: 'X' }, allocations: { key: 'X' }, o: { key: 'o', val: 1 }, format: { key: 'o', val: 1 }, j: { key: 'j', val: 1 }, jobs: { key: 'j', val: 1 }, u: { key: 'u', val: 1 }, user: { key: 'u', val: 1 }, n: { key: 'n' }, noheader: { key: 'n' }, P: { key: 'P' }, parsable2: { key: 'P' }, p: { key: 'p' }, parsable: { key: 'p' }, l: { key: 'l' }, long: { key: 'l' }, b: { key: 'b' }, brief: { key: 'b' }, N: { key: 'N', val: 1 }, nodelist: { key: 'N', val: 1 }, r: { key: 'r', val: 1 }, partition: { key: 'r', val: 1 }, name: { key: 'name', val: 1 }, help: { key: 'help' }, D: { key: 'D' }, duplicates: { key: 'D' }, L: { key: 'L' }, allclusters: { key: 'L' }, T: { key: 'T' }, truncate: { key: 'T' }, e: { key: 'e' }, helpformat: { key: 'e' }, v: { key: 'v' }, verbose: { key: 'v' } });
      if (errs.length) return fail(`sacct: ${errs[0]}\nTry "sacct --help" for more information`);
      if (o.help) return ok('sacct [<OPTION>]\n  -a, --allusers      Display jobs for all users. By default, only the current user\'s jobs are displayed.\n  -S, --starttime     Select jobs eligible after this time. Default is 00:00:00 of the current day,\n                      unless \'-s\' is set, then the default is \'now\'.\n                      With -j and no -s, the default is Epoch 0.\n  -E, --endtime       Select jobs eligible before this time.\n  -s, --state         Select jobs based on their state during the time period given.\n  -X, --allocations   Only show statistics relevant to the job allocation itself.\n  -o, --format        Comma separated list of fields (use "--helpformat" for a list).\n  -j, --jobs          Display information about this job or comma-separated list of jobs.\n  -u, --user          Use this comma separated list of user names to select jobs to display.');
      if (o.e) return ok(Object.values(FIELDS).map(f => f[0]).join('  '));
      // fields
      let fields;
      if (o.o) {
        fields = [];
        for (const raw of o.o.split(',').filter(Boolean)) {
          const [nm, w] = raw.split('%'); const f = FIELDS[nm.toLowerCase()];
          if (!f) return fail(`sacct: error: Invalid field requested: "${nm}"`);
          fields.push([f[0], w ? Math.abs(parseInt(w, 10)) : f[1], f[2]]);
        }
      } else if (o.b) fields = ['jobid', 'state', 'exitcode'].map(k => FIELDS[k]);
      else if (o.l) fields = ['jobid', 'jobidraw', 'jobname', 'partition', 'user', 'account', 'alloccpus', 'nnodes', 'nodelist', 'start', 'end', 'elapsed', 'state', 'exitcode'].map(k => FIELDS[k]);
      else fields = ['jobid', 'jobname', 'partition', 'account', 'alloccpus', 'state', 'exitcode'].map(k => FIELDS[k]);
      // states
      let states = null;
      if (o.s) {
        states = [];
        for (const s of o.s.split(',')) { const u = s.toUpperCase(); const full = STATE_CODES[u] || STATE_NAMES.find(n => n === u) || (u === 'CANCELED' ? 'CANCELLED' : null); if (!full) return fail(`sacct: fatal: unrecognized job state value ${s}`); states.push(full); }
      }
      // time window. With -s or -j and no -S, Slurm uses 'now' as the start time.
      const now = sh.now();
      let S, E;
      if (o.S !== undefined) { S = parseTime(o.S); if (S === null) return fail(`sacct: error: Invalid time specification (pos=0): ${o.S}`); }
      else S = o.j ? 0 : o.s ? now : new Date(now).setHours(0, 0, 0, 0); // -j: Epoch 0; -s: now; otherwise midnight
      if (o.E !== undefined) { E = parseTime(o.E); if (E === null) return fail(`sacct: error: Invalid time specification (pos=0): ${o.E}`); } else E = now;
      if (o.s && o.S === undefined && o.E === undefined) E = now;
      sync();
      const me = user(ctx);
      let list = jobs.filter(j => j.state !== 'PENDING' || states);
      if (o.u) list = list.filter(j => o.u.split(',').includes(j.user));
      else if (!o.a && me !== 'root' && !o.j && !o.N) list = list.filter(j => j.user === me); // -j / -N return every user's jobs
      if (o.j) list = list.filter(j => o.j.split(',').map(x => x.split('.')[0]).includes(String(j.id)));
      else list = list.filter(j => (j.end || now) >= S && j.submit <= E);
      if (states) list = list.filter(j => states.includes(j.state) && (o.j || ((j.end || now) >= S && (j.start || j.submit) <= E)));
      if (o.N) { const want = expand(o.N); list = list.filter(j => want.includes(j.node)); }
      if (o.name) list = list.filter(j => o.name.split(',').includes(j.name));
      const rows = [];
      list.sort((a, b) => a.id - b.id).forEach(j => {
        rows.push([j, null]);
        if (!o.X && j.state !== 'PENDING') { if (j.state !== 'CANCELLED' || j.start) { if (j.mine || j.cpus) rows.push([j, 'batch']); rows.push([j, 'extern']); } if (j.mine && j.state !== 'RUNNING') rows.push([j, '0']); }
      });
      const cell = (f, j, st) => { const v = f[2](j, st) || ''; if (o.P || o.p) return v; return v.length > f[1] ? v.slice(0, f[1] - 1) + '+' : padL(v, f[1]); };
      const lines = [];
      if (!o.n) {
        if (o.P || o.p) lines.push(fields.map(f => f[0]).join('|') + (o.p ? '|' : ''));
        else { lines.push(fields.map(f => padL(f[0].slice(0, f[1]), f[1])).join(' ')); lines.push(fields.map(f => '-'.repeat(f[1])).join(' ')); }
      }
      rows.forEach(([j, st]) => lines.push(fields.map(f => cell(f, j, st)).join(o.P || o.p ? '|' : ' ') + (o.p ? '|' : '')));
      if (practice && !ev.found) {
        const sawFailed = list.some(j => j.id === base || (M && j.id === M.id));
        const oomId = cause === 'oom' ? base : M ? M.id : null;
        if (both && sawFailed && !(list.some(j => j.id === base) && list.some(j => j.id === M.id))) sh.hint('Two jobs failed today. Widen the search so both show up: -s FAILED,NODE_FAIL,TIMEOUT,OUT_OF_MEMORY.');
        else if (oomId && list.some(j => j.id === oomId) && !(o.o && /maxrss/i.test(o.o) && !o.X)) sh.hint(`OUT_OF_MEMORY: compare what job ${oomId} requested with what it used. MaxRSS is recorded per step, so leave out -X: sacct -j ${oomId} --format=JobID,State,ReqMem,MaxRSS,WorkDir`);
        else if (!sawFailed && o.s && o.S === undefined && !o.j) sh.hint('With --state and no -S, sacct only looks at jobs active right now. Add -S today (or a time) to look back.');
        else if (!sawFailed && !o.a && me !== 'root' && !o.u && !o.j && !o.N) sh.hint('Without -a you only see your own jobs. The job that failed may belong to another user. Add -a.');
        else if (sawFailed && !o.o && !o.l) sh.hint('The default columns do not include the node. Add --format=JobID,JobName,User,State,ExitCode,NodeList (or check sinfo -R).');
      }
      return ok(lines.join('\n'));
    }

    /* ---- scontrol ---- */
    function showNode(n) {
      const x = nodes[n], st = nstate(n);
      const alloc = running(n).reduce((s, j) => s + j.cpus, 0), galloc = running(n).reduce((s, j) => s + j.gpus, 0);
      return [`NodeName=${n} Arch=x86_64 CoresPerSocket=56 `,
        `   CPUAlloc=${alloc} CPUEfctv=112 CPUTot=112 CPULoad=${x.noresp ? 'N/A' : (alloc ? '98.41' : '0.03')}`,
        '   AvailableFeatures=(null)', '   ActiveFeatures=(null)',
        `   Gres=gpu:h100:8(S:0-1)`, `   NodeAddr=${n} NodeHostName=${n} Version=24.05.4`,
        `   OS=Linux 5.15.0-1063-nvidia #64-Ubuntu SMP `,
        `   RealMemory=2063937 AllocMem=0 FreeMem=${x.noresp ? 'N/A' : '1987345'} Sockets=2 Boards=1`,
        `   State=${st.long} ThreadsPerCore=1 TmpDisk=0 Weight=1 Owner=N/A MCS_label=N/A`,
        '   Partitions=defq ',
        `   BootTime=${isoTime(x.boot)} SlurmdStartTime=${x.slurmd === 'active' ? isoTime(x.slurmdSince) : isoTime(x.slurmdSince)}`,
        `   LastBusyTime=${isoTime(sh.now() - 600e3)} ResumeAfterTime=None`,
        `   CfgTRES=cpu=112,mem=2063937M,billing=112,gres/gpu=8`,
        `   AllocTRES=${alloc ? `cpu=${alloc}${galloc ? ',gres/gpu=' + galloc : ''}` : ''}`,
        '   CurrentWatts=0 AveWatts=0', '   ',
        x.reason ? `   Reason=${x.reason} [${x.reasonUser}@${isoTime(x.reasonTime)}]` : null].filter(l => l !== null).join('\n').replace(/\n   $/, '');
    }
    function showJob(j) {
      return [`JobId=${j.id} JobName=${j.name}`, `   UserId=${j.user}(${UIDS[j.user]}) GroupId=${j.user}(${UIDS[j.user]}) MCS_label=N/A`,
        `   Priority=1 Nice=0 Account=${j.account} QOS=normal`,
        `   JobState=${j.state} Reason=${j.state === 'PENDING' ? j.reason : 'None'} Dependency=(null)`,
        `   Requeue=1 Restarts=0 BatchFlag=1 Reboot=0 ExitCode=${j.exit}`,
        `   RunTime=${NL.elapsed(j.start ? (j.end || sh.now()) - j.start : 0)} TimeLimit=00:05:00 TimeMin=N/A`,
        `   SubmitTime=${isoTime(j.submit)} EligibleTime=${isoTime(j.submit)}`,
        `   StartTime=${j.start ? isoTime(j.start) : 'Unknown'} EndTime=${j.end ? isoTime(j.end) : j.start ? isoTime(j.start + 300e3) : 'Unknown'} Deadline=N/A`,
        `   Partition=defq AllocNode:Sid=headnode:${NL.int(r, 2000, 9000)}`,
        `   NodeList=${j.node || '(null)'}`, `   BatchHost=${j.node || '(null)'}`,
        `   NumNodes=1 NumCPUs=1 NumTasks=1 CPUs/Task=1 ReqB:S:C:T=0:0:*:*`,
        `   ReqTRES=cpu=1,mem=1000M,node=1,billing=1${j.gpus ? ',gres/gpu=' + j.gpus : ''}`,
        `   Command=${j.script}`, `   WorkDir=${j.workdir}`, `   StdErr=${j.stdout}`, `   StdIn=/dev/null`, `   StdOut=${j.stdout}`,
        `   TresPerNode=gres/gpu:${j.gpus}`].join('\n');
    }
    function scontrol(argv, ctx) {
      const a = argv.slice(1).filter(x => !/^-(v+|d|o|Q)$/.test(x));
      const sub = (a[0] || '').toLowerCase();
      sync();
      if (!sub) return ok(''); // interactive mode not simulated
      if (sub === 'ping') return ok('Slurmctld(primary) at headnode is UP');
      if (sub === 'version' || sub === '-v' || sub === '--version') return ok('slurm 24.05.4');
      if (sub === 'show') {
        const what = (a[1] || '').toLowerCase(), id = a[2];
        if (/^nodes?$/.test(what)) {
          if (!id) return ok(NODES.map(showNode).join('\n\n'));
          const want = expand(id); const bad = want.filter(n => !nodes[n]);
          if (bad.length) return fail(`Node ${bad[0]} not found`);
          if (practice && want.includes(failNode) && nodes[failNode].noresp) sh.hint(`State shows +NOT_RESPONDING: slurmctld can't reach slurmd on ${failNode}. Log in to that node (ssh ${failNode}) and check the slurmd service and its logs with sudo.`);
          return ok(want.map(showNode).join('\n\n'));
        }
        if (/^(jobs?|jobid)$/.test(what)) {
          const vis = jobs.filter(j => j.state === 'RUNNING' || j.state === 'PENDING' || (j.end && sh.now() - j.end < 300e3));
          if (!id) return ok(vis.length ? vis.map(showJob).join('\n\n') : 'No jobs in the system');
          const j = vis.find(x => String(x.id) === String(id));
          if (!j) { if (practice && jobs.some(x => String(x.id) === String(id))) sh.hint('scontrol only knows jobs that are active or finished in the last MinJobAge (300 s). For older jobs use sacct.'); return fail('slurm_load_jobs error: Invalid job id specified'); }
          return ok(showJob(j));
        }
        if (/^partitions?$/.test(what)) return ok(`PartitionName=defq\n   AllowGroups=ALL AllowAccounts=ALL AllowQos=ALL\n   Default=YES QoS=N/A\n   DefaultTime=NONE DisableRootJobs=NO ExclusiveUser=NO GraceTime=0 Hidden=NO\n   MaxNodes=UNLIMITED MaxTime=UNLIMITED MinNodes=0 LLN=NO MaxCPUsPerNode=UNLIMITED\n   Nodes=${compress(NODES)}\n   State=UP TotalCPUs=448 TotalNodes=4\n   TRES=cpu=448,mem=8255748M,node=4,billing=448,gres/gpu=32`);
        if (what === 'config') return ok(['Configuration data as of ' + isoTime(sh.now()), 'AccountingStorageType   = accounting_storage/slurmdbd', 'AuthType                = auth/munge', 'ClusterName             = slurm', 'GresTypes               = gpu', 'MinJobAge               = 300 sec', 'ReturnToService         = 0', 'SlurmctldHost[0]        = headnode', 'SlurmctldLogFile        = /var/log/slurmctld', 'SlurmdLogFile           = /var/log/slurmd', 'SlurmdTimeout           = 300 sec', 'SlurmUser               = slurm(450)', 'SLURM_CONF              = /cm/shared/apps/slurm/var/etc/slurm/slurm.conf', 'SLURM_VERSION           = 24.05.4'].join('\n'));
        return fail(`invalid entity: ${a[1] || ''} for keyword:show`);
      }
      if (sub === 'update') {
        const kv = {}; const extra = [];
        a.slice(1).forEach(x => { const m = /^([A-Za-z]+)=(.*)$/s.exec(x); if (m) kv[m[1].toLowerCase()] = m[2]; else extra.push(x); });
        const target = kv.nodename || kv.node;
        if (kv.jobid || kv.job) return fail('slurm_update error: Access/permission denied');
        if (!target) return fail('No valid entity in update command\nInput line must include "NodeName", "PartitionName", "Reservation/ReservationName", or "JobId"');
        if (extra.length) return fail(`Invalid input: ${extra[0]}\nRequest aborted`);
        const list = expand(target); const bad = list.filter(n => !nodes[n]);
        if (bad.length) return fail('slurm_update error: Invalid node name specified');
        const state = (kv.state || '').toLowerCase();
        if (!state && kv.reason !== undefined) { list.forEach(n => { nodes[n].reason = kv.reason; nodes[n].reasonUser = user(ctx); nodes[n].reasonTime = sh.now(); }); return ok(); }
        if (['drain', 'down', 'fail'].includes(state)) {
          if (!kv.reason) return fail('You must specify a reason when DOWNING or DRAINING a node. Request denied');
          list.forEach(n => {
            const x = nodes[n];
            if (state === 'down') { x.down = true; } else x.drain = true;
            x.reason = kv.reason; x.reasonUser = user(ctx); x.reasonTime = sh.now();
            ctlLog(sh.now(), `update_node: node ${n} reason set to: ${kv.reason}`);
            ctlLog(sh.now(), `update_node: node ${n} state set to ${state === 'down' ? 'DOWN' : running(n).length ? 'DRAINING' : 'DRAINED'}`);
          });
          if (practice && list.includes(drainNode)) sh.hint('Check the result with sinfo or sinfo -R.');
          return ok();
        }
        if (['resume', 'undrain', 'idle'].includes(state)) {
          if (state === 'idle') return fail('slurm_update error: Invalid node state specified');
          for (const n of list) {
            const x = nodes[n];
            if (!x.down && !x.drain) return fail('slurm_update error: Invalid node state specified');
          }
          list.forEach(n => {
            const x = nodes[n];
            if (state === 'undrain') { x.drain = false; if (!x.down) x.reason = ''; }
            else { x.down = false; x.drain = false; x.reason = ''; x.reasonUser = ''; }
            if (x.noresp) { x.down = true; x.reason = 'Not responding'; x.reasonUser = 'slurm'; x.reasonTime = sh.now(); if (practice) sh.hint(`${n} went straight back to down*: slurmd is still not responding there. Fix the node first, then resume it.`); }
            else ctlLog(sh.now(), `update_node: node ${n} state set to IDLE`);
            if (n !== failNode && n !== drainNode) ev.resumedWrong.push(n);
          });
          return ok();
        }
        if (state) return fail('slurm_update error: Invalid node state specified');
        return ok();
      }
      if (sub === 'reconfigure') return isRoot(ctx) ? ok() : fail('slurm_reconfigure error: Invalid user id');
      if (['hold', 'release', 'requeue', 'suspend', 'resume'].includes(sub)) return fail(`Unsupported in this simulator: scontrol ${sub}`);
      return fail(`invalid keyword: ${a[0]}`);
    }

    /* ---- sbatch / scancel ---- */
    const SB = { J: { key: 'J', val: 1 }, 'job-name': { key: 'J', val: 1 }, o: { key: 'o', val: 1 }, output: { key: 'o', val: 1 }, e: { key: 'e', val: 1 }, error: { key: 'e', val: 1 }, p: { key: 'p', val: 1 }, partition: { key: 'p', val: 1 }, N: { key: 'N', val: 1 }, nodes: { key: 'N', val: 1 }, n: { key: 'n', val: 1 }, ntasks: { key: 'n', val: 1 }, w: { key: 'w', val: 1 }, nodelist: { key: 'w', val: 1 }, gres: { key: 'gres', val: 1 }, G: { key: 'G', val: 1 }, gpus: { key: 'G', val: 1 }, t: { key: 't', val: 1 }, time: { key: 't', val: 1 }, c: { key: 'c', val: 1 }, 'cpus-per-task': { key: 'c', val: 1 }, mem: { key: 'mem', val: 1 }, 'ntasks-per-node': { key: 'tpn', val: 1 }, 'gpus-per-node': { key: 'G', val: 1 }, D: { key: 'D', val: 1 }, chdir: { key: 'D', val: 1 }, x: { key: 'x', val: 1 }, exclude: { key: 'x', val: 1 }, wrap: { key: 'wrap', val: 1 }, A: { key: 'A', val: 1 }, account: { key: 'A', val: 1 }, q: { key: 'q', val: 1 }, qos: { key: 'q', val: 1 }, exclusive: { key: 'exclusive' }, H: { key: 'H' }, hold: { key: 'H' }, help: { key: 'help' }, W: { key: 'W' }, wait: { key: 'W' } };
    function sbatch(argv, ctx) {
      const pre = opts(argv.slice(1), SB);
      if (pre.errs.length) return fail(`sbatch: ${pre.errs[0]}\nTry "sbatch --help" for more information`);
      if (pre.o.help) return ok('Usage: sbatch [OPTIONS(0)...] [ : [OPTIONS(N)...]] script(0) [args(0)...]');
      let text, scriptPath;
      if (pre.o.wrap) { text = `#!/bin/sh\n${pre.o.wrap}\n`; scriptPath = '(wrap)'; }
      else {
        const f = pre.o._[0];
        if (!f) return fail('sbatch: error: Batch script is empty!');
        scriptPath = sh.resolve(f); text = lab.readGuard(scriptPath, ctx) ? undefined : sh.read(scriptPath);
        if (text === undefined) return fail(`sbatch: error: Unable to open file ${f}`);
        if (!/^#!/.test(text)) return fail('sbatch: error: This does not look like a batch script.  The first\nsbatch: error: line must start with #! followed by the path to an interpreter.\nsbatch: error: For instance: #!/bin/sh');
      }
      const dirs = [];
      text.split('\n').forEach(l => { const m = /^#SBATCH\s+(.*)$/.exec(l.trim()); if (m) dirs.push(...(NL.tokenize(m[1], {}).toks || []).filter(t => t.t === 'w').map(t => t.v)); });
      const sc = opts(dirs, SB);
      if (sc.errs.length) return fail(`sbatch: ${sc.errs[0]}`);
      const o = Object.assign({}, sc.o, pre.o);
      if (o.p && o.p !== 'defq') return fail(`sbatch: error: invalid partition specified: ${o.p}\nsbatch: error: Batch job submission failed: Invalid partition name specified`);
      let gpus = 0; const g = o.gres || o.G; if (g) { const m = /(\d+)$/.exec(g); gpus = m ? +m[1] : 1; }
      if (gpus > 8) return fail('sbatch: error: Batch job submission failed: Requested node configuration is not available');
      let memMB = null;
      if (o.mem !== undefined) {
        const mm = /^(\d+(?:\.\d+)?)([KMGT]?)B?$/i.exec(String(o.mem));
        if (!mm) return fail(`sbatch: error: Invalid --mem specification`);
        memMB = Math.round(+mm[1] * ({ K: 1 / 1024, M: 1, G: 1024, T: 1048576, '': 1 })[mm[2].toUpperCase()]);
        if (memMB > 2063937) return fail('sbatch: error: Memory specification can not be satisfied\nsbatch: error: Batch job submission failed: Requested node configuration is not available');
      }
      const reqNodes = o.w ? expand(o.w) : null;
      if (reqNodes && reqNodes.some(n => !nodes[n])) return fail('sbatch: error: Batch job submission failed: Invalid node name specified');
      const id = nextId++;
      const workdir = o.D ? sh.resolve(o.D) : sh.cwd;
      const outPat = o.o || 'slurm-%j.out';
      const stdout = NL.normPath(outPat.replace(/%j/g, id).replace(/%x/g, o.J || NL.basename(scriptPath)).replace(/%u/g, sh.user).replace(/%N/g, '{NODE}'), workdir, sh.home);
      // simulate the script body
      const body = text.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
      const lines = []; let runtime = 12000, need = 0, oomed = false;
      const memAvail = memMB === null ? 2063937 : memMB;
      body.forEach(l => {
        if (oomed) return;
        if (/^\s*(srun\s+)?python3?\s+(\S*\/)?train\.py\b/.test(l)) {
          const dg = (failedFor(scriptPath) || { data: dataGiB }).data;
          need = dg * 1024;
          lines.push(`Loading training shards into memory (${dg}.0 GiB)...`);
          if (memAvail < need) { lines.push(`slurmstepd: error: Detected 1 oom_kill event in StepId=${id}.batch. Some of the step tasks have been OOM Killed.`); oomed = true; runtime = 7000; return; }
          lines.push('Epoch 1/1: step 1000/1000 loss=0.4127', 'Saved checkpoint to checkpoints/epoch1.pt'); runtime += 6000; return;
        }
        const c = l.trim().replace(/^srun\s+(-\S+\s+)*/, '');
        if (/^hostname\b/.test(c)) lines.push('{NODE}');
        else if (/^nvidia-smi\s+-L/.test(c)) { if (!gpus) lines.push('No devices found.'); for (let i = 0; i < gpus; i++) lines.push(`GPU ${i}: NVIDIA H100 80GB HBM3 (UUID: GPU-${NL.hex(r, 8)}-${NL.hex(r, 4)}-${NL.hex(r, 4)}-${NL.hex(r, 4)}-${NL.hex(r, 12)})`); }
        else if (/^nvidia-smi\b/.test(c)) lines.push(gpus ? `+-----------------------------------------------------------------------------------------+\n| NVIDIA-SMI 550.90.07              Driver Version: 550.90.07      CUDA Version: 12.4     |\n|   0  NVIDIA H100 80GB HBM3          On  |   00000000:1B:00.0 Off |                    0 |\n+-----------------------------------------------------------------------------------------+` : 'No devices were found');
        else if (/^echo\b/.test(c)) lines.push(c.replace(/^echo\s+(-[ne]\s+)?/, '').replace(/^["']|["']$/g, '').replace(/\$\(date\)|`date`/g, '{DATE}').replace(/\$\(hostname\)|`hostname`|\$SLURMD_NODENAME|\$\{SLURMD_NODENAME\}|\$SLURM_JOB_NODELIST|\$\{SLURM_JOB_NODELIST\}/g, '{NODE}').replace(/\$\{?SLURM_JOB_ID\}?|\$\{?SLURM_JOBID\}?/g, String(id)).replace(/\$\{?SLURM_JOB_NAME\}?/g, o.J || 'job').replace(/\$\{?CUDA_VISIBLE_DEVICES\}?/g, Array.from({ length: gpus }, (_, i) => i).join(',')));
        else if (/^date\b/.test(c)) lines.push('{DATE}');
        else if (/^sleep\s+(\d+)/.test(c)) runtime += 1000 * +/^sleep\s+(\d+)/.exec(c)[1];
        else if (/^(cd|export|module|source|set|ml)\b/.test(c)) { /* environment, no output */ }
        else { const cmd = c.split(/\s+/)[0]; lines.push(`/var/spool/slurmd/job${id}/slurm_script: line ${text.split('\n').indexOf(l) + 1}: ${cmd}: command not found`); }
      });
      const j = { submitLine: argv.join(' '), mem: memMB === null ? 2063937 : memMB, need: need, oom: oomed, maxrss: null, id: id, name: o.J || NL.basename(scriptPath), user: user(ctx), account: user(ctx) === 'student' ? 'student' : 'ml-team', partition: 'defq', state: 'PENDING', exit: '0:0', node: null, submit: sh.now(), start: null, end: null, cpus: 1, gpus: gpus, mine: true, script: scriptPath, workdir: workdir, stdout: stdout, outLines: lines.length ? lines : [''], runtime: Math.min(runtime, 240000), reqNodes: reqNodes, held: !!o.H, timelimit: 300e3 };
      jobs.push(j);
      ctlLog(sh.now(), `_slurm_rpc_submit_batch_job: JobId=${id} InitPrio=1 usec=412`);
      sync();
      if (practice) {
        const fo = failedFor(scriptPath);
        if (fo && j.user !== fo.owner) sh.hint(`This job runs as ${j.user}, so it belongs to ${j.user} and its output lands in ${workdir}. The task asks for the owner: su - ${fo.owner} -c "sbatch ${fo.oom ? '--mem=64G ' : ''}${fo.script}"`);
        else if (oomed) sh.hint(`This job still asks for ${Math.round(memAvail / 1024)}G, but the script loads ${need / 1024} GiB, so it will run out of memory again. Ask for more with --mem on the sbatch command line.`);
        else sh.hint(`Watch it with squeue -j ${id}. The output file appears in the submit directory once the job starts: ${stdout.replace(/\{NODE\}/g, '<node>')}`);
      }
      return ok(`Submitted batch job ${id}`);
    }
    function scancel(argv, ctx) {
      const ids = argv.slice(1).filter(x => !x.startsWith('-'));
      if (!ids.length) return fail('scancel: error: No job identification provided');
      const errs = [];
      ids.forEach(id => {
        const j = jobs.find(x => String(x.id) === id && (x.state === 'RUNNING' || x.state === 'PENDING'));
        if (!j) { errs.push(`scancel: error: Kill job error on job id ${id}: Invalid job id specified`); return; }
        j.state = 'CANCELLED'; j.end = sh.now();
        if (!j.mine) { ev.cancelledOthers.push(j.id); if (practice) sh.hint(`You cancelled job ${j.id}, which belongs to ${j.user}. On a shared cluster that is usually a mistake.`); }
      });
      return { out: '', err: errs.join('\n'), code: errs.length ? 1 : 0 };
    }

    /* ---- systemctl / journalctl / logs on nodes ---- */
    const UNITS = h => h === 'headnode' ? ['slurmctld', 'slurmdbd', 'munge', 'cmd'] : ['slurmd', 'munge'];
    const unitName = u => u.replace(/\.service$/, '');
    function unitInfo(h, u) {
      if (h === 'headnode') return { st: 'active', enabled: true, since: midnight - 86400e3 * 9, pid: { slurmctld: 2231, slurmdbd: 2190, munge: 1840, cmd: 1712 }[u], desc: { slurmctld: 'Slurm controller daemon', slurmdbd: 'Slurm DBD accounting daemon', munge: 'MUNGE authentication service', cmd: 'Bright Cluster Manager daemon' }[u] };
      const x = nodes[h];
      if (u === 'slurmd') return { st: x.slurmd, enabled: x.slurmdEnabled, since: x.slurmdSince, pid: x.slurmdPid, desc: 'Slurm node daemon' };
      return { st: x.munge, enabled: true, since: x.mungeSince, pid: 1102, desc: 'MUNGE authentication service' };
    }
    /* boots recorded in a host's journal: only the 'stopped' node has a reboot in it */
    function bootsOf(h) {
      if (h === failNode && cause === 'stopped') return [{ idx: -1, id: '9b1e44d0c2a74f3e8d51a7c06e2b9f43', from: -Infinity, to: nodes[h].boot }, { idx: 0, id: '3f2a9c1e7b4d4e0c9a61b2d57e8f0a11', from: nodes[h].boot, to: Infinity }];
      return [{ idx: 0, id: h === 'headnode' ? '6c0d2e9a51f84b7c9e3d0a2f4b6c8e10' : 'a1d4c7e0b3f64a2895c1e7d0f2a4b6c8', from: -Infinity, to: Infinity }];
    }
    function journalLines(h, unit, win) {
      const inWin = e => !win || (e.t >= win.from && e.t < win.to && e.unit !== 'boot');
      if (h === 'headnode') {
        if (unit === 'slurmctld') return ctl.slice().sort((a, b) => a.t - b.t).map(e => `${logTime(e.t)} headnode slurmctld[2231]: ${e.text.replace(/^error: /, 'error: ')}`);
        return [`${logTime(midnight - 86400e3 * 9)} headnode systemd[1]: Started ${unitInfo(h, unit || 'cmd').desc}.`];
      }
      return nodes[h].journal.filter(inWin).filter(e => !unit || e.unit === unit || (unit === 'slurmd' && e.unit === 'kernel' && /slurmd/.test(e.text)) || (unit === 'munge' && e.unit === 'kernel' && /munged/.test(e.text))).sort((a, b) => a.t - b.t).map(e => e.unit === 'boot' ? e.text : `${logTime(e.t)} ${h} ${e.proc}: ${e.text}`);
    }
    function statusText(h, u, ctx) {
      const i = unitInfo(h, u);
      const [st, res] = i.st.split(':');
      const ago = NL.dur(sh.now() - i.since);
      const since = new Date(i.since).toString().replace(/ GMT.*$/, '').replace(/^(\w+) (\w+) (\d+) (\d+) /, (m, d, mo, dd, y) => `${d} ${y}-${String(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(mo) + 1).padStart(2, '0')}-${dd.padStart(2, '0')} `);
      const dot = st === 'active' ? '●' : st === 'failed' ? '×' : '○';
      const lines = [`${dot} ${u}.service - ${i.desc}`, `     Loaded: loaded (/lib/systemd/system/${u}.service; ${i.enabled ? 'enabled' : 'disabled'}; vendor preset: enabled)`];
      if (st === 'active') lines.push(`     Active: active (running) since ${since}; ${ago} ago`, `   Main PID: ${i.pid} (${u === 'munge' ? 'munged' : u})`, `      Tasks: ${u === 'munge' ? 4 : 2}`, `     Memory: ${u === 'munge' ? '1.2M' : '6.4M'}`, `        CPU: 1.204s`, `     CGroup: /system.slice/${u}.service`, `             └─${i.pid} /usr/sbin/${u === 'munge' ? 'munged' : u}${u === 'slurmd' ? ' -D -s' : ''}`);
      else if (st === 'failed') lines.push(`     Active: failed (Result: ${res}) since ${since}; ${ago} ago`, `    Process: ${i.pid} ExecStart=/usr/sbin/${u === 'munge' ? 'munged' : u}${u === 'slurmd' ? ' -D -s $SLURMD_OPTIONS' : ''} (${res === 'signal' ? 'code=killed, signal=SEGV' : res === 'oom-kill' ? 'code=killed, signal=KILL' : 'code=exited, status=1/FAILURE'})`, `   Main PID: ${i.pid} (${res === 'signal' ? 'code=killed, signal=SEGV' : res === 'oom-kill' ? 'code=killed, signal=KILL' : 'code=exited, status=1/FAILURE'})`, `        CPU: 312ms`);
      else lines.push(`     Active: inactive (dead)${i.since > midnight - 86400e3 ? ` since ${since}; ${ago} ago` : ''}`);
      if (isRoot(ctx)) { const j = journalLines(h, u).filter(l => !l.startsWith('--')).slice(-6); if (j.length) lines.push('', ...j); }
      else lines.push('', 'Warning: some journal files were not opened due to insufficient permissions.');
      return lines.join('\n');
    }
    function systemctl(argv, ctx) {
      const a = argv.slice(1).filter(x => !/^--(no-pager|full|quiet|now)$|^-[lq]$/.test(x));
      const now = argv.includes('--now');
      const verb = a[0];
      if (!verb) return ok('UNIT                         LOAD   ACTIVE SUB     DESCRIPTION\n' + UNITS(sh.host).map(u => `${padR(u + '.service', 28)} loaded ${padR(unitInfo(sh.host, u).st.split(':')[0], 6)} ${padR(unitInfo(sh.host, u).st === 'active' ? 'running' : 'dead', 7)} ${unitInfo(sh.host, u).desc}`).join('\n'));
      if (verb === 'daemon-reload') return isRoot(ctx) ? ok() : fail('Failed to reload daemon: Interactive authentication required.');
      const us = a.slice(1).map(unitName);
      if (!us.length) return fail(`Too few arguments.`);
      const outs = [], errs = []; let code = 0;
      for (const u of us) {
        const known = UNITS(sh.host).includes(u);
        if (verb === 'status') {
          if (!known) { errs.push(`Unit ${u}.service could not be found.`); code = 4; if (practice && u === 'slurmd' && sh.host === 'headnode') sh.hint(`slurmd runs on the compute nodes, not on the head node. ssh ${failNode} first.`); continue; }
          outs.push(statusText(sh.host, u, ctx)); if (!/^active/.test(unitInfo(sh.host, u).st)) code = 3;
          if (practice && compute() && u === 'slurmd' && sh.host === failNode && nodes[failNode].slurmd !== 'active') sh.hint(cause === 'munge' ? 'slurmd failed. Read why with sudo journalctl -u slurmd. Slurm authenticates with munge, so check that service too.' : cause === 'stopped' ? 'slurmd is inactive and disabled, so it did not start after the reboot. Start it, and enable it so it survives the next reboot.' : 'slurmd crashed. Read the journal with sudo, then restart the service.');
          continue;
        }
        if (verb === 'is-active') { outs.push(known ? unitInfo(sh.host, u).st.split(':')[0] : 'inactive'); if (!known || unitInfo(sh.host, u).st !== 'active') code = 3; continue; }
        if (verb === 'is-enabled') { if (!known) { errs.push(`Failed to get unit file state for ${u}.service: No such file or directory`); code = 1; continue; } outs.push(unitInfo(sh.host, u).enabled ? 'enabled' : 'disabled'); continue; }
        if (!['start', 'stop', 'restart', 'enable', 'disable', 'reload', 'try-restart', 'reset-failed'].includes(verb)) return fail(`Unknown command verb ${verb}.`);
        if (!isRoot(ctx)) { errs.push(`Failed to ${verb} ${u}.service: Interactive authentication required.\nSee system logs and 'systemctl status ${u}.service' for details.`); code = 1; if (practice) sh.hint('Managing services needs root: prefix the command with sudo.'); continue; }
        if (!known) { errs.push(`Failed to ${verb} ${u}.service: Unit ${u}.service not found.`); code = 5; if (practice && u === 'slurmd' && sh.host === 'headnode') sh.hint(`There is no slurmd on the head node. Run this on ${failNode} (ssh ${failNode}).`); continue; }
        if (sh.host === 'headnode') { if (verb !== 'status') outs.push(''); continue; }
        const x = nodes[sh.host];
        const t = sh.now();
        if (verb === 'enable' || verb === 'disable') {
          if (u === 'slurmd') { x.slurmdEnabled = verb === 'enable'; outs.push(verb === 'enable' ? `Created symlink /etc/systemd/system/multi-user.target.wants/slurmd.service → /lib/systemd/system/slurmd.service.` : `Removed "/etc/systemd/system/multi-user.target.wants/slurmd.service".`); }
          if (!now) continue;
        }
        if (verb === 'reset-failed') { if (u === 'slurmd' && x.slurmd.startsWith('failed')) x.slurmd = 'inactive'; if (u === 'munge' && x.munge.startsWith('failed')) x.munge = 'inactive'; continue; }
        const startIt = verb === 'start' || verb === 'restart' || verb === 'try-restart' || verb === 'reload' || ((verb === 'enable') && now);
        if (verb === 'stop' || verb === 'disable') {
          if (u === 'slurmd') { x.slurmd = 'inactive'; x.slurmdSince = t; x.noresp = true; jr(sh.host, t, 'slurmd', 'Stopped Slurm node daemon.', 'systemd[1]'); }
          else { x.munge = 'inactive'; x.mungeSince = t; }
          continue;
        }
        if (startIt) {
          if (u === 'munge') { x.munge = 'active'; x.mungeSince = t; jr(sh.host, t, 'munge', 'Started MUNGE authentication service.', 'systemd[1]'); }
          else {
            x.slurmdPid = pid();
            if (x.munge !== 'active') {
              x.slurmd = 'failed:exit-code'; x.slurmdSince = t;
              ['error: If munged is up, restart with --num-threads=10', 'error: Munge encode failed: Failed to access "/run/munge/munge.socket.2": No such file or directory', 'fatal: Unable to register with slurm controller'].forEach(m => { jr(sh.host, t, 'slurmd', m, `slurmd[${x.slurmdPid}]`); x.slurmdLog.push({ t: t, text: m }); });
              jr(sh.host, t, 'slurmd', `slurmd.service: Main process exited, code=exited, status=1/FAILURE`, 'systemd[1]');
              errs.push(`Job for slurmd.service failed because the control process exited with error code.\nSee "systemctl status slurmd.service" and "journalctl -xeu slurmd.service" for details.`); code = 1;
              if (practice) sh.hint('slurmd failed to start again. Read the journal: the error points at a dependency that is still down.');
            } else {
              x.slurmd = 'active'; x.slurmdSince = t;
              jr(sh.host, t, 'slurmd', 'Started Slurm node daemon.', 'systemd[1]');
              x.slurmdLog.push({ t: t, text: 'slurmd version 24.05.4 started' }, { t: t + 200, text: 'slurmd started on ' + NL.dateCmd(t) }, { t: t + 300, text: 'CPUs=112 Boards=1 Sockets=2 Cores=56 Threads=1 Memory=2063937 TmpDisk=0 Uptime=4211 CPUSpecList=(null) FeaturesAvail=(null) FeaturesActive=(null)' });
              refreshResponding(sh.host);
              if (practice && sh.host === failNode) sh.hint(`slurmd is running again, but with ReturnToService=0 the node stays DOWN until you resume it. Go back to the head node (exit) and run scontrol update nodename=${failNode} state=resume.${!x.slurmdEnabled ? ' Also consider systemctl enable slurmd so it starts after the next reboot.' : ''}`);
            }
          }
        }
      }
      return { out: outs.filter(x => x !== '').join('\n'), err: errs.join('\n'), code: code };
    }
    function journalctl(argv, ctx) {
      const a = argv.slice(1); const units = []; let n = null, boot = null, listBoots = false;
      for (let i = 0; i < a.length; i++) {
        const x = a[i];
        if (x === '-b' || x === '--boot') { boot = 0; if (/^[-+]?\d+$/.test(a[i + 1] || '') || /^[0-9a-f]{32}$/.test(a[i + 1] || '')) boot = a[++i]; continue; }
        if (/^--boot=/.test(x)) { boot = x.slice(7) || 0; continue; }
        if (/^-b[-+]?\d+$/.test(x)) { boot = x.slice(2); continue; }
        if (x === '--list-boots') { listBoots = true; continue; }
        if (x === '-u' || x === '--unit') units.push(unitName(a[++i] || ''));
        else if (/^-u/.test(x)) units.push(unitName(x.slice(2)));
        else if (/^--unit=/.test(x)) units.push(unitName(x.slice(7)));
        else if (x === '-n' || x === '--lines') n = parseInt(a[++i], 10);
        else if (/^-n\d+$/.test(x)) n = parseInt(x.slice(2), 10);
        else if (/^--lines=/.test(x)) n = parseInt(x.slice(8), 10);
        else if (/^--(no-pager|pager-end|catalog|follow|quiet|since=.*|until=.*)$/.test(x)) { /* accepted, no effect */ }
        else if (x === '--since' || x === '--until' || x === '-p' || x === '--priority' || x === '-S' || x === '-U') i++;
        else if (/^-[xefqbru]+n?$/.test(x)) {
          // combined short flags such as -xeu slurmd, -fu slurmd, -e, -xb
          if (x.includes('b')) boot = boot === null ? 0 : boot;
          if (x.endsWith('u')) units.push(unitName(a[++i] || ''));
          else if (x.endsWith('n')) n = parseInt(a[++i], 10);
        }
        else if (x.startsWith('-')) return fail(`journalctl: unrecognized option '${x}'`);
      }
      if (!isRoot(ctx)) { if (practice) sh.hint('System logs are only readable by root here. Use sudo journalctl ...'); return ok('Hint: You are currently not seeing messages from other users and the system.\n      Users in groups \'adm\', \'systemd-journal\' can see all messages.\n      Pass -q to turn off this notice.\n-- No entries --'); }
      const boots = bootsOf(sh.host);
      if (listBoots) return ok(['IDX BOOT ID                          FIRST ENTRY                     LAST ENTRY'].concat(boots.map(b => `${String(b.idx).padStart(3)} ${b.id} ${NL.dateCmd(b.from === -Infinity ? midnight - 86400e3 * 3 + 7.1 * 3600e3 : b.from)}   ${NL.dateCmd(b.to === Infinity ? sh.now() : b.to - 1000)}`)).join('\n'));
      let win = null;
      if (boot !== null) {
        const off = String(boot);
        win = /^[0-9a-f]{32}$/.test(off) ? boots.find(b => b.id === off) : boots.find(b => b.idx === (/^\+?\d+$/.test(off) && +off > 0 ? +off - boots.length : +off));
        if (!win) return fail(`Data from the specified boot (${/^[-+]/.test(off) ? off : (+off > 0 ? '+' + off : off)}) is not available: No such boot ID in journal`);
      }
      let lines = units.length ? units.flatMap(u => journalLines(sh.host, u, win)) : journalLines(sh.host, null, win);
      if (sh.host !== 'headnode' && units.length > 1) lines = journalLines(sh.host, null, win).filter(l => units.some(u => l.includes(u)));
      if (n !== null && n < lines.length) lines = lines.slice(-n);
      if (!lines.length) return ok('-- No entries --');
      return ok(lines.join('\n'));
    }

    /* ---- lab interface ---- */
    const lab = {
      id: 'slurm', params: P, shell: sh,
      title: 'Lab 1 · Slurm',
      intro: asRoot ? 'You are root on the cluster head node. Compute nodes: node001–node004.' : 'You are logged in to the cluster head node as student. Your account has sudo and Slurm operator rights. Compute nodes: node001–node004.',
      tasks: () => both ? [
        { id: 'find', text: 'Two jobs failed today. No job IDs are given: find both failed jobs, their owners and the nodes they ran on.' },
        { id: 'cause', text: 'Find out why each job failed.' },
        { id: 'restore', text: 'Fix the node problem and return the node to service.' },
        { id: 'submit', text: 'Resubmit the job that failed because of the node, as its owner. When it completes, display its output file.' },
        { id: 'submit2', text: 'Resubmit the job that ran out of memory, as its owner, with enough memory. When it completes, display its output file.' },
        { id: 'drain', text: `Drain ${drainNode} for maintenance (use any reason) and confirm its state.` }
      ] : [
        { id: 'find', text: 'A job failed today. No job ID is given: find the failed job, its owner and the node it ran on.' },
        { id: 'cause', text: 'Find out why it failed.' },
        { id: 'restore', text: 'Fix the problem on the node and return the node to service.' },
        { id: 'submit', text: 'Resubmit the failed job as its owner. When it completes, display its output file.' },
        { id: 'drain', text: `Drain ${drainNode} for maintenance (use any reason) and confirm its state.` }
      ],
      commands: () => ['sinfo', 'squeue', 'sacct', 'scontrol', 'sbatch', 'scancel', 'srun', 'systemctl', 'journalctl', 'ssh', 'su', 'module', 'uptime', 'ping', 'munge', 'unmunge', 'remunge'],
      hosts: () => ['headnode'].concat(NODES),
      users: () => [...new Set(['root', 'student', 'mlops', 'research', owner].concat(M ? [M.owner] : []))],
      sshBanner: h => `Welcome to Ubuntu 22.04.4 LTS (GNU/Linux 5.15.0-1063-nvidia x86_64)\n\nLast login: ${NL.dateCmd(sh.now() - 86400e3 * 2)} from 10.141.255.254`,
      which: n => ({ sinfo: 1, squeue: 1, sacct: 1, scontrol: 1, sbatch: 1, scancel: 1, srun: 1 })[n] ? BIN + n : ({ systemctl: '/usr/bin/systemctl', journalctl: '/usr/bin/journalctl', ssh: '/usr/bin/ssh' })[n] || null,
      man: page => ({
        sinfo: 'SINFO(1)\n  sinfo [OPTIONS...]\n  -R, --list-reasons  List reasons nodes are in the down, drained, fail or failing state.\n  -N, --Node          Print information in a node-oriented format.\n  -l, --long          Print more detailed information.\n  -n, --nodes=<nodes> Print information about the specified node(s).\n  -t, --states=<states> List nodes only having the given state(s).',
        sacct: 'SACCT(1)\n  sacct [OPTIONS...]\n  -a, --allusers      Displays all users\' jobs when run by user root or if PrivateData is not configured to jobs. Otherwise display the current user\'s jobs.\n  -S, --starttime     Select jobs in any state after the specified time. Default is 00:00:00 of the current day, unless \'-s\' is set, then the default is \'now\'. With --jobs (and no --state) the start defaults to Epoch 0.\n  -s, --state=<state_list>  Selects jobs based on their state during the time period given. Unless otherwise specified, the start and end time will be the current time when the --state option is specified and only currently running jobs can be displayed. Valid states: CA CANCELLED, CD COMPLETED, F FAILED, NF NODE_FAIL, OOM OUT_OF_MEMORY, PD PENDING, R RUNNING, TO TIMEOUT ...\n  -X, --allocations   Only show statistics relevant to the job allocation itself, not taking steps into consideration.\n  -o, --format        Comma separated list of fields. (use "--helpformat" for a list of available fields).',
        scontrol: 'SCONTROL(1)\n  scontrol show node <name>|job <id>|partition|config\n  scontrol update NodeName=<name> State=<DRAIN|DOWN|RESUME|UNDRAIN> [Reason=<reason>]\n    A Reason is required when setting a node DOWN or DRAIN.',
        squeue: 'SQUEUE(1)\n  squeue [-u user] [--me] [-j jobid] [-t states] [-w nodes] [-l]',
        sbatch: 'SBATCH(1)\n  sbatch [OPTIONS...] script\n  Default output file is slurm-%j.out in the directory from which sbatch was run.',
        systemctl: 'SYSTEMCTL(1)\n  systemctl status|start|stop|restart|enable|disable|is-active UNIT...\n  enable --now also starts the unit.',
        journalctl: 'JOURNALCTL(1)\n  journalctl [-u UNIT] [-n LINES] [-e] [-x] [--no-pager]'
      })[page] || null,
      readGuard: (p, ctx) => {
        if (/^\/var\/log\/(slurm|syslog|messages)/.test(p) && !isRoot(ctx) && sh.exists(p)) return 'Permission denied';
        const m = /^\/home\/([^/]+)\//.exec(p);
        if (m && m[1] !== user(ctx) && !isRoot(ctx) && sh.exists(p)) return 'Permission denied'; // home directories are 0750
        return '';
      },
      writeGuard: p => { if (sh.user === 'root') return ''; if (/^\/(etc|var|cm|usr|root)\//.test(p)) return 'Permission denied'; const m = /^\/home\/([^/]+)/.exec(p); return m && m[1] !== sh.user ? 'Permission denied' : ''; },
      virtualFile(p) {
        if (sh.host === 'headnode' && (p === '/var/log/slurmctld' || p === '/var/log/slurmctld.log')) return ctl.slice().sort((a, b) => a.t - b.t).map(e => `[${isoTime(e.t)}.${String(e.t % 1000).padStart(3, '0')}] ${e.text}`).join('\n') + '\n';
        if (NODES.includes(sh.host) && (p === '/var/log/slurmd' || p === '/var/log/slurmd.log')) return nodes[sh.host].slurmdLog.slice().sort((a, b) => a.t - b.t).map(e => `[${isoTime(e.t)}.${String(e.t % 1000).padStart(3, '0')}] ${e.text}`).join('\n') + '\n';
        if (p === '/etc/slurm/slurm.conf' || p === '/cm/shared/apps/slurm/var/etc/slurm/slurm.conf') return `ClusterName=slurm\nSlurmctldHost=headnode\nAuthType=auth/munge\nReturnToService=0\nMinJobAge=300\nSlurmctldLogFile=/var/log/slurmctld\nSlurmdLogFile=/var/log/slurmd\nGresTypes=gpu\nNodeName=node[001-004] CPUs=112 Sockets=2 CoresPerSocket=56 ThreadsPerCore=1 RealMemory=2063937 Gres=gpu:h100:8\nPartitionName=defq Default=YES MinNodes=1 Nodes=node[001-004] State=UP\n`;
        return undefined;
      },
      virtualList(p) {
        if (p === '/var/log') return sh.host === 'headnode' ? ['slurmctld', 'syslog', 'cmdaemon'] : ['slurmd', 'syslog'];
        if (p === '/etc/slurm') return ['slurm.conf', 'gres.conf', 'cgroup.conf'];
        return [];
      },
      exec(argv, ctx) {
        const c = argv[0];
        sync();
        switch (c) {
          case 'sinfo': return sinfo(argv, ctx);
          case 'squeue': return squeue(argv, ctx);
          case 'sacct': return sacct(argv, ctx);
          case 'scontrol': return scontrol(argv, ctx);
          case 'sbatch': return sbatch(argv, ctx);
          case 'scancel': return scancel(argv, ctx);
          case 'srun': return fail('srun: error: Interactive job steps are not simulated in this lab. Submit a batch script with sbatch.');
          case 'systemctl': return systemctl(argv, ctx);
          case 'journalctl': return journalctl(argv, ctx);
          case 'uptime': { const b = sh.host === 'headnode' ? midnight - 86400e3 * 9 : nodes[sh.host].boot; return ok(` ${new Date(sh.now()).toTimeString().slice(0, 8)} up ${NL.dur(sh.now() - b).replace(/^(\d+):(\d+):\d+$/, '$1:$2')},  1 user,  load average: 0.04, 0.09, 0.11`); }
          case 'ping': { const h = argv[argv.length - 1]; if (!lab.hosts().includes(h)) return fail(`ping: ${h}: Name or service not known`, 2); return ok(`PING ${h} (10.141.0.${NODES.indexOf(h) + 1}) 56(84) bytes of data.\n64 bytes from ${h}: icmp_seq=1 ttl=64 time=0.181 ms\n64 bytes from ${h}: icmp_seq=2 ttl=64 time=0.164 ms\n\n--- ${h} ping statistics ---\n2 packets transmitted, 2 received, 0% packet loss, time 1001ms`); }
          case 'munge': case 'unmunge': case 'remunge': {
            const up = sh.host === 'headnode' ? true : nodes[sh.host].munge === 'active';
            if (!up) return fail(`${c}: Error: Unable to access "/run/munge/munge.socket.2": No such file or directory`);
            if (c === 'remunge') return ok(`${NL.isoTime(sh.now()).replace('T', ' ')} Spawning 1 thread for encoding\n${NL.isoTime(sh.now()).replace('T', ' ')} Processing credentials for 1 second\n${NL.isoTime(sh.now()).replace('T', ' ')} Processed 21354 credentials in 1.000s (21352 creds/sec)`);
            const who = user(ctx);
            if (c === 'munge') {
              if (argv.length > 1 && !argv.slice(1).some(x => /^(-n|--no-input|-s|--string)$/.test(x))) return fail(`munge: Error: Unrecognized option "${argv[1]}"`);
              const hex = [...sh.host].map(ch => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
              return ok(`MUNGE:AwQFAAB${hex}${NL.hex(r, 24)}u${who === 'root' ? 'r' : 'x'}${NL.hex(r, 40)}=:`);
            }
            const m = /MUNGE:AwQFAAB([0-9a-f]+?)([0-9a-f]{24})u([rx])/.exec(ctx.stdin || '');
            if (!m) return fail('unmunge: Error: Invalid credential format');
            const encHost = m[1].match(/../g).map(hx => String.fromCharCode(parseInt(hx, 16))).join('');
            const enc = m[3] === 'r' ? 'root (0)' : `${sh.user} (${UIDS[sh.user] || 1001})`;
            const ipOf = h => h === 'headnode' ? '10.141.255.254' : `10.141.0.${NODES.indexOf(h) + 1}`;
            const off = -new Date(sh.now()).getTimezoneOffset(); const t = NL.isoTime(sh.now()).replace('T', ' ') + ` ${off >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}${String(Math.abs(off) % 60).padStart(2, '0')}`;
            return ok([`STATUS:          Success (0)`, `ENCODE_HOST:     ${encHost} (${ipOf(encHost)})`, `ENCODE_TIME:     ${t} (${Math.floor(sh.now() / 1000)})`, `DECODE_TIME:     ${t} (${Math.floor(sh.now() / 1000)})`, 'TTL:             300', 'CIPHER:          aes128 (4)', 'MAC:             sha256 (5)', 'ZIP:             none (0)', `UID:             ${enc}`, `GID:             ${enc}`, 'LENGTH:          0', ''].join('\n'));
          }
          case 'nvidia-smi': return compute() ? ok(`GPU 0..7: NVIDIA H100 80GB HBM3 (8 GPUs, all healthy)`) : fail('nvidia-smi: command not found', 127);
          case 'module': {
            const sub = argv[1];
            if (sub === 'list') return ok('Currently Loaded Modulefiles:\n 1) shared   2) slurm/slurm/24.05.4');
            if (sub === 'avail' || sub === 'av') return ok('------------------------- /cm/local/modulefiles -------------------------\nshared  cmd  null  dot\n------------------------- /cm/shared/modulefiles ------------------------\nslurm/slurm/24.05.4');
            if (sub === 'load' || sub === 'add') return /^slurm/.test(argv[2] || '') ? ok() : fail(`ERROR: Unable to locate a modulefile for '${argv[2] || ''}'`);
            return ok();
          }
        }
        return undefined;
      },
      onDisplay(out) {
        const lines = out.split('\n');
        [base].concat(M ? [M.id] : []).forEach(id => { if (lines.some(l => new RegExp('(^|[\\s|])' + id + '([\\s|]|$)').test(l) && /NODE_FAIL|OUT_OF_ME/.test(l))) ev.foundIds[id] = true; });
        ev.found = !!ev.foundIds[base] && (!M || !!ev.foundIds[M.id]);
        const oomEvidence = (id, node) => (out.includes(`StepId=${id}.batch`) && /oom_kill/.test(out)) || out.includes(jobs.find(x => x.id === id).maxrss + 'K') || (/Memory cgroup out of memory/.test(out) && (!M || sh.host === node));
        if (cause === 'oom' && oomEvidence(base, failNode)) ev.causeBase = true;
        if (M && oomEvidence(M.id, M.node)) ev.causeM = true;
        if (sh.host === failNode) {
          if (cause === 'crash' && /SEGV|segfault/.test(out) && /slurmd/.test(out)) ev.causeBase = true;
          if (cause === 'munge' && /munge/i.test(out) && /(oom|Munge encode failed|munge\.socket)/i.test(out)) ev.causeBase = true;
          if (cause === 'stopped' && /slurmd\.service/.test(out) && /(inactive \(dead\)|disabled;)/.test(out)) ev.causeBase = true;
        }
        ev.cause = ev.causeBase && (!M || ev.causeM);
        jobs.filter(j => j.mine && j.state === 'COMPLETED' && j.finalLine).forEach(j => { if (out.includes(j.finalLine)) ev.outputShown[j.id] = true; });
      },
      grade() {
        sync();
        const fnx = nodes[failNode], dn = nodes[drainNode];
        const fromScript = jobs.filter(j => j.mine && j.script === ownerScript);
        const asOwner = fromScript.filter(j => j.user === owner);
        const okDone = asOwner.filter(j => j.state === 'COMPLETED');
        const shown = okDone.filter(j => ev.outputShown[j.id]);
        const res = [];
        const stateWord = nodeFail ? 'NODE_FAIL' : 'OUT_OF_MEMORY';
        if (both) res.push({ id: 'find', pass: ev.found, detail: ev.found ? `You displayed both failed jobs: ${base} (${failName}, ${owner}, NODE_FAIL on ${failNode}) and ${M.id} (${M.script}, ${M.owner}, OUT_OF_MEMORY on ${M.node}).` : `Two jobs failed: ${base} (${failName}, ${owner}, NODE_FAIL on ${failNode})${ev.foundIds[base] ? ' (found)' : ''} and ${M.id} (${M.script}, ${M.owner}, OUT_OF_MEMORY on ${M.node})${ev.foundIds[M.id] ? ' (found)' : ''}. sacct -S today -s FAILED,NODE_FAIL,TIMEOUT,OUT_OF_MEMORY shows both.` });
        else res.push({ id: 'find', pass: ev.found, detail: ev.found ? `You displayed job ${base} (${failName}, owner ${owner}) in state ${stateWord} on ${failNode}.` : `The failed job was ${base} (${failName}), owned by ${owner}, ${stateWord} on ${failNode}. sacct -a -S today -s FAILED,NODE_FAIL,TIMEOUT,OUT_OF_MEMORY finds it${asRoot ? '' : ' (-a because it belongs to another user)'}.` });
        const causeText = { crash: 'slurmd crashed with a segfault (SIGSEGV); a restart fixes it', munge: 'munge was killed by the OOM killer, so slurmd could not authenticate and exited; start munge, then restart slurmd', stopped: 'the node rebooted and slurmd was disabled, so it never started; start (and enable) slurmd', oom: `the job used all ${reqMem}G it requested (MaxRSS reached ReqMem) and was OOM-killed; its output shows it loads ${dataGiB} GiB` }[cause];
        if (both) res.push({ id: 'cause', pass: ev.cause, detail: ev.cause ? `You found both: job ${base}: ${causeText}; job ${M.id}: it used all ${M.reqMem}G it requested and was OOM-killed (it loads ${M.dataGiB} GiB).` : `Job ${base}: ${causeText}${ev.causeBase ? ' (found)' : ` (check ${failNode}: systemctl status slurmd, ${SUDO}journalctl -u slurmd)`}. Job ${M.id}: it ran out of memory${ev.causeM ? ' (found)' : ` (sacct -j ${M.id} --format=JobID,State,ReqMem,MaxRSS, or ${M.home}/slurm-${M.id}.out)`}.` });
        else res.push({ id: 'cause', pass: ev.cause, detail: ev.cause ? `You found it: ${causeText}.` : `Cause: ${causeText}. ` + (nodeFail ? `Evidence was on ${failNode} in systemctl status / ${SUDO}journalctl -u slurmd${cause === 'munge' ? ' and the munge service' : ''}.` : `Evidence: sacct -j ${base} --format=JobID,State,ReqMem,MaxRSS,WorkDir, or the job's output file ${ownerHome}/slurm-${base}.out.`) });
        if (nodeFail) {
          const restored = servicesUp(failNode) && !fnx.down && !fnx.drain && !fnx.noresp;
          let rd = restored ? `${failNode} is ${nstate(failNode).s} with slurmd running.` : !servicesUp(failNode) ? `slurmd${nodes[failNode].munge !== 'active' ? ' (and munge)' : ''} is still not running on ${failNode}.` : `slurmd is running, but ${failNode} is still ${nstate(failNode).s}. Resume it with scontrol update nodename=${failNode} state=resume.`;
          if (restored && !fnx.slurmdEnabled) rd += ' Note: slurmd is still disabled, so it will not start after the next reboot (systemctl enable slurmd).';
          res.push({ id: 'restore', pass: restored, detail: rd });
        } else {
          const fixed = fromScript.filter(j => j.state === 'COMPLETED');
          const tried = fromScript.filter(j => j.state === 'OUT_OF_MEMORY');
          res.push({ id: 'restore', pass: fixed.length > 0, detail: fixed.length ? `Job ${fixed[0].id} ran with --mem=${Math.round(fixed[0].mem / 1024)}G and completed.` : tried.length ? `Job ${tried[tried.length - 1].id} asked for ${Math.round(tried[tried.length - 1].mem / 1024)}G and ran out of memory again; it needs at least ${dataGiB}G (for example sbatch --mem=64G).` : `No resubmission asked for more memory. It needs at least ${dataGiB}G, for example sbatch --mem=64G ${script}.` });
        }
        const wrongUser = fromScript.filter(j => j.user !== owner);
        let sd;
        if (!fromScript.length) sd = `${script} was never resubmitted. As root: su - ${owner} -c "sbatch ${cause === 'oom' ? '--mem=64G ' : ''}${script}"`;
        else if (!asOwner.length) sd = `${script} was resubmitted as ${wrongUser.map(j => j.user).join(', ')}, not as its owner ${owner} (su - ${owner} -c "sbatch ..." or sudo -u ${owner} sbatch ...).`;
        else if (!okDone.length) sd = `Job ${asOwner[asOwner.length - 1].id} (as ${owner}) has not completed (${asOwner[asOwner.length - 1].state}).`;
        else if (!shown.length) sd = `Job ${okDone[0].id} completed as ${owner}, but its output file (${okDone[0].stdout}) was never displayed after it finished.`;
        else sd = `Job ${shown[0].id} ran as ${owner}, completed, and you displayed ${shown[0].stdout}.`;
        res.push({ id: 'submit', pass: shown.length > 0, detail: sd });
        if (M) {
          const fm = jobs.filter(j => j.mine && j.script === M.path), om = fm.filter(j => j.user === M.owner), dm = om.filter(j => j.state === 'COMPLETED'), sm = dm.filter(j => ev.outputShown[j.id]);
          let d2;
          if (!fm.length) d2 = `${M.script} was never resubmitted. As root: su - ${M.owner} -c "sbatch --mem=64G ${M.script}"`;
          else if (!om.length) d2 = `${M.script} was resubmitted as ${fm.map(j => j.user).join(', ')}, not as its owner ${M.owner}.`;
          else if (!dm.length) { const last = om[om.length - 1]; d2 = last.state === 'OUT_OF_MEMORY' ? `Job ${last.id} asked for ${Math.round(last.mem / 1024)}G and ran out of memory again; it needs at least ${M.dataGiB}G (for example --mem=64G).` : `Job ${last.id} (as ${M.owner}) has not completed (${last.state}).`; }
          else if (!sm.length) d2 = `Job ${dm[0].id} completed as ${M.owner}, but its output file (${dm[0].stdout}) was never displayed after it finished.`;
          else d2 = `Job ${sm[0].id} ran as ${M.owner} with --mem=${Math.round(sm[0].mem / 1024)}G, completed, and you displayed ${sm[0].stdout}.`;
          res.push({ id: 'submit2', pass: sm.length > 0, detail: d2 });
        }
        // drain: judged on the end state only
        const drained = dn.drain && !!dn.reason;
        const otherDrained = NODES.filter(n => n !== drainNode && nodes[n].drain);
        res.push({ id: 'drain', pass: drained && !otherDrained.length, detail: drained ? `${drainNode} is ${nstate(drainNode).s} with reason "${dn.reason}".` + (otherDrained.length ? ` But ${otherDrained.join(', ')} ${otherDrained.length > 1 ? 'are' : 'is'} also drained, which the task did not ask for.` : '') : `${drainNode} is ${nstate(drainNode).s}, not drained.` });
        const notes = [];
        if (ev.cancelledOthers.length) notes.push(`You cancelled other users' job(s) ${ev.cancelledOthers.join(', ')}. A real grader may treat that as damage.`);
        NODES.filter(n => n !== drainNode && (n !== failNode || !nodeFail) && nodes[n].down).forEach(n => notes.push(`${n} was left ${nstate(n).s}.`));
        return { results: res, notes: notes };
      },
      solution() {
        const find = ['sinfo -R', `sacct ${asRoot ? '' : '-a '}-S today -s FAILED,NODE_FAIL,TIMEOUT,OUT_OF_MEMORY -X --format=JobID,JobName,User,State,ExitCode,NodeList`];
        const resub = cause === 'oom' ? `--mem=64G ${script}` : script;
        const submit = [`${SUDO}su - ${owner} -c "sbatch ${resub}"`];
        const after = [`squeue -u ${owner}`, '#  when the job has left the queue:', `${SUDO}cat ${ownerHome}/slurm-<jobid>.out`,
          `scontrol update nodename=${drainNode} state=drain reason="maintenance"`, 'sinfo -R'];
        if (both) return find.concat([`#  ${base} (${owner}) is NODE_FAIL on ${failNode}; ${M.id} (${M.owner}) is OUT_OF_MEMORY on ${M.node}`,
          `scontrol show node ${failNode}`, `ssh ${failNode}`, `${SUDO}systemctl status slurmd`, `${SUDO}journalctl -u slurmd -n 30 --no-pager`, `${SUDO}systemctl restart slurmd`, 'exit',
          `scontrol update nodename=${failNode} state=resume`, 'sinfo',
          `sacct -j ${M.id} --format=JobID,State,ReqMem,MaxRSS,WorkDir`, `${SUDO}cat ${M.home}/slurm-${M.id}.out`,
          `#  MaxRSS reached ReqMem (${M.reqMem}G) and the job loads ${M.dataGiB} GiB: ask for more memory`,
          `${SUDO}su - ${owner} -c "sbatch ${script}"`, `${SUDO}su - ${M.owner} -c "sbatch --mem=64G ${M.script}"`,
          `squeue -u ${owner},${M.owner}`, '#  when both jobs have left the queue:', `${SUDO}cat ${ownerHome}/slurm-<jobid>.out`, `${SUDO}cat ${M.home}/slurm-<jobid>.out`,
          `scontrol update nodename=${drainNode} state=drain reason="maintenance"`, 'sinfo -R']);
        if (cause === 'oom') return find.concat([`sacct -j ${base} --format=JobID,State,ReqMem,MaxRSS,WorkDir`, `${SUDO}cat ${ownerHome}/slurm-${base}.out`, `${SUDO}grep SBATCH ${ownerScript}`,
          `#  MaxRSS reached ReqMem (${reqMem}G) and the job loads ${dataGiB} GiB: ask for more memory on the command line`], submit, after);
        const fix = { crash: [`${SUDO}systemctl restart slurmd`], munge: [`${SUDO}systemctl status munge`, `${SUDO}systemctl start munge`, `${SUDO}systemctl restart slurmd`], stopped: [`${SUDO}systemctl enable --now slurmd`] }[cause];
        return find.concat([`scontrol show node ${failNode}`, `ssh ${failNode}`, `${SUDO}systemctl status slurmd`, `${SUDO}journalctl -u slurmd -n 30 --no-pager`],
          fix, ['systemctl status slurmd', 'exit', `scontrol update nodename=${failNode} state=resume`, 'sinfo'], submit, after);
      }
    };
    sh.lab = lab;
    return lab;
  }

  NL.labs.slurm = { create: create, compress: compress, expand: expand };
})(typeof window !== 'undefined' ? window : globalThis);
