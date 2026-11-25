# NCP-AIO three-lab update — test branch candidate

Based on candidate feedback, not an official NVIDIA exam replica.

- Slurm: no supplied job ID; supports `sacct -a -S today` and valid comma-separated state filters; diagnosis, recovery, job output, and drain state graded.
- Kubernetes: separate tasks for YAML Job and logs, manifest-based workload, and an additional image-based Pod via `kubectl run inference-direct --image=nginx:1.27`. Both workloads must be seen with `kubectl get pods` before final objective is awarded.
- BCM: software-image and category cloning, assignment, physical node, wizard saved configuration, deployment from that configuration, and node verification.
- Task sheet now appears above the terminal on narrow and wide displays.

Tested with Node.js simulated-DOM workflow covering all 15 objectives, incorrect `sacct` syntax, Kubernetes two workload types, and BCM saved config path. JavaScript syntax and ZIP CRC checks passed. Full real-browser testing and execution against actual Slurm/Kubernetes/BCM infrastructure are not performed. Terminal outputs and wizard interaction remain simulations. No written-exam questions changed.
