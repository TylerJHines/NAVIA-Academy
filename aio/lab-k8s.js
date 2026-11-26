/* NAVIA Lab 2 – Kubernetes: load the module, save manifests to exact paths, apply them, read Job logs,
 * run a Pod from an image. Simulation for training only; messages follow kubectl 1.30 wording where practical. */
(function (G) {
  'use strict';
  const NL = G.NaviaLab;
  const { padR, ok, fail } = NL;

  const KNOWN_IMAGES = {
    nginx: ['1.25', '1.26', '1.27', '1.27.2', 'latest', 'alpine', '1.27-alpine', 'stable'],
    busybox: ['1.36', '1.36.1', '1.37', 'latest', 'stable'],
    httpd: ['2.4', '2.4.62', 'latest', 'alpine'],
    redis: ['7', '7.2', '7.4', 'latest', 'alpine'],
    alpine: ['3.19', '3.20', 'latest'],
    ubuntu: ['22.04', '24.04', 'latest', 'jammy', 'noble'],
    python: ['3.11', '3.12', '3.11-slim', '3.12-slim', 'latest'],
    'nvcr.io/nvidia/cuda': null, 'nvcr.io/nvidia/pytorch': null, 'nvcr.io/nvidia/tritonserver': null, 'nvcr.io/nvidia/k8s/cuda-sample': null
  };
  const SERVERS = ['nginx', 'httpd', 'redis', 'nvcr.io/nvidia/tritonserver'];
  const splitImage = img => { const at = img.lastIndexOf(':'); const slash = img.lastIndexOf('/'); return at > slash ? [img.slice(0, at), img.slice(at + 1)] : [img, 'latest']; };
  const imageOk = img => { let [repo, tag] = splitImage(img); repo = repo.replace(/^docker\.io\/(library\/)?/, ''); if (!(repo in KNOWN_IMAGES)) return false; return KNOWN_IMAGES[repo] === null || KNOWN_IMAGES[repo].includes(tag); };
  const fullRef = img => { const [repo, tag] = splitImage(img); return repo.includes('/') && repo.includes('.') ? `${repo}:${tag}` : `docker.io/library/${repo}:${tag}`; };

  /* allowed fields for strict decoding (subset of the real schema) */
  const F = {
    top: ['apiVersion', 'kind', 'metadata', 'spec', 'status'],
    meta: ['name', 'namespace', 'labels', 'annotations', 'generateName', 'creationTimestamp', 'uid', 'resourceVersion', 'ownerReferences', 'finalizers'],
    pod: ['containers', 'initContainers', 'restartPolicy', 'nodeSelector', 'nodeName', 'tolerations', 'affinity', 'volumes', 'serviceAccountName', 'serviceAccount', 'imagePullSecrets', 'terminationGracePeriodSeconds', 'activeDeadlineSeconds', 'hostNetwork', 'hostPID', 'hostIPC', 'securityContext', 'runtimeClassName', 'dnsPolicy', 'priorityClassName', 'schedulerName', 'hostname', 'subdomain', 'enableServiceLinks', 'automountServiceAccountToken', 'shareProcessNamespace', 'topologySpreadConstraints', 'priority', 'preemptionPolicy', 'overhead', 'dnsConfig', 'hostAliases', 'readinessGates', 'os', 'resourceClaims', 'schedulingGates', 'ephemeralContainers'],
    ctr: ['name', 'image', 'command', 'args', 'env', 'envFrom', 'ports', 'resources', 'imagePullPolicy', 'volumeMounts', 'volumeDevices', 'workingDir', 'securityContext', 'livenessProbe', 'readinessProbe', 'startupProbe', 'lifecycle', 'stdin', 'stdinOnce', 'tty', 'terminationMessagePath', 'terminationMessagePolicy', 'resizePolicy', 'restartPolicy'],
    job: ['template', 'backoffLimit', 'completions', 'parallelism', 'activeDeadlineSeconds', 'ttlSecondsAfterFinished', 'selector', 'manualSelector', 'suspend', 'completionMode', 'podFailurePolicy', 'backoffLimitPerIndex', 'maxFailedIndexes', 'podReplacementPolicy', 'successPolicy', 'managedBy'],
    tmpl: ['metadata', 'spec'],
    deploy: ['replicas', 'selector', 'template', 'strategy', 'minReadySeconds', 'revisionHistoryLimit', 'progressDeadlineSeconds', 'paused']
  };
  const KINDS = { Pod: ['v1', 'pods', 'pod'], Job: ['batch/v1', 'jobs.batch', 'job.batch'], Deployment: ['apps/v1', 'deployments.apps', 'deployment.apps'] };
  const RFC1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
  const LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
  const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
  const goType = x => Array.isArray(x) ? 'array' : x === null ? 'null' : typeof x === 'object' ? 'object' : typeof x === 'number' ? 'number' : typeof x === 'boolean' ? 'bool' : 'string';

  function create(cfg) {
    const mode = cfg.mode || 'practice', practice = mode === 'practice';
    const seed = cfg.seed >>> 0, r = NL.rng(seed);
    const asRoot = cfg.user !== 'student'; // the exam ran as root with paths like /root/lab2/hello-job.yaml
    const H = asRoot ? '/root' : '/home/student';
    const sh = new NL.Shell({ mode: mode, user: asRoot ? 'root' : 'student', home: H, host: 'headnode', now: cfg.now });
    const jobChoices = [['data-prep', 'Data preparation finished'], ['train-check', 'Training check passed'], ['gpu-smoke', 'GPU smoke test OK'], ['etl-batch', 'ETL batch done']];
    const jc = NL.pick(r, jobChoices);
    const P = practice ? {
      jobName: 'training', jobImage: 'busybox:1.36', jobMsg: 'Training job complete', jobPath: asRoot ? '/root/lab2/training-job.yaml' : '/home/student/jobs/training.yaml',
      podName: 'inference', podImage: 'nginx:1.27', podPath: asRoot ? '/root/lab2/inference-pod.yaml' : '/home/student/workloads/inference.yaml',
      runName: 'inference-direct', runImage: 'nginx:1.27', logMode: 'show', logPath: null, seed: seed
    } : (() => {
      const podName = NL.pick(r, ['web-frontend', 'inference-api', 'model-server']);
      const logMode = NL.pick(r, ['show', 'save']);
      return {
        jobName: jc[0], jobImage: 'busybox:1.36', jobMsg: jc[1], jobPath: `${H}/${NL.pick(r, asRoot ? ['lab2', 'manifests', 'k8s'] : ['jobs', 'manifests', 'k8s'])}/${jc[0]}.yaml`,
        podName: podName, podImage: NL.pick(r, ['nginx:1.27', 'httpd:2.4']), podPath: `${H}/${NL.pick(r, asRoot ? ['lab2', 'apps', 'deploy'] : ['workloads', 'apps', 'deploy'])}/${podName}.yaml`,
        runName: NL.pick(r, ['cache', 'web-direct', 'api-direct']), runImage: NL.pick(r, ['redis:7.2', 'nginx:1.27', 'httpd:2.4']),
        logMode: logMode, logPath: logMode === 'save' ? `${H}/${jc[0]}-logs.txt` : null, seed: seed
      };
    })();
    sh.mkdirp(NL.dirname(P.jobPath)); sh.mkdirp(NL.dirname(P.podPath)); // on the exam the folders already exist
    // the exam gives you the manifests; you save them to the exact path and apply them
    const JOB_YAML = ['apiVersion: batch/v1', 'kind: Job', 'metadata:', `  name: ${P.jobName}`, 'spec:', '  template:', '    spec:', '      restartPolicy: Never', '      containers:', `      - name: ${P.jobName}`, `        image: ${P.jobImage}`, `        command: ["sh", "-c", "echo ${P.jobMsg}"]`];
    const POD_YAML = ['apiVersion: v1', 'kind: Pod', 'metadata:', `  name: ${P.podName}`, 'spec:', '  containers:', `  - name: ${P.podName}`, `    image: ${P.podImage}`, '    ports:', '    - containerPort: 80'];
    const t0 = sh.now();

    let moduleLoaded = false;
    /* objects live in namespaces; pods/jobs/deps point at the namespace the current kubectl command uses */
    const NSS = {};
    const SYSTEM_NS = ['kube-system', 'kube-public', 'kube-node-lease', 'gpu-operator'];
    const mkNs = (n, t) => { NSS[n] = { pods: {}, jobs: {}, deps: {}, created: t }; };
    ['default'].concat(SYSTEM_NS).forEach(n => mkNs(n, t0 - 12 * 86400e3));
    let curNs = 'default', cmdNs = 'default', cmdNsExplicit = false;
    let pods = NSS.default.pods, jobs = NSS.default.jobs, deps = NSS.default.deps;
    const useNs = n => { const st = NSS[n] || { pods: {}, jobs: {}, deps: {} }; curNs = n; pods = st.pods; jobs = st.jobs; deps = st.deps; };
    const allObjs = kind => Object.values(NSS).flatMap(st => Object.values(st[kind]));
    const podsOf = o => (NSS[o.ns] || { pods: {} }).pods;
    const ev = { nodesShown: false, logsShown: false, verify: false };
    let lastJobLogs = null;
    let podSeq = 10;
    const NODES = [['node001', 'control-plane', '10.141.0.1'], ['node002', '<none>', '10.141.0.2'], ['node003', '<none>', '10.141.0.3']];
    const SYS = [['calico-kube-controllers-7c9f5d6b8-x2mpl', 'kube-system'], ['calico-node-4hk8z', 'kube-system'], ['calico-node-9qwnd', 'kube-system'], ['calico-node-tz7cr', 'kube-system'], ['coredns-76f75df574-8lwgk', 'kube-system'], ['coredns-76f75df574-rv2xb', 'kube-system'], ['metrics-server-6d94bc8694-kqz4t', 'kube-system'], ['nvidia-device-plugin-daemonset-5wq7d', 'gpu-operator'], ['nvidia-device-plugin-daemonset-b8m2k', 'gpu-operator']];

    /* ---- pod lifecycle ---- */
    function ctrOf(p) { return p.spec.containers[0]; }
    function longRunning(c) {
      const repo = splitImage(c.image)[0].replace(/^docker\.io\/(library\/)?/, '');
      const full = [].concat(c.command || [], c.args || []).join(' ');
      if (/sleep\s+(infinity|\d{3,})|tail\s+-f|while\s+true/.test(full)) return true;
      if (c.command && c.command.length) return false;
      return SERVERS.includes(repo);
    }
    function shortRuntime(c) { const m = /sleep\s+(\d+)/.exec([].concat(c.command || [], c.args || []).join(' ')); return 4000 + (m ? +m[1] * 1000 : 0); }
    function pstatus(p) {
      const age = sh.now() - p.created, c = ctrOf(p);
      if (p.deleting) return { st: 'Terminating', ready: '0/1', restarts: 0 };
      if (!imageOk(c.image)) return { st: age < 2500 ? 'ContainerCreating' : (Math.floor(age / 15000) % 2 ? 'ImagePullBackOff' : 'ErrImagePull'), ready: '0/1', restarts: 0, bad: true };
      if (age < 2500) return { st: 'ContainerCreating', ready: '0/1', restarts: 0 };
      if (longRunning(c)) return { st: 'Running', ready: '1/1', restarts: 0, started: p.created + 2500 };
      const rt = shortRuntime(c);
      if (age < 2500 + rt) return { st: 'Running', ready: '1/1', restarts: 0, started: p.created + 2500 };
      const rp = p.spec.restartPolicy || 'Always';
      if (rp === 'Always') { const restarts = 1 + Math.floor((age - 2500 - rt) / 12000); return { st: (age - 2500 - rt) % 12000 < 2000 ? 'Completed' : 'CrashLoopBackOff', ready: '0/1', restarts: restarts, crash: true, started: p.created + 2500 }; }
      return { st: 'Completed', ready: '0/1', restarts: 0, done: true, finished: p.created + 2500 + rt, started: p.created + 2500 };
    }
    function jobStatus(j) {
      const p = podsOf(j)[j.podName];
      if (!p) return { st: 'Running', comp: '0/1', dur: NL.age(sh.now() - j.created) };
      const s = pstatus(p);
      if (s.done) return { st: 'Complete', comp: '1/1', dur: NL.age(s.finished - j.created), done: true };
      return { st: 'Running', comp: '0/1', dur: NL.age(sh.now() - j.created) };
    }
    function interpretScript(script, p) {
      const out = [];
      script.split(/\n|;|&&/).map(x => x.trim()).filter(Boolean).forEach(cmd => {
        const sub = s => s.replace(/\$\(hostname\)|`hostname`|\$HOSTNAME|\$\{HOSTNAME\}/g, p.name).replace(/\$\(date\)|`date`/g, NL.dateCmd(p.created + 3000).replace(` ${NL.tz} `, ' UTC '));
        if (/^echo\b/.test(cmd)) { let t = cmd.replace(/^echo\s*(-[ne]\s+)?/, ''); const toks = NL.tokenize(t, { HOSTNAME: p.name }); t = toks.toks ? toks.toks.filter(x => x.t === 'w').map(x => x.v).join(' ') : t; out.push(sub(t)); }
        else if (/^date\b/.test(cmd)) out.push(sub('$(date)'));
        else if (/^hostname\b/.test(cmd)) out.push(p.name);
        else if (/^(sleep|true|exit\s+0|cd|export)\b/.test(cmd)) { /* no output */ }
        else if (/^(printenv|env)\b/.test(cmd)) out.push(`PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nHOSTNAME=${p.name}\nKUBERNETES_SERVICE_HOST=10.150.0.1\nKUBERNETES_SERVICE_PORT=443\nHOME=/root`);
        else if (/^cat\s+\/etc\/os-release/.test(cmd)) out.push('NAME="BusyBox"');
        else out.push(`sh: ${cmd.split(/\s+/)[0]}: not found`);
      });
      return out;
    }
    function podLogs(p) {
      const c = ctrOf(p); const repo = splitImage(c.image)[0].replace(/^docker\.io\/(library\/)?/, '');
      const full = [].concat(c.command || [], c.args || []);
      if (full.length) {
        if (/^(\/bin\/)?(ba)?sh$/.test(full[0]) && full[1] === '-c') return interpretScript(String(full[2] || ''), p);
        if (full[0] === 'echo' || full[0] === '/bin/echo') return [full.slice(1).join(' ')];
        if (/^(\/bin\/)?(ba)?sh$/.test(full[0])) return [];
        return interpretScript(full.join(' '), p);
      }
      const ts = NL.isoTime(p.created + 2600).replace('T', ' ').replace(/-/g, '/');
      if (repo === 'nginx') return ['/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration', '/docker-entrypoint.sh: Looking for shell scripts in /docker-entrypoint.d/', '/docker-entrypoint.sh: Launching /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh', '10-listen-on-ipv6-by-default.sh: info: Enabled listen on IPv6 in /etc/nginx/conf.d/default.conf', '/docker-entrypoint.sh: Configuration complete; ready for start up', `${ts} [notice] 1#1: using the "epoll" event method`, `${ts} [notice] 1#1: nginx/1.27.2`, `${ts} [notice] 1#1: start worker processes`];
      if (repo === 'httpd') return [`AH00558: httpd: Could not reliably determine the server's fully qualified domain name, using ${p.ip}. Set the 'ServerName' directive globally to suppress this message`, `[${new Date(p.created + 2600).toUTCString()}] [mpm_event:notice] [pid 1:tid 1] AH00489: Apache/2.4.62 (Unix) configured -- resuming normal operations`];
      if (repo === 'nvcr.io/nvidia/k8s/cuda-sample' && /vectoradd/.test(splitImage(c.image)[1])) return ['[Vector addition of 50000 elements]', 'Copy input data from the host memory to the CUDA device', 'CUDA kernel launch with 196 blocks of 256 threads', 'Copy output data from the CUDA device to the host memory', 'Test PASSED', 'Done'];
      if (repo === 'redis') return ['1:C 24 Nov 2026 * oO0OoO0OoO0Oo Redis is starting oO0OoO0OoO0Oo', '1:C * Redis version=7.2.6, bits=64, commit=00000000, modified=0, pid=1, just started', '1:M * Running mode=standalone, port=6379.', '1:M * Server initialized', '1:M * Ready to accept connections tcp'];
      return [];
    }

    /* ---- validation like the API server ---- */
    function validate(doc, src) {
      const where = src === '-' ? 'STDIN' : src;
      if (!isObj(doc)) return { err: `error: error validating "${where}": error validating data: invalid object to validate; if you choose to ignore these errors, turn validation off with --validate=false` };
      const miss = []; if (!doc.apiVersion) miss.push('apiVersion not set'); if (!doc.kind) miss.push('kind not set');
      if (miss.length) return { err: `error: error validating "${where}": error validating data: [${miss.join(', ')}]; if you choose to ignore these errors, turn validation off with --validate=false` };
      const kind = doc.kind, name = isObj(doc.metadata) ? doc.metadata.name : undefined;
      if (!KINDS[kind] || KINDS[kind][0] !== doc.apiVersion) return { err: `error: resource mapping not found for name: "${name || ''}" namespace: "" from "${where}": no matches for kind "${kind}" in version "${doc.apiVersion}"\nensure CRDs are installed first` };
      const bad = (path, expect, got) => ({ err: `Error from server (BadRequest): error when creating "${where}": ${kind} in version "${doc.apiVersion.replace(/^.*\//, '')}" cannot be handled as a ${kind}: json: cannot unmarshal ${got} into Go struct field ${path} of type ${expect}` });
      const unknown = [];
      const check = (obj, allowed, prefix) => { if (isObj(obj)) Object.keys(obj).forEach(k => { if (!allowed.includes(k)) unknown.push(`unknown field "${prefix}${k}"`); }); };
      check(doc, F.top, '');
      if (doc.metadata !== undefined && !isObj(doc.metadata)) return bad('ObjectMeta.metadata', 'v1.ObjectMeta', goType(doc.metadata));
      check(doc.metadata, F.meta, 'metadata.');
      if (doc.metadata && doc.metadata.labels !== undefined && !isObj(doc.metadata.labels)) return bad('ObjectMeta.metadata.labels', 'map[string]string', goType(doc.metadata.labels));
      let podSpec, pfx, tmplLabels = null;
      if (kind === 'Pod') { podSpec = doc.spec; pfx = 'spec.'; }
      else {
        if (doc.spec !== undefined && !isObj(doc.spec)) return bad(`${kind}.spec`, `v1.${kind}Spec`, goType(doc.spec));
        check(doc.spec, kind === 'Job' ? F.job : F.deploy, 'spec.');
        const t = doc.spec && doc.spec.template;
        if (t !== undefined && !isObj(t)) return bad(`${kind}Spec.spec.template`, 'v1.PodTemplateSpec', goType(t));
        check(t, F.tmpl, 'spec.template.');
        check(t && t.metadata, F.meta, 'spec.template.metadata.');
        tmplLabels = t && isObj(t.metadata) ? t.metadata.labels : null;
        podSpec = t && t.spec; pfx = 'spec.template.spec.';
      }
      if (podSpec !== undefined && !isObj(podSpec)) return bad(`${kind === 'Pod' ? 'Pod' : 'PodTemplateSpec'}.${pfx.slice(0, -1)}`, 'v1.PodSpec', goType(podSpec));
      check(podSpec, F.pod, pfx);
      const ctrs = podSpec && podSpec.containers;
      if (ctrs !== undefined && ctrs !== null && !Array.isArray(ctrs)) return bad(`PodSpec.${pfx}containers`, '[]v1.Container', goType(ctrs));
      (ctrs || []).forEach((c, i) => {
        if (!isObj(c)) return;
        check(c, F.ctr, `${pfx}containers[${i}].`);
      });
      for (let i = 0; i < (ctrs || []).length; i++) {
        const c = ctrs[i];
        if (!isObj(c)) return bad(`PodSpec.${pfx}containers`, 'v1.Container', goType(c));
        for (const k of ['command', 'args']) if (c[k] !== undefined && c[k] !== null && !Array.isArray(c[k])) return bad(`Container.${pfx}containers.${k}`, '[]string', goType(c[k]));
        if (c.image !== undefined && typeof c.image !== 'string') return bad(`Container.${pfx}containers.image`, 'string', goType(c.image));
      }
      if (unknown.length) return { err: `Error from server (BadRequest): error when creating "${where}": ${kind} in version "${doc.apiVersion.replace(/^.*\//, '')}" cannot be handled as a ${kind}: strict decoding error: ${unknown.join(', ')}` };
      const ns = doc.metadata && doc.metadata.namespace;
      if (ns && !NSS[ns]) return { err: `Error from server (NotFound): error when creating "${where}": namespaces "${ns}" not found` };
      const errs = [];
      if (!name) errs.push('metadata.name: Required value: name or generateName is required');
      else if (!RFC1123.test(String(name))) errs.push(`metadata.name: Invalid value: "${name}": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character (e.g. 'example.com', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*')`);
      if (!ctrs || !ctrs.length) errs.push(`${pfx}containers: Required value`);
      (ctrs || []).forEach((c, i) => {
        if (!c.name) errs.push(`${pfx}containers[${i}].name: Required value`);
        else if (!LABEL.test(String(c.name))) errs.push(`${pfx}containers[${i}].name: Invalid value: "${c.name}": a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character (e.g. 'my-name',  or '123-abc', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?')`);
        if (!c.image) errs.push(`${pfx}containers[${i}].image: Required value`);
      });
      const rp = podSpec && podSpec.restartPolicy;
      if (rp !== undefined && !['Always', 'OnFailure', 'Never'].includes(rp)) errs.push(`${pfx}restartPolicy: Unsupported value: "${rp}": supported values: "Always", "OnFailure", "Never"`);
      else if (kind === 'Job' && (!rp || rp === 'Always')) errs.push(rp ? `${pfx}restartPolicy: Unsupported value: "Always": supported values: "OnFailure", "Never"` : `${pfx}restartPolicy: Required value: valid values: "OnFailure", "Never"`);
      if (kind === 'Deployment') {
        const sel = doc.spec && doc.spec.selector;
        if (!sel || !isObj(sel.matchLabels)) errs.push('spec.selector: Required value');
        else if (!tmplLabels || Object.entries(sel.matchLabels).some(([k, v]) => tmplLabels[k] !== v)) errs.push(`spec.template.metadata.labels: Invalid value: ${JSON.stringify(tmplLabels || {}).replace(/"/g, '"')}: \`selector\` does not match template \`labels\``);
      }
      if (errs.length) return { err: `The ${kind} "${name || ''}" is invalid: ${errs.length > 1 ? '[' + errs.join(', ') + ']' : errs[0]}`, invalid: true };
      return { kind: kind, name: name, doc: doc };
    }

    /* ---- object creation ---- */
    const kTime = t => { const d = new Date(t); const off = -d.getTimezoneOffset(); const sign = off >= 0 ? '+' : '-'; const two = n => String(Math.abs(n)).padStart(2, '0'); return `${d.toString().slice(0, 3)}, ${two(d.getDate())} ${d.toString().slice(4, 7)} ${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${sign}${two(Math.floor(Math.abs(off) / 60))}${two(Math.abs(off) % 60)}`; };
    const eventTable = rows => { const w = [4, 6, 3, 4].map((n, i) => Math.max(n, ...rows.map(r => r[i].length))); const pad = (v, i) => v.padEnd(w[i]); return ['  ' + ['Type', 'Reason', 'Age', 'From'].map(pad).join('  ') + '  Message', '  ' + ['----', '------', '----', '----'].map(pad).join('  ') + '  -------'].concat(rows.map(r => '  ' + r.slice(0, 4).map(pad).join('  ') + '  ' + r[4])).join('\n'); };
    const newIp = () => `10.244.${NL.int(r, 1, 2)}.${NL.int(r, 10, 250)}`;
    function makePod(name, spec, labels, source, owner) {
      const node = NODES[1 + (podSeq++ % 2)][0];
      pods[name] = { ns: curNs, name: name, spec: JSON.parse(JSON.stringify(spec)), labels: labels || {}, created: sh.now(), source: source, owner: owner || null, node: node, ip: newIp(), uid: NL.hex(r, 8) };
      return pods[name];
    }
    function applyDoc(v, how, src) {
      const { kind, name, doc } = v;
      const res = KINDS[kind][2];
      const store = kind === 'Pod' ? pods : kind === 'Job' ? jobs : deps;
      const prev = store[name];
      const specStr = JSON.stringify(doc.spec);
      if (prev) {
        if (how === 'create') return fail(`Error from server (AlreadyExists): error when creating "${src}": ${KINDS[kind][1]} "${name}" already exists`);
        if (prev.specStr === specStr) return ok(`${res}/${name} unchanged`);
        if (kind === 'Pod') {
          const a = JSON.parse(prev.specStr), b = JSON.parse(specStr);
          (a.containers || []).forEach((c, i) => { if (b.containers && b.containers[i]) c.image = b.containers[i].image; });
          if (JSON.stringify(a) !== JSON.stringify(b)) return fail(`The Pod "${name}" is invalid: spec: Forbidden: pod updates may not change fields other than \`spec.containers[*].image\`,\`spec.initContainers[*].image\`,\`spec.activeDeadlineSeconds\`,\`spec.tolerations\` (only additions to existing tolerations),\`spec.terminationGracePeriodSeconds\` (allow it to be set to 1 if it was previously negative)`);
          prev.spec = b; prev.specStr = specStr; prev.created = sh.now();
          if (practice) sh.hint('Only the image of a running Pod can be changed in place. For other changes: kubectl delete pod NAME, then apply again.');
          return ok(`pod/${name} configured`);
        }
        if (kind === 'Job') { if (practice) sh.hint('A Job\'s pod template is immutable. Delete the Job (kubectl delete job NAME) and apply the file again.'); return fail(`The Job "${name}" is invalid: spec.template: Invalid value: core.PodTemplateSpec{...}: field is immutable`); }
        prev.specStr = specStr; prev.doc = doc; return ok(`deployment.apps/${name} configured`);
      }
      const source = { how: how, path: src };
      if (kind === 'Pod') { const p = makePod(name, doc.spec, doc.metadata.labels, source); p.specStr = specStr; p.doc = doc; }
      else if (kind === 'Job') {
        const podName = `${name}-${NL.alnum(r, 5)}`;
        jobs[name] = { ns: curNs, name: name, doc: doc, specStr: specStr, created: sh.now(), source: source, podName: podName };
        makePod(podName, doc.spec.template.spec, Object.assign({ 'batch.kubernetes.io/job-name': name, 'job-name': name }, (doc.spec.template.metadata || {}).labels), source, { kind: 'Job', name: name });
      } else {
        const hash = NL.hex(r, 10), reps = doc.spec.replicas == null ? 1 : doc.spec.replicas;
        deps[name] = { ns: curNs, name: name, doc: doc, specStr: specStr, created: sh.now(), source: source, hash: hash, pods: [] };
        for (let i = 0; i < reps; i++) { const pn = `${name}-${hash}-${NL.alnum(r, 5)}`; makePod(pn, doc.spec.template.spec, doc.spec.template.metadata.labels, source, { kind: 'ReplicaSet', name: `${name}-${hash}` }); deps[name].pods.push(pn); }
      }
      return ok(`${res}/${name} created`);
    }
    function fromFile(path, how, stdin) {
      let text, src = path;
      if (path === '-') text = stdin || '';
      else {
        const p = sh.resolve(path);
        if (sh.isDir(p)) { const files = sh.listDir(p).filter(n => /\.(ya?ml|json)$/.test(n)); if (!files.length) return fail(`error: no objects passed to ${how}`); return files.map(f => fromFile((path.replace(/\/$/, '')) + '/' + f, how)).reduce((a, b) => ({ out: [a.out, b.out].filter(Boolean).join('\n'), err: [a.err, b.err].filter(Boolean).join('\n'), code: a.code || b.code })); }
        text = sh.read(p);
        if (text === undefined) { if (practice) sh.hint(`There is no file at ${path}. Check the path with ls, and create it with nano/vi or a heredoc (cat <<'EOF' > ${path}).`); return fail(`error: the path "${path}" does not exist`); }
        src = path;
      }
      let docs;
      try { docs = text.trim().startsWith('{') ? [JSON.parse(text)] : NL.yaml.parse(text); }
      catch (e) { if (practice) sh.hint('The YAML could not be parsed. Check the indentation (spaces, never tabs) on and just before the reported line.'); return fail(`error: error parsing ${src === '-' ? 'STDIN' : src}: error converting YAML to JSON: ${e.message}`); }
      if (!docs.length) return fail(`error: no objects passed to ${how}`);
      const outs = [], errs = [];
      for (const d of docs) {
        if (isObj(d) && d.kind === 'Namespace' && d.apiVersion === 'v1') { const r2 = createNs(isObj(d.metadata) ? d.metadata.name : '', how, cmdCtx); if (r2.out) outs.push(r2.out); if (r2.err) errs.push(r2.err); continue; }
        const v = validate(d, src);
        if (v.err) { errs.push(v.err.startsWith('The ') ? `Error from server (Invalid): error when creating "${src === '-' ? 'STDIN' : src}": ${v.err}` : v.err); continue; }
        const docNs = d.metadata.namespace;
        if (cmdNsExplicit && docNs && docNs !== cmdNs) { errs.push(`error: the namespace from the provided object "${docNs}" does not match the namespace "${cmdNs}". You must pass '--namespace=${docNs}' to perform this operation.`); continue; }
        useNs(docNs || cmdNs);
        const r2 = applyDoc(v, how, src === '-' ? '-' : sh.resolve(src));
        useNs(cmdNs);
        if (r2.out) outs.push(r2.out); if (r2.err) errs.push(r2.err);
      }
      return { out: outs.join('\n'), err: errs.join('\n'), code: errs.length ? 1 : 0 };
    }

    /* ---- manifests produced by imperative commands (also used for --dry-run=client -o yaml) ---- */
    function podManifest(name, image, restart, cmd, args, labels, port) {
      const c = { name: name, image: image }; if (cmd && cmd.length) c.command = cmd; if (args && args.length) c.args = args; if (port) c.ports = [{ containerPort: +port }]; c.resources = {};
      return { apiVersion: 'v1', kind: 'Pod', metadata: { creationTimestamp: null, labels: labels || { run: name }, name: name }, spec: { containers: [c], dnsPolicy: 'ClusterFirst', restartPolicy: restart || 'Always' }, status: {} };
    }
    function jobManifest(name, image, cmd) {
      const c = { image: image, name: name, resources: {} }; if (cmd && cmd.length) c.command = cmd;
      return { apiVersion: 'batch/v1', kind: 'Job', metadata: { creationTimestamp: null, name: name }, spec: { template: { metadata: { creationTimestamp: null }, spec: { containers: [c], restartPolicy: 'Never' } } }, status: {} };
    }
    function deployManifest(name, image, reps) {
      return { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { creationTimestamp: null, labels: { app: name }, name: name }, spec: { replicas: reps, selector: { matchLabels: { app: name } }, strategy: {}, template: { metadata: { creationTimestamp: null, labels: { app: name } }, spec: { containers: [{ image: image, name: splitImage(image)[0].replace(/^.*\//, ''), resources: {} }] } } }, status: {} };
    }

    /* ---- flag parsing for kubectl ---- */
    function kflags(args) {
      const f = { _: [], dash: null };
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--') { f.dash = args.slice(i + 1); break; }
        let m;
        if ((m = /^--([\w-]+)=(.*)$/s.exec(a))) { f[m[1]] = m[2]; continue; }
        if ((m = /^--([\w-]+)$/.exec(a))) {
          const k = m[1];
          if (['all-namespaces', 'command', 'all', 'wait', 'force', 'rm', 'show-labels', 'watch', 'follow', 'previous', 'help', 'no-headers', 'recursive', 'overwrite'].includes(k)) { f[k] = true; continue; }
          f[k] = args[++i]; continue;
        }
        if (/^-[A-Za-z]$/.test(a)) {
          const k = a[1];
          if ('Awfhpi'.includes(k) && k !== 'f') { f[k] = true; continue; }
          f[k] = args[++i]; continue;
        }
        if ((m = /^-([A-Za-z])(.+)$/.exec(a))) { f[m[1]] = m[2]; continue; }
        f._.push(a);
      }
      return f;
    }
    const RES = { po: 'pods', pod: 'pods', pods: 'pods', job: 'jobs', jobs: 'jobs', 'jobs.batch': 'jobs', deploy: 'deployments', deployment: 'deployments', deployments: 'deployments', no: 'nodes', node: 'nodes', nodes: 'nodes', ns: 'namespaces', namespace: 'namespaces', namespaces: 'namespaces', svc: 'services', service: 'services', services: 'services', rs: 'replicasets', replicaset: 'replicasets', replicasets: 'replicasets', all: 'all', ev: 'events', event: 'events', events: 'events' };

    /* ---- kubectl get ---- */
    function nsOf(f) { return f.A || f['all-namespaces'] ? '*' : (f.n || f.namespace || 'default'); }
    function podRows(list) {
      return list.map(p => { const s = pstatus(p); return { ns: p.ns, name: p.name, ready: s.ready, st: s.st, rs: String(s.restarts) + (s.restarts ? ` (${NL.age(Math.max(1000, (sh.now() - p.created) % 12000))} ago)` : ''), age: NL.age(sh.now() - p.created), ip: s.st === 'ContainerCreating' ? '<none>' : p.ip, node: p.node }; });
    }
    const PREFIX = { pods: 'pod/', jobs: 'job.batch/', deployments: 'deployment.apps/', nodes: 'node/', services: 'service/', replicasets: 'replicaset.apps/', namespaces: 'namespace/' };
    function retable(lines, prefix, nsCols) {
      // rebuild one aligned table from rows of several single-object tables (columns are 3+ spaces apart)
      const rows = lines.map(l => l.split(/\s{3,}/));
      const hdr = rows.shift();
      if (prefix) rows.forEach(r => { r[nsCols] = prefix + r[nsCols]; });
      return NL.table(hdr, rows, { sep: '   ' });
    }
    function getNames(type, names, f, multi) {
      const k = RES[type], o = f.o || f.output || '', plain = !['name', 'yaml', 'json'].includes(o);
      const nsCols = nsOf(f) === '*' ? 1 : 0;
      if (!names.length) {
        const r = get1(Object.assign({}, f, { _: [type] }));
        if (r.code || !multi || !plain || /^No resources found/.test(r.out)) return r;
        return ok(retable(r.out.split('\n'), PREFIX[k], nsCols));
      }
      let header = null; const rows = [], errs = [], others = [];
      names.forEach(n => {
        const r = get1(Object.assign({}, f, { _: [type, n] }));
        if (r.code) { errs.push(r.err); return; }
        if (!plain) { others.push(r.out); return; }
        const ls = r.out.split('\n'); header = header || ls[0]; rows.push(...ls.slice(1));
      });
      const out = !plain ? others.join(o === 'yaml' ? '\n---\n' : '\n') : rows.length ? retable([header].concat(rows), multi ? PREFIX[k] : '', nsCols) : '';
      return { out: out, err: errs.join('\n'), code: errs.length ? 1 : 0 };
    }
    function get(f) {
      const args = f._;
      if (args.length <= 1 && !(args[0] || '').includes(',')) return get1(f);
      const groups = [];
      if (args.every(x => x.includes('/'))) {
        args.forEach(x => { const [t, n] = x.split('/'); const g = groups.find(y => RES[y[0]] === RES[t]); if (g) g[1].push(n); else groups.push([t, [n]]); });
      } else {
        const types = args[0].split(',').filter(Boolean), names = args.slice(1);
        if (args.slice(1).some(x => x.includes('/'))) return fail('error: there is no need to specify a resource type as a separate argument when passing arguments in resource/name form (e.g. \'kubectl get resource/<resource_name>\' instead of \'kubectl get resource resource/<resource_name>\'');
        if (types.length > 1 && names.length) return fail('error: arguments in resource/name form must have a single resource and name');
        types.forEach(t => groups.push([t, names]));
      }
      const bad = groups.find(g => !RES[g[0]]);
      if (bad) return fail(`error: the server doesn't have a resource type "${bad[0]}"`);
      const multi = groups.length > 1;
      const outs = [], errs = [];
      groups.forEach(([t, names]) => { const r = getNames(t, names, f, multi); if (r.out && !(multi && /^No resources found/.test(r.out))) outs.push(r.out); if (r.err) errs.push(r.err); });
      if (!outs.length && !errs.length) { const ns = nsOf(f); return ok(ns === '*' ? 'No resources found' : `No resources found in ${ns} namespace.`); }
      return { out: outs.join('\n\n'), err: errs.join('\n'), code: errs.length ? 1 : 0 };
    }
    function get1(f) {
      const kind = RES[f._[0]];
      const rest = f._.slice(1);
      let target = rest[0];
      let k = kind;
      if (!kind && f._[0] && f._[0].includes('/')) { const [a, b] = f._[0].split('/'); k = RES[a]; target = b; }
      if (!k) return fail(f._[0] ? `error: the server doesn't have a resource type "${f._[0]}"` : 'You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.\n\nerror: Required resource not specified.\nUse "kubectl explain <resource>" for a detailed description of that resource (e.g. kubectl explain pods).\nSee \'kubectl get -h\' for help and examples');
      const ns = nsOf(f), o = f.o || f.output || '';
      const wide = o === 'wide', noHead = f['no-headers'] !== undefined;
      const all = ns === '*';
      const nsCol = all ? ['NAMESPACE'] : [];
      const emptyMsg = () => ok(all ? 'No resources found' : `No resources found in ${ns} namespace.`);
      if (k === 'nodes') {
        if (target && !NODES.some(n => n[0] === target)) return fail(`Error from server (NotFound): nodes "${target}" not found`);
        const list = NODES.filter(n => !target || n[0] === target);
        if (o === 'name') return ok(list.map(n => 'node/' + n[0]).join('\n'));
        const hdr = ['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION'].concat(wide ? ['INTERNAL-IP', 'EXTERNAL-IP', 'OS-IMAGE', 'KERNEL-VERSION', 'CONTAINER-RUNTIME'] : []);
        const rows = list.map(n => [n[0], 'Ready', n[1], '12d', 'v1.30.4'].concat(wide ? [n[2], '<none>', 'Ubuntu 22.04.4 LTS', '5.15.0-1063-nvidia', 'containerd://1.7.20'] : []));
        return ok(noHead ? NL.table(hdr, rows, { sep: '   ' }).split('\n').slice(1).join('\n') : NL.table(hdr, rows, { sep: '   ' }));
      }
      if (k === 'namespaces') {
        const names = Object.keys(NSS).sort().filter(n => !target || n === target);
        if (target && !names.length) return fail(`Error from server (NotFound): namespaces "${target}" not found`);
        if (o === 'name') return ok(names.map(n => 'namespace/' + n).join('\n'));
        return ok(NL.table(['NAME', 'STATUS', 'AGE'], names.map(n => [n, 'Active', NL.age(sh.now() - NSS[n].created)]), { sep: '   ' }));
      }
      if (ns !== '*' && !NSS[ns]) return emptyMsg();
      if (k === 'pods' || k === 'all') {
        let list = (all ? allObjs('pods') : Object.values(pods)).filter(p => !target || p.name === target).sort((a, b) => a.name < b.name ? -1 : 1);
        const sysList = SYS.filter(([n, sn]) => (all || sn === ns) && (!target || n === target));
        if (target && !list.length && k === 'pods' && !sysList.length) return fail(`Error from server (NotFound): pods "${target}" not found`);
        if (f.l || f.selector) { const sel = (f.l || f.selector).split(',').map(x => x.split('=')); list = list.filter(p => sel.every(([a, b]) => p.labels[a] === b)); }
        if (target && (o === 'yaml' || o === 'json')) {
          const p = list[0], s = pstatus(p);
          const obj = { apiVersion: 'v1', kind: 'Pod', metadata: { creationTimestamp: NL.isoTime(p.created) + 'Z', labels: p.labels, name: p.name, namespace: p.ns, uid: p.uid + '-1f2e-4c3b-9a8d-' + NL.hex(r, 12) }, spec: Object.assign({}, p.spec, { nodeName: p.node }), status: { phase: s.st === 'Running' ? 'Running' : s.done ? 'Succeeded' : 'Pending', podIP: p.ip, hostIP: NODES.find(n => n[0] === p.node)[2] } };
          return ok(o === 'json' ? JSON.stringify(obj, null, 4) : NL.yaml.dump(obj));
        }
        if (o === 'name') return ok(list.map(p => 'pod/' + p.name).join('\n'));
        let rowsData = podRows(list).map(x => (all ? [x.ns] : []).concat([(k === 'all' ? 'pod/' : '') + x.name, x.ready, x.st, x.rs, x.age]).concat(wide ? [x.ip, x.node, '<none>', '<none>'] : []));
        if (k === 'pods') rowsData = sysList.map(([n, sn]) => (all ? [sn] : []).concat([n, '1/1', 'Running', '0', '12d']).concat(wide ? ['10.244.0.' + (n.length % 200), 'node00' + (1 + n.length % 3), '<none>', '<none>'] : [])).concat(rowsData);
        if (all) rowsData.sort((a, b) => a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1)); // -A lists by namespace, then name
        const hdr = nsCol.concat(['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE']).concat(wide ? ['IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES'] : []);
        if (k === 'pods') { if (!rowsData.length) return emptyMsg(); const t = NL.table(hdr, rowsData, { sep: '   ' }); return ok(noHead ? t.split('\n').slice(1).join('\n') : t); }
        // all
        const sections = [];
        if (rowsData.length) sections.push(NL.table(hdr, rowsData, { sep: '   ' }));
        if (all || ns === 'default') sections.push(NL.table(nsCol.concat(['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE']), [(all ? ['default'] : []).concat(['service/kubernetes', 'ClusterIP', '10.150.0.1', '<none>', '443/TCP', '12d'])], { sep: '   ' }));
        const dl = all ? allObjs('deps') : Object.values(deps);
        if (dl.length) sections.push(NL.table(nsCol.concat(['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE']), dl.map(d => { const ready = d.pods.filter(n => podsOf(d)[n] && pstatus(podsOf(d)[n]).st === 'Running').length; return (all ? [d.ns] : []).concat([`deployment.apps/${d.name}`, `${ready}/${d.pods.length}`, String(d.pods.length), String(ready), NL.age(sh.now() - d.created)]); }), { sep: '   ' }));
        if (dl.length) sections.push(NL.table(nsCol.concat(['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE']), dl.map(d => (all ? [d.ns] : []).concat([`replicaset.apps/${d.name}-${d.hash}`, String(d.pods.length), String(d.pods.length), String(d.pods.filter(n => podsOf(d)[n] && pstatus(podsOf(d)[n]).st === 'Running').length), NL.age(sh.now() - d.created)])), { sep: '   ' }));
        const jl = all ? allObjs('jobs') : Object.values(jobs);
        if (jl.length) sections.push(NL.table(nsCol.concat(['NAME', 'STATUS', 'COMPLETIONS', 'DURATION', 'AGE']), jl.map(j => { const s = jobStatus(j); return (all ? [j.ns] : []).concat([`job.batch/${j.name}`, s.st, s.comp, s.dur, NL.age(sh.now() - j.created)]); }), { sep: '   ' }));
        return ok(sections.join('\n\n'));
      }
      if (k === 'jobs') {
        const list = (all ? allObjs('jobs') : Object.values(jobs)).filter(j => !target || j.name === target);
        if (target && !list.length) return fail(`Error from server (NotFound): jobs.batch "${target}" not found`);
        if (o === 'name') return ok(list.map(j => 'job.batch/' + j.name).join('\n'));
        if (target && (o === 'yaml' || o === 'json')) { const j = list[0]; const obj = Object.assign({}, j.doc, { status: jobStatus(j).done ? { succeeded: 1, completionTime: NL.isoTime(sh.now()) + 'Z' } : { active: 1 } }); return ok(o === 'json' ? JSON.stringify(obj, null, 4) : NL.yaml.dump(obj)); }
        if (!list.length) return emptyMsg();
        const hdr = nsCol.concat(['NAME', 'STATUS', 'COMPLETIONS', 'DURATION', 'AGE']).concat(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : []);
        return ok(NL.table(hdr, list.map(j => { const s = jobStatus(j); const c = j.doc.spec.template.spec.containers[0]; return (all ? [j.ns] : []).concat([j.name, s.st, s.comp, s.dur, NL.age(sh.now() - j.created)]).concat(wide ? [c.name, c.image, `batch.kubernetes.io/controller-uid=${NL.hex(r, 8)}`] : []); }), { sep: '   ' }));
      }
      if (k === 'deployments') {
        const list = (all ? allObjs('deps') : Object.values(deps)).filter(d => !target || d.name === target);
        if (target && !list.length) return fail(`Error from server (NotFound): deployments.apps "${target}" not found`);
        if (!list.length) return emptyMsg();
        return ok(NL.table(nsCol.concat(['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE']), list.map(d => { const ready = d.pods.filter(n => podsOf(d)[n] && pstatus(podsOf(d)[n]).st === 'Running').length; return (all ? [d.ns] : []).concat([d.name, `${ready}/${d.pods.length}`, String(d.pods.length), String(ready), NL.age(sh.now() - d.created)]); }), { sep: '   ' }));
      }
      if (k === 'services') return ok(NL.table(['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE'], [['kubernetes', 'ClusterIP', '10.150.0.1', '<none>', '443/TCP', '12d']], { sep: '   ' }));
      if (k === 'replicasets') { const dl = Object.values(deps); if (!dl.length) return emptyMsg(); return ok(NL.table(['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE'], dl.map(d => [`${d.name}-${d.hash}`, String(d.pods.length), String(d.pods.length), String(d.pods.length), NL.age(sh.now() - d.created)]), { sep: '   ' })); }
      if (k === 'events') return events(null);
      return emptyMsg();
    }
    function podEvents(p) {
      const c = ctrOf(p), s = pstatus(p), age = sh.now() - p.created, a = ms => NL.age(Math.max(0, age - ms));
      const ev2 = [['Normal', 'Scheduled', a(0), 'default-scheduler', `Successfully assigned ${p.ns}/${p.name} to ${p.node}`]];
      if (s.bad) {
        ev2.push(['Normal', 'Pulling', a(500), 'kubelet', `Pulling image "${c.image}"`]);
        if (age > 2500) ev2.push(['Warning', 'Failed', a(2500), 'kubelet', `Failed to pull image "${c.image}": rpc error: code = NotFound desc = failed to pull and unpack image "${fullRef(c.image)}": failed to resolve reference "${fullRef(c.image)}": ${fullRef(c.image)}: not found`], ['Warning', 'Failed', a(2500), 'kubelet', 'Error: ErrImagePull'], ['Normal', 'BackOff', a(4000), 'kubelet', `Back-off pulling image "${c.image}"`], ['Warning', 'Failed', a(4000), 'kubelet', 'Error: ImagePullBackOff']);
      } else if (age > 500) {
        ev2.push(['Normal', 'Pulled', a(1500), 'kubelet', `Container image "${c.image}" already present on machine`]);
        if (age > 2500) ev2.push(['Normal', 'Created', a(2500), 'kubelet', `Created container ${c.name}`], ['Normal', 'Started', a(2500), 'kubelet', `Started container ${c.name}`]);
        if (s.crash) ev2.push(['Warning', 'BackOff', a(6000), 'kubelet', `Back-off restarting failed container ${c.name} in pod ${p.name}_default(${p.uid})`]);
      }
      return ev2;
    }
    function events() {
      const rows = [];
      Object.values(pods).forEach(p => podEvents(p).forEach(e => rows.push([e[2], e[0], e[1], 'pod/' + p.name, e[4]])));
      Object.values(jobs).forEach(j => { rows.push([NL.age(sh.now() - j.created), 'Normal', 'SuccessfulCreate', 'job/' + j.name, `Created pod: ${j.podName}`]); if (jobStatus(j).done) rows.push(['1s', 'Normal', 'Completed', 'job/' + j.name, 'Job completed']); });
      if (!rows.length) return ok('No resources found in default namespace.');
      return ok(NL.table(['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'], rows, { sep: '   ' }));
    }
    function describe(f) {
      let k = RES[f._[0]], target = f._[1];
      if (!k && f._[0] && f._[0].includes('/')) { const [a, b] = f._[0].split('/'); k = RES[a]; target = b; }
      if (!k) return fail(`error: the server doesn't have a resource type "${f._[0] || ''}"`);
      if (k === 'nodes') { const n = NODES.find(x => x[0] === target) || NODES[1]; return ok(`Name:               ${n[0]}\nRoles:              ${n[1]}\nLabels:             kubernetes.io/hostname=${n[0]}\n                    nvidia.com/gpu.present=true\nConditions:\n  Type             Status  Reason                       Message\n  ----             ------  ------                       -------\n  MemoryPressure   False   KubeletHasSufficientMemory   kubelet has sufficient memory available\n  DiskPressure     False   KubeletHasNoDiskPressure     kubelet has no disk pressure\n  PIDPressure      False   KubeletHasSufficientPID      kubelet has sufficient PID available\n  Ready            True    KubeletReady                 kubelet is posting ready status\nAddresses:\n  InternalIP:  ${n[2]}\n  Hostname:    ${n[0]}\nCapacity:\n  cpu:                112\n  nvidia.com/gpu:     8\nSystem Info:\n  Kubelet Version:            v1.30.4\n  Container Runtime Version:  containerd://1.7.20`); }
      if (k === 'pods') {
        const list = target ? [pods[target]].filter(Boolean) : Object.values(pods);
        if (!list.length) return fail(target ? `Error from server (NotFound): pods "${target}" not found` : 'No resources found in default namespace.');
        return ok(list.map(p => {
          const c = ctrOf(p), s = pstatus(p);
          const state = s.st === 'Running' ? `Running\n      Started:      ${kTime(s.started)}` : s.done ? `Terminated\n      Reason:       Completed\n      Exit Code:    0` : s.crash ? `Waiting\n      Reason:       CrashLoopBackOff\n    Last State:     Terminated\n      Reason:       Completed\n      Exit Code:    0` : `Waiting\n      Reason:       ${s.st}`;
          const evs = podEvents(p);
          return [`Name:             ${p.name}`, `Namespace:        ${p.ns}`, 'Priority:         0', 'Service Account:  default', `Node:             ${p.node}/${NODES.find(n => n[0] === p.node)[2]}`, `Start Time:       ${kTime(p.created)}`,
            `Labels:           ${Object.entries(p.labels).map(([a, b]) => a + '=' + b).join('\n                  ') || '<none>'}`, 'Annotations:      <none>', `Status:           ${s.st === 'Running' ? 'Running' : s.done ? 'Succeeded' : 'Pending'}`, `IP:               ${s.st === 'ContainerCreating' ? '' : p.ip}`,
            p.owner ? `Controlled By:    ${p.owner.kind}/${p.owner.name}` : null, 'Containers:', `  ${c.name}:`, `    Image:          ${c.image}`,
            c.command ? `    Command:\n${c.command.map(x => '      ' + x).join('\n')}` : null, c.args ? `    Args:\n${c.args.map(x => '      ' + x).join('\n')}` : null,
            `    State:          ${state}`, `    Ready:          ${s.ready === '1/1' ? 'True' : 'False'}`, `    Restart Count:  ${s.restarts}`, '    Environment:    <none>',
            'Events:', eventTable(evs)
          ].filter(x => x !== null).join('\n');
        }).join('\n\n\n'));
      }
      if (k === 'jobs') {
        const j = jobs[target]; if (!j) return fail(`Error from server (NotFound): jobs.batch "${target || ''}" not found`);
        const s = jobStatus(j), c = j.doc.spec.template.spec.containers[0];
        return ok([`Name:             ${j.name}`, `Namespace:        ${j.ns}`, `Completions:      1`, `Parallelism:      1`, `Start Time:       ${kTime(j.created)}`, s.done ? `Completed At:     ${kTime(sh.now())}` : null, `Pods Statuses:    ${s.done ? '0 Active (0 Ready) / 1 Succeeded / 0 Failed' : '1 Active (0 Ready) / 0 Succeeded / 0 Failed'}`, 'Pod Template:', '  Containers:', `   ${c.name}:`, `    Image:      ${c.image}`, c.command ? `    Command:\n${c.command.map(x => '      ' + x).join('\n')}` : null, 'Events:', '  Type    Reason            Age   From            Message', '  ----    ------            ----  ----            -------', `  Normal  SuccessfulCreate  ${NL.age(sh.now() - j.created)}   job-controller  Created pod: ${j.podName}`, s.done ? `  Normal  Completed         1s    job-controller  Job completed` : null].filter(x => x !== null).join('\n'));
      }
      if (k === 'deployments') { const d = deps[target]; if (!d) return fail(`Error from server (NotFound): deployments.apps "${target || ''}" not found`); return ok(`Name:                   ${d.name}\nNamespace:              ${d.ns}\nReplicas:               ${d.pods.length} desired | ${d.pods.length} updated | ${d.pods.length} total\nPod Template:\n  Containers:\n   ${d.doc.spec.template.spec.containers[0].name}:\n    Image:        ${d.doc.spec.template.spec.containers[0].image}`); }
      return fail(`error: the server doesn't have a resource type "${f._[0]}"`);
    }
    function logs(f) {
      const selector = f.l || f.selector;
      if (selector && !f._[0]) {
        const sel = String(selector).split(',').map(x => x.split('='));
        const list = Object.values(pods).filter(p => sel.every(([a, b]) => p.labels[a] === b)).sort((a, b) => a.name < b.name ? -1 : 1);
        if (!list.length) return ok('No resources found in default namespace.');
        const tail = f.tail !== undefined ? parseInt(f.tail, 10) : 10; // with a selector kubectl defaults to the last 10 lines per pod
        const outs = [];
        list.forEach(p => {
          const s = pstatus(p); if (s.bad || s.st === 'ContainerCreating') return;
          let lines = podLogs(p); if (tail >= 0) lines = lines.slice(Math.max(0, lines.length - tail));
          if (p.owner && p.owner.kind === 'Job' && p.owner.name === P.jobName && lines.length) lastJobLogs = lines.join('\n');
          outs.push(...lines);
        });
        return ok(outs.join('\n'));
      }
      let t = f._[0] || (typeof f.f === 'string' ? f.f : undefined); // -f is --follow for logs
      if (!t) return fail('error: expected \'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]\'.\nPOD or TYPE/NAME is a required argument for the logs command\nSee \'kubectl logs -h\' for help and examples');
      let p;
      if (t.includes('/')) {
        const [a, b] = t.split('/'); const k = RES[a];
        if (k === 'jobs') { const j = jobs[b]; if (!j) return fail(`error: error from server (NotFound): jobs.batch "${b}" not found in namespace "${curNs}"`); p = pods[j.podName]; }
        else if (k === 'deployments') { const d = deps[b]; if (!d) return fail(`error: error from server (NotFound): deployments.apps "${b}" not found in namespace "${curNs}"`); p = pods[d.pods[0]]; }
        else if (k === 'pods') { p = pods[b]; if (!p) return fail(`Error from server (NotFound): pods "${b}" not found`); }
        else return fail(`error: cannot get the logs from ${a}: selector for ${a} not implemented`);
      } else {
        p = pods[t];
        if (!p) { if (jobs[t] && practice) sh.hint(`"${t}" is a Job, not a Pod. Use kubectl logs job/${t}, or the pod name from kubectl get pods.`); return fail(`Error from server (NotFound): pods "${t}" not found`); }
      }
      const s = pstatus(p);
      if (s.bad) return fail(`Error from server (BadRequest): container "${ctrOf(p).name}" in pod "${p.name}" is waiting to start: trying and failing to pull image`);
      if (s.st === 'ContainerCreating') return fail(`Error from server (BadRequest): container "${ctrOf(p).name}" in pod "${p.name}" is waiting to start: ContainerCreating`);
      let lines = podLogs(p);
      const tail = f.tail !== undefined ? parseInt(f.tail, 10) : -1;
      if (tail >= 0) lines = lines.slice(Math.max(0, lines.length - tail));
      const out = lines.join('\n');
      if (p.owner && p.owner.kind === 'Job' && p.owner.name === P.jobName && out) lastJobLogs = out;
      return ok(out);
    }
    function run(f) {
      const name = f._[0];
      if (!name) return fail('error: NAME is required for run\nSee \'kubectl run -h\' for help and examples');
      const image = f.image;
      if (!image) return fail('error: required flag(s) "image" not set');
      const restart = f.restart || 'Always';
      if (!['Always', 'OnFailure', 'Never'].includes(restart)) return fail(`error: invalid restart policy: ${restart}`);
      const labels = f.labels || f.l ? Object.fromEntries((f.labels || f.l).split(',').map(x => x.split('='))) : { run: name };
      const cmd = f.command ? f.dash : null, args = f.command ? null : f.dash;
      const man = podManifest(name, image, restart, cmd, args, labels, f.port);
      if (f['dry-run']) return dry(f, man, 'pod/' + name);
      if (!RFC1123.test(name)) return fail(`The Pod "${name}" is invalid: metadata.name: Invalid value: "${name}": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character`);
      if (pods[name]) return fail(`Error from server (AlreadyExists): pods "${name}" already exists`);
      const p = makePod(name, man.spec, labels, { how: 'run' }); p.specStr = JSON.stringify(man.spec); p.doc = man;
      if (practice && !imageOk(image)) sh.hint(`Check the image name: "${image}" does not exist in the registry, so the Pod will go to ErrImagePull/ImagePullBackOff.`);
      return ok(`pod/${name} created`);
    }
    function dry(f, man, ref) {
      const o = f.o || f.output;
      if (o === 'yaml') return ok(NL.yaml.dump(man));
      if (o === 'json') return ok(JSON.stringify(man, null, 4));
      return ok(`${ref} created (dry run)`);
    }
    let cmdCtx = null;
    const isAdmin = ctx => sh.user === 'root' || (ctx && ctx.sudo);
    function createNs(name, how, ctx) {
      if (!isAdmin(ctx)) return fail(`Error from server (Forbidden): namespaces is forbidden: User "${sh.user}" cannot create resource "namespaces" in API group "" at the cluster scope`);
      if (!name) return fail('error: exactly one NAME is required, got 0');
      if (!LABEL.test(name) || name.length > 63) return fail(`The Namespace "${name}" is invalid: metadata.name: Invalid value: "${name}": a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character (e.g. 'my-name',  or '123-abc', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?')`);
      if (NSS[name]) return how === 'apply' ? ok(`namespace/${name} unchanged`) : fail(`Error from server (AlreadyExists): namespaces "${name}" already exists`);
      mkNs(name, sh.now());
      return ok(`namespace/${name} created`);
    }
    function kcreate(f, stdin) {
      if (f.f || f.filename) return fromFile(f.f || f.filename, 'create', stdin);
      const what = f._[0], name = f._[1];
      if (what === 'job') {
        if (!name) return fail('error: exactly one NAME is required, got 0');
        if (!f.image && !f.from) return fail('error: either --image or --from must be specified');
        const man = jobManifest(name, f.image, f.dash);
        if (f['dry-run']) return dry(f, man, 'job.batch/' + name);
        return applyDoc({ kind: 'Job', name: name, doc: man }, 'create-imperative', null);
      }
      if (what === 'deployment' || what === 'deploy') {
        if (!name) return fail('error: exactly one NAME is required, got 0');
        if (!f.image) return fail('error: required flag(s) "image" not set');
        const man = deployManifest(name, f.image, f.replicas ? +f.replicas : 1);
        if (f['dry-run']) return dry(f, man, 'deployment.apps/' + name);
        return applyDoc({ kind: 'Deployment', name: name, doc: man }, 'create-imperative', null);
      }
      if (what === 'namespace' || what === 'ns') {
        if (f['dry-run']) return dry(f, { apiVersion: 'v1', kind: 'Namespace', metadata: { creationTimestamp: null, name: name }, spec: {}, status: {} }, 'namespace/' + name);
        return createNs(name, 'create', cmdCtx);
      }
      return fail(what ? `error: unknown command "${what}" for "kubectl create"` : 'error: must specify one of -f and -k');
    }
    function del(f) {
      if (f.f || f.filename) {
        const p = sh.resolve(f.f || f.filename); const text = sh.read(p);
        if (text === undefined) return fail(`error: the path "${f.f || f.filename}" does not exist`);
        let docs; try { docs = NL.yaml.parse(text); } catch (e) { return fail(`error: error parsing ${f.f || f.filename}: error converting YAML to JSON: ${e.message}`); }
        const outs = [], errs = [];
        docs.forEach(d => { if (!isObj(d) || !KINDS[d.kind]) return; const nm = d.metadata && d.metadata.name; const r2 = delOne(RES[d.kind.toLowerCase()], nm); if (r2.out) outs.push(r2.out); if (r2.err) errs.push(r2.err.replace('Error from server (NotFound): ', `Error from server (NotFound): error when deleting "${f.f || f.filename}": `)); });
        return { out: outs.join('\n'), err: errs.join('\n'), code: errs.length ? 1 : 0 };
      }
      let k = RES[f._[0]], names = f._.slice(1);
      if (!k && f._[0] && f._[0].includes('/')) { const outs = [], errs = []; f._.forEach(x => { const [a, b] = x.split('/'); const r2 = delOne(RES[a], b); if (r2.out) outs.push(r2.out); if (r2.err) errs.push(r2.err); }); return { out: outs.join('\n'), err: errs.join('\n'), code: errs.length ? 1 : 0 }; }
      if (!k) return fail(f._[0] ? `error: the server doesn't have a resource type "${f._[0]}"` : 'error: You must provide one or more resources by argument or filename.');
      if (f.all) names = Object.keys(k === 'pods' ? pods : k === 'jobs' ? jobs : deps);
      if (!names.length) return fail('error: resource(s) were provided, but no name was specified');
      const outs = [], errs = [];
      names.forEach(n => { const r2 = delOne(k, n); if (r2.out) outs.push(r2.out); if (r2.err) errs.push(r2.err); });
      return { out: outs.join('\n'), err: errs.join('\n'), code: errs.length ? 1 : 0 };
    }
    function delOne(k, n) {
      if (k === 'pods') { if (!pods[n]) return fail(`Error from server (NotFound): pods "${n}" not found`); delete pods[n]; if (curNs === 'default' && (n === P.podName || n === P.runName)) ev.verify = false; return ok(`pod "${n}" deleted`); }
      if (k === 'jobs') { const j = jobs[n]; if (!j) return fail(`Error from server (NotFound): jobs.batch "${n}" not found`); delete pods[j.podName]; delete jobs[n]; return ok(`job.batch "${n}" deleted`); }
      if (k === 'namespaces') {
        if (!NSS[n]) return fail(`Error from server (NotFound): namespaces "${n}" not found`);
        if (n === 'default' || SYSTEM_NS.includes(n)) return fail(`Error from server (Forbidden): namespaces "${n}" is forbidden: this namespace may not be deleted`);
        if (!isAdmin(cmdCtx)) return fail(`Error from server (Forbidden): namespaces "${n}" is forbidden: User "${sh.user}" cannot delete resource "namespaces" in API group "" in the namespace "${n}"`);
        delete NSS[n]; return ok(`namespace "${n}" deleted`);
      }
      if (k === 'deployments') { const d = deps[n]; if (!d) return fail(`Error from server (NotFound): deployments.apps "${n}" not found`); d.pods.forEach(p => delete pods[p]); delete deps[n]; return ok(`deployment.apps "${n}" deleted`); }
      return fail(`error: the server doesn't have a resource type "${k}"`);
    }
    function wait(f) {
      const cond = (f.for || '').toLowerCase(); const t = f._[0] || '';
      const timeout = /^(\d+)(s|m)?$/.test(f.timeout || '30s') ? (+(/^(\d+)/.exec(f.timeout || '30s')[1])) * ((f.timeout || '30s').endsWith('m') ? 60e3 : 1e3) : 30e3;
      const [a, b] = t.split('/'); const k = RES[a];
      const check = () => {
        if (k === 'jobs') { const j = jobs[b]; if (!j) return null; return cond === 'condition=complete' ? jobStatus(j).done : false; }
        if (k === 'pods') { const p = pods[b]; if (!p) return null; return cond === 'condition=ready' ? pstatus(p).st === 'Running' : false; }
        return null;
      };
      let c = check();
      if (c === null) return fail(`Error from server (NotFound): ${k === 'jobs' ? 'jobs.batch' : 'pods'} "${b || ''}" not found`);
      let waited = 0;
      while (!c && waited < timeout) { sh.advance(1000); waited += 1000; c = check(); }
      return c ? ok(`${k === 'jobs' ? 'job.batch' : 'pod'}/${b} condition met`) : fail(`error: timed out waiting for the condition on ${k}/${b}`);
    }
    function kubectl(argv, ctx) {
      const f = kflags(argv.slice(2));
      const sub = argv[1];
      if (!sub || sub === '--help' || sub === '-h') return ok('kubectl controls the Kubernetes cluster manager.\n\nBasic Commands (Beginner):\n  create          Create a resource from a file or from stdin\n  run             Run a particular image on the cluster\n\nBasic Commands (Intermediate):\n  get             Display one or many resources\n  delete          Delete resources by file names, stdin, resources and names, or by resources and label selector\n\nTroubleshooting and Debugging Commands:\n  describe        Show details of a specific resource or group of resources\n  logs            Print the logs for a container in a pod\n\nAdvanced Commands:\n  apply           Apply a configuration to a resource by file name or stdin\n  wait            Experimental: Wait for a specific condition on one or many resources');
      const nsArg = f.n || f.namespace;
      cmdNsExplicit = !!nsArg && !(f.A || f['all-namespaces']); cmdNs = nsArg || 'default'; cmdCtx = ctx;
      const makesNs = sub === 'create' && /^(ns|namespace)$/.test(f._[0] || '');
      if (nsArg && !NSS[nsArg] && ['apply', 'create', 'run'].includes(sub) && !makesNs) return fail(`Error from server (NotFound): namespaces "${nsArg}" not found`);
      useNs(cmdNs);
      try { return kubectlSub(sub, f, ctx, argv); } finally { useNs('default'); cmdNs = 'default'; cmdNsExplicit = false; }
    }
    function kubectlSub(sub, f, ctx, argv) {
      switch (sub) {
        case 'get': return get(f);
        case 'describe': return describe(f);
        case 'logs': return logs(f);
        case 'apply': {
          if (!f.f && !f.filename && !f.k) return fail('error: must specify one of -f and -k');
          if (f['dry-run']) return ok(`(dry run) ${f.f}`);
          return fromFile(f.f || f.filename, 'apply', ctx.stdin);
        }
        case 'create': return kcreate(f, ctx.stdin);
        case 'run': return run(f);
        case 'delete': return del(f);
        case 'wait': return wait(f);
        case 'version': return ok('Client Version: v1.30.4\nKustomize Version: v5.0.4-0.20230601165947-6ce0bf390ce3\nServer Version: v1.30.4');
        case 'cluster-info': return ok('Kubernetes control plane is running at https://10.141.0.1:10443\nCoreDNS is running at https://10.141.0.1:10443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy\n\nTo further debug and diagnose cluster problems, use \'kubectl cluster-info dump\'.');
        case 'config': return ok(argv[2] === 'current-context' ? 'kubernetes-admin@default' : 'apiVersion: v1\nclusters:\n- cluster:\n    server: https://10.141.0.1:10443\n  name: default\ncontexts:\n- context:\n    cluster: default\n    user: student\n  name: kubernetes-admin@default\ncurrent-context: kubernetes-admin@default\nkind: Config');
        case 'api-resources': return ok('NAME          SHORTNAMES   APIVERSION   NAMESPACED   KIND\nnamespaces    ns           v1           false        Namespace\nnodes         no           v1           false        Node\npods          po           v1           true         Pod\nservices      svc          v1           true         Service\ndeployments   deploy       apps/v1      true         Deployment\nreplicasets   rs           apps/v1      true         ReplicaSet\njobs                       batch/v1     true         Job');
        case 'explain': return ok(`KIND:       ${f._[0] || ''}\n\nDESCRIPTION:\n    (kubectl explain is abbreviated in this simulator. Common fields: apiVersion, kind, metadata.name, spec.containers[].name/image/command/args, spec.restartPolicy; for Jobs spec.template.spec.)`);
        case 'top': return ok('NAME      CPU(cores)   CPU(%)   MEMORY(bytes)   MEMORY(%)\nnode001   412m         0%       9812Mi          0%\nnode002   153m         0%       6123Mi          0%\nnode003   149m         0%       6040Mi          0%');
        case 'exec': return fail('error: kubectl exec is not simulated in this lab');
        case 'edit': return fail('error: kubectl edit is not simulated here. Edit the manifest file and re-apply (Pods: delete and re-create).');
      }
      return fail(`error: unknown command "${sub}" for "kubectl"\n\nDid you mean this?\n\tget\n\tlogs\n\tapply`);
    }

    const lab = {
      id: 'k8s', params: P, shell: sh,
      title: 'Lab 2 · Kubernetes',
      intro: `You are logged in to the head node of a BCM-managed cluster as ${asRoot ? 'root' : 'student'}. Kubernetes is installed but its client tools are provided through an environment module.`,
      tasks: () => [
        { id: 'env', text: 'Load the Kubernetes environment module and confirm all cluster nodes are Ready.' },
        { id: 'jobfile', text: `Save this Job manifest to ${P.jobPath}:`, manifest: JOB_YAML.join('\n') },
        { id: 'jobrun', text: `Create the Job from that file and confirm it completes.` },
        { id: 'joblogs', text: P.logMode === 'save' ? `Save the Job's logs to ${P.logPath}.` : 'Display the Job\'s logs.' },
        { id: 'podfile', text: `Save this Pod manifest to ${P.podPath}, then create the Pod from that file:`, manifest: POD_YAML.join('\n') },
        { id: 'runpod', text: `Run a second Pod named ${P.runName} directly from the image ${P.runImage}, without a manifest file.` },
        { id: 'verify', text: 'Confirm that both Pods are Running.' }
      ],
      commands: () => ['module', 'ml'].concat(moduleLoaded ? ['kubectl', 'helm'] : []),
      hosts: () => ['headnode'],
      users: () => ['root', 'student'],
      which: n => n === 'kubectl' && moduleLoaded ? '/cm/local/apps/kubernetes/current/bin/kubectl' : null,
      man: p => p === 'kubectl' ? 'kubectl has no man page here; use kubectl --help or kubectl <command> --help.' : p === 'module' ? 'module avail | module load <name> | module list | module unload <name>' : null,
      onWrite() {},
      exec(argv, ctx) {
        const c = argv[0];
        if (c === 'module' || c === 'ml') {
          const sub = c === 'ml' && argv[1] && !['load', 'add', 'avail', 'av', 'list', 'unload', 'rm', 'purge'].includes(argv[1]) ? 'load' : argv[1];
          const names = c === 'ml' && sub === 'load' && argv[1] !== 'load' ? argv.slice(1) : argv.slice(2);
          if (sub === 'avail' || sub === 'av' || (c === 'ml' && !argv[1])) return ok(c === 'ml' && !argv[1] ? (moduleLoaded ? 'Currently Loaded Modulefiles:\n 1) shared   2) kubernetes/default/1.30.4' : 'Currently Loaded Modulefiles:\n 1) shared') : '------------------------- /cm/local/modulefiles -------------------------\ncluster-tools/10.0  cmd  dot  freeipmi/1.6.10  ipmitool/1.8.19  module-git  module-info  null  shared\n------------------------- /cm/shared/modulefiles ------------------------\ncm-pmix4/4.1.3  kubernetes/default/1.30.4  slurm/slurm/24.05.4');
          if (sub === 'list') return ok(moduleLoaded ? 'Currently Loaded Modulefiles:\n 1) shared   2) kubernetes/default/1.30.4' : 'Currently Loaded Modulefiles:\n 1) shared');
          if (sub === 'load' || sub === 'add') {
            if (!names.length) return fail('ERROR: Unexpected number of args');
            for (const n of names) { if (/^kubernetes(\/\S+)?$/.test(n)) moduleLoaded = true; else if (!/^(shared|slurm.*)$/.test(n)) return fail(`ERROR: Unable to locate a modulefile for '${n}'`); }
            if (practice) sh.hint('kubectl is now on your PATH. Check the cluster with kubectl get nodes.');
            return ok();
          }
          if (sub === 'unload' || sub === 'rm' || sub === 'purge') { moduleLoaded = false; return ok(); }
          return fail(`ERROR: Invalid command '${sub || ''}'`);
        }
        if (c === 'kubectl' || c === 'k') {
          if (!moduleLoaded) { if (practice) sh.hint('kubectl is not on the PATH until you load the environment module: module load kubernetes'); return fail(`${c === 'k' ? 'k' : 'kubectl'}: command not found`, 127); }
          return kubectl(argv, ctx);
        }
        if (c === 'helm') return moduleLoaded ? fail('Error: helm is not needed for this lab') : fail('helm: command not found', 127);
        return undefined;
      },
      onDisplay(out) {
        if (/^NAME\s+STATUS\s+ROLES\s+AGE\s+VERSION/m.test(out) && /node001\s+Ready/.test(out)) ev.nodesShown = true;
        if (lastJobLogs && out.includes(lastJobLogs) && jobs[P.jobName] && jobStatus(jobs[P.jobName]).done) ev.logsShown = true;
        const lines = out.split('\n');
        const running = n => lines.some(l => new RegExp('^(pod/)?' + n.replace(/[-.]/g, '\\$&') + '\\s+\\S+\\s+Running\\b').test(l));
        if (running(P.podName) && running(P.runName)) ev.verify = true;
      },
      /* in practice mode, nudge for common path mistakes when saving a manifest */
      editorSaved(path, err) {
        if (!practice) return;
        if (err && /No such file/.test(err)) sh.hint(`The directory ${NL.dirname(path)} does not exist yet. Create it with mkdir -p ${NL.dirname(path)} and save again.`);
        else if (!err && /\.ya?ml$/.test(path) && ![P.jobPath, P.podPath].includes(path)) sh.hint(`Saved, but the task asks for ${P.jobPath} and ${P.podPath}. A grader checks the exact path.`);
      },
      grade() {
        useNs('default');
        const res = [];
        res.push({ id: 'env', pass: moduleLoaded && ev.nodesShown, detail: !moduleLoaded ? 'The kubernetes module is not loaded (module load kubernetes).' : ev.nodesShown ? 'Module loaded and nodes listed as Ready.' : 'Module loaded, but you never listed the nodes (kubectl get nodes).' });
        // job file
        const jt = sh.read(P.jobPath);
        let jdoc = null, jerr = '';
        if (jt === undefined) jerr = `No file at ${P.jobPath}.`;
        else { try { const d = NL.yaml.parse(jt).find(x => isObj(x) && x.kind === 'Job'); if (!d) jerr = `${P.jobPath} does not contain a Job.`; else { const v = validate(d, P.jobPath); if (v.err) jerr = 'The manifest is not valid: ' + v.err.split('\n')[0]; else jdoc = d; } } catch (e) { jerr = 'The file is not valid YAML: ' + e.message; } }
        if (jdoc) {
          const c = jdoc.spec.template.spec.containers[0];
          const fakePod = { name: 'x', created: sh.now(), ip: '', spec: jdoc.spec.template.spec };
          if (jdoc.metadata.name !== P.jobName) jerr = `The Job in the file is named "${jdoc.metadata.name}", not "${P.jobName}".`;
          else if (c.image !== P.jobImage) jerr = `The container image is "${c.image}", not "${P.jobImage}".`;
          else if (!podLogs(fakePod).join('\n').includes(P.jobMsg)) jerr = `The container command does not print "${P.jobMsg}" (for example command: ["sh", "-c", "echo ${P.jobMsg}"]).`;
        }
        res.push({ id: 'jobfile', pass: !jerr, detail: jerr || `${P.jobPath} defines Job ${P.jobName} (${P.jobImage}) printing the message.` });
        const j = jobs[P.jobName];
        let jr2;
        if (!j) jr2 = [false, `There is no Job named ${P.jobName} in the cluster.`];
        else if (!j.source.path || j.source.path !== P.jobPath) jr2 = [false, `Job ${P.jobName} exists, but it was not created from ${P.jobPath} (${j.source.how === 'create-imperative' ? 'it was created imperatively' : 'source: ' + (j.source.path || j.source.how)}).`];
        else if (!jobStatus(j).done) jr2 = [false, `Job ${P.jobName} was created from the file but has not completed (${pods[j.podName] ? pstatus(pods[j.podName]).st : 'no pod'}).`];
        else jr2 = [true, `Job ${P.jobName} was created from ${P.jobPath} and is Complete.`];
        res.push({ id: 'jobrun', pass: jr2[0], detail: jr2[1] });
        if (P.logMode === 'save') {
          const lt = sh.read(P.logPath);
          res.push({ id: 'joblogs', pass: !!lt && lt.includes(P.jobMsg), detail: lt === undefined ? `No file at ${P.logPath}. Example: kubectl logs job/${P.jobName} > ${P.logPath}` : lt.includes(P.jobMsg) ? `${P.logPath} contains the Job output.` : `${P.logPath} exists but does not contain the Job output.` });
        } else res.push({ id: 'joblogs', pass: ev.logsShown, detail: ev.logsShown ? 'You displayed the Job logs.' : `The Job logs were never displayed (kubectl logs job/${P.jobName}).` });
        // pod file + running
        const pt = sh.read(P.podPath);
        let perr = '';
        if (pt === undefined) perr = `No file at ${P.podPath}.`;
        else { try { const d = NL.yaml.parse(pt).find(x => isObj(x) && x.kind === 'Pod'); if (!d) perr = `${P.podPath} does not contain a Pod.`; else if (d.metadata.name !== P.podName) perr = `The Pod in the file is named "${d.metadata.name}", not "${P.podName}".`; else if (!d.spec.containers || d.spec.containers[0].image !== P.podImage) perr = `The Pod in the file does not use image ${P.podImage}.`; } catch (e) { perr = 'The file is not valid YAML: ' + e.message; } }
        const p = pods[P.podName];
        if (!perr) { if (!p) perr = `${P.podPath} is correct, but Pod ${P.podName} does not exist (kubectl apply -f ${P.podPath}).`; else if (p.source.path !== P.podPath) perr = `Pod ${P.podName} exists but was not created from ${P.podPath}.`; else if (pstatus(p).st !== 'Running') perr = `Pod ${P.podName} is ${pstatus(p).st}, not Running.`; }
        res.push({ id: 'podfile', pass: !perr, detail: perr || `Pod ${P.podName} was created from ${P.podPath} and is Running.` });
        const q = pods[P.runName];
        let qerr = '';
        if (!q) qerr = `There is no Pod named ${P.runName}.`;
        else if (ctrOf(q).image !== P.runImage) qerr = `Pod ${P.runName} uses image ${ctrOf(q).image}, not ${P.runImage}.`;
        else if (q.source.how !== 'run') qerr = `Pod ${P.runName} was created from a file; the task asked for kubectl run.`;
        else if (pstatus(q).st !== 'Running') qerr = `Pod ${P.runName} is ${pstatus(q).st}, not Running.`;
        res.push({ id: 'runpod', pass: !qerr, detail: qerr || `Pod ${P.runName} was created with kubectl run and is Running.` });
        const bothRunning = [P.podName, P.runName].every(n => pods[n] && pstatus(pods[n]).st === 'Running');
        res.push({ id: 'verify', pass: ev.verify && bothRunning, detail: !bothRunning ? `Both Pods must still be Running at the end; ${[P.podName, P.runName].filter(n => !pods[n] || pstatus(pods[n]).st !== 'Running').join(' and ')} ${[P.podName, P.runName].filter(n => !pods[n] || pstatus(pods[n]).st !== 'Running').length > 1 ? 'are' : 'is'} not.` : ev.verify ? 'You listed both Pods while they were Running.' : 'You never listed both Pods in Running state together (kubectl get pods).' });
        const notes = [];
        Object.values(pods).filter(x => !x.owner && ![P.podName, P.runName].includes(x.name)).forEach(x => notes.push(`Extra Pod left behind: ${x.name} (${pstatus(x).st}).`));
        return { results: res, notes: notes };
      },
      solution() {
        return ['module load kubernetes', 'kubectl get nodes',
          `vi ${P.jobPath}`, '#  press i, paste the Job manifest from the task, press Esc, type :wq',
          `cat ${P.jobPath}`, `kubectl apply -f ${P.jobPath}`, 'kubectl get jobs', '#  repeat kubectl get jobs until STATUS is Complete',
          P.logMode === 'save' ? `kubectl logs job/${P.jobName} > ${P.logPath}` : `kubectl logs job/${P.jobName}`,
          `vi ${P.podPath}`, '#  press i, paste the Pod manifest from the task, press Esc, type :wq',
          `cat ${P.podPath}`, `kubectl apply -f ${P.podPath}`,
          `kubectl run ${P.runName} --image=${P.runImage}`, 'kubectl get pods',
          '#  nano works too: nano <path>, paste, Ctrl+O, Enter, Ctrl+X'];
      }
    };
    sh.lab = lab;
    return lab;
  }
  NL.labs.k8s = { create: create, imageOk: imageOk };
})(typeof window !== 'undefined' ? window : globalThis);
