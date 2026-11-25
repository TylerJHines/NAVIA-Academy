# NCP-AIO scenario command audit (test build)

The scenario content is based on candidate recollections, not verified exam tasks. The simulator is not a real shell, Slurm cluster, Kubernetes API, or BCM installation.

Changes:
- Removed fictional `save manifest` terminal command. The YAML editor now supports Ctrl+O to write and Ctrl+X to close, like GNU nano; the Write Out button is an accessibility alternative, not a shell command.
- Removed fictional `mode` BCM command. `cmsh` context is controlled with documented mode commands and `exit`.
- Corrected BCM physical node creation to `add physicalnode gpu004` followed by `set ip ...`, category, MAC, and commit.
- Added support for documented `commit --wait` during image cloning.
- Kept state-based five-objective completion for each lab.

References:
- https://docs.nvidia.com/dgx/baseos-on-bcm-install-guide/managing-images-bcm.html
- https://docs.nvidia.com/base-command-manager/product-manuals/10/admin/configuring
- https://docs.nvidia.com/base-command-manager/product-manuals/11/admin/clustermanagement
- https://docs.nvidia.com/dgx/baseos-on-bcm-install-guide/updating-nodes-bcm.html
- https://kubernetes.io/docs/reference/kubectl/generated/kubectl_apply/
- https://slurm.schedmd.com/sacct.html

Validation: Node.js syntax check and 47 automated command/state assertions passed across Slurm, Kubernetes, BCM (5/5 objectives each). Browser-based end-to-end testing and integration against real infrastructure were not performed. The simulation supports a limited command subset and illustrative outputs.
