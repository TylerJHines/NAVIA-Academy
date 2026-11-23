/* NAVIA NCP-AIO simulated cluster engine. No real host commands are executed.
   Each accepted command has documented Linux, Kubernetes, Slurm or BCM CLI syntax.
   Synthetic state, evidence, and validation are kept separate from checklist order. */
'use strict';
const NAVIAOps = (() => {
  const ENGINE_REVISION = '2026-11-19-martin-aligned-r2';
  const GOOD_IMAGE = 'nvcr.io/nvidia/pytorch:24.08-py3';
  const BAD_IMAGE = 'nvcr.io/nvidia/pytorch:missing-release';
  const GOOD_BCM_IMAGE = 'dgx-h100-image';
  const labDefs = {
    drain: ['Slurm','Restore a drained Slurm node','Maintenance has ended on node002. Investigate why it remains unavailable, confirm its health, and return it to service.','sinfo -R','scontrol update NodeName=node002 State=RESUME','sinfo'],
    image: ['Kubernetes','Recover a failed inference rollout','The inference Deployment in the default namespace stopped serving after a rollout. Identify the failing container image, discover the previous approved image through ReplicaSets, restore service, and validate.','kubectl describe pod inference','kubectl rollout undo deployment/inference','kubectl rollout status deployment/inference'],
    bcm: ['BCM','Provision discovered GPU node','BCM detected node003 (MAC 02:00:00:00:03:03). Assign an available GPU software image and category in cmsh, commit, power on and verify provisioning.','cmsh -c "softwareimage; list"','device; use node003; set softwareimage dgx-h100-image; set category gpu; commit','device; status'],
    'slurm-resources': ['Slurm','Resolve a blocked GPU training job','Job 1042 needs 8 GPUs. A completed training benchmark (job 1041, owned by trainer) still occupies node002. Inspect both jobs and release only the stale allocation.','scontrol show job 1041','scancel 1041','squeue'],
    'slurm-partition': ['Slurm','Correct a stale Slurm partition','Job 1042 was queued to a retired partition. Discover the active GPU partition and correct the pending job allocation.','scontrol show job 1042','scontrol update JobId=1042 PartitionName=gpu','squeue'],
    'slurm-gres': ['Slurm','Repair GPU GRES inventory','node002 physically has eight GPUs but Slurm reports zero. Investigate GPU visibility and the node GRES mapping; correct configuration before restarting slurmd.','cat /etc/slurm/gres.conf',"sudo sed -i 's/Count=0/Count=8/' /etc/slurm/gres.conf",'scontrol show node node002'],
    'slurm-service': ['Slurm','Restore compute daemon','Slurm reports node002 DOWN after an unexpected slurmd stop. Inspect daemon logs and restart the service after checking the cause.','systemctl status slurmd','sudo systemctl restart slurmd','sinfo -R'],
    'k8s-pending': ['Kubernetes','Resolve an unwanted node taint','The inference Pod is Pending because an old training taint on node002 blocks placement. Check scheduling events and node taints before removing it.','kubectl describe pod inference','kubectl taint nodes node002 training=blocked:NoSchedule-','kubectl get pods'],
    'k8s-crash': ['Kubernetes','Fix a crashing inference container','Inference is restarting. Read its logs to discover the missing environment configuration and restore its Deployment.','kubectl logs inference','kubectl set env deployment/inference MODEL_PATH=/models','kubectl get pods'],
    'k8s-gpu': ['Kubernetes','Recover GPU device-plugin advertisement','A GPU workload is Pending despite healthy GPUs on node002. Inspect node allocatable resources and GPU Operator device-plugin logs before recovery.','kubectl describe node node002','kubectl rollout restart daemonset/nvidia-device-plugin-daemonset -n gpu-operator','kubectl describe node node002'],
    'k8s-node': ['Kubernetes','Restore a NotReady node','node002 is NotReady because kubelet is stopped. Inspect node conditions and service logs, then restore node readiness.','systemctl status kubelet','sudo systemctl restart kubelet','kubectl get nodes'],
    'bcm-image': ['BCM','Repair an invalid BCM software image','node003 is assigned a retired image. Inspect the image inventory to find the approved GPU image, commit the corrected assignment and verify.','cmsh -c "softwareimage; list"','device; use node003; set softwareimage dgx-h100-image; commit','device; use node003; get softwareimage'],
    'bcm-category': ['BCM','Correct a BCM node category','node003 was accidentally assigned to the CPU category. Verify the available categories and assign GPU with a committed change.','cmsh -c "category; list"','device; use node003; set category gpu; commit','device; use node003; get category'],
    'gpu-xid': ['GPU','Isolate a GPU after an Xid 79 event','node002 reported a GPU-off-bus event (Xid 79). Collect kernel/GPU evidence and drain the affected node to prevent new jobs. A physical repair is not simulated.','journalctl -k -n 30','scontrol update NodeName=node002 State=DRAIN Reason=GPU_Xid','sinfo -R'],
    'storage-full': ['Linux','Recover checkpoint storage capacity','/shared is full. The owner has explicitly approved deleting only /shared/old-checkpoint.tmp, an obsolete test checkpoint. Verify the target before removal.','ls -lh /shared/old-checkpoint.tmp','rm /shared/old-checkpoint.tmp','df -h']
  };
  const defs = Object.fromEntries(Object.entries(labDefs).map(([id,a])=>[id,{id,domain:a[0],name:a[1],story:a[2],investigate:a[3],repair:a[4],verify:a[5]}]));
  function create(id='free'){
    const s={id,shell:'bash',mode:'',selected:'',staged:{},nodes:{node001:{state:'IDLE',reason:'',gres:8,hardware:8,allocated:0,slurmd:true},node002:{state:'IDLE',reason:'',gres:8,hardware:8,allocated:0,slurmd:true}},jobs:{1042:{state:'R',reason:'None',partition:'gpu',gres:8,node:'node002',owner:'trainer',name:'training'}},k8s:{image:GOOD_IMAGE,goodImage:GOOD_IMAGE,ready:true,taint:false,plugin:true,kubelet:true,env:true},bcm:{node003:{softwareimage:GOOD_BCM_IMAGE,category:'gpu',mac:'02:00:00:00:03:03',power:'on',provisioned:true},images:['default-image',GOOD_BCM_IMAGE],categories:['default','cpu','gpu']},gresFileCount:8,storageFull:false,storageFile:true,xid:false,seen:[],repaired:false,validated:false,commandLog:[]};
    const n=s.nodes.node002,k=s.k8s,b=s.bcm.node003,j=s.jobs[1042];
    switch(id){
      case 'drain':n.state='DRAIN';n.reason='Scheduled maintenance completed';break;
      case 'image':k.image=BAD_IMAGE;k.ready=false;break;
      case 'bcm':b.softwareimage='';b.category='';b.power='off';b.provisioned=false;break;
      case 'slurm-resources':s.jobs[1041]={state:'R',reason:'None',partition:'gpu',gres:8,node:'node002',owner:'trainer',name:'completed-benchmark'};j.state='PD';j.reason='Resources';j.node='';n.allocated=8;break;
      case 'slurm-partition':j.state='PD';j.partition='gpu-old';j.reason='InvalidPartition';j.node='';break;
      case 'slurm-gres':n.gres=0;s.gresFileCount=0;break;
      case 'slurm-service':n.state='DOWN';n.slurmd=false;n.reason='slurmd not responding';break;
      case 'k8s-pending':k.ready=false;k.taint=true;break;
      case 'k8s-crash':k.ready=false;k.env=false;break;
      case 'k8s-gpu':k.ready=false;k.plugin=false;break;
      case 'k8s-node':k.ready=false;k.kubelet=false;break;
      case 'bcm-image':b.softwareimage='retired-image';b.provisioned=false;break;
      case 'bcm-category':b.category='cpu';break;
      case 'gpu-xid':s.xid=true;break;
      case 'storage-full':s.storageFull=true;break;
    }
    return s;
  }
  function healthy(s){
    const n=s.nodes.node002,k=s.k8s,b=s.bcm.node003,j=s.jobs[1042];
    switch(s.id){
      case 'drain':return n.state==='IDLE'&&!n.reason;
      case 'image':return k.image===GOOD_IMAGE&&k.ready;
      case 'bcm':return b.softwareimage===GOOD_BCM_IMAGE&&b.category==='gpu'&&b.provisioned&&b.power==='on';
      case 'slurm-resources':return !s.jobs[1041]&&j.state==='R';
      case 'slurm-partition':return j.partition==='gpu'&&j.state==='R';
      case 'slurm-gres':return n.gres===8&&s.gresFileCount===8;
      case 'slurm-service':return n.slurmd&&n.state==='IDLE';
      case 'k8s-pending':return !k.taint&&k.ready;
      case 'k8s-crash':return k.env&&k.ready;
      case 'k8s-gpu':return k.plugin&&k.ready;
      case 'k8s-node':return k.kubelet&&k.ready;
      case 'bcm-image':return b.softwareimage===GOOD_BCM_IMAGE&&!Object.keys(s.staged).length;
      case 'bcm-category':return b.category==='gpu'&&!Object.keys(s.staged).length;
      case 'gpu-xid':return n.state==='DRAIN'&&n.reason==='GPU_Xid';
      case 'storage-full':return !s.storageFull&&!s.storageFile;
      default:return true;
    }
  }
  const docs = {
    sinfo:'sinfo [-R] [-N]     Show Slurm partition or node availability and drain reasons',
    squeue:'squeue [-j JOBID]   Show job states, owners, reasons and placements',
    scontrol:'scontrol show node NODE | show job JOBID | update NodeName=NODE State=RESUME | update JobId=ID PartitionName=PARTITION',
    scancel:'scancel JOBID       Cancel an authorized Slurm job',
    kubectl:'kubectl get pods; kubectl describe pod inference; kubectl get rs -o yaml; kubectl rollout history deployment/inference; kubectl set image deployment/inference inference=IMAGE; kubectl rollout undo deployment/inference; kubectl rollout status deployment/inference; kubectl get nodes; kubectl describe node node002; kubectl set env deployment/inference MODEL_PATH=/models; kubectl taint nodes node002 training=blocked:NoSchedule-; kubectl rollout restart daemonset/nvidia-device-plugin-daemonset -n gpu-operator',
    cmsh:'cmsh [-c "device; list"]   BCM interactive shell: device|softwareimage|category, list, use, get, set, commit, status, power, exit',
    'nvidia-smi':'nvidia-smi [-L|-q]  GPU inventory and driver-reported health',
    systemctl:'systemctl status slurmd|kubelet; sudo systemctl restart SERVICE',
    journalctl:'journalctl -k -n 30 | journalctl -u slurmd|kubelet -n 20',
    'dcgmi':'dcgmi diag -r 1     Run DCGM GPU quick diagnostics (simulated)',
    'cat':'cat /etc/slurm/gres.conf',
    'df':'df -h',
    'du':'du -sh /shared/*',
    'ls':'ls -lh /shared/old-checkpoint.tmp'
  };
  const err=t=>'Error: '+t;
  // Evidence is tracked separately from system recovery. All commands execute irrespective of goal order.
  function diagnosticEvidence(s,cmd,result){
    if(/^Error:/.test(result)||healthy(s))return false;
    const c=cmd.replace(/\s+(?:-n|--namespace)\s+\S+/g,'').trim();
    const read={
      drain:/^(sinfo(?:\s|$)|scontrol show node node002|systemctl status slurmd)/,
      image:/^kubectl (get (?:pods?|deploy(?:ment)?s?)(?:\s|$)|describe (?:pod inference|deployment inference)|rollout history deployment\/inference)/,
      bcm:/^(cmsh -c .*device.*(?:list|show|status)|(?:list|show|status|power status)(?:\s|$))/, 
      'slurm-resources':/^(squeue|scontrol show (?:node node002|job 104[12])|sacct)/,
      'slurm-partition':/^(squeue|scontrol show (?:job 1042|partition)|sinfo)/,
      'slurm-gres':/^(sinfo|scontrol show node node002|nvidia-smi|cat \/etc\/slurm\/gres.conf)/,
      'slurm-service':/^(sinfo|scontrol show node node002|(?:ssh node002 )?(?:sudo )?systemctl status slurmd|(?:ssh node002 )?journalctl -u slurmd)/,
      'k8s-pending':/^kubectl (get pods|describe pod inference|describe node node002|describe nodes node002)/,
      'k8s-crash':/^kubectl (get pods|describe pod inference|logs inference)/,
      'k8s-gpu':/^kubectl (get pods|get daemonset|describe pod inference|describe node node002|logs daemonset\/nvidia-device-plugin-daemonset)/,
      'k8s-node':/^(kubectl (get nodes|describe node node002)|(?:ssh node002 )?(?:sudo )?systemctl status kubelet|(?:ssh node002 )?journalctl -u kubelet)/,
      'bcm-image':/^(cmsh -c .*?(?:list|show|get)|(?:list|show|get softwareimage)(?:\s|$))/, 
      'bcm-category':/^(cmsh -c .*?(?:list|show|get)|(?:list|show|get category)(?:\s|$))/, 
      'gpu-xid':/^(nvidia-smi|journalctl -k|ssh node002 journalctl -k|dcgmi|nvsm show health)/,
      'storage-full':/^(df -h|du -sh \/shared\/\*|ls -lh \/shared\/old-checkpoint.tmp)/
    };
    return !!(read[s.id]&&read[s.id].test(c));
  }
  function verificationEvidence(s,cmd,result){
    if(/^Error:/.test(result)||!healthy(s))return false;
    const c=cmd.replace(/\s+(?:-n|--namespace)\s+\S+/g,'').trim();
    const read={
      drain:/^(sinfo|scontrol show node node002)/,
      image:/^kubectl (get pods|get deployment|describe deployment inference|rollout status deployment\/inference)/,
      bcm:/^(cmsh -c .*?(?:status|list|show)|(?:list|status|show)(?:\s|$))/, 
      'slurm-resources':/^(squeue|scontrol show job 1042)/,
      'slurm-partition':/^(squeue|scontrol show job 1042)/,
      'slurm-gres':/^(scontrol show node node002|sinfo)/,
      'slurm-service':/^(sinfo|scontrol show node node002|(?:ssh node002 )?systemctl status slurmd)/,
      'k8s-pending':/^kubectl (get pods|describe pod inference)/,
      'k8s-crash':/^kubectl (get pods|describe pod inference|rollout status deployment\/inference)/,
      'k8s-gpu':/^kubectl (get pods|describe node node002|get daemonset)/,
      'k8s-node':/^kubectl (get nodes|describe node node002)/,
      'bcm-image':/^(cmsh -c .*?(?:get|show|list)|(?:get softwareimage|show|list)(?:\s|$))/, 
      'bcm-category':/^(cmsh -c .*?(?:get|show|list)|(?:get category|show|list)(?:\s|$))/, 
      'gpu-xid':/^(sinfo -R|scontrol show node node002)/,
      'storage-full':/^(df -h|du -sh \/shared\/\*)/
    };
    return !!(read[s.id]&&read[s.id].test(c));
  }
  function run(s,raw){
    const cmd=String(raw||'').trim().replace(/\s+/g,' ');
    if(!cmd)return '';
    if(cmd==='help'||cmd==='?'||cmd==='man')return 'NAVIA simulation command reference (not a live host):\n'+Object.values(docs).join('\n')+'\nUse COMMAND --help or man COMMAND for usage. Outputs are synthetic.';
    const helpKey=cmd.match(/^([\w-]+) --help$/);
    if(helpKey)return docs[helpKey[1]]||err('No simulated manual for '+helpKey[1]);
    if(cmd.startsWith('man '))return docs[cmd.slice(4).split(' ')[0]]||err('Manual unavailable for this command');
    if(cmd==='clear')return 'Screen cleared. Your cluster configuration is unchanged.';
    const wasHealthy=healthy(s);
    let result;
    if(cmd.startsWith('cmsh -c ')){
      const m=cmd.match(/^cmsh -c ["'](.+)["']$/);
      if(!m)return err('cmsh -c requires a quoted command sequence');
      const session={...s,shell:'cmsh',mode:'',selected:'',staged:{}};
      const out=[];
      for(const part of m[1].split(';').map(x=>x.trim()).filter(Boolean)){
        const line=cmsh(session,part);out.push(line);
        if(line.startsWith('Error:'))break;
      }
      result=out.join('\n');
      if(!out.some(t=>t.startsWith('Error:')))s.bcm=session.bcm;
    }else if(s.shell==='cmsh'||cmd==='cmsh'){
      if(cmd==='cmsh'&&s.shell!=='cmsh'){
        s.shell='cmsh';s.mode='';s.selected='';result='BCM cmsh shell (simulated). Select device, softwareimage or category; type help for usage.';
      }else result=cmsh(s,cmd);
    }else result=linux(s,cmd);
    if(!result.startsWith('Error:')){
      s.commandLog.push(cmd);if(s.commandLog.length>300)s.commandLog.shift();
      if(!Array.isArray(s.seen))s.seen=[];
      if(!wasHealthy&&diagnosticEvidence(s,cmd,result)){
        if(!s.seen.includes('investigate'))s.seen.push('investigate');
        s.lastEvidence=cmd;
      }
      const recovered=healthy(s);
      if(!recovered){s.validated=false;s.repaired=false;}
      else{
        s.repaired=true;
        if(verificationEvidence(s,cmd,result)&&wasHealthy){s.validated=true;s.lastValidation=cmd;}
      }
    }
    return result;
  }
  function grade(s){const investigated=s.seen.includes('investigate'),repair=healthy(s),verify=repair&&s.validated;return {investigated,repair,verify,passed:investigated&&repair&&verify,percent:100*(Number(investigated)+Number(repair)+Number(verify))/3};}
  function cmsh(s,cmd){
    const b=s.bcm,dev=b.node003,t=cmd.split(' ');
    if(cmd==='help'||cmd==='?')return docs.cmsh;
    if(cmd==='exit'){if(s.selected){s.selected='';return 'Returned to '+s.mode+' mode.'}if(s.mode){s.mode='';return 'Returned to cmsh root.'}s.shell='bash';return 'Exited cmsh.'}
    if(['device','category','softwareimage'].includes(t[0])){s.mode=t[0];s.selected='';if(t.length>1)return cmsh(s,t.slice(1).join(' '));return 'Entered '+s.mode+' mode. Use list or use NAME.'}
    if(!s.mode)return err('Select device, category or softwareimage mode first');
    if(cmd==='list'||cmd==='ls'){
      if(s.mode==='softwareimage')return 'Name                     Path\n'+b.images.map(x=>x+'  /cm/images/'+x).join('\n');
      if(s.mode==='category')return 'Name     Software image\n'+b.categories.map(x=>`${x}   ${x==='gpu'?GOOD_BCM_IMAGE:'default-image'}`).join('\n');
      return `Name     Power  Provisioned  Category   Software image\nnode003 ${dev.power.padEnd(5)} ${String(dev.provisioned).padEnd(12)} ${dev.category||'(unset)'}  ${dev.softwareimage||'(unset)'}`;
    }
    if(t[0]==='use'){let name=t[1];const list=s.mode==='device'?['node003']:s.mode==='category'?b.categories:b.images;if(!list.includes(name))return err(`Unknown ${s.mode} entry ${name}`);s.selected=name;return `Selected ${s.mode} ${name}`}
    if(cmd==='show')return s.mode==='device'&&s.selected?`Name: ${s.selected}\nSoftware image: ${dev.softwareimage||'(unset)'}\nCategory: ${dev.category||'(unset)'}\nMAC: ${dev.mac}\nPower: ${dev.power}\nProvisioned: ${dev.provisioned}`:err('Select an object with use before show');
    if(t[0]==='get'){
      if(!s.selected)return err('Select an object first using use NAME');
      let prop=t[1];if(prop==='image')return err('Use actual BCM property name: get softwareimage');
      if(!['softwareimage','category','mac','power','hostname'].includes(prop))return err('Unknown property '+prop);
      return `${prop} = ${s.staged[prop]??(prop==='hostname'?'node003':dev[prop])??'(unset)'}`;
    }
    if(t[0]==='set'){
      if(s.mode!=='device'||s.selected!=='node003')return err('Select device node003 to set node properties');
      let prop=t[1],value=t.slice(2).join(' ');
      if(prop==='image')return err('Use BCM field softwareimage, not image');
      if(!['softwareimage','category','mac'].includes(prop)||!value)return err('Usage: set softwareimage NAME | set category NAME | set mac XX:XX:XX:XX:XX:XX');
      if(prop==='softwareimage'&&!b.images.includes(value))return err('Unknown software image '+value+'. Use softwareimage; list.');
      if(prop==='category'&&!b.categories.includes(value))return err('Unknown category '+value+'. Use category; list.');
      if(prop==='mac'&&!/^([\da-f]{2}:){5}[\da-f]{2}$/i.test(value))return err('Invalid MAC address format');
      s.staged[prop]=value;return `Staged ${prop} = ${value} (not committed)`;
    }
    if(cmd==='commit'||cmd==='commit -w'){
      if(!s.selected||s.mode!=='device')return err('Select a device before committing properties');
      const props=Object.keys(s.staged);if(!props.length)return 'No pending changes.';
      Object.assign(dev,s.staged);s.staged={};
      if(!dev.softwareimage||!b.images.includes(dev.softwareimage)||!dev.category||!b.categories.includes(dev.category))dev.provisioned=false;
      else if(dev.power==='on')dev.provisioned=true;
      return `Committed ${props.join(', ')} for node003. ${dev.power==='on'?'Restart or synchronize the node if image changed.':'Power on for provisioning.'}`;
    }
    if(t[0]==='power'&&s.mode==='device'){
      const action=t[1],node=t.includes('-n')?t[t.indexOf('-n')+1]:s.selected;
      if(node!=='node003')return err('Choose node003 (power on -n node003)');
      if(action==='status')return `${node} power: ${dev.power}`;
      if(!['on','off','reset'].includes(action))return err('Usage: power on|off|reset -n node003');
      if(action!=='off'&&(!b.images.includes(dev.softwareimage)||!b.categories.includes(dev.category)||!dev.mac))return err('Provisioning blocked: valid softwareimage, category and MAC are required');
      dev.power=action==='off'?'off':'on';dev.provisioned=action!=='off';return `${node}: power ${action}; ${dev.provisioned?'PXE/image sync completed (synthetic)':'node powered off'}`;
    }
    if(cmd==='status'||cmd==='status node003')return `node003: ${dev.power.toUpperCase()} ${dev.provisioned?'UP / provisioned':'UNPROVISIONED'} image=${dev.softwareimage||'(unset)'} category=${dev.category||'(unset)'}`;
    return err('Unsupported BCM subcommand. '+docs.cmsh);
  }
  function linux(s,cmd){
    const n=s.nodes.node002,k=s.k8s,b=s.bcm.node003,j=s.jobs[1042],a=cmd.split(' ');
    if(a[0]==='ssh'){
      if(a[1]!=='node002')return err('This training cluster supports ssh node002. Check node names with sinfo or kubectl get nodes.');
      const sub=cmd.slice('ssh node002 '.length);
      if(!sub||sub===cmd)return err('Usage: ssh node002 COMMAND');
      if(!/^(sudo )?(systemctl|journalctl|nvidia-smi|cat)\b/.test(sub))return err('Remote command not modeled; use ssh node002 systemctl status slurmd or kubelet.');
      return linux(s,sub);
    }
    if(a[0]==='sinfo'){
      if(a.includes('-R'))return Object.entries(s.nodes).filter(([,x])=>x.reason).map(([id,x])=>`REASON                         USER     NODELIST\n${x.reason.padEnd(30)} trainer  ${id}`).join('\n')||'No unavailable nodes';
      if(a.includes('-N'))return 'NODELIST NODES PARTITION STATE\n'+Object.entries(s.nodes).map(([id,x])=>`${id} 1 gpu ${x.state.toLowerCase()}`).join('\n');
      return 'PARTITION AVAIL TIMELIMIT NODES STATE NODELIST\ngpu* up infinite 2 mixed '+Object.entries(s.nodes).map(([id,x])=>`${id}:${x.state.toLowerCase()}`).join(',');
    }
    if(a[0]==='squeue'){
      let jobs=Object.entries(s.jobs);if(a.includes('-j'))jobs=jobs.filter(([id])=>id===a[a.indexOf('-j')+1]);
      return 'JOBID PARTITION NAME USER ST REASON NODELIST\n'+jobs.map(([id,x])=>`${id} ${x.partition} ${x.name} ${x.owner} ${x.state} ${x.state==='PD'?x.reason:'-'} ${x.node||'-'}`).join('\n');
    }
    if(a[0]==='scontrol'){
      if(a[1]==='show'&&a[2]==='node'){
        let id=a[3]||'node002',node=s.nodes[id];if(!node)return err('Unknown node '+id);
        return `NodeName=${id} State=${node.state} Reason=${node.reason||'None'} Gres=gpu:${node.gres} CfgTRES=gres/gpu=${node.gres} AllocTRES=gres/gpu=${node.allocated} Slurmd=${node.slurmd?'active':'inactive'}`;
      }
      if(a[1]==='show'&&a[2]==='job'){
        let job=s.jobs[a[3]];if(!job)return err('Unknown job '+a[3]);return `JobId=${a[3]} UserId=${job.owner} JobName=${job.name} JobState=${job.state==='PD'?'PENDING':'RUNNING'} Partition=${job.partition} Reason=${job.reason} TresPerNode=gres:gpu:${job.gres} NodeList=${job.node||'(null)'}`;
      }
      if(a[1]==='show'&&a[2]==='partition')return 'PartitionName=gpu State=UP Nodes=node001,node002 Default=YES';
      if(a[1]==='update'){
        let nodeMatch=cmd.match(/NodeName=(\w+)/i),stateMatch=cmd.match(/State=(\w+)/i),reasonMatch=cmd.match(/Reason=(\S+)/i);
        if(nodeMatch&&stateMatch){let node=s.nodes[nodeMatch[1]],target=stateMatch[1].toUpperCase();if(!node)return err('Unknown Slurm node');
          if(target==='RESUME'){
            if(!node.slurmd||node.gres!==node.hardware||s.xid)return err('Unsafe RESUME: node daemon, GPU resources or hardware fault not resolved');
            node.state='IDLE';node.reason='';return `Node ${nodeMatch[1]} set to RESUME; check sinfo.`;
          }
          if(target==='DRAIN') {node.state='DRAIN';node.reason=reasonMatch?.[1]||'Administrative drain';return `Node ${nodeMatch[1]} set to DRAIN; no new jobs will be scheduled.`;}
          return err('Supported state changes: DRAIN or RESUME');
        }
        let jm=cmd.match(/JobId=(\d+)/i),pm=cmd.match(/PartitionName=(\S+)/i);
        if(jm&&pm){let job=s.jobs[jm[1]];if(!job)return err('Unknown job');if(!['gpu'].includes(pm[1]))return err('Partition does not exist; use sinfo');if(job.state!=='PD')return err('Only pending jobs can be modified in this simulator');job.partition=pm[1];job.reason='None';job.state='R';job.node='node002';return `Updated JobId=${jm[1]} PartitionName=${pm[1]}; scheduler started job.`;}
        return err(docs.scontrol);
      }
      return err(docs.scontrol);
    }
    if(a[0]==='scancel'){
      let job=s.jobs[a[1]];if(!job)return err('Unknown job '+a[1]);delete s.jobs[a[1]];
      if(s.id==='slurm-resources'&&a[1]==='1041'){n.allocated=0;j.reason='None';j.state='R';j.node='node002';}
      return 'Cancelled job '+a[1];
    }
    if(a[0]==='sacct')return 'JobID State AllocTRES\n'+Object.entries(s.jobs).map(([id,x])=>`${id} ${x.state==='PD'?'PENDING':'RUNNING'} gres/gpu=${x.gres}`).join('\n');
    if(a[0]==='sbatch')return err('This lab provides no writable job script. Use squeue and scontrol to operate the existing scheduler.');
    if(cmd==='cat /etc/slurm/gres.conf')return `# node002 GPU resources\nNodeName=node002 Name=gpu Count=${s.gresFileCount} File=/dev/nvidia[0-7]`;
    if(/^sudo sed -i ["']s\/Count=0\/Count=8\/["'] \/etc\/slurm\/gres\.conf$/.test(cmd)){
      if(s.gresFileCount!==0)return 'Configuration already shows Count=8; no replacement performed.';
      s.gresFileCount=8;return 'Updated /etc/slurm/gres.conf; restart slurmd to load changes.';
    }
    if(a[0]==='systemctl'||(a[0]==='sudo'&&a[1]==='systemctl')){
      let t=a[0]==='sudo'?a.slice(1):a.slice(0),act=t[1],svc=t[2];
      if(!['slurmd','kubelet'].includes(svc))return err('Supported services: slurmd, kubelet');
      if(act==='status')return `${svc}.service - ${svc}\nActive: ${svc==='slurmd'?(n.slurmd?'active (running)':'inactive (dead)'):(k.kubelet?'active (running)':'inactive (dead)')}`;
      if(act==='restart'){
        if(svc==='slurmd'){
          if(s.id==='slurm-gres'&&s.gresFileCount!==8)return err('slurmd restart failed: GRES file still reports Count=0; resolve mapping first');
          n.slurmd=true;n.gres=s.gresFileCount;if(!s.xid){n.state='IDLE';n.reason=''}return 'slurmd restarted; re-read node GRES with scontrol.';
        }
        k.kubelet=true;if(s.id==='k8s-node')k.ready=true;return 'kubelet restarted; node reports Ready.';
      }
      return err('Supported actions: status or restart');
    }
    if(cmd.startsWith('journalctl ')){
      if(cmd.includes(' -k ')||cmd.startsWith('journalctl -k'))return s.xid?'Nov 19 kernel: NVRM: Xid (PCI:0000:41:00): 79, GPU has fallen off the bus':'Nov 19 kernel: No NVIDIA Xid events detected';
      if(cmd.includes('-u slurmd'))return n.slurmd?'slurmd: node daemon healthy':'slurmd: service stopped unexpectedly; no GPU errors reported';
      if(cmd.includes('-u kubelet'))return k.kubelet?'kubelet: node healthy':'kubelet: service stopped; node readiness failing';
      return err('Supported: journalctl -k -n 30; journalctl -u SERVICE -n 20');
    }
    if(a[0]==='nvidia-smi')return `NVIDIA-SMI (SYNTHETIC)\nGPU 0..7: NVIDIA H100 80GB\nDetected devices: ${n.hardware}\n${s.xid?'GPU 2: not accessible; prior Xid 79 in kernel logs':'GPU health: nominal'}\nUse journalctl -k for NVIDIA Xid details.`;
    if(a[0]==='dcgmi'&&a[1]==='diag')return `DCGM diagnostics (simulated): ${s.xid?'GPU 2 diagnostic failed; refer to Xid log':'PASS for detected GPUs'}`;
    if(cmd==='nvsm show health')return `NVSM platform health (simulated): ${s.xid?'Degraded - GPU 2':'Healthy'}`;
    if(cmd==='df -h')return `Filesystem Size Used Avail Use% Mounted on\n/shared 1.0T ${s.storageFull?'1.0T':'600G'} ${s.storageFull?'0':'400G'} ${s.storageFull?'100%':'60%'} /shared`;
    if(cmd==='du -sh /shared/*')return s.storageFile?'400G /shared/old-checkpoint.tmp\n600G /shared/datasets':'600G /shared/datasets';
    if(cmd==='ls -lh /shared/old-checkpoint.tmp')return s.storageFile?'-rw-r--r-- 1 trainer trainer 400G /shared/old-checkpoint.tmp':'ls: cannot access: No such file';
    if(cmd==='rm /shared/old-checkpoint.tmp'){
      if(!s.storageFile)return err('File does not exist');s.storageFile=false;s.storageFull=false;return 'Removed /shared/old-checkpoint.tmp (explicitly approved training artifact).';
    }
    if(a[0]==='kubectl')return kube(s,cmd);
    if(a[0]==='ibstat')return 'CA mlx5_0 Port 1 State: Active Physical state: LinkUp Rate: 400 Gb/sec (synthetic)';
    return err('Unsupported simulated command: '+cmd+'. Type help or COMMAND --help.');
  }
  function kube(s,cmd){
    const k=s.k8s,t=cmd.replace(/\s+(?:-n|--namespace)\s+\S+/g,'').replace(/\s+--namespace=\S+/g,'').trim(),a=t.split(' ');
    const ns=cmd.match(/(?:-n|--namespace)\s+(\S+)/)?.[1]||cmd.match(/--namespace=(\S+)/)?.[1]||'default';
    let status=k.image!==GOOD_IMAGE?'ImagePullBackOff':!k.kubelet||k.taint||!k.plugin?'Pending':!k.env?'CrashLoopBackOff':'Running';
    if(ns!=='default'&&ns!=='gpu-operator'&&ns!=='kube-system')return err('namespace "'+ns+'" not found');
    if(a[1]==='get'){
      if(['pod','pods','po'].includes(a[2]))return ns==='default'?`NAME READY STATUS RESTARTS AGE\ninference ${status==='Running'?'1/1':'0/1'} ${status} ${status==='CrashLoopBackOff'?5:0} 6m`:`NAME READY STATUS\nnvidia-device-plugin-daemonset-pq7lm ${k.plugin?'1/1':'0/1'} ${k.plugin?'Running':'CrashLoopBackOff'}`;
      if(['node','nodes'].includes(a[2]))return `NAME STATUS ROLES AGE\nnode001 Ready worker 24d\nnode002 ${k.kubelet?'Ready':'NotReady'} worker 24d`;
      if(['deployment','deploy','deployments','deployment/inference'].includes(a[2])){
        if(a[3]&&!a[3].startsWith('-')&&a[3]!=='inference')return err('Deployment '+a[3]+' not found');
        if(a.includes('-o'))return `apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: inference}\nspec:\n  template:\n    spec:\n      containers:\n      - name: inference\n        image: ${k.image}\n        env: ${k.env?'MODEL_PATH=/models':'[]'}`;
        return `NAME READY UP-TO-DATE AVAILABLE\ninference ${status==='Running'?'1/1':'0/1'} 1 ${status==='Running'?1:0}`;
      }
      if(['rs','replicaset','replicasets'].includes(a[2])){
        if(a[3]&&!a[3].startsWith('-')&&!['inference-previous','inference-current'].includes(a[3]))return err('ReplicaSet '+a[3]+' not found');
        if(a.includes('-o'))return `kind: ReplicaSet\nmetadata:\n  name: inference-previous\n  annotations:\n    deployment.kubernetes.io/revision: "1"\nspec:\n  template:\n    spec:\n      containers:\n      - name: inference\n        image: ${GOOD_IMAGE}\n---\nkind: ReplicaSet\nmetadata:\n  name: inference-current\n  annotations:\n    deployment.kubernetes.io/revision: "2"\nspec:\n  template:\n    spec:\n      containers:\n      - name: inference\n        image: ${k.image}`;
        return `NAME DESIRED CURRENT READY\ninference-previous 0 0 0\ninference-current 1 1 ${status==='Running'?1:0}`;
      }
      if(['daemonset','daemonsets','ds'].includes(a[2]))return ns==='gpu-operator'?`NAME DESIRED CURRENT READY\nnvidia-device-plugin-daemonset 2 2 ${k.plugin?'2':'0'}`:'No resources found in '+ns+' namespace';
      return err('Supported kubectl get targets: pods, nodes, deployments, rs, daemonset');
    }
    if(a[1]==='describe'){
      if(a[2]==='pod'&&a[3]==='inference')return `Name: inference\nNamespace: default\nImage: ${k.image}\nStatus: ${status}\nEvents:\n${status==='ImagePullBackOff'?'Warning Failed: manifest for '+k.image+' not found':status==='Pending'?(k.taint?'FailedScheduling: 0/2 nodes available: untolerated taint training=blocked:NoSchedule':!k.plugin?'FailedScheduling: Insufficient nvidia.com/gpu':'FailedScheduling: node002 NotReady'):status==='CrashLoopBackOff'?'Warning BackOff: Back-off restarting failed container':'Normal Pulled / Started successfully'}`;
      if(a[2]==='node'&&['node002','node001'].includes(a[3]))return `Name: ${a[3]}\nReady: ${k.kubelet?'True':'False'}\nTaints: ${k.taint&&a[3]==='node002'?'training=blocked:NoSchedule':'<none>'}\nCapacity: nvidia.com/gpu: 8\nAllocatable: nvidia.com/gpu: ${k.plugin?'8':'0'}\nConditions: ${k.kubelet?'KubeletReady':'KubeletNotReady'}`;
      if(a[2]==='deployment'&&a[3]==='inference')return `Name: inference\nContainers: inference\nImage: ${k.image}\nAvailable: ${status==='Running'?1:0}`;
      return err('Resource not found; try kubectl get pods/nodes/deployments');
    }
    if(a[1]==='logs'){
      if(t.includes('daemonset/nvidia-device-plugin-daemonset')&&ns==='gpu-operator')return k.plugin?'device plugin: GPUs registered successfully':'device plugin: registration stalled; failed to advertise devices; restart the DaemonSet after diagnosis';
      if(a[2]==='inference')return status==='CrashLoopBackOff'?'FATAL: MODEL_PATH must be set to /models':status==='ImagePullBackOff'?'Error: container cannot start because image pull failed':status==='Running'?'Inference server ready':'Container has not started';
      return err('Unknown pod or daemonset');
    }
    if(a[1]==='rollout'){
      if(a[2]==='history'&&a[3]==='deployment/inference'){if(/--revision(?:=| )1\b/.test(cmd))return 'deployment.apps/inference revision 1\nContainers:\n inference: '+GOOD_IMAGE+'\nPrevious approved rollout';return 'deployment.apps/inference\nREVISION CHANGE-CAUSE\n1 Initial approved rollout (inspect --revision=1 or previous ReplicaSet)\n2 Current rollout';}
      if(a[2]==='undo'&&a[3]==='deployment/inference'){if(/--to-revision(?:=| )(\d+)/.test(cmd)&&!/^1$/.test(cmd.match(/--to-revision(?:=| )(\d+)/)[1]))return err('Only revision 1 is retained as healthy in this simulation');k.image=GOOD_IMAGE;k.ready=true;return 'deployment.apps/inference rolled back to previously approved image; check rollout status.';}
      if(a[2]==='status'&&a[3]==='deployment/inference')return status==='Running'?'deployment "inference" successfully rolled out':'Waiting for deployment "inference": 0 of 1 replicas available. Status: '+status;
      if(a[2]==='restart'&&a[3]==='daemonset/nvidia-device-plugin-daemonset'&&ns==='gpu-operator'){
        k.plugin=true;k.ready=true;return 'daemonset.apps/nvidia-device-plugin-daemonset restarted; check node allocatable resources.';
      }
    }
    if(a[1]==='set'&&a[2]==='image'&&a[3]==='deployment/inference'){
      const m=t.match(/^kubectl set image deployment\/inference inference=(\S+)$/);if(!m)return err('Usage: kubectl set image deployment/inference inference=IMAGE');
      k.image=m[1];k.ready=m[1]===GOOD_IMAGE;return `deployment.apps/inference image updated to ${m[1]}; ${k.ready?'image matches previously approved revision':'image pull still failing'}; verify rollout.`;
    }
    if(a[1]==='set'&&a[2]==='env'&&a[3]==='deployment/inference'){
      if(a[4]!=='MODEL_PATH=/models')return err('MODEL_PATH required by application; find value in logs');
      k.env=true;k.ready=true;return 'deployment.apps/inference environment updated; pod restarted.';
    }
    if(a[1]==='taint'&&a[2]==='nodes'&&a[3]==='node002'){
      if(a[4]==='training=blocked:NoSchedule-'){if(!k.taint)return 'node/node002 does not have the specified taint; unchanged.';k.taint=false;k.ready=true;return 'node/node002 untainted; pod can now schedule.';}
      return err('Unsupported taint modification');
    }
    if(a[1]==='delete'&&a[2]==='pod'&&a[3]==='inference')return 'pod "inference" deleted; ReplicaSet recreated it with status '+status;
    return err('Unsupported Kubernetes subcommand in the simulation. '+docs.kubectl);
  }
  return {create,run,grade,healthy,defs,docs,GOOD_IMAGE,GOOD_BCM_IMAGE,ENGINE_REVISION};
})();
if(typeof window!=='undefined')window.NAVIAOps=NAVIAOps;
if(typeof module!=='undefined'&&module.exports)module.exports=NAVIAOps;
