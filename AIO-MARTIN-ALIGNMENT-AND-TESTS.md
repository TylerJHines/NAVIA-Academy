# NAVIA AIO — Martin Kaufmann workflow alignment and validation

**Release:** 2026-11-19, AIO stateful-lab correction r2.

**Source basis:** Original `NAVIA-Academy-main (1).zip`, with targeted AIO simulator changes. The latest previously supplied NAVIA Test Day Prep navigation and the exact user's infographic PNG were retained because those files were absent in the older original ZIP. The complete **AIN source remains byte-identical** to the original ZIP.

## What changed

- Replaced the old AIO command executor and `simctl` repair shortcuts with a browser-based, stateful simulated cluster. No actual Linux, Kubernetes, Slurm, BCM, GPU, or cloud commands run on a real host.
- Each valid supported command is executed regardless of active checklist goal; its output reflects synthetic cluster state.
- Lab progress is independently based on: (1) evidence collected while the problem existed; (2) current recovered/protected cluster state; (3) a separate read-only validation after recovery. **This is not exact-command/string matching.**
- Fixed the reported issue: `kubectl describe pod inference` now marks the investigation goal (1 of 3), because it shows the failure and image reference. The next hint points to the previous approved ReplicaSet/revision, not the already-run `describe` command.
- The image replacement name is discoverable with `kubectl get rs -o yaml` or `kubectl rollout history deployment/inference --revision=1`; both a correct `kubectl set image ...` and valid `kubectl rollout undo ...` are supported. There is no secret `:valid` image tag.
- Corrected BCM node field names (`softwareimage`, not a simulated `image`) and included software image/category inventory and node power/provisioning simulation.
- Added `ssh node002 ...` service operations, real Slurm/GRES-oriented syntax, `dcgmi`/`nvsm` diagnostics, Kubernetes device plugin status, and `man COMMAND` / `COMMAND --help` command references.
- Advanced guided hints (not available in mock practical exams) follow unmet objectives instead of repeating completed investigation commands.
- Timed AIO mocks: four variants, 30 domain-weighted questions and three simulated labs each. Lab credit follows real synthetic cluster state, not checkbox command order; recovery and verification credit are withdrawn if the fault returns.
- Changed cache version for AIO simulator files and restricted AIO service-worker cache cleanup to AIO caches, to minimize interference with the rest of NAVIA.

## Scope compared with Martin Kaufmann's trainer

Reference: https://martin-kaufmann.github.io/ncp-aio-prep/ and https://github.com/martin-kaufmann/ncp-aio-prep

This release aligns **training mechanics** (stateful terminal, realistic incidents, command usage, discoverable context, free execution, and objective-based verification) and key domain families (BCM, Slurm, Kubernetes, Linux, DCGM/GPU triage). It **does not** copy Martin's code, questions, 33-scenario library, eight-node topology, or entire command sandbox. It is not a live cluster. Some advanced topics (for example BCM HA failover, extensive Pyxis/Enroot, MIG profile administration, deeper InfiniBand diagnostics) remain better covered by Martin's broader trainer and vendor documentation.

Official NCP-AIO exam structure (per NVIDIA): 30 multiple-choice questions, three hands-on labs, combined 120 minutes. NAVIA remains an **unofficial simulator** and cannot guarantee identical lab commands, configuration, or questions to the protected actual exam.

Official: https://www.nvidia.com/en-us/learn/certification/ai-operations-professional/

## Validation performed on this package

- 15/15 real-command AIO scripted recovery paths passed in Node.
- 15/15 AIO lab paths executed via Chromium DOM controls and passed the three-goal checklist.
- 4/4 mock variants rendered 30 questions + 3 labs in Chromium; no guided solution commands were revealed in mock practical labs.
- Negative tests: wrong `:valid` tag rejected as a solution; incorrect repairs do not complete labs; out-of-order commands execute; repair/verification credit is withdrawn on regression; training-only `simctl` shortcuts rejected.
- The reported `kubectl describe pod inference` issue passed both engine and Chromium regression tests (1/3 immediately and adaptive hint changes goal).
- The supplied infographic was compared byte-for-byte with the packaged PNG, and the main-page navigation/image rendered in Chromium.
- AIN source bytes match the original archive; AIN page JavaScript loaded in Chromium without a page error.
- JavaScript syntax and ZIP integrity were checked. **Not verified:** production GitHub Pages configuration, live Google sign-in, real NVIDIA hardware, all possible real-world command variations.

### Local testing

Open NAVIA through a static server, e.g. from this folder `python -m http.server 8000`, and open `http://localhost:8000/aio/`. If an old service worker cached an earlier version, close old NAVIA tabs and hard refresh after publishing.

Original work for NAVIA; Martin Kaufmann's trainer is cited for independent study and is not embedded or redistributed here.
