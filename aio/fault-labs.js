/* NAVIA · Fault lab engine (guided labs).
   Same conventions as the 3 Reported Labs: you log in as root@headnode, slurmd/kubelet live on the
   compute nodes (ssh nodeNNN), kubectl needs `module load kubernetes`, the partition is defq, and
   BCM uses real cmsh syntax (navigated or cmsh -c "..."). Every command is simulated. */
(function (root) {
'use strict';
const NOW = '2026-11-25T11:45:00', DAY = 'Nov 25';
const S = (v, n) => String(v).padStart(n), E = (v, n) => String(v).padEnd(n);
const clone = o => JSON.parse(JSON.stringify(o));
const NODES = ['node001', 'node002', 'node003', 'node004'];
const MAC = { headnode: 'FA:16:3E:0A:11:01', node001: 'FA:16:3E:5C:21:0A', node002: 'FA:16:3E:5C:21:0B', node003: 'FA:16:3E:5C:21:0C' };

/* ---------------- tokenizer ---------------- */
function words(line) {
  const out = []; let cur = '', q = null, has = false;
  for (const ch of line) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}
// split on an unquoted separator string
function splitTop(line, sepRe) {
  const parts = []; let cur = '', q = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    const m = line.slice(i).match(sepRe);
    if (m && m.index === 0) { parts.push(cur); cur = ''; i += m[0].length - 1; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map(s => s.trim());
}
const compress = list => {
  if (!list.length) return '';
  const nums = list.map(n => +n.replace('node', '')).sort((a, b) => a - b);
  if (nums.length === 1) return 'node' + String(nums[0]).padStart(3, '0');
  const r = []; let a = nums[0], b = nums[0];
  for (const n of nums.slice(1)) { if (n === b + 1) b = n; else { r.push([a, b]); a = b = n; } }
  r.push([a, b]);
  return 'node[' + r.map(([x, y]) => x === y ? String(x).padStart(3, '0') : String(x).padStart(3, '0') + '-' + String(y).padStart(3, '0')).join(',') + ']';
};
const table = (head, rows) => {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
  return [head, ...rows].map(r => r.map((c, i) => i === r.length - 1 ? String(c) : E(c, w[i] + 3)).join('')).join('\n');
};

/* ---------------- base world ---------------- */
function baseWorld() {
  const n = {};
  NODES.forEach((id, i) => n[id] = { drain: false, down: false, notResp: false, reason: '', rUser: '', rTime: '', gres: 8, gresFound: 8, svc: { slurmd: 'active', munge: 'active', kubelet: 'active' }, ip: '10.141.0.' + (i + 1) });
  return {
    host: 'headnode', modules: [], ev: [], hints: [], files: {},
    slurm: { nodes: n, parts: { defq: { state: 'UP', def: true, nodes: [...NODES] } }, jobs: { 5819: { name: 'llm-eval', user: 'research', st: 'R', reason: 'None', part: 'defq', node: 'node004', gpus: 8, time: '1:09:11', comment: '' } }, nextId: 5824 },
    journal: {}, kern: {},
    k8s: null,
    bcm: {
      devices: {
        headnode: { type: 'HeadNode', mac: MAC.headnode, cat: '', ip: '10.141.255.254', img: '', power: 'on' },
        node001: { type: 'PhysicalNode', mac: MAC.node001, cat: 'default', ip: '10.141.0.1', img: '', power: 'on' },
        node002: { type: 'PhysicalNode', mac: MAC.node002, cat: 'gpu-nodes', ip: '10.141.0.2', img: '', power: 'on' },
        node003: { type: 'PhysicalNode', mac: MAC.node003, cat: 'gpu-nodes', ip: '10.141.0.3', img: '', power: 'on' }
      },
      cats: { default: { img: 'default-image' }, 'gpu-nodes': { img: 'dgx-image' } },
      images: ['default-image', 'dgx-image', 'old-dgx-image'],
      updated: {}
    },
    cm: null, storage: { full: true }, xid: false, bug: false
  };
}
function k8sWorld() {
  return {
    nodes: {
      node001: { role: 'control-plane', ready: true, kubeletOk: true, taints: [{ key: 'node-role.kubernetes.io/control-plane', value: '', effect: 'NoSchedule' }], gpu: 0, ip: '10.141.0.1' },
      node002: { role: '<none>', ready: true, kubeletOk: true, taints: [], gpu: 8, ip: '10.141.0.2', plugin: true },
      node003: { role: '<none>', ready: true, kubeletOk: true, taints: [], gpu: 0, ip: '10.141.0.3' }
    },
    deploys: {}, pods: [], seq: 0
  };
}
const GOOD_IMG = /^(nvcr\.io\/nvidia\/(tritonserver:24\.08-py3|cuda:12\.4\.1-base-ubuntu22\.04|k8s-device-plugin:v0\.16\.2|driver:550\.90\.07)|registry\.k8s\.io\/coredns\/coredns:v1\.11\.1|nginx:1\.27|busybox:1\.36)$/;
const HASH = ['7c9d8f6b5', '5f7b9c8d4', '6d8f4b7c9', '84c6d9f7b'], SUF = ['k2x4m', 'q7w2n', 'p9v3c', 'z5r8t', 'h4j6s', 'w3b7d'];

/* ---------------- labs ---------------- */
const has = (w, e) => w.ev.includes(e);
const on = (w, h) => w.host === h || w.ev.includes('remote@' + h);
const back = (w, h) => (w.host === 'headnode' && w.ev.includes('exit:' + h)) || (w.host === 'headnode' && w.ev.includes('remote@' + h));
const any = (w, re) => w.ev.some(e => re.test(e));
const LABS = [
{ id: 'drain', name: 'Slurm: restore a drained node', domain: 'Slurm', level: 'Beginner',
  story: 'Maintenance on node002 has finished, but the node is still drained and jobs are not landing on it. Confirm why it is unavailable, check that its slurmd is healthy, and return it to service.',
  setup(w) { Object.assign(w.slurm.nodes.node002, { drain: true, reason: 'maintenance', rUser: 'root', rTime: '2026-11-24T16:02:11' }); },
  steps: [
    ['Investigate', 'List the nodes that are unavailable and why.', 'sinfo -R', 'node002 is drained with the reason "maintenance".', w => has(w, 'sinfo-R')],
    ['Inspect', 'Show the details of node002.', 'scontrol show node node002', 'State=IDLE+DRAIN and Reason=maintenance.', w => has(w, 'show-node:node002')],
    ['Log in', 'Log in to node002.', 'ssh node002', 'slurmd runs on the compute node, so you check it there.', w => on(w, 'node002')],
    ['Check health', 'Confirm slurmd is running on node002.', 'systemctl status slurmd', 'Active: active (running), so the node is healthy.', w => has(w, 'status:slurmd@node002')],
    ['Return', 'Go back to the head node.', 'exit', 'You are back on root@headnode.', w => back(w, 'node002')],
    ['Repair', 'Resume node002.', 'scontrol update nodename=node002 state=resume', 'RESUME clears the drain so the scheduler can use the node.', w => !w.slurm.nodes.node002.drain && has(w, 'update-node:node002')],
    ['Verify', 'Confirm node002 is idle.', 'sinfo', 'node002 is listed as idle.', w => has(w, 'sinfo') && !w.slurm.nodes.node002.drain]
  ] },
{ id: 'image', name: 'Kubernetes: fix a bad container image', domain: 'Kubernetes', level: 'Beginner',
  story: 'The inference Deployment stopped serving after someone changed its image tag. Find the failing Pod, read its events, and set the approved image nvcr.io/nvidia/tritonserver:24.08-py3 on the Deployment\'s inference container.',
  setup(w) { const k = w.k8s = k8sWorld(); k.deploys.inference = { image: 'nvcr.io/nvidia/tritonserver:24.08-py', prev: 'nvcr.io/nvidia/tritonserver:24.08-py3', env: {}, needEnv: null, gpu: 0, rev: 2 }; },
  steps: [
    ['Set up', 'Load the Kubernetes environment.', 'module load kubernetes', 'kubectl is on your PATH only after the module is loaded.', w => w.modules.includes('kubernetes')],
    ['Investigate', 'List the Pods.', 'kubectl get pods', 'The inference Pod shows ImagePullBackOff.', w => has(w, 'k:get-pods')],
    ['Inspect', 'Read the failing Pod\'s events.', 'kubectl describe pod inference', 'kubectl describe matches the name prefix. The events show the image tag was not found.', w => any(w, /^k:describe-pod:inference/)],
    ['Repair', 'Set the approved image on the Deployment.', 'kubectl set image deployment/inference inference=nvcr.io/nvidia/tritonserver:24.08-py3', 'Changing the Deployment rolls out a new Pod with the right image. kubectl rollout undo deployment/inference also works here.', w => w.k8s.deploys.inference.image.endsWith(':24.08-py3') && any(w, /^k:(set-image|undo)/)],
    ['Verify', 'Confirm the new Pod is Running.', 'kubectl get pods', 'A new inference Pod is 1/1 Running.', w => (has(w, 'k:get-pods') || has(w, 'k:rollout-status')) && podsOk(w, 'inference')]
  ] },
{ id: 'bcm', name: 'BCM: add and power on a GPU node', domain: 'BCM', level: 'Intermediate',
  story: 'A new GPU server has been racked. Add it in BCM as node004 with IP 10.141.0.4 and MAC 02:00:00:00:00:04, put it in the gpu-nodes category, commit, power it on and confirm it comes UP.',
  setup() {},
  steps: [
    ['Connect', 'Open the BCM shell.', 'cmsh', 'You are in cmsh at [headnode]%.', w => has(w, 'cm:enter')],
    ['Navigate', 'Go to device mode.', 'device', 'The prompt shows [headnode->device]%.', w => has(w, 'cm:mode:device')],
    ['Add', 'Add the new physical node.', 'add physicalnode node004 10.141.0.4', 'BCM stages a new node object and selects it.', w => has(w, 'cm:add:node004')],
    ['Category', 'Put it in the gpu-nodes category.', 'set category gpu-nodes', 'The category gives it the dgx-image software image.', w => cmVal(w, 'node004', 'cat') === 'gpu-nodes' && has(w, 'cm:set:category')],
    ['MAC', 'Set its MAC address so BCM can identify it at PXE boot.', 'set mac 02:00:00:00:00:04', 'Staged; the * in the prompt means uncommitted changes.', w => cmVal(w, 'node004', 'mac') === '02:00:00:00:00:04' && has(w, 'cm:set:mac')],
    ['Commit', 'Save the new node.', 'commit', 'node004 now exists in the BCM database.', w => !!w.bcm.devices.node004 && w.bcm.devices.node004.cat === 'gpu-nodes' && w.bcm.devices.node004.mac === '02:00:00:00:00:04'],
    ['Power on', 'Power on node004 through BCM.', 'power on -n node004', 'BCM switches the server on over IPMI and it PXE-boots and provisions.', w => w.bcm.devices.node004?.power === 'on'],
    ['Verify', 'Confirm node004 is UP.', 'status -n node004', 'node004 [ UP ].', w => has(w, 'cm:status:node004') && w.bcm.devices.node004?.power === 'on']
  ] },
{ id: 'slurm-resources', name: 'Slurm: GPU job blocked by a stale job', domain: 'Slurm', level: 'Beginner',
  story: 'Job 5823 needs a full GPU node and is pending. Every node is busy, and the benchmark job on node002 finished its work hours ago but never exited. Its owner (trainer) asked you to cancel it. Find it, cancel only that job, and confirm 5823 starts.',
  setup(w) {
    const J = w.slurm.jobs;
    J[5820] = { name: 'bench-a', user: 'trainer', st: 'R', reason: 'None', part: 'defq', node: 'node002', gpus: 8, time: '6:42:17', comment: 'benchmark done - safe to cancel' };
    J[5821] = { name: 'pretrain', user: 'lee', st: 'R', reason: 'None', part: 'defq', node: 'node001', gpus: 8, time: '2:10:03', comment: '' };
    J[5822] = { name: 'finetune', user: 'priya', st: 'R', reason: 'None', part: 'defq', node: 'node003', gpus: 8, time: '0:48:55', comment: '' };
    J[5823] = { name: 'train', user: 'dana', st: 'PD', reason: 'Resources', part: 'defq', node: '', gpus: 8, time: '0:00', comment: '' };
  },
  steps: [
    ['Check queue', 'List the jobs.', 'squeue', '5823 is PD (Resources); every node is running a job.', w => has(w, 'squeue')],
    ['Inspect', 'See what 5823 is waiting for.', 'scontrol show job 5823', 'Reason=Resources and TRES gres/gpu=8: it needs a whole node.', w => has(w, 'show-job:5823')],
    ['Find stale job', 'Inspect the long-running benchmark job.', 'scontrol show job 5820', 'Comment says the benchmark is done and safe to cancel.', w => has(w, 'show-job:5820')],
    ['Repair', 'Cancel only the stale benchmark job.', 'scancel 5820', 'Cancelling 5820 frees node002.', w => !w.slurm.jobs[5820] && has(w, 'scancel:5820')],
    ['Verify', 'Confirm 5823 is now running.', 'squeue', '5823 shows R on node002.', w => has(w, 'squeue') && w.slurm.jobs[5823]?.st === 'R']
  ] },
{ id: 'slurm-partition', name: 'Slurm: job stuck on a retired partition', domain: 'Slurm', level: 'Intermediate',
  story: 'Job 5823 was submitted to the legacy partition, which has been retired (inactive), so it will never start. Find the active partition and move the pending job to it.',
  setup(w) {
    w.slurm.parts.legacy = { state: 'INACTIVE', def: false, nodes: ['node001', 'node002'] };
    w.slurm.jobs[5823] = { name: 'train', user: 'dana', st: 'PD', reason: 'PartitionInactive', part: 'legacy', node: '', gpus: 8, time: '0:00', comment: '' };
  },
  steps: [
    ['Check queue', 'List the jobs.', 'squeue', '5823 is PD with reason PartitionInactive.', w => has(w, 'squeue')],
    ['Inspect', 'Show the job details.', 'scontrol show job 5823', 'Partition=legacy.', w => has(w, 'show-job:5823')],
    ['Partitions', 'List the partitions and their state.', 'sinfo', 'legacy is inact; defq* is up.', w => has(w, 'sinfo')],
    ['Repair', 'Move the pending job to defq.', 'scontrol update jobid=5823 partition=defq', 'A pending job can be moved to another partition with scontrol update.', w => w.slurm.jobs[5823]?.part === 'defq'],
    ['Verify', 'Confirm the job is running.', 'squeue', '5823 shows R.', w => has(w, 'squeue') && w.slurm.jobs[5823]?.st === 'R']
  ] },
{ id: 'slurm-gres', name: 'Slurm: GPU count mismatch (GRES)', domain: 'Slurm', level: 'Advanced',
  story: 'node002 has eight GPUs but Slurm drained it because slurmd reports fewer than configured. Check the GPUs and the node\'s /etc/slurm/gres.conf, fix the file, restart slurmd and return the node to service.',
  setup(w) {
    const n = w.slurm.nodes.node002; Object.assign(n, { drain: true, gresFound: 1, reason: 'gres/gpu count reported lower than configured (1 < 8)', rUser: 'slurm', rTime: '2026-11-25T09:02:14' });
    w.files['node002:/etc/slurm/gres.conf'] = '# Managed by the cluster team\nNodeName=node002 Name=gpu Type=h100 File=/dev/nvidia0\n';
    w.journal['slurmd@node002'] = [`${DAY} 09:02:13 node002 systemd[1]: Started Slurm node daemon.`, `${DAY} 09:02:13 node002 slurmd[2210]: slurmd: gpu/generic: init: GPU Generic plugin loaded`, `${DAY} 09:02:13 node002 slurmd[2210]: slurmd: Gres Name=gpu Type=h100 Count=1 Index=0 ID=7696487 File=/dev/nvidia0`, `${DAY} 09:02:14 node002 slurmd[2210]: slurmd: slurmd started on Wed, 25 Nov 2026 09:02:14 -0600`];
  },
  steps: [
    ['Investigate', 'See why node002 is unavailable.', 'sinfo -R', 'gres/gpu count reported lower than configured (1 < 8).', w => has(w, 'sinfo-R')],
    ['Log in', 'Log in to node002.', 'ssh node002', 'The GPUs and gres.conf are on the compute node.', w => on(w, 'node002')],
    ['Check GPUs', 'List the GPUs the driver sees.', 'nvidia-smi -L', 'All eight GPUs are present, so the hardware is fine.', w => has(w, 'nvsmi@node002')],
    ['Check config', 'Read the node\'s GRES configuration.', 'cat /etc/slurm/gres.conf', 'File=/dev/nvidia0 lists only one GPU device.', w => has(w, 'cat:/etc/slurm/gres.conf@node002')],
    ['Repair', 'Change the file so it lists all eight GPUs.', "sed -i 's#/dev/nvidia0#/dev/nvidia[0-7]#' /etc/slurm/gres.conf", 'File=/dev/nvidia[0-7] covers GPUs 0 to 7. (echo "..." > file works too.)', w => gresIn(w.files['node002:/etc/slurm/gres.conf']) === 8],
    ['Restart', 'Restart slurmd so it rereads gres.conf.', 'systemctl restart slurmd', 'slurmd now reports gpu:8.', w => w.slurm.nodes.node002.gresFound === 8],
    ['Return', 'Go back to the head node.', 'exit', 'You are back on root@headnode.', w => back(w, 'node002')],
    ['Resume', 'Resume node002.', 'scontrol update nodename=node002 state=resume', 'The drain is cleared now that the GPU count matches.', w => !w.slurm.nodes.node002.drain],
    ['Verify', 'Confirm Slurm sees eight GPUs on node002.', 'scontrol show node node002', 'State=IDLE and Gres=gpu:h100:8.', w => has(w, 'show-node:node002') && !w.slurm.nodes.node002.drain]
  ] },
{ id: 'slurm-service', name: 'Slurm: compute daemon down', domain: 'Slurm', level: 'Intermediate',
  story: 'node002 went DOWN overnight. Find out why on the node, bring slurmd back, and return the node to service. (ReturnToService=0, so the node stays DOWN until you resume it.)',
  setup(w) {
    Object.assign(w.slurm.nodes.node002, { down: true, notResp: true, reason: 'Not responding', rUser: 'slurm', rTime: '2026-11-25T03:17:40' }); w.slurm.nodes.node002.svc.slurmd = 'oom';
    w.journal['slurmd@node002'] = [`Nov 22 07:12:00 node002 systemd[1]: Started Slurm node daemon.`, `${DAY} 03:16:52 node002 systemd[1]: slurmd.service: A process of this unit has been killed by the OOM killer.`, `${DAY} 03:16:52 node002 systemd[1]: slurmd.service: Main process exited, code=killed, status=9/KILL`, `${DAY} 03:16:52 node002 systemd[1]: slurmd.service: Failed with result 'oom-kill'.`];
  },
  steps: [
    ['Investigate', 'See which node is unavailable and why.', 'sinfo -R', 'node002: Not responding.', w => has(w, 'sinfo-R')],
    ['Log in', 'Log in to node002.', 'ssh node002', 'slurmd runs on the compute node.', w => on(w, 'node002')],
    ['Inspect', 'Check the slurmd service.', 'systemctl status slurmd', 'failed (Result: oom-kill).', w => has(w, 'status:slurmd@node002')],
    ['Read logs', 'Read the slurmd journal.', 'journalctl -u slurmd -n 30 --no-pager', 'The OOM killer stopped slurmd; nothing points to a hardware fault.', w => has(w, 'journal:slurmd@node002')],
    ['Repair', 'Restart slurmd.', 'systemctl restart slurmd', 'slurmd is active (running) again.', w => w.slurm.nodes.node002.svc.slurmd === 'active'],
    ['Return', 'Go back to the head node.', 'exit', 'You are back on root@headnode.', w => back(w, 'node002')],
    ['Resume', 'Return node002 to service.', 'scontrol update nodename=node002 state=resume', 'With ReturnToService=0 an admin must resume the node.', w => !w.slurm.nodes.node002.down],
    ['Verify', 'Confirm node002 is idle.', 'sinfo', 'node002 is idle.', w => has(w, 'sinfo') && !w.slurm.nodes.node002.down]
  ] },
{ id: 'k8s-pending', name: 'Kubernetes: Pod blocked by a taint', domain: 'Kubernetes', level: 'Beginner',
  story: 'The inference Pod needs one GPU and stays Pending. node002 is the only GPU worker, and an old training taint (training=blocked:NoSchedule) was never removed from it. Confirm that from the events, then remove the taint.',
  setup(w) { const k = w.k8s = k8sWorld(); k.nodes.node002.taints.push({ key: 'training', value: 'blocked', effect: 'NoSchedule' }); k.pods.push(newPod('default', 'inference', null, 'nvcr.io/nvidia/tritonserver:24.08-py3', 1)); },
  steps: [
    ['Set up', 'Load the Kubernetes environment.', 'module load kubernetes', 'kubectl is on your PATH.', w => w.modules.includes('kubernetes')],
    ['Investigate', 'List the Pods.', 'kubectl get pods', 'inference is Pending.', w => has(w, 'k:get-pods')],
    ['Inspect', 'Read the scheduling events.', 'kubectl describe pod inference', 'FailedScheduling: node002 has the untolerated taint {training: blocked}.', w => any(w, /^k:describe-pod:inference/)],
    ['Check node', 'Look at node002\'s taints.', 'kubectl describe node node002', 'Taints: training=blocked:NoSchedule.', w => has(w, 'k:describe-node:node002')],
    ['Repair', 'Remove the taint (the trailing - removes it).', 'kubectl taint nodes node002 training=blocked:NoSchedule-', 'node/node002 untainted.', w => !w.k8s.nodes.node002.taints.some(t => t.key === 'training')],
    ['Verify', 'Confirm the Pod is Running.', 'kubectl get pods', 'inference is 1/1 Running.', w => has(w, 'k:get-pods') && podsOk(w, 'inference')]
  ] },
{ id: 'k8s-crash', name: 'Kubernetes: CrashLoopBackOff', domain: 'Kubernetes', level: 'Intermediate',
  story: 'The inference Deployment\'s Pod keeps restarting. Read its logs to find the missing setting and fix the Deployment. The model files are in /models.',
  setup(w) { const k = w.k8s = k8sWorld(); k.deploys.inference = { image: 'nvcr.io/nvidia/tritonserver:24.08-py3', prev: null, env: {}, needEnv: 'MODEL_PATH', gpu: 0, rev: 1 }; },
  steps: [
    ['Set up', 'Load the Kubernetes environment.', 'module load kubernetes', 'kubectl is on your PATH.', w => w.modules.includes('kubernetes')],
    ['Investigate', 'List the Pods.', 'kubectl get pods', 'The inference Pod is CrashLoopBackOff with several restarts.', w => has(w, 'k:get-pods')],
    ['Inspect', 'Read the Pod\'s events.', 'kubectl describe pod inference', 'Back-off restarting failed container; exit code 1.', w => any(w, /^k:describe-pod:inference/)],
    ['Read logs', 'Read the application logs.', 'kubectl logs deployment/inference', 'MODEL_PATH is not set. (kubectl logs <full-pod-name> works too.)', w => any(w, /^k:logs:inference/)],
    ['Repair', 'Set MODEL_PATH on the Deployment.', 'kubectl set env deployment/inference MODEL_PATH=/models', 'The Deployment rolls out a new Pod with the variable.', w => w.k8s.deploys.inference.env.MODEL_PATH === '/models'],
    ['Verify', 'Confirm the new Pod is Running.', 'kubectl get pods', 'inference is 1/1 Running with 0 restarts.', w => (has(w, 'k:get-pods') || has(w, 'k:rollout-status')) && podsOk(w, 'inference')]
  ] },
{ id: 'k8s-gpu', name: 'Kubernetes: GPU device plugin not ready', domain: 'Kubernetes', level: 'Advanced',
  story: 'The gpu-test Pod requests one GPU and stays Pending. node002 should offer 8 nvidia.com/gpu, but its GPU Operator device-plugin Pod started before the driver was ready. Confirm it in the gpu-operator namespace and restart the plugin.',
  setup(w) { const k = w.k8s = k8sWorld(); k.nodes.node002.plugin = false; k.pods.push(newPod('default', 'gpu-test', null, 'nvcr.io/nvidia/cuda:12.4.1-base-ubuntu22.04', 1)); },
  steps: [
    ['Set up', 'Load the Kubernetes environment.', 'module load kubernetes', 'kubectl is on your PATH.', w => w.modules.includes('kubernetes')],
    ['Investigate', 'Read the Pod\'s scheduling events.', 'kubectl describe pod gpu-test', 'FailedScheduling: Insufficient nvidia.com/gpu.', w => any(w, /^k:describe-pod:gpu-test/)],
    ['Capacity', 'Check node002\'s GPU capacity.', 'kubectl describe node node002', 'Allocatable nvidia.com/gpu is 0.', w => has(w, 'k:describe-node:node002')],
    ['GPU Operator', 'List the GPU Operator Pods.', 'kubectl get pods -n gpu-operator', 'The device-plugin Pod on node002 is CrashLoopBackOff.', w => has(w, 'k:get-pods:gpu-operator')],
    ['Logs', 'Read the device plugin logs.', 'kubectl logs -n gpu-operator daemonset/nvidia-device-plugin-daemonset', 'It failed to load NVML because the driver was not ready yet.', w => any(w, /^k:logs:nvidia-device-plugin/)],
    ['Repair', 'Restart the device plugin.', 'kubectl rollout restart daemonset/nvidia-device-plugin-daemonset -n gpu-operator', 'The new plugin Pod finds the driver and registers 8 GPUs. (Deleting the plugin Pod also works.)', w => w.k8s.nodes.node002.plugin],
    ['Verify', 'Confirm gpu-test is Running.', 'kubectl get pods', 'gpu-test is 1/1 Running on node002.', w => has(w, 'k:get-pods') && podsOk(w, 'gpu-test')]
  ] },
{ id: 'k8s-node', name: 'Kubernetes: node NotReady', domain: 'Kubernetes', level: 'Intermediate',
  story: 'node002 shows NotReady, so the GPU inference Pod cannot run. Check the node, then log in and fix its kubelet.',
  setup(w) {
    const k = w.k8s = k8sWorld(); Object.assign(k.nodes.node002, { ready: false, kubeletOk: false }); w.slurm.nodes.node002.svc.kubelet = 'inactive';
    k.deploys.inference = { image: 'nvcr.io/nvidia/tritonserver:24.08-py3', prev: null, env: {}, needEnv: null, gpu: 1, rev: 1 };
    w.journal['kubelet@node002'] = [`${DAY} 06:58:01 node002 systemd[1]: Stopping kubelet: The Kubernetes Node Agent...`, `${DAY} 06:58:01 node002 systemd[1]: kubelet.service: Deactivated successfully.`, `${DAY} 06:58:01 node002 systemd[1]: Stopped kubelet: The Kubernetes Node Agent.`];
  },
  steps: [
    ['Set up', 'Load the Kubernetes environment.', 'module load kubernetes', 'kubectl is on your PATH.', w => w.modules.includes('kubernetes')],
    ['Investigate', 'List the nodes.', 'kubectl get nodes', 'node002 is NotReady.', w => has(w, 'k:get-nodes')],
    ['Inspect', 'Read node002\'s conditions.', 'kubectl describe node node002', 'Kubelet stopped posting node status.', w => has(w, 'k:describe-node:node002')],
    ['Log in', 'Log in to node002.', 'ssh node002', 'kubelet runs on the node.', w => on(w, 'node002')],
    ['Check service', 'Check the kubelet service.', 'systemctl status kubelet', 'inactive (dead): it was stopped and never started again.', w => has(w, 'status:kubelet@node002')],
    ['Repair', 'Start kubelet again.', 'systemctl restart kubelet', 'kubelet is active (running).', w => w.slurm.nodes.node002.svc.kubelet === 'active'],
    ['Return', 'Go back to the head node.', 'exit', 'kubectl is configured on the head node.', w => back(w, 'node002')],
    ['Verify', 'Confirm node002 is Ready.', 'kubectl get nodes', 'node002 is Ready, and the inference Pod can run.', w => has(w, 'k:get-nodes') && w.k8s.nodes.node002.ready]
  ] },
{ id: 'bcm-image', name: 'BCM: wrong software image on a node', domain: 'BCM', level: 'Intermediate',
  story: 'node003 is in the gpu-nodes category, which uses dgx-image, but someone pinned old-dgx-image on the node itself. Put node003 back on dgx-image and push the image to the running node.',
  setup(w) { w.bcm.devices.node003.img = 'old-dgx-image'; },
  steps: [
    ['Connect', 'Open the BCM shell.', 'cmsh', 'You are at [headnode]%.', w => has(w, 'cm:enter')],
    ['Navigate', 'Go to device mode.', 'device', '[headnode->device]%.', w => has(w, 'cm:mode:device')],
    ['Select', 'Select node003.', 'use node003', '[headnode->device[node003]]%.', w => has(w, 'cm:use:node003')],
    ['Inspect', 'Check its software image.', 'get softwareimage', 'old-dgx-image is set on the node and overrides the category.', w => has(w, 'cm:get:softwareimage') || has(w, 'cm:show')],
    ['Repair', 'Set the correct image.', 'set softwareimage dgx-image', 'clear softwareimage also works: the node then inherits dgx-image from gpu-nodes.', w => effImg(w, 'node003', true) === 'dgx-image' && any(w, /^cm:(set|clear):softwareimage/)],
    ['Commit', 'Save the change.', 'commit', 'The node now uses dgx-image.', w => effImg(w, 'node003') === 'dgx-image' && has(w, 'cm:commit')],
    ['Apply', 'Push the image to the running node.', 'imageupdate -w', 'imageupdate syncs node003 with its image without a reboot (-w waits until done).', w => w.bcm.updated.node003 === 'dgx-image'],
    ['Verify', 'Read the image back.', 'get softwareimage', 'dgx-image.', w => (has(w, 'cm:get:softwareimage') || has(w, 'cm:show')) && effImg(w, 'node003') === 'dgx-image']
  ] },
{ id: 'bcm-category', name: 'BCM: node in the wrong category', domain: 'BCM', level: 'Beginner',
  story: 'GPU server node003 was put in the default (CPU) category, so it gets the wrong image and settings. Move it to the gpu-nodes category.',
  setup(w) { w.bcm.devices.node003.cat = 'default'; },
  steps: [
    ['Connect', 'Open the BCM shell.', 'cmsh', 'You are at [headnode]%.', w => has(w, 'cm:enter')],
    ['Navigate', 'Go to device mode.', 'device', '[headnode->device]%.', w => has(w, 'cm:mode:device')],
    ['Select', 'Select node003.', 'use node003', '[headnode->device[node003]]%.', w => has(w, 'cm:use:node003')],
    ['Inspect', 'Check its category.', 'get category', 'default (the CPU category).', w => has(w, 'cm:get:category') || has(w, 'cm:show')],
    ['Repair', 'Set the GPU category.', 'set category gpu-nodes', 'Staged; the prompt shows *.', w => cmVal(w, 'node003', 'cat') === 'gpu-nodes'],
    ['Commit', 'Save the change.', 'commit', 'node003 is now in gpu-nodes.', w => w.bcm.devices.node003.cat === 'gpu-nodes'],
    ['Verify', 'Read the category back.', 'get category', 'gpu-nodes.', w => (has(w, 'cm:get:category') || has(w, 'cm:show') || has(w, 'cm:list')) && w.bcm.devices.node003.cat === 'gpu-nodes']
  ] },
{ id: 'gpu-xid', name: 'GPU: Xid error triage', domain: 'GPU', level: 'Advanced',
  story: 'Jobs on node002 keep failing with CUDA errors. Check the GPUs and kernel log on the node, collect a bug report for NVIDIA support, and drain the node so no new jobs land on it. Do not try to repair the hardware.',
  setup(w) { w.xid = true; },
  steps: [
    ['Log in', 'Log in to node002.', 'ssh node002', 'GPU tools run on the GPU node.', w => on(w, 'node002')],
    ['Inspect GPUs', 'Check the GPUs.', 'nvidia-smi', 'One GPU cannot be reached.', w => has(w, 'nvsmi@node002')],
    ['Kernel log', 'Search the kernel log for Xid errors.', 'journalctl -k | grep -i xid', 'Xid 79: GPU has fallen off the bus. (dmesg | grep -i xid works too.)', w => has(w, 'xidlog@node002')],
    ['Evidence', 'Collect the NVIDIA bug report.', 'nvidia-bug-report.sh', 'nvidia-bug-report.log.gz is what NVIDIA support asks for.', w => w.bug],
    ['Return', 'Go back to the head node.', 'exit', 'You are back on root@headnode.', w => back(w, 'node002')],
    ['Isolate', 'Drain node002 with a reason.', 'scontrol update nodename=node002 state=drain reason="GPU Xid 79"', 'Running jobs finish; no new jobs start on node002.', w => w.slurm.nodes.node002.drain],
    ['Verify', 'Confirm the drain and its reason.', 'sinfo -R', 'node002 shows your reason.', w => has(w, 'sinfo-R') && w.slurm.nodes.node002.drain]
  ] },
{ id: 'storage-full', name: 'Linux: shared storage full', domain: 'Linux', level: 'Beginner',
  story: 'Training jobs cannot write checkpoints because /shared is full. The training team confirmed that /shared/old-checkpoint.tmp is a leftover temporary file that can be deleted. Do not touch /shared/datasets.',
  setup() {},
  steps: [
    ['Inspect usage', 'Check filesystem usage.', 'df -h', '/shared is 100% used.', w => has(w, 'df')],
    ['Find usage', 'See what is using the space.', 'du -sh /shared/*', 'old-checkpoint.tmp uses 800G.', w => has(w, 'du')],
    ['Inspect file', 'Look at the file before you delete it.', 'ls -lh /shared/old-checkpoint.tmp', 'An 800G temporary file owned by trainer.', w => has(w, 'ls:/shared/old-checkpoint.tmp')],
    ['Repair', 'Delete only that file.', 'rm /shared/old-checkpoint.tmp', 'The temporary file is removed; datasets are untouched.', w => !w.storage.full],
    ['Verify', 'Check usage again.', 'df -h', '/shared has free space.', w => has(w, 'df') && !w.storage.full]
  ] }
];
const BY = Object.fromEntries(LABS.map(l => [l.id, l]));

/* ---------------- helpers used by labs ---------------- */
function gresIn(text) {
  if (!text) return 0;
  let n = 0;
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line) || !/Name=gpu/i.test(line)) { if (/AutoDetect=nvml/i.test(line)) n = 8; continue; }
    const c = line.match(/Count=(\d+)/i); if (c) { n += +c[1]; continue; }
    const f = line.match(/File=\/dev\/nvidia(\[(\d+)-(\d+)\]|\d+)/);
    if (f) n += f[2] !== undefined ? (+f[3] - +f[2] + 1) : 1;
  }
  return n;
}
function cmVal(w, node, key) { const c = w.cm, p = c && c.pending[node]; if (p && key in p) return p[key]; return w.bcm.devices[node]?.[key]; }
function effImg(w, node, staged) { const d = w.bcm.devices[node]; if (!d) return ''; const img = staged ? cmVal(w, node, 'img') : d.img; const cat = staged ? cmVal(w, node, 'cat') : d.cat; return img || w.bcm.cats[cat]?.img || ''; }
function newPod(ns, name, owner, image, gpu, extra) { return Object.assign({ ns, name, owner, image, gpu: gpu || 0, node: null, status: 'Pending', restarts: 0, age: '14m', ip: '' }, extra || {}); }
function podsOk(w, prefix) { const p = w.k8s.pods.filter(p => p.ns === 'default' && p.name.startsWith(prefix)); return p.length > 0 && p.every(x => x.status === 'Running'); }

