# NAVIA Academy — AIO and AIN Simulator Release

**Release:** 20 · **Prepared:** November 19, 2026  
**Scope:** AIO simulator, AIN simulator, their practice labs and mock exams. All original non-AIO/AIN academy files are retained, byte-for-byte.

## What this release provides

### NCP-AIO — AI Operations Professional

- **15 interactive, stateful simulated incident labs**, with live command responses for supported Slurm, Kubernetes, BCM, Linux, DCGM/NVIDIA utilities.
- **Commands are evaluated independently of checklist order.** Investigate, repair/contain, and post-change verification count toward independent objectives. Actual synthetic target state is what earns repair credit.
- **No invented `simctl` repair commands**, no hidden `:valid` NGC tag, and no requirement to guess BCM software images. The lab terminal supports a documented subset of genuine command forms. Commands outside the subset produce helpful errors; the simulator never executes actual commands against user systems.
- **Image failure lab:** `kubectl describe pod inference` shows the failing pull; `kubectl get rs -o yaml` exposes the previous approved image; `kubectl set image deployment/inference inference=IMAGE` or `kubectl rollout undo deployment/inference` repairs the synthetic rollout; `kubectl rollout status deployment/inference` verifies recovery. The image reference has to match the discovered known-good state.
- **BCM:** Correct `cmsh` `set softwareimage`, `get softwareimage`, category assignment, commit, power and status steps. Image names and categories are discoverable from `softwareimage; list` and `category; list`.
- **Slurm:** node drains, scheduler capacity, job reservations, partition correction, GRES troubleshooting, and slurmd service recovery.
- **GPU/Linux:** diagnostic Xid-event isolation, DCGM read-only diagnostics, controlled storage cleanup. No hardware repair is falsely simulated.
- **Four randomized training mock exams** with 30 questions, three scenario labs, one 120-minute timer, and custom practice scoring. Exam mode hides solution examples and disables hints.

### NCP-AIN — AI Networking Professional

- **14 interactive practice labs** spanning InfiniBand, Cumulus Linux/NVUE, Spectrum-X/RoCE, Kubernetes Network Operator diagnostics, and Ansible/NVUE config drift.
- Supported commands include `ibstat`, `ibv_devinfo`, `iblinkinfo`, `ibdiagnet`, `perfquery`, `mlxlink`, `rdma link show`, `ethtool`, `ip`, `nv`, `vtysh`, selected read-only Kubernetes Network Operator commands, and an Ansible check/diff fixture.
- Cumulus link-state and MTU repairs use staged NVUE state and `nv config apply`; the lab is not complete until the interface is verified in its target state.
- Hardware and fabric diagnostics are triage labs, not fake fixes or fake incident-escalation commands.
- **Four mock exam variants** with **75 distinct questions per attempt**, spanning all six published NCP-AIN objective categories. Domain-weighted practice distribution: Design 4, Spectrum 22, InfiniBand 23, Kubernetes Integration 4, Troubleshooting 15, Automation 7. Includes three additional NAVIA-specific simulator labs and a 120-minute timer. Lab counts/scoring are NAVIA training choices, not official NVIDIA exam specifications.

## User experience

1. Open `index.html` from a suitable static web host (e.g., GitHub Pages) and go to **AI Operations** or **AI Networking**.
2. Select **Fault lab** and start a scenario. Read the incident before doing anything in the terminal.
3. Run `help` and use diagnostic commands. Output is **synthetic and scenario/state dependent**, not a real Linux shell or actual NVIDIA cluster.
4. In guided mode, see command examples as an optional training aid. In mock mode, command examples and hints are hidden.
5. Recover and verify. If the simulated fault is reintroduced before submitting, recovery credit is removed.

## Testing performed

See `BROWSER-REGRESSION-RESULTS.json` and `test-aio.cjs` for repeatable evidence.

- 15/15 AIO incident paths completed in the command engine AND through browser DOM interactions.
- 14/14 AIN incident paths completed through Chromium browser DOM interactions.
- 4/4 AIO mock exam variants validated for 30 questions, three lab selections, transition and results.
- 4/4 AIN mock variants validated for 75 distinct questions, published subject proportions, lab selection, results, and 120-minute expiration.
- Negative checks: unsupported commands, incorrect/undiscoverable image, unsupported BCM provisioning, wrong Slurm GRES repair order, staged but unapplied NVUE config, withholding and retracting lab credit, and absence of displayed solution examples in exam mode.
- JavaScript syntax checks for all packaged JS, static ZIP integrity, and original-file preservation check.
- **Not externally verified:** live Google/Firebase credentials, external cloud sync, live production hosting, devices, or a genuine NVIDIA NCP exam environment. Real-host software/version compatibility is not guaranteed.

## Official references checked

- AIO exam: https://www.nvidia.com/en-us/learn/certification/ai-operations-professional/
- AIN exam: https://www.nvidia.com/en-us/learn/certification/ai-networking-professional/
- BCM node software image assignment: https://docs.nvidia.com/dgx/baseos-on-bcm-install-guide/updating-nodes-bcm.html
- NVIDIA BCM manuals: https://docs.nvidia.com/base-command-manager/
- Unofficial Martin Kaufmann training reference: https://martin-kaufmann.github.io/ncp-aio-prep/

**Scope statement:** This is a tested, internally complete NAVIA AIO/AIN **browser training simulator**. It is **not** an emulator of every upstream command, a real GPU/Slurm/Kubernetes/BCM installation, an exact copy of NVIDIA's undisclosed exam tasks, or a guarantee of certification success. The app only accepts its documented command subset and responds with internally consistent synthetic data.
