/* Regression tests for the NCP-AIO three-lab simulator (aio/lab-*.js).
 * Run: node test-labs.cjs
 * 1. Solves 120 randomized exam scenarios per lab and expects every check to pass.
 * 2. Replays common mistakes and expects the matching checks to fail. */
'use strict';
const path = require('path');
['lab-core', 'lab-slurm', 'lab-k8s', 'lab-bcm'].forEach(f => require(path.join(__dirname, 'aio', f + '.js')));
const NL = globalThis.NaviaLab;
let failures = 0, runs = 0;
const assert = (cond, msg) => { if (!cond) { failures++; console.error('FAIL ' + msg); } };

function make(id, seed, mode) {
  let now = new Date('2026-11-24T10:15:00').getTime();
  const lab = NL.labs[id].create({ mode: mode || 'exam', seed: seed, now: () => now });
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

/* ---- full solves ---- */
for (let seed = 1; seed <= 120; seed++) {
  { const t = make('slurm', seed), P = t.P, run = t.run;
    run('sacct -a -S today -s NF -X -o JobID,User,State,NodeList'); run(`ssh ${P.failNode}`); run('sudo systemctl status slurmd'); run('sudo journalctl -u slurmd');
    if (P.cause === 'munge') { run('sudo systemctl status munge'); run('sudo systemctl start munge'); }
    run(P.cause === 'stopped' ? 'sudo systemctl enable --now slurmd' : 'sudo systemctl restart slurmd'); run('exit');
    run(`scontrol update nodename=${P.failNode} state=resume`);
    const id = run('sbatch job.sh').split(' ').pop(); t.wait(40); run(`cat slurm-${id}.out`);
    run(`scontrol update nodename=${P.drainNode} state=drain reason="maintenance window"`);
    allPass(t, 'slurm seed ' + seed); }
  { const t = make('k8s', seed), P = t.P, run = t.run;
    run('module load kubernetes'); run('kubectl get nodes');
    run(`kubectl create job ${P.jobName} --image=${P.jobImage} --dry-run=client -o yaml -- sh -c "echo ${P.jobMsg}" > ${P.jobPath}`);
    run(`kubectl apply -f ${P.jobPath}`); run(`kubectl wait --for=condition=complete job/${P.jobName} --timeout=60s`);
    run(P.logMode === 'save' ? `kubectl logs job/${P.jobName} > ${P.logPath}` : `kubectl logs job/${P.jobName}`);
    run(`mkdir -p ${NL.dirname(P.podPath)}`); run(`cat <<EOF > ${P.podPath}`);
    ['apiVersion: v1', 'kind: Pod', 'metadata:', `  name: ${P.podName}`, 'spec:', '  containers:', `  - name: ${P.podName}`, `    image: ${P.podImage}`, 'EOF'].forEach(run);
    run(`kubectl apply -f ${P.podPath}`); run(`kubectl run ${P.runName} --image ${P.runImage}`); t.wait(5); run('kubectl get pods');
    allPass(t, 'k8s seed ' + seed); }
  { const t = make('bcm', seed), P = t.P, run = t.run;
    ['cmsh', 'softwareimage', `clone default-image ${P.image}`, 'commit', 'category', `clone default ${P.category}`, 'commit', `use ${P.category}`, `set softwareimage ${P.image}`, 'commit',
      'device', `add physicalnode ${P.node} ${P.ip}`, `set category ${P.category}`, `set mac ${P.mac.toLowerCase()}`, 'commit', `power on -n ${P.node}`, 'quit'].forEach(run);
    run(`mkdir -p ${NL.dirname(P.cfgPath)}`); run('cm-kubernetes-setup');
    ['1', '', '', '', '1', '2', '', '', 'n', '2', P.cfgPath].forEach(run);
    run(`cm-kubernetes-setup -c ${P.cfgPath}`);
    allPass(t, 'bcm seed ' + seed); }
}

/* ---- mistakes must be caught ---- */
const failed = (t, id) => !t.lab.grade().results.find(x => x.id === id).pass;
{ const t = make('slurm', 5); t.run('sacct -S today -s F,NF'); assert(failed(t, 'find'), 'sacct without -a must not find the other user\'s job'); }
{ const t = make('slurm', 5); t.run('sacct -a -s NF'); assert(failed(t, 'find'), 'sacct --state without -S must not look back in time'); }
{ const t = make('slurm', 1, 'practice'); t.run('scontrol update nodename=node002 state=resume'); assert(failed(t, 'restore'), 'resume without fixing slurmd must not restore the node'); }
{ const t = make('slurm', 1, 'practice'); t.run('scontrol update nodename=node001 state=drain'); assert(failed(t, 'drain'), 'drain without a reason must be refused'); }
{ const t = make('k8s', 1, 'practice'); t.run('module load kubernetes'); t.run('kubectl create job training --image=busybox:1.36 -- sh -c "echo Training job complete"'); t.wait(10); assert(failed(t, 'jobrun'), 'an imperatively created Job must not satisfy "create from file"'); }
{ const t = make('k8s', 1, 'practice'); t.run('module load kubernetes'); t.run('cat <<EOF > /home/student/jobs/training.yaml'); ['apiVersion: batch/v1', 'kind: Job', 'metadata:', '  name: training', 'spec:', '  template:', '    spec:', '      containers:', '      - name: t', '        image: busybox:1.36', 'EOF'].forEach(t.run); const o = t.run('kubectl apply -f /home/student/jobs/training.yaml'); assert(/restartPolicy: Required value/.test(o), 'a Job without restartPolicy must be rejected'); }
{ const t = make('k8s', 1, 'practice'); t.run('module load kubernetes'); t.run('kubectl run inference-direct --image=ngnix:1.27'); t.wait(10); assert(/ImagePullBackOff|ErrImagePull/.test(t.run('kubectl get pods')), 'a misspelled image must not start'); }
{ const t = make('bcm', 1, 'practice'); ['cmsh', 'softwareimage', 'clone default-image dgx-training', 'quit'].forEach(t.run); assert(failed(t, 'image'), 'an uncommitted clone must not count'); }
{ const t = make('bcm', 1, 'practice'); ['cmsh -c "category; clone default gpu-training; commit"', 'cmsh -c "device; add physicalnode gpu004 10.141.0.44; set category gpu-training; set mac 02:00:00:00:04:04; commit"'].forEach(t.run); assert(failed(t, 'node'), 'a node that was never powered on must not pass');
  const o = t.run('scontrol update nodename=gpu004 state=resume'); assert(/Invalid node name/.test(o), 'scontrol must not power on a BCM node'); t.run('cmsh -c "device; power on -n gpu004"'); assert(!failed(t, 'node'), 'power on through cmsh must pass'); }
{ const t = make('bcm', 1, 'practice'); ['cmsh', 'softwareimage', 'clone default-image dgx-training', 'category', 'clone default gpu-training', 'set softwareimage dgx-training'].forEach(t.run); assert(/not committed/.test(t.log[t.log.length - 1]), 'referencing an uncommitted image must fail'); }

/* ---- command forms from a candidate's lab drill must all be accepted (one-liners and navigated) ---- */
const BAD = /command not found|Unknown command|unrecognized|invalid option|Invalid (field|format|node|job)|Unable to|error:/i;
function accepts(id, cmds) {
  const t = make(id, 1, 'practice');
  cmds.forEach(c => { if (c === '^D') { t.lab.shell.endInput(); return; } if (c.startsWith('#WAIT ')) { t.wait(+c.slice(6)); return; } const out = t.run(c); assert(!BAD.test(out), `${id}: "${c}" was not accepted:\n${out}`); });
  return t;
}
accepts('slurm', ['sinfo', 'sinfo -N -l', 'sinfo -Nel', 'sinfo -l', 'sinfo -R', 'scontrol show nodes node002',
  'sacct -a -X -S today -s FAILED,NODE_FAIL,TIMEOUT,OUT_OF_MEMORY --format=JobID,User,JobName,State,ExitCode,NodeList',
  'ssh node002 systemctl status slurmd', 'ssh node002 "sudo journalctl -u slurmd --no-pager"', 'ssh node002 sudo systemctl start slurmd',
  'scontrol update NodeName=node002 State=RESUME', 'sinfo -N -n node002 -o "%N %T %E"', 'sudo su - mlops -c "whoami"', 'sudo -u mlops whoami',
  'sbatch job.sh', 'squeue -j 5822', 'squeue -u student', 'scontrol show jobid 5822', 'scontrol show job 5822', '#WAIT 30', 'tail -n 2 slurm-5822.out',
  'scontrol update NodeName=node001 Reason="maintenance" State=DRAIN', 'sinfo -N -n node001 -o "%N %T %E"', 'sinfo -O NodeList,StateLong,Reason']);
accepts('k8s', ['module load kubernetes/default/1.32', 'kubectl cluster-info', 'kubectl get nodes -o wide', 'mkdir -p /home/student/lab2',
  'kubectl create job hello --image=busybox --dry-run=client -o yaml -- echo \u201Chello from k8s\u201D > /home/student/lab2/hello-job.yaml',
  'kubectl apply -f /home/student/lab2/hello-job.yaml', 'kubectl wait job/hello --for=condition=complete --timeout=60s', 'kubectl logs jobs/hello',
  'cat > /home/student/lab2/cuda-vectoradd.yaml', 'apiVersion: v1', 'kind: Pod', 'metadata:', '  name: cuda-vectoradd', 'spec:', '  restartPolicy: OnFailure', '  containers:', '  - name: cuda-vectoradd', '    image: "nvcr.io/nvidia/k8s/cuda-sample:vectoradd-cuda12.5.0-ubuntu22.04"', '    resources:', '      limits:', '        nvidia.com/gpu: 1', '^D',
  'ls -l /home/student/lab2', 'kubectl apply -f /home/student/lab2/cuda-vectoradd.yaml', '#WAIT 8', 'kubectl get pods -o wide', 'kubectl logs pod/cuda-vectoradd',
  'kubectl run web --image nginx --restart=Never', 'kubectl wait --for=condition=Ready pod/web --timeout=30s', 'kubectl get pod web']);
{ const t = accepts('bcm', ['cmsh -c "softwareimage; list"', 'cmsh -c "softwareimage; clone default-image dgx-training; commit --wait"',
    'cmsh -c "category; clone default gpu-training; set softwareimage dgx-training; commit"', 'cmsh -c "category; list"', 'cmsh -c "category; use gpu-training; get softwareimage"',
    'cmsh -c "device; add physicalnode gpu004 10.141.0.44; set category gpu-training; set mac 02:00:00:00:04:04; commit"',
    'cmsh -c "device; power on -n gpu004"', 'cmsh -c "device; list"', 'cmsh -c "device; use gpu004; get category"', 'cmsh -c "device; status -n gpu004"', 'cmsh -c "ds"',
    'cm-kubernetes-setup', '1', '', '', '', '1', '2', '', '', 'y', '2', '/root/cm-kubernetes-setup.conf',
    'cm-kubernetes-setup -v -c /root/cm-kubernetes-setup.conf', 'module load kubernetes && kubectl get nodes', 'kubectl cluster-info']);
  allPass(t, 'bcm one-liner style'); }
{ const t = accepts('bcm', ['cmsh', 'softwareimage', 'clone default-image dgx-training', 'commit', 'category; clone default gpu-training; commit', 'use gpu-training', 'set softwareimage dgx-training', 'commit',
    'device', 'add physicalnode gpu004 10.141.0.44', 'set category gpu-training', 'set mac 02:00:00:00:04:04', 'commit', 'power on', 'quit']);
  ['image', 'category', 'assign', 'node'].forEach(id => assert(!failed(t, id), 'bcm navigated style: ' + id)); }

console.log(`${runs} scenario solves, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
