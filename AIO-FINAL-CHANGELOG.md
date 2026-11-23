# NAVIA AIO revision - scope and validation

This build preserves the rest of the academy and modifies `aio/app.js`.

## Verified changes
- Kubernetes image recovery: supported discovery via `kubectl get rs -o yaml`, `kubectl rollout history`, pod events; actual image is discoverable in simulated outputs.
- `kubectl set image` and `kubectl rollout undo` are alternate repair paths; `kubectl rollout status` verifies recovery.
- Lab checklist for the image incident accepts either repair and requires evidence discovery before credit.
- Added the new command families to the academy.
- Removed answer-insertion from guided lab workspace.

## Limitations (important)
This is a JavaScript simulation, not NVIDIA exam content or a live cluster. Other Slurm/BCM scenarios still have scripted command matching and the mock lab grading still uses checklist completion. Full state-based grading and exhaustive command coverage are **not** implemented. Do not present this as a verified full exam replica.
