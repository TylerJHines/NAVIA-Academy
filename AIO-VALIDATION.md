# AIO simulator validation and limitations

This package is a **tested revision**, not a verified replica of the NVIDIA NCP-AIO hands-on examination.

## Tests performed
- `node --check aio/app.js` JavaScript syntax check.
- Automated Node VM smoke test initialized the app and executed the prescribed command sequence for all 15 lab scenarios. The Kubernetes image lab additionally inspected a previous ReplicaSet before repairing the deployment.
- All 15 scripted paths reached their checklist completion state in this test harness.
- ZIP archive integrity checked after packaging.

## Outstanding limitations
- Commands and outputs are simulated. The command parser does not implement the full CLI behavior of Slurm, Kubernetes, or NVIDIA Base Command Manager.
- Some labs still use exact command matching to mark diagnostic steps complete. Not all legitimate alternate repair paths are implemented.
- Mock exam practical scoring still uses checklist progress, with added state checks for a number of repair outcomes, rather than a fully independent system-state rubric.
- No actual Kubernetes, Slurm, or BCM cluster was used for verification; no live browser UI regression run was completed.
- This is an unofficial training aid and cannot reproduce confidential NVIDIA exam tasks.
