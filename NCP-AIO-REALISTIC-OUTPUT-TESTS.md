# NCP-AIO scenario terminal output revision

This is a simulated training environment, not captured exam output or a real NVIDIA cluster. Names, timestamps, errors, and versions are illustrative.

## Updates
- Slurm `systemctl status slurmd` now displays systemd-style unit status, while `journalctl -u slurmd -n 20 --no-pager` shows distinct chronological log entries. Both change after a successful restart.
- Slurm `sacct -S today` lists a failed job and node information without requiring a `--state` filter. `sinfo` and `sinfo -R` change after recovery; draining node001 changes `sinfo`.
- Kubernetes node, Job, and Pod listings now have realistic column headers and states.
- BCM Kubernetes verification uses Kubernetes-style node listing.

## Automated tests
- `node --check aio/exam-recall.js`: PASS.
- Scripted command/output tests: 44 checks passed across Slurm, Kubernetes, and BCM.
- Each of the three scenarios reached 5/5 objectives.
- Distinct before/after daemon status and log outputs were asserted.

## Limitations
- These outputs are illustrative; they are not verbatim logs from NVIDIA hardware or a real exam.
- This is a JavaScript simulator; no actual Slurm, Kubernetes, or BCM cluster is provisioned.
- Browser UI and exhaustive malformed-command testing have not been performed.
