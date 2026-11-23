const assert=require('assert'); const ops=require('./aio/ops-engine.js');
const steps={
 drain:['sinfo -R','scontrol show node node002','scontrol update NodeName=node002 State=RESUME','sinfo -N'],
 image:['kubectl get pods','kubectl describe pod inference','kubectl get rs -o yaml','kubectl set image deployment/inference inference=nvcr.io/nvidia/pytorch:24.08-py3','kubectl rollout status deployment/inference'],
 bcm:['cmsh','softwareimage','list','device','list','use node003','set softwareimage dgx-h100-image','set category gpu','commit','power on -n node003','status'],
 'slurm-resources':['squeue','scontrol show job 1041','scancel 1041','squeue'],
 'slurm-partition':['squeue','scontrol show job 1042','sinfo','scontrol update JobId=1042 PartitionName=gpu','squeue'],
 'slurm-gres':['scontrol show node node002','nvidia-smi','cat /etc/slurm/gres.conf',"sudo sed -i 's/Count=0/Count=8/' /etc/slurm/gres.conf",'sudo systemctl restart slurmd','scontrol show node node002'],
 'slurm-service':['sinfo -R','systemctl status slurmd','journalctl -u slurmd -n 20','sudo systemctl restart slurmd','sinfo -R'],
 'k8s-pending':['kubectl get pods','kubectl describe pod inference','kubectl describe node node002','kubectl taint nodes node002 training=blocked:NoSchedule-','kubectl get pods'],
 'k8s-crash':['kubectl get pods','kubectl logs inference','kubectl set env deployment/inference MODEL_PATH=/models','kubectl get pods'],
 'k8s-gpu':['kubectl describe pod inference','kubectl describe node node002','kubectl get daemonset -n gpu-operator','kubectl logs daemonset/nvidia-device-plugin-daemonset -n gpu-operator','kubectl rollout restart daemonset/nvidia-device-plugin-daemonset -n gpu-operator','kubectl get pods'],
 'k8s-node':['kubectl get nodes','systemctl status kubelet','journalctl -u kubelet -n 20','sudo systemctl restart kubelet','kubectl get nodes'],
 'bcm-image':['cmsh -c "softwareimage; list"','cmsh','device','list','use node003','get softwareimage','set softwareimage dgx-h100-image','commit','get softwareimage'],
 'bcm-category':['cmsh -c "category; list"','cmsh','device','list','use node003','get category','set category gpu','commit','get category'],
 'gpu-xid':['nvidia-smi','journalctl -k -n 30','scontrol update NodeName=node002 State=DRAIN Reason=GPU_Xid','sinfo -R'],
 'storage-full':['df -h','du -sh /shared/*','ls -lh /shared/old-checkpoint.tmp','rm /shared/old-checkpoint.tmp','df -h']
};
let results=[];
for(const [id,seq] of Object.entries(steps)){
 let s=ops.create(id); assert.equal(ops.grade(s).passed,false,`initial ${id} must fail`);
 let logs=seq.map(cmd=>{let r=ops.run(s,cmd);assert(!r.startsWith('Error:'),`${id} ${cmd} -> ${r}`);return r});
 let g=ops.grade(s);assert(g.passed, `${id}: ${JSON.stringify(g)}\n${logs.join('\n')}`); results.push({id,passed:true,commands:seq.length});
}
for(const id of Object.keys(steps)){
 let s=ops.create(id); assert(!ops.grade(s).passed);
 assert(ops.run(s,'not-a-real-command').startsWith('Error:'));
 assert(!ops.grade(s).passed);
}
{
 let s=ops.create('image');let wrong=ops.run(s,'kubectl set image deployment/inference inference=nvcr.io/nvidia/pytorch:valid');assert(!ops.grade(s).repair);assert(wrong.includes('failing'));let r=ops.run(s,'kubectl get rs -o yaml');assert(r.includes(ops.GOOD_IMAGE));assert(!ops.grade(s).passed);
}
{
 let s=ops.create('slurm-gres');let r=ops.run(s,'sudo systemctl restart slurmd'); assert(r.startsWith('Error:'));assert(!ops.grade(s).repair);
}
{
 let s=ops.create('bcm');let r=ops.run(s,'cmsh -c "device; use node003; power on -n node003"');assert(r.includes('Error:'));assert(!ops.grade(s).repair);
}
{
 let s=ops.create('image');
 for(let cmd of steps.image)ops.run(s,cmd);
 assert(ops.grade(s).passed,'Image lab should be recovered');
 ops.run(s,'kubectl set image deployment/inference inference=nvcr.io/nvidia/pytorch:missing-release');
 const score=ops.grade(s);
 assert(!score.repair&&!score.verify&&!score.passed,'Rebreaking repaired workload must invalidate recovered state');
}
console.log(JSON.stringify({success:true,passedLabs:results.length,tests:results},null,2));