/* ---------------- world creation ---------------- */
function create(id) {
  const w = baseWorld(); w.lab = id;
  if (BY[id]) BY[id].setup(w);
  if (id === 'sandbox') w.k8s = k8sWorld();
  if (w.k8s) { // GPU Operator device plugin on the GPU worker + system pods
    const k = w.k8s;
    k.pods.push(newPod('gpu-operator', 'nvidia-device-plugin-daemonset-5wq7d', 'ds', 'nvcr.io/nvidia/k8s-device-plugin:v0.16.2', 0, { node: 'node002', age: '12d' }));
    k.pods.push(newPod('gpu-operator', 'nvidia-driver-daemonset-r4t8x', 'ds-driver', 'nvcr.io/nvidia/driver:550.90.07', 0, { node: 'node002', age: '12d' }));
    k.pods.push(newPod('kube-system', 'coredns-7db6d8ff4d-6c2tq', 'sys', 'registry.k8s.io/coredns/coredns:v1.11.1', 0, { node: 'node001', age: '12d' }));
    for (const [name, d] of Object.entries(k.deploys)) rollout(w, name, d);
    reconcile(w);
  }
  schedule(w);
  return w;
}
function rollout(w, name, d) {
  const k = w.k8s; k.pods = k.pods.filter(p => p.owner !== 'deploy:' + name);
  const h = HASH[(d.rev + name.length) % HASH.length], s = SUF[(k.seq++ + d.rev) % SUF.length];
  k.pods.push(newPod('default', `${name}-${h}-${s}`, 'deploy:' + name, d.image, d.gpu, { age: k.seq > 1 ? '3s' : '14m' }));
}
function untolerated(n) { const t = n.taints.slice(); if (!n.ready) t.push({ key: 'node.kubernetes.io/unreachable', value: '', effect: 'NoSchedule' }); return t; }
function reconcile(w) {
  const k = w.k8s; if (!k) return;
  for (const [id, n] of Object.entries(k.nodes)) { n.kubeletOk = w.slurm.nodes[id] ? w.slurm.nodes[id].svc.kubelet === 'active' : true; n.ready = n.kubeletOk; }
  const alloc = id => { const n = k.nodes[id]; return n.gpu && n.plugin ? n.gpu : 0; };
  for (const p of k.pods) {
    if (p.owner === 'ds') { p.status = k.nodes[p.node].plugin ? 'Running' : 'CrashLoopBackOff'; p.restarts = k.nodes[p.node].plugin ? 0 : 7; continue; }
    if (p.owner === 'ds-driver' || p.owner === 'sys') { p.status = 'Running'; continue; }
    // schedule
    const ok = id => { const n = k.nodes[id]; return n.ready && !untolerated(n).length && alloc(id) >= p.gpu; };
    if (!p.node || !k.nodes[p.node].ready) { const pick = Object.keys(k.nodes).find(ok); p.node = pick || null; }
    if (!p.node) { p.status = 'Pending'; continue; }
    const d = p.owner && p.owner.startsWith('deploy:') ? k.deploys[p.owner.slice(7)] : null;
    if (!GOOD_IMG.test(p.image)) { p.status = 'ImagePullBackOff'; continue; }
    if (d && d.needEnv && !d.env[d.needEnv]) { p.status = 'CrashLoopBackOff'; p.restarts = 6; continue; }
    p.status = 'Running';
  }
  k.pods.forEach(p => { if (p.node) p.ip = p.ip || '10.244.' + (p.node.slice(-1)) + '.' + (40 + p.name.length); });
}
function failReasons(w, p) {
  const k = w.k8s, parts = {}; const add = r => parts[r] = (parts[r] || 0) + 1;
  for (const n of Object.values(k.nodes)) {
    const ut = untolerated(n);
    if (ut.length) add(`node(s) had untolerated taint {${ut[0].key}: ${ut[0].value}}`);
    else if ((n.gpu && n.plugin ? n.gpu : 0) < p.gpu) add('Insufficient nvidia.com/gpu');
  }
  const list = Object.entries(parts).sort().map(([r, c]) => r.startsWith('Insufficient') ? `${c} ${r}` : `${c} ${r}`);
  return `0/${Object.keys(k.nodes).length} nodes are available: ${list.join(', ')}. preemption: 0/${Object.keys(k.nodes).length} nodes are available: ${Object.keys(k.nodes).length} Preemption is not helpful for scheduling.`;
}
function schedule(w) {
  const sl = w.slurm, busy = new Set(Object.values(sl.jobs).filter(j => j.st === 'R').map(j => j.node));
  for (const [id, j] of Object.entries(sl.jobs).sort((a, b) => a[0] - b[0])) {
    if (j.st !== 'PD') continue;
    const part = sl.parts[j.part];
    if (!part) continue;
    if (part.state !== 'UP') { j.reason = 'PartitionInactive'; continue; }
    const free = part.nodes.find(n => { const x = sl.nodes[n]; return !busy.has(n) && !x.drain && !x.down && x.gresFound >= j.gpus; });
    if (!free) { j.reason = 'Resources'; continue; }
    j.st = 'R'; j.reason = 'None'; j.node = free; j.time = '0:02'; busy.add(free);
  }
}

