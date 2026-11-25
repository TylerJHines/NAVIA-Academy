/* Regression tests for the NCP-AIO three-lab simulator (aio/lab-*.js).
 * Run: node test-labs.cjs
 * 1. Solves 120 randomized exam scenarios per lab, as root and as student, and expects every check to pass.
 * 2. Replays common mistakes and expects the matching checks to fail.
 * 3. Replays command forms from a candidate's lab drill and expects all of them to be accepted. */
'use strict';
const path = require('path');
['lab-core', 'lab-slurm', 'lab-k8s', 'lab-bcm'].forEach(f => require(path.join(__dirname, 'aio', f + '.js')));
const NL = globalThis.NaviaLab;
let failures = 0, runs = 0;
const assert = (cond, msg) => { if (!cond) { failures++; console.error('FAIL ' + msg); } };

function make(id, seed, mode, user, variant) {
  let now = new Date('2026-11-24T10:15:00').getTime();
  const lab = NL.labs[id].create({ mode: mode || 'exam', seed: seed, user: user || 'root', variant: variant, now: () => now });
  const out = [];
  const run = c => { const r = lab.shell.input(c); out.push(c + '\n' + r.out); return r.out; };
  return { lab: lab, P: lab.params, run: run, wait: s => { now += s * 1000; }, log: out };
}
function allPass(t, label) {
  runs++;
  const g = t.lab.grade();
  const bad = g.results.filter(x => !x.pass);
  assert(!bad.length && !g.notes.length, `${label} ${JSON.stringify(t.P)} ${bad.map(b => b.id + ': ' + b.detail).join(' | ')} ${g.notes.join(' | ')}`);
}
const failed = (t, id) => !t.lab.grade().results.find(x => x.id === id).pass;

