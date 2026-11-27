// node test-faults.cjs : every guided fault lab must finish with its reference commands and with common variants.
const F = require('./aio/fault-labs.js');
let fail = 0, total = 0;
const ok = (c, m) => { total++; if (!c) { fail++; console.log('FAIL ' + m); } };
function play(id, cmds, show) {
  const w = F.create(id); let at = 0; const log = [];
  for (const c of cmds) { const out = F.exec(w, c); at = F.advance(w, id, at); log.push(F.prompt(w) + ' ' + c + '\n' + out); }
  if (show) console.log(log.join('\n'));
  return { w, at, n: F.byId[id].steps.length, log };
}
const BAD = /command not found|Unknown command|Invalid|error|not found|Usage|cannot/i;
// 1. reference path for every lab
for (const lab of F.labs) {
  const r = play(lab.id, lab.steps.map(s => s[2]));
  ok(r.at === r.n, `${lab.id}: reference commands finish (${r.at}/${r.n})`);
  r.log.forEach(l => { const body = l.split('\n').slice(1).join('\n'); if (BAD.test(body) && !/\[hint\]/.test(body) && !/ErrImagePull|ImagePullBackOff|FailedScheduling|Error: |error starting|E1125|Back-off|Unknown Error/.test(body)) ok(false, `${lab.id}: unexpected error output:\n${l}`); });
}
// 2. variants
const V = {
  drain: ['sinfo -R', 'scontrol show node node002', 'ssh node002 systemctl status slurmd', 'scontrol update NodeName=node002 State=RESUME', 'sinfo'],
  'slurm-service': ['sinfo -R', 'ssh node002', 'sudo systemctl status slurmd', 'sudo journalctl -u slurmd --no-pager', 'sudo systemctl start slurmd', 'exit', 'scontrol update NodeName=node002 State=RESUME', 'sinfo'],
  'slurm-gres': ['sinfo -R', 'ssh node002', 'nvidia-smi', 'cat /etc/slurm/gres.conf', 'echo "NodeName=node002 Name=gpu Type=h100 File=/dev/nvidia[0-7]" > /etc/slurm/gres.conf', 'systemctl restart slurmd', 'exit', 'scontrol update nodename=node002 state=resume', 'scontrol show node node002'],
  'slurm-gres#sed-slashes': ['sinfo -R', 'ssh node002', 'nvidia-smi -L', 'cat /etc/slurm/gres.conf', "sed -i 's/\\/dev\\/nvidia0/\\/dev\\/nvidia[0-7]/' /etc/slurm/gres.conf", 'systemctl restart slurmd', 'exit', 'scontrol update nodename=node002 state=resume', 'scontrol show node node002'],
  'slurm-partition': ['squeue', 'scontrol show job 5823', 'sinfo', 'scontrol update JobId=5823 Partition=defq', 'squeue'],
  image: ['module load kubernetes', 'kubectl get pods', 'kubectl describe pod inference', 'kubectl rollout undo deployment/inference', 'kubectl rollout status deployment/inference'],
  'k8s-crash': ['module load kubernetes', 'kubectl get pods', 'kubectl describe pods inference', 'kubectl logs -l app=inference', 'kubectl set env deploy/inference MODEL_PATH=/models', 'kubectl get pods'],
  'k8s-gpu': ['module load kubernetes', 'kubectl describe pod gpu-test', 'kubectl describe node node002', 'kubectl get pods -n gpu-operator', 'kubectl logs -n gpu-operator ds/nvidia-device-plugin-daemonset', 'kubectl delete pod nvidia-device-plugin-daemonset-5wq7d -n gpu-operator', 'kubectl get pods'],
  'k8s-pending': ['module load kubernetes', 'kubectl get pods', 'kubectl describe pod inference', 'kubectl describe node node002', 'kubectl taint node node002 training-', 'kubectl get pods'],
  'k8s-node': ['module load kubernetes', 'kubectl get nodes', 'kubectl describe node node002', 'ssh node002', 'systemctl status kubelet', 'systemctl start kubelet', 'exit', 'kubectl get nodes'],
  bcm: ['cmsh -c "device; add physicalnode node004 10.141.0.4; set category gpu-nodes; set mac 02:00:00:00:00:04; commit"', 'cmsh -c "device; power on -n node004"', 'cmsh -c "device; status -n node004"'],
  'bcm#exit-then-commit': ['cmsh', 'device', 'add physicalnode node004 10.141.0.4', 'set category gpu-nodes', 'set mac 02:00:00:00:00:04', 'exit', 'commit', 'use node004', 'power on', 'status -n node004'],
  'bcm-image': ['cmsh', 'device', 'use node003', 'show', 'clear softwareimage', 'commit', 'imageupdate -n node003 -w', 'get softwareimage'],
  'bcm-category': ['cmsh -c "device; use node003; get category"', 'cmsh -c "device; use node003; set category gpu-nodes; commit"', 'cmsh -c "device; use node003; get category"'],
  'gpu-xid': ['ssh node002', 'nvidia-smi', 'dmesg | grep -i xid', 'sudo nvidia-bug-report.sh', 'exit', 'scontrol update NodeName=node002 State=DRAIN Reason="GPU Xid 79"', 'sinfo -R'],
  'storage-full': ['df -h', 'du -sh /shared/*', 'ls -lh /shared/old-checkpoint.tmp', 'rm -f /shared/old-checkpoint.tmp', 'df -h'],
  'slurm-resources': ['squeue', 'scontrol show job 5823', 'scontrol show job 5820', 'scancel 5820', 'squeue -j 5823']
};
// bcm one-liners skip the navigated steps, so those labs advance on state, not on every step
for (const [key, cmds] of Object.entries(V)) {
  const id = key.split('#')[0], r = play(id, cmds);
  ok(r.at === r.n, `${key}: variant finishes (${r.at}/${r.n})\n` + r.log.join('\n'));
}
// 3. mistakes must NOT pass
const M = [
  ['drain', ['sinfo -R', 'scontrol show node node002', 'scontrol update nodename=node002 state=resume'], 2, 'skipping the health check stops at step 3'],
  ['slurm-service', ['sinfo -R', 'ssh node002', 'systemctl status slurmd', 'journalctl -u slurmd -n 30 --no-pager', 'exit', 'scontrol update nodename=node002 state=resume'], 4, 'resume without restarting slurmd'],
  ['slurm-gres', ['sinfo -R', 'ssh node002', 'nvidia-smi -L', 'cat /etc/slurm/gres.conf', 'systemctl restart slurmd'], 4, 'restart without fixing gres.conf'],
  ['image', ['module load kubernetes', 'kubectl get pods', 'kubectl describe pod inference', 'kubectl set image deployment/inference inference=nvcr.io/nvidia/tritonserver:latest'], 3, 'a wrong image is not a fix'],
  ['bcm-category', ['cmsh', 'device', 'use node003', 'get category', 'set category gpu-nodes', 'quit'], 5, 'quit without commit'],
  ['storage-full', ['df -h', 'du -sh /shared/*', 'ls -lh /shared/old-checkpoint.tmp', 'rm -rf /shared/datasets'], 3, 'deleting datasets is blocked'],
  ['k8s-pending', ['kubectl get pods'], 0, 'kubectl needs module load'],
  ['slurm-service', ['systemctl restart slurmd'], 0, 'slurmd is not on the head node']
];
for (const [id, cmds, want, why] of M) { const r = play(id, cmds); ok(r.at === want, `${id}: ${why} (at ${r.at}, want ${want})\n` + r.log.join('\n')); }
console.log(`${total} checks, ${fail} failure(s)`);
process.exitCode = fail ? 1 : 0;