/* ---------------- output builders ---------------- */
const busyNodes = w => new Set(Object.values(w.slurm.jobs).filter(j => j.st === 'R').map(j => j.node));
function nodeShort(w, id) { const n = w.slurm.nodes[id], b = busyNodes(w).has(id); if (n.down) return n.notResp ? 'down*' : 'down'; if (n.drain) return b ? 'drng' : 'drain'; return b ? 'alloc' : 'idle'; }
function sinfo(w, args) {
  if (args.includes('-R') || args.includes('--list-reasons')) {
    const rows = NODES.filter(id => { const n = w.slurm.nodes[id]; return (n.drain || n.down) && n.reason; });
    return 'REASON               USER      TIMESTAMP           NODELIST' + rows.map(id => { const n = w.slurm.nodes[id]; return `\n${E(n.reason.slice(0, 20), 20)} ${E(n.rUser, 9)} ${n.rTime} ${id}`; }).join('');
  }
  const out = ['PARTITION AVAIL  TIMELIMIT  NODES  STATE NODELIST'];
  for (const [name, p] of Object.entries(w.slurm.parts)) {
    const groups = new Map();
    p.nodes.forEach(id => { const s = nodeShort(w, id); groups.set(s, [...(groups.get(s) || []), id]); });
    const avail = p.state === 'UP' ? 'up' : p.state === 'INACTIVE' ? 'inact' : 'down';
    for (const [s, list] of groups) out.push(`${E(name + (p.def ? '*' : ''), 9)} ${S(avail, 5)} ${S('infinite', 10)} ${S(list.length, 6)} ${S(s, 6)} ${compress(list)}`);
  }
  return out.join('\n');
}
function squeue(w, args) {
  let jobs = Object.entries(w.slurm.jobs).sort((a, b) => a[0] - b[0]);
  const u = args.indexOf('-u'); if (u >= 0) jobs = jobs.filter(([, j]) => j.user === args[u + 1]);
  const ji = args.indexOf('-j'); if (ji >= 0) { const ids = String(args[ji + 1] || '').split(','); jobs = jobs.filter(([id]) => ids.includes(id)); if (!jobs.length) return 'slurm_load_jobs error: Invalid job id specified'; }
  if (args.includes('--me')) jobs = jobs.filter(([, j]) => j.user === 'root');
  return '             JOBID PARTITION     NAME     USER ST       TIME  NODES NODELIST(REASON)' + jobs.map(([id, j]) => `\n${S(id, 18)} ${S(j.part, 9)} ${S(j.name.slice(0, 8), 8)} ${S(j.user.slice(0, 8), 8)} ${S(j.st, 2)} ${S(j.time, 10)} ${S(1, 6)} ${j.st === 'R' ? j.node : '(' + j.reason + ')'}`).join('');
}
function showNode(w, id) {
  const n = w.slurm.nodes[id], b = busyNodes(w).has(id);
  let st = n.down ? 'DOWN' : b ? 'ALLOCATED' : 'IDLE'; if (n.drain) st += '+DRAIN'; if (n.notResp) st += '+NOT_RESPONDING';
  const parts = Object.entries(w.slurm.parts).filter(([, p]) => p.nodes.includes(id)).map(([k]) => k).join(',');
  return `NodeName=${id} Arch=x86_64 CoresPerSocket=56 \n   CPUAlloc=${b ? 112 : 0} CPUEfctv=112 CPUTot=112 CPULoad=${n.notResp ? 'N/A' : '0.41'}\n   AvailableFeatures=(null)\n   ActiveFeatures=(null)\n   Gres=gpu:h100:${n.gresFound}(S:0-1)\n   NodeAddr=${id} NodeHostName=${id} Version=24.05.4\n   OS=Linux 5.15.0-1063-nvidia #64-Ubuntu SMP \n   RealMemory=2063937 AllocMem=0 FreeMem=${n.notResp ? 'N/A' : '1991200'} Sockets=2 Boards=1\n   State=${st} ThreadsPerCore=1 TmpDisk=0 Weight=1 Owner=N/A MCS_label=N/A\n   Partitions=${parts} \n   BootTime=2026-11-22T07:10:25 SlurmdStartTime=2026-11-25T09:02:14\n   CfgTRES=cpu=112,mem=2063937M,billing=112,gres/gpu=${n.gres}\n   AllocTRES=${b ? 'cpu=112,gres/gpu=8' : ''}\n   CurrentWatts=0 AveWatts=0\n   ` + (n.reason && (n.drain || n.down) ? `\n   Reason=${n.reason} [${n.rUser}@${n.rTime}]` : '');
}
function showJob(w, id) {
  const j = w.slurm.jobs[id]; if (!j) return 'slurm_load_jobs error: Invalid job id specified';
  return `JobId=${id} JobName=${j.name}\n   UserId=${j.user}(${1000 + j.user.length}) GroupId=${j.user}(${1000 + j.user.length}) MCS_label=N/A\n   Priority=4294901759 Nice=0 Account=research QOS=normal\n   JobState=${j.st === 'R' ? 'RUNNING' : 'PENDING'} Reason=${j.reason} Dependency=(null)\n   Requeue=1 Restarts=0 BatchFlag=1 Reboot=0 ExitCode=0:0\n   RunTime=${j.st === 'R' ? j.time.padStart(8, '0') : '00:00:00'} TimeLimit=1-00:00:00 TimeMin=N/A\n   Partition=${j.part} AllocNode:Sid=headnode:4711\n   NodeList=${j.st === 'R' ? j.node : '(null)'}\n   NumNodes=1 NumCPUs=16 NumTasks=1 CPUs/Task=16 ReqB:S:C:T=0:0:*:*\n   TRES=cpu=16,mem=128G,node=1,billing=16,gres/gpu=${j.gpus}\n   Command=/home/${j.user}/${j.name}.sh\n   WorkDir=/home/${j.user}\n   Comment=${j.comment || '(null)'}\n   StdOut=/home/${j.user}/slurm-${id}.out`;
}
function svcStatus(w, unit) {
  const host = w.host, n = w.slurm.nodes[host];
  const desc = { slurmd: 'Slurm node daemon', slurmctld: 'Slurm controller daemon', munge: 'MUNGE authentication service', kubelet: 'kubelet: The Kubernetes Node Agent' }[unit];
  if (!desc || (host === 'headnode' && (unit === 'slurmd' || unit === 'kubelet')) || (host !== 'headnode' && unit === 'slurmctld')) return { out: `Unit ${unit}.service could not be found.`, hint: unit === 'slurmd' || unit === 'kubelet' ? `${unit} runs on the compute nodes, not on the head node. ssh to the node first.` : '' };
  const st = host === 'headnode' ? 'active' : n.svc[unit];
  const log = (w.journal[`${unit}@${host}`] || [`Nov 22 07:12:00 ${host} systemd[1]: Started ${desc}.`]).slice(-5).join('\n');
  if (st === 'active') return { out: `● ${unit}.service - ${desc}\n     Loaded: loaded (/lib/systemd/system/${unit}.service; enabled; vendor preset: enabled)\n     Active: active (running) since Wed 2026-11-25 ${w.restarted?.[unit + host] || '07:12:00'}; ${w.restarted?.[unit + host] ? '0:00' : '4h 33min'} ago\n   Main PID: 3876 (${unit})\n      Tasks: 2\n     Memory: 6.4M\n        CPU: 1.204s\n     CGroup: /system.slice/${unit}.service\n             └─3876 /usr/sbin/${unit}${unit === 'slurmd' ? ' -D -s' : ''}\n\n${log}` };
  if (st === 'oom') return { out: `× ${unit}.service - ${desc}\n     Loaded: loaded (/lib/systemd/system/${unit}.service; enabled; vendor preset: enabled)\n     Active: failed (Result: oom-kill) since Wed 2026-11-25 03:16:52; 8h ago\n    Process: 2210 ExecStart=/usr/sbin/slurmd -D -s $SLURMD_OPTIONS (code=killed, signal=KILL)\n   Main PID: 2210 (code=killed, signal=KILL)\n        CPU: 41.881s\n\n${log}` };
  return { out: `○ ${unit}.service - ${desc}\n     Loaded: loaded (/lib/systemd/system/${unit}.service; enabled; vendor preset: enabled)\n     Active: inactive (dead) since Wed 2026-11-25 06:58:01; 4h 46min ago\n       Docs: https://kubernetes.io/docs/\n\n${log}` };
}
function nvsmi(w, args) {
  const bad = w.xid && w.host === 'node002';
  const ids = [0, 1, 2, 3, 4, 5, 6, 7].filter(i => !(bad && i === 2));
  const bus = i => ['18', '2A', '41', '5D', '9A', 'AB', 'BA', 'DB'][i];
  if (args.includes('-L')) return ids.map(i => `GPU ${i}: NVIDIA H100 80GB HBM3 (UUID: GPU-6b2f${i}e1c-7a3d-4c1e-9f0b-2d8e5a7c3b1${i})`).join('\n');
  const head = `Wed Nov 25 11:45:00 2026       \n+-----------------------------------------------------------------------------------------+\n| NVIDIA-SMI 550.90.07              Driver Version: 550.90.07      CUDA Version: 12.4     |\n|-----------------------------------------+------------------------+----------------------+\n| GPU  Name                 Persistence-M | Bus-Id          Disp.A | Volatile Uncorr. ECC |\n| Fan  Temp   Perf          Pwr:Usage/Cap |           Memory-Usage | GPU-Util  Compute M. |\n|=========================================+========================+======================|`;
  const rows = ids.map(i => `|   ${i}  NVIDIA H100 80GB HBM3          On  |   00000000:${bus(i)}:00.0 Off |                    0 |\n| N/A   34C    P0             71W /  700W |       0MiB /  81559MiB |      0%      Default |\n+-----------------------------------------+------------------------+----------------------+`).join('\n');
  return (bad ? 'Unable to determine the device handle for GPU2: 0000:41:00.0: Unknown Error\n' : '') + head + '\n' + rows;
}
function kernLog(w, dm) {
  const L = [[`${DAY} 07:10:31`, '[    4.112903]', 'nvidia: module license \'NVIDIA\' taints kernel.'], [`${DAY} 07:10:33`, '[    6.240117]', 'NVRM: loading NVIDIA UNIX x86_64 Kernel Module  550.90.07']];
  if (w.xid && w.host === 'node002') w.ev.push('kern-xid@node002');
  if (w.xid && w.host === 'node002') L.push([`${DAY} 09:41:07`, '[95436.507281]', 'NVRM: GPU at PCI:0000:41:00: GPU-6b2f2e1c-7a3d-4c1e-9f0b-2d8e5a7c3b12'], [`${DAY} 09:41:07`, '[95436.507290]', 'NVRM: Xid (PCI:0000:41:00): 79, pid=48211, name=python, GPU has fallen off the bus.'], [`${DAY} 09:41:07`, '[95436.507302]', 'NVRM: GPU 0000:41:00.0: GPU has fallen off the bus.']);
  return L.map(([t, d, m]) => dm ? `${d} ${m}` : `${t} ${w.host} kernel: ${m}`).join('\n');
}
function df(w) {
  const full = w.storage.full;
  return `Filesystem               Size  Used Avail Use% Mounted on\n/dev/sda2                440G   61G  357G  15% /\ntmpfs                    504G     0  504G   0% /dev/shm\n10.141.255.254:/shared   2.0T  ${full ? '2.0T' : '1.2T'}  ${full ? '   0' : '800G'} ${full ? '100%' : ' 60%'} /shared`;
}