/* ---- full solves ---- */
function solveSlurm(t, user) {
  const P = t.P, run = t.run, S = user === 'root' ? '' : 'sudo ';
  run(`sacct ${user === 'root' ? '' : '-a '}-S today -s F,NF,TO,OOM -X -o JobID,User,State,NodeList`);
  if (P.cause === 'oom') {
    run(`sacct -j ${P.failId} --format=JobID,State,ReqMem,MaxRSS,WorkDir`);
  } else {
    run(`ssh ${P.failNode}`); run(`${S}systemctl status slurmd`); run(`${S}journalctl -u slurmd`);
    if (P.cause === 'munge') { run(`${S}systemctl status munge`); run(`${S}systemctl start munge`); }
    run(P.cause === 'stopped' ? `${S}systemctl enable --now slurmd` : `${S}systemctl restart slurmd`); run('exit');
    run(`scontrol update nodename=${P.failNode} state=resume`);
  }
  const id = run(`${S}su - ${P.owner} -c "sbatch ${P.cause === 'oom' ? '--mem=64G ' : ''}${P.script}"`).split(' ').pop();
  t.wait(40); run(`${S}cat /home/${P.owner}/slurm-${id}.out`);
  run(`scontrol update nodename=${P.drainNode} state=drain reason="maintenance window"`);
}
function solveK8s(t) {
  const P = t.P, run = t.run, T = Object.fromEntries(t.lab.tasks().map(x => [x.id, x]));
  run('module load kubernetes'); run('kubectl get nodes');
  run(`cat > ${P.jobPath}`); T.jobfile.manifest.split('\n').forEach(run); t.lab.shell.endInput();
  run(`kubectl apply -f ${P.jobPath}`); t.wait(10); run('kubectl get jobs');
  run(P.logMode === 'save' ? `kubectl logs job/${P.jobName} > ${P.logPath}` : `kubectl logs job/${P.jobName}`);
  run(`cat <<EOF > ${P.podPath}`); T.podfile.manifest.split('\n').forEach(run); run('EOF');
  run(`kubectl apply -f ${P.podPath}`); run(`kubectl run ${P.runName} --image ${P.runImage}`); t.wait(5); run('kubectl get pods');
}
for (let seed = 1; seed <= 120; seed++) {
  ['root', 'student'].forEach(user => {
    { const t = make('slurm', seed, 'exam', user); solveSlurm(t, user); allPass(t, `slurm ${user} seed ${seed}`); }
    { const t = make('k8s', seed, 'exam', user); solveK8s(t); allPass(t, `k8s ${user} seed ${seed}`); }
  });
  { const t = make('bcm', seed), P = t.P, run = t.run;
    ['cmsh', 'softwareimage', `clone default-image ${P.image}`, 'commit', 'category', `clone default ${P.category}`, 'commit', `use ${P.category}`, `set softwareimage ${P.image}`, 'commit',
      'device', `add physicalnode ${P.node} ${P.ip}`, `set category ${P.category}`, `set mac ${P.mac.toLowerCase()}`, 'commit', `power on -n ${P.node}`, 'quit'].forEach(run);
    run(`mkdir -p ${NL.dirname(P.cfgPath)}`); run('cm-kubernetes-setup');
    ['1', '', '', '', '1', '2', '', '', 'y', '2', P.cfgPath].forEach(run);
    run(`cm-kubernetes-setup -c ${P.cfgPath}`);
    allPass(t, 'bcm seed ' + seed); }
}
// practice scenarios: each Lab 1 variant, both users
['node', 'oom'].forEach(v => ['root', 'student'].forEach(u => { const t = make('slurm', 1, 'practice', u, v); solveSlurm(t, u); allPass(t, `slurm practice ${v} ${u}`); }));
function solveBoth(t, user) {
  const P = t.P, M = P.oomJob, run = t.run, S = user === 'root' ? '' : 'sudo ';
  run(`sacct ${user === 'root' ? '' : '-a '}-S today -s F,NF,TO,OOM -X -o JobID,User,State,NodeList`);
  run(`sacct -j ${M.id} --format=JobID,State,ReqMem,MaxRSS,WorkDir`);
  run(`ssh ${P.failNode} ${S}systemctl status slurmd`); run(`ssh ${P.failNode} ${S}systemctl restart slurmd`);
  run(`scontrol update nodename=${P.failNode} state=resume`);
  const a = run(`${S}su - ${P.owner} -c "sbatch ${P.script}"`).split(' ').pop();
  const b = run(`${S}su - ${M.owner} -c "sbatch --mem=64G ${M.script}"`).split(' ').pop();
  t.wait(40); run(`${S}cat /home/${P.owner}/slurm-${a}.out`); run(`${S}cat /home/${M.owner}/slurm-${b}.out`);
  run(`scontrol update nodename=${P.drainNode} state=drain reason=maint`);
}
['root', 'student'].forEach(u => { const t = make('slurm', 1, 'practice', u, 'both'); solveBoth(t, u); allPass(t, `slurm practice both ${u}`); });
{ const t = make('slurm', 1, 'practice', 'root', 'both'); t.run('sacct -S today -s NF -X'); assert(failed(t, 'find'), 'finding only one of the two failed jobs must not pass'); }
{ const t = make('slurm', 1, 'practice', 'root', 'both'); solveBoth(t, 'root'); assert(t.lab.grade().results.length === 6, 'the both drill has six checks'); }
{ const t = make('slurm', 1, 'practice', 'root', 'both'); const id = t.run('su - lee -c "sbatch finetune.sh"').split(' ').pop(); t.wait(40); t.run(`cat /home/lee/slurm-${id}.out`); assert(failed(t, 'submit2'), 'resubmitting the OOM job without more memory must fail'); }
['root', 'student'].forEach(u => { const t = make('k8s', 1, 'practice', u); solveK8s(t); allPass(t, `k8s practice ${u}`); });

