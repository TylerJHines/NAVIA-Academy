# NCP-AIO three-scenario trainer: documentation alignment

These are **practice simulations based on an unverified candidate report**, not official NVIDIA exam tasks.

## Slurm
Discover the failure without a supplied job ID; inspect `sinfo`, `squeue`, accounting (`sacct`), `scontrol show node`, and daemon logs; correct the simulated slurmd failure; resume and verify node state; submit a batch job, inspect output; drain and verify the maintenance node. `sacct` requires working accounting. Node resume is not itself a repair. See NVIDIA BCM Workload Management and SchedMD Slurm documentation.

## Kubernetes
Access the Kubernetes environment, verify ready nodes, create a batch/v1 Job with valid restartPolicy, apply and verify completion/logs, then create and verify a separate workload. `module load kubernetes` is environment-dependent. The simulator's editor is used in place of an interactive terminal editor.

## BCM
Clone default-image and commit (image copying may take time), clone default category and assign the committed image, then register a physical node with category and MAC. Real deployments may require network-interface configuration, provisioning checks and more settings. `cm-kubernetes-setup` launches a TUI that can save configuration; use `cm-kubernetes-setup -c /path/to/config` to deploy the saved config. The simulator abstracts the TUI and physical provisioning.

## Primary sources
- https://docs.nvidia.com/base-command-manager/product-manuals/10/admin/workloadmanagement
- https://docs.nvidia.com/base-command-manager/product-manuals/10/admin/clustermanagement
- https://docs.nvidia.com/enterprise-reference-architectures/base-command-manager-enterprise-ra-deployment-guide/latest/create-custom-softwareimage-and-category.html
- https://docs.nvidia.com/base-command-manager/product-manuals/10/containerization/kubernetes

## Known limitations
Simulated commands and results are not a real shell, scheduler, cluster, or BCM installation. Do not use this simulator as a production runbook. The academy's existing timed mock labs and progress persistence are not modified by this update.
