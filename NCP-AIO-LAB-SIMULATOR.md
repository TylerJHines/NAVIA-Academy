# NCP-AIO three-lab simulator (practice + exam modes)

Page: `aio/exam-recall.html` (linked from the AIO home page as before).

Based on one candidate's description of the exam's three lab simulations. These are not the official tasks, and everything runs as a simulation in the browser.

## Modes

| | Practice | Exam |
|---|---|---|
| Scenario | Fixed (node002 fails, job 5817, `dgx-training`, …) | Randomized from a seed: failed node, failure cause, job IDs, names, paths, IP/MAC |
| Hints | Shown under commands when you hit a common mistake | None |
| Checklist | Ticks off live as the simulated state changes | Hidden until you submit |
| Grading | "Check my work" at any time | Only on **Submit lab**, then the terminal locks |
| Timer | None | 15/20/30/45 min or no limit; auto-submits at 0 |
| Lab 1 scenario | Choose: **both failures (full drill, default)**, node failure only, or out-of-memory job only | One random failure, as on the exam: slurmd crash, munge killed, slurmd disabled after reboot, or OOM job |
| Solution | Always available | Shown after submit |

**Log in as** (top bar): `root`, as on the exam (default, paths like `/root/lab2/...`), or `student` with sudo. It applies to Labs 1 and 2; Lab 3 is always root.

Grading checks the **final state** of the simulated system (node state, objects and files that exist and how they were created), not the command text you typed. Tasks that only ask you to *display* something (find the failed job, show job output or logs, list nodes) are credited when the relevant output appeared on screen.

## Files

- `aio/lab-core.js`: simulated bash (quotes, `;` `&&` `||`, pipes with grep/head/tail/wc, `>`/`>>` redirects, heredocs, globs, `sudo`, `ssh`), a virtual filesystem, a nano/vi editor, tab completion and a YAML parser that reports errors in kubectl/go-yaml style.
- `aio/lab-slurm.js`: Lab 1. sinfo/squeue/sacct/scontrol/sbatch/scancel with real option parsing; systemctl/journalctl on nodes; munge/unmunge. A failed job owned by another user (`dana` in practice) must be found, fixed and resubmitted as its owner (`su - dana -c "sbatch train.sh"`). Failure causes: slurmd segfault, munge OOM-killed, slurmd disabled after a reboot, or the job itself running out of memory (found with `sacct -j ID --format=JobID,State,ReqMem,MaxRSS,WorkDir`, fixed with `sbatch --mem=...` as the owner). The practice full drill combines both: dana's `train.sh` hit by a node failure and lee's `finetune.sh` out of memory, each resubmitted as its owner.
- `aio/lab-k8s.js`: Lab 2. `module load kubernetes`, kubectl get/describe/logs/apply/create/run/delete/wait, `--dry-run=client -o yaml`, strict field validation, pod lifecycle (ContainerCreating → Running/Completed, ImagePullBackOff for bad images).
- `aio/lab-bcm.js`: Lab 3. cmsh with real-style prompts (`[headnode->device*[gpu004*]]%`), staged and committed changes, `add physicalnode NAME IP`, `cmsh -c`, and a text version of the `cm-kubernetes-setup` wizard with save-then-deploy (`-c FILE`).
- `aio/exam-recall.js`: page controller (modes, timer, editor, report).
- `test-labs.cjs`: `node test-labs.cjs` solves 120 random exam scenarios per lab, and checks that common mistakes fail.

## Command styles accepted

Both styles work everywhere and are covered by `test-labs.cjs`:

- **Navigated:** `cmsh` → `device` → `add physicalnode gpu004 10.141.0.44` → `set …` → `commit`
- **One-liner:** `cmsh -c "device; add physicalnode gpu004 10.141.0.44; set category gpu-training; set mac …; commit"`, or the same `;`-separated line typed inside cmsh

Also supported, from a candidate's lab drill:

- `ssh node002 systemctl status slurmd`, including quoted remote commands
- `su - USER -c "…"` and `sudo -u USER …`
- `sinfo -N -n node002 -o "%N %T %E"` and `sinfo -O …`
- `scontrol show jobid N`
- `cat > file`, then paste, then Ctrl+D
- `vi` with `i`, `Esc`, `:w`, `:wq`, `:x`, `:q!`, `ZZ`, `dd` and `:set paste`
- `squeue -o "<format>"`, `journalctl -b -1` / `--list-boots`, `munge -n | unmunge` (also `munge -n | ssh node002 unmunge`)
- `kubectl logs -l <selector>`, `kubectl get pod a b`, `kubectl get deploy,pods`, `kubectl get pod/a job/b`, `-n kube-system` / `-n gpu-operator`
- cmsh `interfaces`, `roles` (assign/unassign), `foreach -n node001..node003 ( ... )`, `imageupdate [-w]`, `power on|off|reset|status`
- cmsh `ds` and `status -n NODE`
- `module load kubernetes/<anything>`
- `kubectl cluster-info` after the BCM deploy
- the cuda-vectoradd sample pod
- "smart quotes" pasted from documents

## Realistic behaviours to be aware of (deliberate)

- `sacct` without `-a` only shows your own jobs (root sees everyone's), but `-j` and `-N` return every user's jobs. `sacct --state=…` without `-S` only looks at the current moment; with `-j` the start defaults to Epoch 0. MaxRSS is recorded per step, so `-X` hides it.
- `scontrol show job` forgets jobs after MinJobAge (300 s), so older jobs have to be found with `sacct`.
- `ReturnToService=0`: after fixing slurmd the node stays `down` until `scontrol update … state=resume`.
- `scontrol update … state=drain` without `reason=` is refused.
- Logs and service control need `sudo`, and `slurmd` exists only on compute nodes.
- Saving a manifest into a directory that doesn't exist fails, so you need `mkdir -p`. A Job needs `restartPolicy: Never|OnFailure`.
- In cmsh, references (`set softwareimage`, `set category`) only work for committed objects, and `quit` discards uncommitted changes. A new node must be committed before `power on`.
- Other users' home directories are not readable without root (use sudo as `student`).
- `cm-kubernetes-setup` does not pre-select the NVIDIA GPU Operator; the task requires it.
- Grading uses the end state: draining a wrong node and resuming it is fine; deleting a Pod after verifying fails the verify check.

## Assumptions to confirm with candidates

These were guessed and are easy to change:
1. **Users.** All labs default to `root`, as a candidate reported; `student` with sudo remains an option for Labs 1 and 2.
2. **Log task.** Exam mode randomly asks either to display the Job logs or to save them to a file.
3. **Wizard.** The `cm-kubernetes-setup` screens and the saved config's layout are approximations of the real ncurses tool.
4. **Default paths.** `/root/cm-kubernetes-setup.conf` as the default config path; module name `kubernetes`; partition `defq`; node names `node001…`.