/* ---- mistakes must be caught ---- */
{ const t = make('slurm', 5, 'exam', 'student'); t.run('sacct -S today -s F,NF,OOM'); assert(failed(t, 'find'), 'sacct without -a must not find the other user\'s job'); }
{ const t = make('slurm', 5); t.run('sacct -a -s NF,OOM'); assert(failed(t, 'find'), 'sacct --state without -S must not look back in time'); }
{ const t = make('slurm', 1, 'practice', 'student'); assert(/5817/.test(t.run('sacct -j 5817')), 'sacct -j must show another user\'s job without -a'); }
{ const t = make('slurm', 1, 'practice', 'student'); assert(/5817/.test(t.run('sacct -N node002 -S today')), 'sacct -N must show other users\' jobs without -a'); }
{ const t = make('slurm', 1, 'practice'); t.run('scontrol update nodename=node002 state=resume'); assert(failed(t, 'restore'), 'resume without fixing slurmd must not restore the node'); }
{ const t = make('slurm', 1, 'practice'); t.run('scontrol update nodename=node001 state=drain'); assert(failed(t, 'drain'), 'drain without a reason must be refused'); }
{ const t = make('slurm', 1, 'practice'); ['scontrol update nodename=node003 state=drain reason=x', 'scontrol update nodename=node003 state=resume', 'scontrol update nodename=node001 state=drain reason=maint'].forEach(t.run);
  assert(!failed(t, 'drain'), 'draining a wrong node and resuming it must not fail the drain task (end state)'); }
{ const t = make('slurm', 1, 'practice'); t.run('ssh node002 systemctl restart slurmd'); t.run('scontrol update nodename=node002 state=resume');
  const id = t.run('sbatch /home/dana/train.sh').split(' ').pop(); t.wait(40); t.run(`cat slurm-${id}.out`); assert(failed(t, 'submit'), 'resubmitting as root instead of the owner must fail'); }
{ const t = make('slurm', 1, 'practice', 'root', 'oom'); const id = t.run('su - dana -c "sbatch --mem=32G train.sh"').split(' ').pop(); t.wait(40);
  assert(/OUT_OF_ME/.test(t.run(`sacct -j ${id} -X`)), 'too little memory must run out of memory again'); assert(failed(t, 'restore') && failed(t, 'submit'), 'an OOM resubmission must not pass'); }
{ const t = make('slurm', 1, 'practice'); assert(/invalid option -- 'd'/.test(t.run('su -dana -c whoami')), 'su -dana (no space) must fail like real su'); }
{ const t = make('k8s', 1, 'practice'); t.run('module load kubernetes'); t.run('kubectl create job training --image=busybox:1.36 -- sh -c "echo Training job complete"'); t.wait(10); assert(failed(t, 'jobrun'), 'an imperatively created Job must not satisfy "create from file"'); }
{ const t = make('k8s', 1, 'practice'); t.run('module load kubernetes'); t.run('cat <<EOF > /root/lab2/training-job.yaml'); ['apiVersion: batch/v1', 'kind: Job', 'metadata:', '  name: training', 'spec:', '  template:', '    spec:', '      containers:', '      - name: t', '        image: busybox:1.36', 'EOF'].forEach(t.run); const o = t.run('kubectl apply -f /root/lab2/training-job.yaml'); assert(/restartPolicy: Required value/.test(o), 'a Job without restartPolicy must be rejected'); }
{ const t = make('k8s', 1, 'practice'); t.run('module load kubernetes'); t.run('kubectl run inference-direct --image=ngnix:1.27'); t.wait(10); assert(/ImagePullBackOff|ErrImagePull/.test(t.run('kubectl get pods')), 'a misspelled image must not start'); }
{ const t = make('k8s', 1, 'practice'); solveK8s(t); t.run('kubectl delete pod inference-direct'); assert(failed(t, 'verify'), 'verify must fail when a Pod is deleted afterwards'); }
{ const t = make('bcm', 1, 'practice'); ['cmsh', 'softwareimage', 'clone default-image dgx-training', 'quit'].forEach(t.run); assert(failed(t, 'image'), 'an uncommitted clone must not count'); }
{ const t = make('bcm', 1, 'practice'); ['cmsh -c "category; clone default gpu-training; commit"', 'cmsh -c "device; add physicalnode gpu004 10.141.0.44; set category gpu-training; set mac 02:00:00:00:04:04; commit"'].forEach(t.run); assert(failed(t, 'node'), 'a node that was never powered on must not pass');
  const o = t.run('scontrol update nodename=gpu004 state=resume'); assert(/Invalid node name/.test(o), 'scontrol must not power on a BCM node'); t.run('cmsh -c "device; power on -n gpu004"'); assert(!failed(t, 'node'), 'power on through cmsh must pass'); }
{ const t = make('bcm', 1, 'practice'); ['cmsh', 'softwareimage', 'clone default-image dgx-training', 'category', 'clone default gpu-training', 'set softwareimage dgx-training'].forEach(t.run); assert(/not committed/.test(t.log[t.log.length - 1]), 'referencing an uncommitted image must fail'); }
{ const t = make('bcm', 1, 'practice'); ['cmsh -c "category; clone default gpu-training; commit"', 'cm-kubernetes-setup', '1', '', '', '', '1', '2', '', '', '', '2', ''].forEach(t.run); assert(failed(t, 'config'), 'a config without the GPU Operator must fail (it is not pre-selected)'); }

