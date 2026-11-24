# NCP-AIO candidate-reported lab simulator — test notes

These are simulated training exercises, not official NVIDIA exam tasks. Command behavior is simplified; a production Slurm, Kubernetes or BCM cluster may differ by version and site configuration.

## Corrections
- Slurm: simulate an SSH session on the affected compute node before checking/restarting slurmd. Return to login node to resume and submit; require verifying node IDLE, job output and maintenance drain. The `cat slurm-5822.out` command is required by this exercise to verify output; `scontrol show job` identifies the path.
- Kubernetes: `nano /home/student/jobs/training.yaml` and `nano /home/student/workloads/inference.yaml` open the provided YAML editor with path-specific starter manifests. Save, then apply, inspect Job completion/logs and pod state. `kubectl run` creates a Pod, not a Job.
- BCM: mode is explicit (`mode`), and image/category/node must be cloned/assigned/committed in sequence. `cm-kubernetes-setup` is simulated and requires exit from cmsh; verify with `kubectl get nodes` after deployment.

## Automated smoke tests
Node.js DOM-harness test completed 2026-11-23: Slurm 5/5, Kubernetes 5/5, BCM 5/5 objective checkmarks. JavaScript syntax check passed. Browser E2E testing and real NVIDIA environment validation were NOT performed.

## Known limits
This is a browser-only simulator, not a real SSH terminal, text editor, Slurm controller, Kubernetes API, or BCM installation. It supports a bounded subset of commands. Actual `cmsh` and `cm-kubernetes-setup` syntax and available settings can differ by BCM release; confirm against the version's NVIDIA documentation and built-in help. Node IP/MAC and paths are fictional.