/* ---------------- kubectl ---------------- */
function kOut(w, a, raw) {
  const k = w.k8s;
  if (!k) return 'The connection to the server localhost:8080 was refused - did you specify the right host or port?';
  const ev = e => w.ev.push(e);
  let ns = 'default', all = false, wide = false, sel = null; const rest = [];
  for (let i = 1; i < a.length; i++) {
    const x = a[i];
    if (x === '-n' || x === '--namespace') ns = a[++i]; else if (x.startsWith('--namespace=')) ns = x.split('=')[1];
    else if (x === '-A' || x === '--all-namespaces') all = true;
    else if (x === '-o' && a[i + 1] === 'wide') { wide = true; i++; } else if (x === '-owide' || x === '-o=wide') wide = true;
    else if (x === '-l' || x === '--selector') sel = a[++i];
    else rest.push(x);
  }
  const [verb, r1, r2, r3] = rest;
  const nsOk = ['default', 'kube-system', 'gpu-operator'].includes(ns);
  const pods = all ? k.pods : k.pods.filter(p => p.ns === ns);
  const ready = p => p.status === 'Running' ? '1/1' : '0/1';
  if (verb === 'get' && /^(po|pod|pods)$/.test(r1 || '')) {
    ev(all ? 'k:get-pods:all' : ns === 'default' ? 'k:get-pods' : 'k:get-pods:' + ns); if (all) ev('k:get-pods');
    let list = r2 ? pods.filter(p => p.name === r2) : pods;
    if (r2 && !list.length) return `Error from server (NotFound): pods "${r2}" not found`;
    if (!list.length) return nsOk ? `No resources found in ${ns} namespace.` : `No resources found in ${ns} namespace.`;
    const head = [...(all ? ['NAMESPACE'] : []), 'NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', ...(wide ? ['IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES'] : [])];
    return table(head, list.map(p => [...(all ? [p.ns] : []), p.name, ready(p), p.status, p.restarts ? `${p.restarts} (${p.restarts * 13}s ago)` : '0', p.age, ...(wide ? [p.ip || '<none>', p.node || '<none>', '<none>', '<none>'] : [])]));
  }
  if (verb === 'get' && /^(no|node|nodes)$/.test(r1 || '')) {
    ev('k:get-nodes');
    return table(['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION', ...(wide ? ['INTERNAL-IP'] : [])], Object.entries(k.nodes).map(([id, n]) => [id, n.ready ? 'Ready' : 'NotReady', n.role, '12d', 'v1.30.4', ...(wide ? [n.ip] : [])]));
  }
  if (verb === 'get' && /^(deploy|deployment|deployments)$/.test(r1 || '')) {
    const d = ns === 'default' ? Object.entries(k.deploys) : [];
    if (!d.length) return `No resources found in ${ns} namespace.`;
    return table(['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'], d.map(([n]) => { const ok = podsOk(w, n); return [n, ok ? '1/1' : '0/1', '1', ok ? '1' : '0', '14m']; }));
  }
  if (verb === 'get' && /^(ds|daemonset|daemonsets)$/.test(r1 || '')) {
    if (ns !== 'gpu-operator') return `No resources found in ${ns} namespace.`;
    const r = k.nodes.node002.plugin ? 1 : 0;
    return table(['NAME', 'DESIRED', 'CURRENT', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'NODE SELECTOR', 'AGE'], [['nvidia-device-plugin-daemonset', 1, 1, r, 1, r, 'nvidia.com/gpu.deploy.device-plugin=true', '12d'], ['nvidia-driver-daemonset', 1, 1, 1, 1, 1, 'nvidia.com/gpu.deploy.driver=true', '12d']]);
  }
  if (verb === 'get' && /^(ns|namespace|namespaces)$/.test(r1 || '')) return table(['NAME', 'STATUS', 'AGE'], [['default', 'Active', '12d'], ['gpu-operator', 'Active', '12d'], ['kube-system', 'Active', '12d']]);
  if (verb === 'describe' && /^(po|pod|pods)$/.test(r1 || '')) {
    const list = r2 ? pods.filter(p => p.name === r2).concat(pods.filter(p => p.name !== r2 && p.name.startsWith(r2))) : pods;
    if (!list.length) return `Error from server (NotFound): pods "${r2 || ''}" not found`;
    list.forEach(p => ev('k:describe-pod:' + p.name));
    return list.map(p => describePod(w, p)).join('\n\n\n');
  }
  if (verb === 'describe' && /^(no|node|nodes)$/.test(r1 || '')) {
    const ids = r2 ? [r2] : Object.keys(k.nodes);
    if (r2 && !k.nodes[r2]) return `Error from server (NotFound): nodes "${r2}" not found`;
    ids.forEach(id => ev('k:describe-node:' + id));
    return ids.map(id => describeNode(w, id)).join('\n\n');
  }
  if (verb === 'logs') {
    let target = r1, p = null;
    if (sel) { p = pods.find(x => sel.includes('=') && x.name.startsWith(sel.split('=')[1])); }
    else if (target && /^(deploy|deployment|ds|daemonset)\//.test(target)) { const n = target.split('/')[1]; p = pods.find(x => x.name.startsWith(n)); if (!p) return `error: ${/^d(eploy|eployment)/.test(target) ? 'deployments.apps' : 'daemonsets.apps'} "${n}" not found`; }
    else p = pods.find(x => x.name === target);
    if (!p) return target ? `error: error from server (NotFound): pods "${target}" not found in namespace "${ns}"` : 'error: expected \'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]\'.\nPOD or TYPE/NAME is a required argument for the logs command';
    ev('k:logs:' + p.name);
    if (p.status === 'Pending' || p.status === 'ImagePullBackOff') return `Error from server (BadRequest): container "${p.name.split('-')[0]}" in pod "${p.name}" is waiting to start: ${p.status === 'Pending' ? 'ContainerCreating' : 'trying and failing to pull image'}`;
    if (p.owner === 'ds') return p.status === 'Running' ? 'I1125 11:45:02.118320       1 main.go:317] Retrieving plugins.\nI1125 11:45:02.209611       1 server.go:216] Starting GRPC server for \'nvidia.com/gpu\'\nI1125 11:45:02.211730       1 server.go:154] Registered device plugin for \'nvidia.com/gpu\' with Kubelet' : 'I1125 09:12:44.510226       1 main.go:317] Retrieving plugins.\nE1125 09:12:44.511902       1 factory.go:68] Failed to initialize NVML: could not load NVML library.\nE1125 09:12:44.511934       1 factory.go:69] If this is a GPU node, did you set the docker default runtime to `nvidia`?\nE1125 09:12:44.512010       1 main.go:173] error starting plugins: error creating plugin manager: unable to create plugin manager: nvml init failed: ERROR_LIBRARY_NOT_FOUND';
    if (p.status === 'CrashLoopBackOff') return 'I1125 11:44:51.003 Loading inference server configuration\nE1125 11:44:51.004 MODEL_PATH is not set; set the MODEL_PATH environment variable to the model repository directory\nerror: creating server: Invalid argument - --model-repository must be specified';
    return 'I1125 11:45:03.311 Started GRPCInferenceService at 0.0.0.0:8001\nI1125 11:45:03.312 Started HTTPService at 0.0.0.0:8000\nI1125 11:45:03.354 Started Metrics Service at 0.0.0.0:8002';
  }
  if (verb === 'set' && r1 === 'image') {
    const m = (r2 || '').match(/^(deploy|deployment|deployments)\/(\S+)$/); const kv = rest[3] || '';
    if (!m) return 'error: you must specify resources by --filename when --local is set.\nUsage: kubectl set image deployment/NAME CONTAINER=IMAGE';
    const d = k.deploys[m[2]]; if (!d || ns !== 'default') return `Error from server (NotFound): deployments.apps "${m[2]}" not found`;
    const [c, img] = kv.split('='); if (!img) return 'error: at least one image update is required';
    if (c !== m[2]) return `error: unable to find container named "${c}"`;
    if (img === d.image) return `deployment.apps/${m[2]} image updated`;
    d.prev = d.image; d.image = img; d.rev++; rollout(w, m[2], d); reconcile(w); ev('k:set-image');
    return `deployment.apps/${m[2]} image updated`;
  }
  if (verb === 'set' && r1 === 'env') {
    const m = (r2 || '').match(/^(deploy|deployment|deployments)\/(\S+)$/); if (!m) return 'error: Usage: kubectl set env deployment/NAME KEY=VALUE';
    const d = k.deploys[m[2]]; if (!d || ns !== 'default') return `Error from server (NotFound): deployments.apps "${m[2]}" not found`;
    const pairs = rest.slice(3).filter(x => x.includes('=')); if (!pairs.length) return 'error: at least one environment variable must be provided';
    pairs.forEach(x => { const [kk, v] = x.split('='); d.env[kk] = v; });
    d.rev++; rollout(w, m[2], d); reconcile(w); ev('k:set-env');
    return `deployment.apps/${m[2]} env updated`;
  }
  if (verb === 'rollout') {
    const m = (r2 || '').match(/^(deploy|deployment|deployments|ds|daemonset|daemonsets)\/(\S+)$/);
    if (!m) return 'error: required resource not specified';
    const isDs = /^d(s|aemonset)/.test(m[1]);
    if (isDs) {
      if (ns !== 'gpu-operator' || !m[2].startsWith('nvidia-')) return `Error from server (NotFound): daemonsets.apps "${m[2]}" not found`;
      if (r1 === 'restart') { if (m[2] === 'nvidia-device-plugin-daemonset') { restartPlugin(w); ev('k:restart-plugin'); } return `daemonset.apps/${m[2]} restarted`; }
      if (r1 === 'status') return `daemon set "${m[2]}" successfully rolled out`;
    }
    const d = k.deploys[m[2]]; if (!d || ns !== 'default') return `Error from server (NotFound): deployments.apps "${m[2]}" not found`;
    if (r1 === 'status') { ev('k:rollout-status'); return podsOk(w, m[2]) ? `deployment "${m[2]}" successfully rolled out` : `Waiting for deployment "${m[2]}" rollout to finish: 0 of 1 updated replicas are available...\nerror: timed out waiting for the condition`; }
    if (r1 === 'restart') { d.rev++; rollout(w, m[2], d); reconcile(w); return `deployment.apps/${m[2]} restarted`; }
    if (r1 === 'undo') { if (!d.prev) return `error: no rollout history found for deployment "${m[2]}"`; [d.image, d.prev] = [d.prev, d.image]; d.rev++; rollout(w, m[2], d); reconcile(w); ev('k:undo'); return `deployment.apps/${m[2]} rolled back`; }
    if (r1 === 'history') return `deployment.apps/${m[2]}\nREVISION  CHANGE-CAUSE\n${d.prev ? '1         <none>\n' : ''}${d.prev ? 2 : 1}         <none>`;
  }
  if (verb === 'taint') {
    if (!/^(no|node|nodes)$/.test(r1 || '')) return 'error: at least one taint update is required';
    const n = k.nodes[r2]; if (!n) return `Error from server (NotFound): nodes "${r2}" not found`;
    const spec = rest[3]; if (!spec) return 'error: at least one taint update is required';
    if (spec.endsWith('-')) {
      const s = spec.slice(0, -1), key = s.split(/[=:]/)[0], eff = s.includes(':') ? s.split(':')[1] : null;
      const before = n.taints.length; n.taints = n.taints.filter(t => !(t.key === key && (!eff || t.effect === eff)));
      if (n.taints.length === before) return `error: taint "${s}" not found`;
      reconcile(w); ev('k:untaint'); return `node/${r2} untainted`;
    }
    const m = spec.match(/^([^=:]+)(?:=([^:]*))?:(NoSchedule|PreferNoSchedule|NoExecute)$/); if (!m) return `error: invalid taint spec: ${spec}`;
    n.taints.push({ key: m[1], value: m[2] || '', effect: m[3] }); reconcile(w); return `node/${r2} tainted`;
  }
  if (verb === 'delete' && /^(po|pod|pods)$/.test(r1 || '')) {
    const p = pods.find(x => x.name === r2); if (!p) return `Error from server (NotFound): pods "${r2}" not found`;
    if (p.owner === 'ds' && p.name.startsWith('nvidia-device-plugin')) { restartPlugin(w); ev('k:restart-plugin'); return `pod "${r2}" deleted`; }
    if (p.owner && p.owner.startsWith('deploy:')) { const n = p.owner.slice(7); rollout(w, n, k.deploys[n]); reconcile(w); return `pod "${r2}" deleted`; }
    k.pods = k.pods.filter(x => x !== p); return `pod "${r2}" deleted`;
  }
  if (verb === 'cluster-info') return 'Kubernetes control plane is running at https://10.141.255.254:6443\nCoreDNS is running at https://10.141.255.254:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy';
  if (verb === 'version') return 'Client Version: v1.30.4\nKustomize Version: v5.0.4-0.20230601165947-6ce0bf390ce3\nServer Version: v1.30.4';
  if (!verb) return 'kubectl controls the Kubernetes cluster manager.\n\nUsage:\n  kubectl [flags] [options]';
  return `error: the server doesn't have a resource type "${r1 || verb}"`;
}
function restartPlugin(w) {
  const k = w.k8s; k.nodes.node002.plugin = true;
  const p = k.pods.find(x => x.owner === 'ds'); if (p) { p.name = 'nvidia-device-plugin-daemonset-x7k2p'; p.age = '4s'; p.restarts = 0; }
  reconcile(w);
}
function describePod(w, p) {
  const k = w.k8s, waiting = p.status !== 'Running', c = p.name.split('-')[0];
  let evs;
  if (p.status === 'Pending') evs = [['Warning', 'FailedScheduling', '2m (x4 over 14m)', 'default-scheduler', failReasons(w, p)]];
  else if (p.status === 'ImagePullBackOff') evs = [['Normal', 'Scheduled', '14m', 'default-scheduler', `Successfully assigned default/${p.name} to ${p.node}`], ['Normal', 'Pulling', '13m (x4 over 14m)', 'kubelet', `Pulling image "${p.image}"`], ['Warning', 'Failed', '13m (x4 over 14m)', 'kubelet', `Failed to pull image "${p.image}": rpc error: code = NotFound desc = failed to pull and unpack image "${p.image}": failed to resolve reference "${p.image}": ${p.image}: not found`], ['Warning', 'Failed', '13m (x4 over 14m)', 'kubelet', 'Error: ErrImagePull'], ['Normal', 'BackOff', '4m (x41 over 14m)', 'kubelet', `Back-off pulling image "${p.image}"`], ['Warning', 'Failed', '4m (x41 over 14m)', 'kubelet', 'Error: ImagePullBackOff']];
  else if (p.status === 'CrashLoopBackOff') evs = [['Normal', 'Scheduled', '14m', 'default-scheduler', `Successfully assigned ${p.ns}/${p.name} to ${p.node}`], ['Normal', 'Pulled', '3m (x6 over 14m)', 'kubelet', `Container image "${p.image}" already present on machine`], ['Normal', 'Started', '3m (x6 over 14m)', 'kubelet', `Started container ${c}`], ['Warning', 'BackOff', '30s (x52 over 14m)', 'kubelet', `Back-off restarting failed container ${c} in pod ${p.name}_${p.ns}`]];
  else evs = [['Normal', 'Scheduled', p.age, 'default-scheduler', `Successfully assigned ${p.ns}/${p.name} to ${p.node}`], ['Normal', 'Pulled', p.age, 'kubelet', `Container image "${p.image}" already present on machine`], ['Normal', 'Created', p.age, 'kubelet', `Created container ${c}`], ['Normal', 'Started', p.age, 'kubelet', `Started container ${c}`]];
  const state = p.status === 'Running' ? `Running\n      Started:      Wed, 25 Nov 2026 11:44:57 -0600` : p.status === 'CrashLoopBackOff' ? `Waiting\n      Reason:       CrashLoopBackOff\n    Last State:     Terminated\n      Reason:       Error\n      Exit Code:    1` : `Waiting\n      Reason:       ${p.status === 'Pending' ? 'ContainerCreating' : 'ImagePullBackOff'}`;
  const d = p.owner && p.owner.startsWith('deploy:') ? k.deploys[p.owner.slice(7)] : null;
  const env = d && Object.keys(d.env).length ? '\n' + Object.entries(d.env).map(([a, b]) => `      ${a}:  ${b}`).join('\n') : '    <none>';
  return `Name:             ${p.name}\nNamespace:        ${p.ns}\nPriority:         0\nService Account:  default\nNode:             ${p.node ? p.node + '/' + k.nodes[p.node].ip : '<none>'}\nLabels:           app=${c}\nStatus:           ${p.status === 'Running' || p.status === 'CrashLoopBackOff' ? 'Running' : 'Pending'}\nIP:               ${p.ip || ''}\n${d ? `Controlled By:    ReplicaSet/${p.name.split('-').slice(0, 2).join('-')}\n` : ''}Containers:\n  ${c}:\n    Image:          ${p.image}\n    State:          ${state}\n    Ready:          ${waiting ? 'False' : 'True'}\n    Restart Count:  ${p.restarts}\n${p.gpu ? `    Limits:\n      nvidia.com/gpu:  ${p.gpu}\n` : ''}    Environment:${env}\nEvents:\n` + table(['  Type', 'Reason', 'Age', 'From', 'Message'], [['  ----', '------', '----', '----', '-------'], ...evs.map(e => ['  ' + e[0], ...e.slice(1)])]);
}
function describeNode(w, id) {
  const n = w.k8s.nodes[id], alloc = n.gpu && n.plugin ? n.gpu : 0;
  const t = untolerated(n), taints = t.length ? t.map(x => `${x.key}${x.value ? '=' + x.value : ''}:${x.effect}`).join('\n                    ') : '<none>';
  const cond = n.ready ? [['MemoryPressure', 'False', 'KubeletHasSufficientMemory', 'kubelet has sufficient memory available'], ['DiskPressure', 'False', 'KubeletHasNoDiskPressure', 'kubelet has no disk pressure'], ['PIDPressure', 'False', 'KubeletHasSufficientPID', 'kubelet has sufficient PID available'], ['Ready', 'True', 'KubeletReady', 'kubelet is posting ready status']]
    : [['MemoryPressure', 'Unknown', 'NodeStatusUnknown', 'Kubelet stopped posting node status.'], ['DiskPressure', 'Unknown', 'NodeStatusUnknown', 'Kubelet stopped posting node status.'], ['PIDPressure', 'Unknown', 'NodeStatusUnknown', 'Kubelet stopped posting node status.'], ['Ready', 'Unknown', 'NodeStatusUnknown', 'Kubelet stopped posting node status.']];
  return `Name:               ${id}\nRoles:              ${n.role}\nLabels:             kubernetes.io/hostname=${id}${n.gpu ? '\n                    nvidia.com/gpu.present=true' : ''}\nTaints:             ${taints}\nUnschedulable:      false\nConditions:\n` + table(['  Type', 'Status', 'Reason', 'Message'], [['  ----', '------', '------', '-------'], ...cond.map(c => ['  ' + c[0], ...c.slice(1)])]) + `\nAddresses:\n  InternalIP:  ${n.ip}\n  Hostname:    ${id}\nCapacity:\n  cpu:                112\n  memory:             2113471488Ki${n.gpu ? `\n  nvidia.com/gpu:     ${alloc}` : ''}\nAllocatable:\n  cpu:                112\n  memory:             2113369088Ki${n.gpu ? `\n  nvidia.com/gpu:     ${alloc}` : ''}\nSystem Info:\n  Kubelet Version:            v1.30.4\n  Container Runtime Version:  containerd://1.7.20`;
}

/* ---------------- cmsh ---------------- */
const PROP = { category: 'cat', softwareimage: 'img', mac: 'mac', ip: 'ip' };
function cmPrompt(w) {
  const c = w.cm, dirty = Object.keys(c.pending).length > 0, selDirty = c.sel && c.pending[c.sel];
  return `[headnode${c.mode ? '->' + c.mode + (dirty ? '*' : '') : ''}${c.sel ? '[' + c.sel + (selDirty ? '*' : '') + ']' : ''}]% `;
}
function cmRun(w, line) {
  const out = [];
  for (const part of splitTop(line, /^;/)) { if (!part) continue; const r = cmOne(w, part); if (r) out.push(r); if (!w.cm) break; }
  return out.join('\n');
}
function cmOne(w, line) {
  const c = w.cm, a = words(line), cmd = a[0], ev = e => w.ev.push(e), B = w.bcm;
  if (cmd === 'quit' || (cmd === 'exit' && !c.mode)) { const lost = Object.keys(c.pending).length; w.cm = null; if (lost) w.hints.push('You left cmsh with uncommitted changes, so they were discarded. Always run commit before you leave a mode.'); return ''; }
  if (cmd === 'exit' || cmd === '..') { if (c.sel) { c.sel = null; } else c.mode = ''; return ''; }
  if (cmd === 'home' || cmd === '/') { c.mode = ''; c.sel = null; return ''; }
  if (['device', 'category', 'softwareimage'].includes(cmd) && a.length === 1) { if (c.mode !== cmd) c.sel = null; c.mode = cmd; ev('cm:mode:' + cmd); return ''; }
  if (!c.mode) return cmd === 'help' ? 'Top level modes: device, category, softwareimage, partition, network ... (type a mode name to enter it)' : `Unknown command: ${cmd}`;
  if (c.mode === 'softwareimage') {
    if (cmd === 'list') { ev('cm:list'); return 'Name (key)       Path                     Kernel version\n---------------- ------------------------ ----------------------\n' + B.images.map(i => `${E(i, 16)} ${E('/cm/images/' + i, 24)} 5.15.0-1063-nvidia`).join('\n'); }
    return `Unknown command: ${cmd}`;
  }
  if (c.mode === 'category') {
    if (cmd === 'list') { ev('cm:list'); return 'Name (key) Software image Nodes\n---------- -------------- -----\n' + Object.entries(B.cats).map(([n, x]) => `${E(n, 10)} ${E(x.img, 14)} ${Object.values(B.devices).filter(d => d.cat === n).length}`).join('\n'); }
    if (cmd === 'use') { if (!B.cats[a[1]]) return `Unable to find object ${a[1]}`; c.sel = a[1]; return ''; }
    if (cmd === 'get' && c.sel) return a[1] === 'softwareimage' ? B.cats[c.sel].img : '';
    return c.sel ? `Unknown command: ${cmd}` : `Unknown command: ${cmd}`;
  }
  // device mode
  const target = () => { const i = a.indexOf('-n'); return i >= 0 ? a[i + 1] : c.sel; };
  if (cmd === 'list') { ev('cm:list'); return 'Type         Hostname (key) MAC               Category  IP             Network     Status\n------------ -------------- ----------------- --------- -------------- ----------- ----------\n' + Object.entries(B.devices).map(([n, d]) => `${E(d.type, 12)} ${E(n, 14)} ${E(d.mac, 17)} ${E(d.cat, 9)} ${E(d.ip, 14)} ${E('internalnet', 11)} ${d.power === 'on' ? '[   UP   ]' : '[  DOWN  ]'}`).join('\n'); }
  if (cmd === 'status' || cmd === 'ds') { const t = a.indexOf('-n') >= 0 ? a[a.indexOf('-n') + 1] : null; if (t && !B.devices[t]) return `Unable to find device ${t}`; const list = t ? [t] : Object.keys(B.devices); list.forEach(x => ev('cm:status:' + x)); ev('cm:status'); return list.map(n => `${E(n, 16)} ${B.devices[n].power === 'on' ? '[   UP   ]' : '[  DOWN  ]'}`).join('\n'); }
  if (cmd === 'use') { const n = a[1]; if (!B.devices[n]) return `Unable to find object ${n || ''}`; c.sel = n; ev('cm:use:' + n); return ''; }
  if (cmd === 'add') {
    if (a[1] !== 'physicalnode' || !a[2]) return 'Usage: add physicalnode <hostname> [ip]';
    if (B.devices[a[2]] || c.pending[a[2]]) return `Object ${a[2]} already exists`;
    c.sel = a[2]; c.pending[a[2]] = { isNew: true, type: 'PhysicalNode', mac: '00:00:00:00:00:00', cat: 'default', ip: a[3] || '', img: '', power: 'off' }; ev('cm:add:' + a[2]); return '';
  }
  if (cmd === 'power') {
    const sub = a[1], t = target(); if (!['on', 'off', 'status', 'reset'].includes(sub)) return 'Usage: power on|off|reset|status [-n node]';
    if (!t) return 'No device selected; use -n <node>';
    const d = B.devices[t]; if (!d) return c.pending[t]?.isNew ? `Device ${t} has not been committed yet` : `Unable to find device ${t}`;
    if (sub === 'on' || sub === 'reset') { d.power = 'on'; ev('cm:power-on:' + t); }
    if (sub === 'off') d.power = 'off';
    return `ipmi0 .................... [ ${sub === 'status' ? (d.power === 'on' ? '  ON   ' : '  OFF  ') : sub === 'off' ? '  OFF  ' : '  ON   '} ] ${t}`;
  }
  if (cmd === 'imageupdate') {
    const t = target(); if (!t || !B.devices[t]) return 'No device selected; use -n <node>';
    const img = effImg(w, t); B.updated[t] = img; ev('cm:imageupdate:' + t);
    return `Wed Nov 25 11:45:00 CST 2026 [notice] headnode: Provisioning started: sending headnode:/cm/images/${img} to ${t}:/, mode UPDATE, dry run = no` + (a.includes('-w') ? `\nWed Nov 25 11:45:00 CST 2026 [notice] headnode: Provisioning completed: sent headnode:/cm/images/${img} to ${t}:/, mode UPDATE, dry run = no` : '');
  }
  if (cmd === 'commit') {
    ev('cm:commit'); const names = c.sel ? (c.pending[c.sel] ? [c.sel] : []) : Object.keys(c.pending), out = [];
    for (const n of names) {
      const ch = c.pending[n]; delete c.pending[n];
      if (ch.isNew) { const d = Object.assign({}, ch); delete d.isNew; B.devices[n] = d; out.push(`Wed Nov 25 11:45:00 CST 2026 [notice] headnode: Check node ${n}: PhysicalNode added`); w.hints.push(`Saved, but the server is still powered off. Power it on through BCM: power on -n ${n} (or just power on while it is selected).`); }
      else Object.assign(B.devices[n], ch);
    }
    return out.join('\n');
  }
  if (!c.sel && ['get', 'set', 'clear', 'show'].includes(cmd)) return 'No object selected; run use <node> first';
  const cur = () => Object.assign({}, B.devices[c.sel] || {}, c.pending[c.sel] || {});
  if (cmd === 'show') { ev('cm:show'); const d = cur(); return `Parameter                        Value\n-------------------------------- ------------------------------------------------\nHostname                         ${c.sel}\nType                             ${d.type}\nCategory                         ${d.cat}\nSoftware image                   ${d.img || `(${d.cat}->${B.cats[d.cat]?.img || ''})`}\nMAC                              ${d.mac}\nIP                               ${d.ip}\nNetwork                          internalnet\nStatus                           ${d.power === 'on' ? 'UP' : 'DOWN'}`; }
  if (cmd === 'get') { const p = PROP[a[1]]; if (!p) return `Unknown property: ${a[1] || ''}`; ev('cm:get:' + a[1]); const d = cur(); return p === 'img' ? (d.img || `(${d.cat}->${B.cats[d.cat]?.img})`) : d[p]; }
  if (cmd === 'set') {
    const p = PROP[a[1]]; if (!p) return `Unknown property: ${a[1] || ''}`; const v = a[2]; if (!v) return `Missing value for ${a[1]}`;
    if (p === 'cat' && !B.cats[v]) return `Unable to find category ${v}`;
    if (p === 'img' && !B.images.includes(v)) return `Unable to find software image ${v}`;
    (c.pending[c.sel] = c.pending[c.sel] || {})[p] = v; ev('cm:set:' + a[1]); return '';
  }
  if (cmd === 'clear') { const p = PROP[a[1]]; if (p !== 'img') return `Unable to clear ${a[1] || ''}`; (c.pending[c.sel] = c.pending[c.sel] || {}).img = ''; ev('cm:clear:' + a[1]); return ''; }
  return `Unknown command: ${cmd}`;
}

/* ---------------- shell ---------------- */
const NOTFOUND = c => `${c}: command not found`;
function filter(text, cmdline) {
  const a = words(cmdline), c = a[0], args = a.slice(1);
  if (c === 'grep') { const flags = args.filter(x => x.startsWith('-')).join(''), pat = args.find(x => !x.startsWith('-')) || ''; const re = new RegExp(pat.replace(/[.*+?^${}()[\]\\]/g, m => m === '.' || m === '*' ? m : '\\' + m), flags.includes('i') ? 'i' : ''); return text.split('\n').filter(l => flags.includes('v') ? !re.test(l) : re.test(l)).join('\n'); }
  if (c === 'head' || c === 'tail') { const n = +(args.find(x => /^-?\d+$/.test(x.replace('-n', ''))) || '10').replace(/^-n?/, '') || 10; const L = text.split('\n'); return (c === 'head' ? L.slice(0, n) : L.slice(-n)).join('\n'); }
  if (c === 'wc' && args.includes('-l')) return String(text ? text.split('\n').length : 0);
  if (c === 'less' || c === 'more' || c === 'cat' || c === 'sort') return text;
  return null;
}
function fileKey(w, p) { if (p.startsWith('/shared')) return '*:' + p; return w.host + ':' + p; }
function run(w, line) {
  w.ev = []; w.hints = [];
  let out;
  if (w.cm) out = cmRun(w, line);
  else out = splitTop(line, /^(;|&&)/).map(seg => seg ? pipeline(w, seg) : '').filter(x => x !== '').join('\n');
  schedule(w); if (w.k8s) reconcile(w);
  return out;
}
function pipeline(w, seg) {
  const parts = splitTop(seg, /^\|/);
  let m = parts[0].match(/^(.*?)\s*(>>|>)\s*(\S+)\s*$/), redirect = null;
  if (m && parts.length === 1) { redirect = { mode: m[2], path: m[3] }; parts[0] = m[1]; }
  let text = simple(w, parts[0]);
  for (const f of parts.slice(1)) { const r = filter(text, f); text = r === null ? `${words(f)[0]}: command not found` : r; }
  if (/xid/i.test(text) && w.ev.includes('kern-xid@node002')) w.ev.push('xidlog@node002');
  if (redirect) { const k = fileKey(w, redirect.path); w.files[k] = (redirect.mode === '>>' ? (w.files[k] || '') : '') + text + '\n'; w.ev.push('write:' + redirect.path + '@' + w.host); afterWrite(w, redirect.path); return ''; }
  return text;
}
function afterWrite(w, path) { if (path === '/etc/slurm/gres.conf') { /* takes effect after slurmd restart */ } }
function simple(w, line) {
  let a = words(line); if (!a.length) return '';
  while (a[0] === 'sudo') { a = a.slice(1); if (a[0] === '-i' || a[0] === 'su') return ''; }
  const c = a[0], args = a.slice(1), ev = e => w.ev.push(e), host = w.host, onNode = host !== 'headnode';
  if (c === 'clear') return '';
  if (c === 'hostname') return host;
  if (c === 'whoami') return 'root';
  if (c === 'pwd') return '/root';
  if (c === 'ssh') {
    const t = args.find(x => !x.startsWith('-'));
    if (!t) return 'usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] destination [command [argument ...]]';
    const h = t.replace(/^root@/, '');
    if (h !== 'headnode' && !w.slurm.nodes[h]) return `ssh: Could not resolve hostname ${h}: Name or service not known`;
    const rest = args.slice(args.indexOf(t) + 1);
    if (rest.length) { const prev = w.host; w.host = h; ev('remote@' + h); const r = run1(w, rest.join(' ')); w.host = prev; return r; }
    w.prevHost = host; w.host = h; ev('ssh:' + h);
    return `Welcome to Ubuntu 22.04.4 LTS (GNU/Linux 5.15.0-1063-nvidia x86_64)\n\nLast login: Mon Nov 23 11:45:00 CST 2026 from 10.141.255.254`;
  }
  if (c === 'exit' || c === 'logout') {
    if (!onNode) return 'This is your login session on the head node (exit is not simulated here).';
    ev('exit:' + host); w.host = 'headnode'; return `logout\nConnection to ${host} closed.`;
  }
  if (c === 'module') {
    if (args[0] === 'load' && /^kubernetes(\/.*)?$/.test(args[1] || '')) { if (!w.modules.includes('kubernetes')) w.modules.push('kubernetes'); ev('module:kubernetes'); return ''; }
    if (args[0] === 'list') return w.modules.length ? 'Currently Loaded Modulefiles:\n 1) ' + w.modules.join('  2) ') : 'No Modulefiles Currently Loaded.';
    if (args[0] === 'avail') return '------------------ /cm/shared/modulefiles ------------------\ncmd  cuda12.4/toolkit/12.4.1  kubernetes/default/1.30.4  slurm/slurm/24.05.4';
    if (args[0] === 'load') return `ERROR: Unable to locate a modulefile for '${args[1] || ''}'`;
    return 'Usage: module [options] sub-command [args ...]';
  }
  if (c === 'kubectl') {
    if (onNode || !w.modules.includes('kubernetes')) { if (!onNode) w.hints.push('kubectl is not on the PATH until you load the environment module: module load kubernetes'); else w.hints.push('kubectl is set up on the head node. exit back to it first.'); return NOTFOUND('kubectl'); }
    return kOut(w, a, line);
  }
  if (c === 'cmsh') {
    if (onNode) return NOTFOUND('cmsh');
    const ci = args.indexOf('-c');
    w.cm = { mode: '', sel: null, pending: {} }; ev('cm:enter');
    if (ci >= 0) { const r = cmRun(w, args[ci + 1] || ''); if (w.cm && Object.keys(w.cm.pending).length) w.hints.push('These changes were not saved: add ; commit at the end of the cmsh -c command.'); w.cm = null; return r; }
    return '';
  }
  // Slurm client commands work on every host
  if (c === 'sinfo') { ev(args.includes('-R') || args.includes('--list-reasons') ? 'sinfo-R' : 'sinfo'); return sinfo(w, args); }
  if (c === 'squeue') { ev('squeue'); return squeue(w, args); }
  if (c === 'scontrol') return scontrol(w, args);
  if (c === 'scancel') {
    const id = args.find(x => /^\d+$/.test(x)); if (!id) return 'scancel: error: No job identification provided';
    if (!w.slurm.jobs[id]) return `scancel: error: Kill job error on job id ${id}: Invalid job id specified`;
    delete w.slurm.jobs[id]; ev('scancel:' + id); return '';
  }
  if (c === 'sacct') return '       JobID    JobName  Partition    Account  AllocCPUS      State ExitCode \n------------ ---------- ---------- ---------- ---------- ---------- -------- \n' + Object.entries(w.slurm.jobs).map(([id, j]) => `${S(id, 12)} ${S(j.name, 10)} ${S(j.part, 10)} ${S('research', 10)} ${S(16, 10)} ${S(j.st === 'R' ? 'RUNNING' : 'PENDING', 10)} ${S('0:0', 8)} `).join('\n');
  if (c === 'systemctl') {
    const sub = args[0], unit = (args.find((x, i) => i > 0 && !x.startsWith('-')) || '').replace(/\.service$/, '');
    if (!unit) return sub ? `Too few arguments.` : '';
    if (sub === 'status') { const r = svcStatus(w, unit); if (r.hint) w.hints.push(r.hint); if (!/could not be found/.test(r.out)) ev(`status:${unit}@${host}`); return r.out; }
    if (['start', 'restart', 'enable', 'stop'].includes(sub)) {
      const known = { slurmd: onNode, kubelet: onNode, munge: true, slurmctld: !onNode }[unit];
      if (!known) { if (unit === 'slurmd' || unit === 'kubelet') w.hints.push(`${unit} runs on the compute nodes, not on the head node. ssh to the node first.`); return `Failed to ${sub} ${unit}.service: Unit ${unit}.service not found.`; }
      if (!onNode) return '';
      const n = w.slurm.nodes[host];
      if (sub === 'enable' && !args.includes('--now')) return '';
      if (sub === 'stop') { n.svc[unit] = 'inactive'; return ''; }
      n.svc[unit] = 'active'; w.restarted = w.restarted || {}; w.restarted[unit + host] = '11:45:00'; ev(`restart:${unit}@${host}`);
      const jl = w.journal[`${unit}@${host}`] = w.journal[`${unit}@${host}`] || [];
      jl.push(`${DAY} 11:45:00 ${host} systemd[1]: Started ${unit === 'slurmd' ? 'Slurm node daemon' : unit === 'kubelet' ? 'kubelet: The Kubernetes Node Agent' : unit}.`);
      if (unit === 'slurmd') {
        const g = gresIn(w.files[host + ':/etc/slurm/gres.conf']) || n.gres; n.gresFound = w.files[host + ':/etc/slurm/gres.conf'] ? g : n.gresFound;
        jl.push(`${DAY} 11:45:00 ${host} slurmd[3876]: slurmd: Gres Name=gpu Type=h100 Count=${n.gresFound}`);
        if (n.notResp) { n.notResp = false; }
        if (n.gresFound < n.gres) w.hints.push(`slurmd still finds only ${n.gresFound} GPU(s) in /etc/slurm/gres.conf. Fix the file, then restart slurmd again.`);
        else if (n.down || n.drain) w.hints.push(`slurmd is running, but node ${host} stays ${n.down ? 'DOWN' : 'drained'} until you resume it: exit to the head node and run scontrol update nodename=${host} state=resume.`);
      }
      return '';
    }
    return `Unknown command verb ${sub}.`;
  }
  if (c === 'journalctl') {
    const u = args.indexOf('-u'), unit = u >= 0 ? (args[u + 1] || '').replace(/\.service$/, '') : null;
    if (args.includes('-k') || args.includes('--dmesg')) { ev('kern@' + host); return kernLog(w, false); }
    if (!unit) return `-- Logs begin at Sun 2026-11-22 07:10:25 CST. --\n${kernLog(w, false)}`;
    const L = w.journal[`${unit}@${host}`] || (onNode || unit === 'slurmctld' || unit === 'munge' ? [`Nov 22 07:12:00 ${host} systemd[1]: Started ${unit}.`] : null);
    if (!L) { if (unit === 'slurmd' || unit === 'kubelet') w.hints.push(`The ${unit} log is on the compute node: ssh to it first.`); return '-- No entries --'; }
    ev(`journal:${unit}@${host}`);
    const ni = args.indexOf('-n'); return (ni >= 0 ? L.slice(-(+args[ni + 1] || 10)) : L).join('\n');
  }
  if (c === 'dmesg') { ev('kern@' + host); return kernLog(w, true); }
  if (c === 'nvidia-smi') { if (!onNode) { w.hints.push('The head node has no GPUs. ssh to a GPU node (for example ssh node002) first.'); return NOTFOUND('nvidia-smi'); } ev('nvsmi@' + host); return nvsmi(w, args); }
  if (c === 'nvidia-bug-report.sh') {
    if (!onNode) return NOTFOUND('nvidia-bug-report.sh');
    if (host === 'node002') w.bug = true; ev('bugreport@' + host); w.files[host + ':/root/nvidia-bug-report.log.gz'] = '(binary)';
    return `nvidia-bug-report.sh will now collect information about your\nsystem and create the file 'nvidia-bug-report.log.gz' in the current\ndirectory.  It may take several seconds to run.\n\nRunning nvidia-bug-report.sh... complete.\n\nThe file nvidia-bug-report.log.gz has been created; please send this\nfile, along with a description of your problem, to NVIDIA support.`;
  }
  if (c === 'df') { ev('df'); return df(w); }
  if (c === 'du') {
    const t = args.filter(x => !x.startsWith('-'));
    if (t.some(x => x.startsWith('/shared'))) { ev('du'); const rows = [['1.1T', '/shared/datasets'], ...(w.storage.full ? [['800G', '/shared/old-checkpoint.tmp']] : []), ['96G', '/shared/home']]; return rows.filter(([, p]) => t.some(x => x === '/shared/*' || x === '/shared' || x === '/shared/' || p === x)).map(([s, p]) => `${s}\t${p}`).join('\n') || (t.includes('/shared') ? (w.storage.full ? '2.0T\t/shared' : '1.2T\t/shared') : ''); }
    return `4.0K\t${t[0] || '.'}`;
  }
  if (c === 'ls') {
    const t = args.filter(x => !x.startsWith('-')), long = args.some(x => /^-.*l/.test(x));
    const p = t[0] || '/root';
    if (p === '/shared' || p === '/shared/') { const items = [['drwxr-xr-x 8 root    root    4.0K Oct 02 10:11', 'datasets'], ['drwxr-xr-x 9 root    root    4.0K Sep 14 08:30', 'home'], ...(w.storage.full ? [['-rw-r--r-- 1 trainer trainer 800G Nov 03 02:14', 'old-checkpoint.tmp']] : [])]; return long ? 'total 800G\n' + items.map(i => i.join(' ')).join('\n') : items.map(i => i[1]).join('  '); }
    if (p === '/shared/old-checkpoint.tmp') { if (!w.storage.full) return `ls: cannot access '${p}': No such file or directory`; ev('ls:' + p); return long ? `-rw-r--r-- 1 trainer trainer 800G Nov 03 02:14 ${p}` : p; }
    if (p === '/etc/slurm') return onNode ? 'cgroup.conf  gres.conf  slurm.conf' : 'cgroup.conf  gres.conf  slurm.conf  slurmdbd.conf';
    if (w.files[fileKey(w, p)] !== undefined) return p;
    if (p === '/root' || p === '~' || p === '.') return Object.keys(w.files).filter(k => k.startsWith(host + ':/root/')).map(k => k.split('/').pop()).join('  ');
    return `ls: cannot access '${p}': No such file or directory`;
  }
  if (c === 'rm') {
    const t = args.filter(x => !x.startsWith('-')), rec = args.some(x => /^-.*r/i.test(x));
    if (!t.length) return 'rm: missing operand';
    for (const p of t) {
      if (p === '/shared/old-checkpoint.tmp') { if (!w.storage.full) return `rm: cannot remove '${p}': No such file or directory`; w.storage.full = false; ev('rm:' + p); continue; }
      if (/^\/shared\/?(\*|datasets.*|home.*)?$/.test(p)) return rec ? `This lab stops you here: ${p} holds production data. Remove only the file you verified.` : `rm: cannot remove '${p}': Is a directory`;
      const k = fileKey(w, p); if (w.files[k] === undefined) return `rm: cannot remove '${p}': No such file or directory`; delete w.files[k];
    }
    return '';
  }
  if (c === 'cat') {
    const p = args[0]; if (!p) return '';
    const k = fileKey(w, p);
    if (w.files[k] !== undefined) { ev('cat:' + p + '@' + host); return w.files[k].replace(/\n$/, ''); }
    if (p === '/etc/slurm/gres.conf') { ev('cat:' + p + '@' + host); return onNode ? `# Managed by the cluster team\nNodeName=${host} Name=gpu Type=h100 File=/dev/nvidia[0-7]` : 'AutoDetect=off\n# GPU nodes are configured in their local gres.conf'; }
    return `cat: ${p}: No such file or directory`;
  }
  if (c === 'echo') return args.join(' ');
  if (c === 'sed') {
    if (args[0] !== '-i' || !args[1] || !args[2]) return "Usage in this lab: sed -i 's/OLD/NEW/' FILE";
    const m = parseSed(args[1]); if (!m) return `sed: -e expression #1, char ${args[1].length}: unterminated \`s' command`;
    const k = fileKey(w, args[2]); if (w.files[k] === undefined) return `sed: can't read ${args[2]}: No such file or directory`;
    let re; try { re = new RegExp(m.pat, m.g ? 'g' : ''); } catch (e) { return 'sed: -e expression #1: Invalid regular expression'; }
    w.files[k] = w.files[k].split('\n').map(l => l.replace(re, () => m.rep)).join('\n'); ev('write:' + args[2] + '@' + host); return '';
  }
  if (c === 'vi' || c === 'vim' || c === 'nano') return `${c}: the guided fault labs have no full-screen editor. Use sed -i 's/OLD/NEW/' FILE or echo "..." > FILE. (The 3 Reported Labs have vi and nano.)`;
  if (c === 'munge' || c === 'unmunge') return 'STATUS:          Success (0)';
  if (c === 'ip' || c === 'ping') return c === 'ping' ? `PING ${args[args.length - 1]} 56(84) bytes of data.\n64 bytes from ${args[args.length - 1]}: icmp_seq=1 ttl=64 time=0.181 ms` : '1: lo: <LOOPBACK,UP,LOWER_UP>\n2: eno1: <BROADCAST,MULTICAST,UP,LOWER_UP>';
  return NOTFOUND(c);
}
function parseSed(x) {
  if (x[0] !== 's' || x.length < 4) return null;
  const d = x[1], f = []; let cur = '', i = 2;
  for (; i < x.length && f.length < 2; i++) { const ch = x[i]; if (ch === '\\' && x[i + 1] === d) { cur += d === '/' || d === '#' || d === '|' ? d : '\\' + d; i++; continue; } if (ch === d) { f.push(cur); cur = ''; continue; } cur += ch; }
  if (f.length < 2) return null;
  // sed BRE: \( \) \| are groups/alternation; plain [ ] stay a bracket expression
  const pat = f[0].replace(/\\([()|{}+?])/g, '$1'), flags = x.slice(i);
  return { pat, rep: f[1].replace(/\\&/g, '\u0000').replace(/\u0000/g, '&'), g: flags.includes('g') };
}
function run1(w, line) { return splitTop(line, /^(;|&&)/).map(seg => seg ? pipeline(w, seg) : '').filter(Boolean).join('\n'); }
function scontrol(w, args) {
  const ev = e => w.ev.push(e), sub = (args[0] || '').toLowerCase();
  if (sub === 'show') {
    const what = (args[1] || '').toLowerCase(), id = args[2];
    if (/^nodes?$/.test(what)) { if (!id) { NODES.forEach(n => ev('show-node:' + n)); return NODES.map(n => showNode(w, n)).join('\n\n'); } if (!w.slurm.nodes[id]) return `Node ${id} not found`; ev('show-node:' + id); return showNode(w, id); }
    if (/^jobs?$/.test(what)) { if (!id) return Object.keys(w.slurm.jobs).map(j => (ev('show-job:' + j), showJob(w, j))).join('\n\n'); ev('show-job:' + id); return showJob(w, id); }
    if (/^partitions?$/.test(what)) return Object.entries(w.slurm.parts).filter(([n]) => !id || n === id).map(([n, p]) => `PartitionName=${n}\n   AllowGroups=ALL AllowAccounts=ALL AllowQos=ALL\n   Default=${p.def ? 'YES' : 'NO'} QoS=N/A\n   MaxNodes=UNLIMITED MaxTime=UNLIMITED MinNodes=0\n   Nodes=${compress(p.nodes)}\n   State=${p.state} TotalCPUs=${p.nodes.length * 112} TotalNodes=${p.nodes.length}`).join('\n\n') || `Partition ${id} not found`;
    return `invalid entity:${args[1] || ''} for keyword:show`;
  }
  if (sub === 'reconfigure') return '';
  if (sub === 'update') {
    const kv = {}; for (const x of args.slice(1)) { const i = x.indexOf('='); if (i > 0) kv[x.slice(0, i).toLowerCase()] = x.slice(i + 1); }
    if (kv.nodename) {
      const n = w.slurm.nodes[kv.nodename]; if (!n) return 'slurm_update error: Invalid node name specified';
      const st = (kv.state || '').toLowerCase();
      if (!st) return 'slurm_update error: Invalid node state specified';
      ev('update-node:' + kv.nodename);
      if (st === 'drain' || st === 'down') { if (!kv.reason) return 'You must specify a reason when DOWNING or DRAINING a node. Request denied'; if (st === 'drain') n.drain = true; else n.down = true; n.reason = kv.reason; n.rUser = 'root'; n.rTime = '2026-11-25T11:45:00'; return ''; }
      if (st === 'resume' || st === 'idle' || st === 'undrain') {
        if (!n.drain && !n.down) return st === 'resume' ? `slurm_update error: Invalid node state specified` : '';
        if (n.notResp || (n.svc.slurmd !== 'active')) { n.drain = false; n.down = true; n.notResp = true; n.reason = 'Not responding'; n.rUser = 'slurm'; w.hints.push(`slurmd on ${kv.nodename} is not running, so the node went straight back to DOWN. Fix slurmd on the node first.`); return ''; }
        if (n.gresFound < n.gres) { n.drain = true; n.reason = `gres/gpu count reported lower than configured (${n.gresFound} < ${n.gres})`; n.rUser = 'slurm'; w.hints.push('Slurm drained the node again: slurmd still reports fewer GPUs than configured.'); return ''; }
        n.drain = false; n.down = false; n.reason = ''; return '';
      }
      return 'slurm_update error: Invalid node state specified';
    }
    if (kv.jobid) {
      const j = w.slurm.jobs[kv.jobid]; if (!j) return `slurm_update error: Invalid job id specified`;
      const p = kv.partition || kv.partitionname;
      if (p !== undefined) { if (!w.slurm.parts[p]) return 'slurm_update error: Invalid partition name specified'; if (j.st !== 'PD') return `slurm_update error: Job is no longer pending execution for job ${kv.jobid}`; j.part = p; j.reason = 'None'; ev('update-job:' + kv.jobid); }
      return '';
    }
    return 'slurm_update error: Invalid argument';
  }
  return `invalid keyword: ${args[0] || ''}`;
}

/* ---------------- public API ---------------- */
function prompt(w) { return w.cm ? cmPrompt(w) : `root@${w.host}:~#`; }
function advance(w, id, at) {
  const lab = BY[id]; if (!lab) return at;
  while (at < lab.steps.length && lab.steps[at][4](w)) at++;
  return at;
}
function exec(w, line) {
  const out = run(w, line);
  const hints = w.hints.length ? '\n' + w.hints.map(h => '  [hint] ' + h).join('\n') : '';
  return (out + hints).replace(/^\n/, '');
}
root.NaviaFaults = { labs: LABS, byId: BY, create, exec, prompt, advance, gresIn };
if (typeof module !== 'undefined' && module.exports) module.exports = root.NaviaFaults;
})(typeof window !== 'undefined' ? window : globalThis);