{ const t = make('bcm', 1, 'practice'); const P = t.P;
  ['cmsh -c "softwareimage; clone default-image dgx-training; commit"', 'cmsh -c "category; clone default gpu-training; set softwareimage dgx-training; commit"',
   'cmsh -c "device; add physicalnode gpu004 10.141.0.44; set category gpu-training; set mac 02:00:00:00:04:04; commit; power on"',
   'cm-kubernetes-setup', '1', '', '', '', '1', '2', '', '', '', '2', '', 'cm-kubernetes-setup -c /root/cm-kubernetes-setup.conf'].forEach(t.run);
  assert(failed(t, 'deploy'), 'deploying without the GPU Operator must fail');
  assert(/already deployed/.test(t.run('cm-kubernetes-setup -c /root/cm-kubernetes-setup.conf')), 'a second deploy must be refused');
  ['cm-kubernetes-setup', '2', 'y'].forEach(t.run);
  ['cm-kubernetes-setup', '1', '', '', '', '1', '2', '', '', 'y', '2', '', 'cm-kubernetes-setup -c /root/cm-kubernetes-setup.conf'].forEach(t.run);
  allPass(t, 'bcm recover with wizard uninstall');
  t.run('cm-kubernetes-setup --remove'); assert(failed(t, 'deploy'), '--remove must uninstall'); }

/* ---- command forms from a candidate's lab drill must all be accepted (one-liners and navigated) ---- */
const BAD = /command not found|Unknown command|unrecognized|invalid option|Invalid (field|format|node|job)|Unable to|(?<!slurmstepd: )error:/i;
function accepts(id, cmds, user, variant) {
  const t = make(id, 1, 'practice', user, variant);
  cmds.forEach(c => { if (c === '^D') { t.lab.shell.endInput(); return; } if (c.startsWith('#WAIT ')) { t.wait(+c.slice(6)); return; } const out = t.run(c); assert(!BAD.test(out), `${id}: "${c}" was not accepted:\n${out}`); });
  return t;
}
accepts('slurm', ['sinfo', 'sinfo -N -l', 'sinfo -Nel', 'sinfo -l', 'sinfo -R', 'scontrol show nodes node002',
  'sacct -a -X -S today -s FAILED,NODE_FAIL,TIMEOUT,OUT_OF_MEMORY --format=JobID,User,JobName,State,ExitCode,NodeList',
  'ssh node002 systemctl status slurmd', 'ssh node002 "journalctl -u slurmd --no-pager"', 'ssh node002 journalctl -b -u slurmd', 'ssh node002 systemctl start slurmd',
  'munge -n | unmunge', 'munge -n | ssh node002 unmunge', 'ssh node002 munge -n | unmunge',
  'scontrol update NodeName=node002 State=RESUME', 'sinfo -N -n node002 -o "%N %T %E"', 'su - dana -c "whoami"', 'sudo -u dana whoami',
  'su - dana -c "sbatch train.sh"', 'squeue -j 5822', 'squeue -u dana', 'squeue -o "%.18i %.9P %.8j %.8u %.2t %.10M %.6D %R"', 'scontrol show jobid 5822', 'scontrol show job 5822', '#WAIT 30', 'tail -n 2 /home/dana/slurm-5822.out',
  'scontrol update NodeName=node001 Reason="maintenance" State=DRAIN', 'sinfo -N -n node001 -o "%N %T %E"', 'sinfo -O NodeList,StateLong,Reason']);
accepts('slurm', ['sacct -a -S today -s OOM -X', 'sacct -j 5817 --format=JobID,State,ReqMem,MaxRSS,AveRSS,MaxVMSize,WorkDir', 'cat /home/dana/slurm-5817.out', 'grep SBATCH /home/dana/train.sh',
  'su - dana -c "sbatch --mem=64G train.sh"', '#WAIT 30', 'sacct -u dana -S today --format=JobID,State,ReqMem,MaxRSS'], 'root', 'oom');
accepts('slurm', ['ssh node002 journalctl -b -1 -u slurmd', 'ssh node002 journalctl --list-boots'], 'root', 'node');
accepts('k8s', ['module load kubernetes/default/1.32', 'kubectl cluster-info', 'kubectl get nodes -o wide', 'mkdir -p /root/lab2',
  'kubectl create job hello --image=busybox --dry-run=client -o yaml -- echo “hello from k8s” > /root/lab2/hello-job.yaml',
  'kubectl apply -f /root/lab2/hello-job.yaml', 'kubectl wait job/hello --for=condition=complete --timeout=60s', 'kubectl logs jobs/hello', 'kubectl logs -l job-name=hello',
  'cat > /root/lab2/cuda-vectoradd.yaml', 'apiVersion: v1', 'kind: Pod', 'metadata:', '  name: cuda-vectoradd', 'spec:', '  restartPolicy: OnFailure', '  containers:', '  - name: cuda-vectoradd', '    image: "nvcr.io/nvidia/k8s/cuda-sample:vectoradd-cuda12.5.0-ubuntu22.04"', '    resources:', '      limits:', '        nvidia.com/gpu: 1', '^D',
  'ls -la /root/lab2', 'kubectl apply -f /root/lab2/cuda-vectoradd.yaml', '#WAIT 8', 'kubectl get pods -o wide', 'kubectl logs pod/cuda-vectoradd',
  'kubectl run web --image nginx --restart=Never', 'kubectl wait --for=condition=Ready pod/web --timeout=30s', 'kubectl get pod web', 'kubectl get pod web cuda-vectoradd', 'kubectl get deploy,pods',
  'kubectl get pods -n gpu-operator', 'kubectl logs -l run=web --tail=3']);
{ const t = accepts('bcm', ['cmsh -c "softwareimage; list"', 'cmsh -c "softwareimage; clone default-image dgx-training; commit --wait"',
    'cmsh -c "category; clone default gpu-training; set softwareimage dgx-training; commit"', 'cmsh -c "category; list"', 'cmsh -c "category; use gpu-training; get softwareimage"',
    'cmsh -c "device; add physicalnode gpu004 10.141.0.44; set category gpu-training; set mac 02:00:00:00:04:04; commit"',
    'cmsh -c "device; power on -n gpu004"', 'cmsh -c "device; list"', 'cmsh -c "device; use gpu004; get category"', 'cmsh -c "device; status -n gpu004"', 'cmsh -c "ds"',
    'cmsh -c "device; use node001; interfaces; list"', 'cmsh -c "device; use node001; roles; assign slurmclient; commit"', 'cmsh -c "device; foreach -n node001..node003 (get ip)"',
    'cmsh -c "device; imageupdate -n node001"', 'cmsh -c "device; foreach -c default (get category)"',
    'cm-kubernetes-setup', '1', '', '', '', '1', '2', '', '', 'y', '2', '/root/cm-kubernetes-setup.conf',
    'cm-kubernetes-setup -v -c /root/cm-kubernetes-setup.conf', 'module load kubernetes && kubectl get nodes', 'kubectl cluster-info']);
  allPass(t, 'bcm one-liner style'); }
{ const t = accepts('bcm', ['cmsh', 'softwareimage', 'clone default-image dgx-training', 'commit', 'category; clone default gpu-training; commit', 'use gpu-training', 'set softwareimage dgx-training', 'commit',
    'device', 'add physicalnode gpu004 10.141.0.44', 'set category gpu-training', 'set mac 02:00:00:00:04:04', 'commit', 'power on', 'interfaces', 'list', 'exit', 'roles', 'list', 'exit', 'quit']);
  ['image', 'category', 'assign', 'node'].forEach(id => assert(!failed(t, id), 'bcm navigated style: ' + id)); }

console.log(`${runs} scenario solves, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
