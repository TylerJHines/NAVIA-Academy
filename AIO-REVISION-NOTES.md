# NAVIA AIO simulator revision

- Based on the original NAVIA archive; only `aio/app.js` was changed.
- 15 scenario exercises and four randomized 30-question / three-lab mock exams remain.
- Removed `simctl` repair shortcuts in favor of recognizable CLI command forms.
- Guided objectives can be completed out of order; valid commands still return outputs.
- Expanded the multiple-choice bank with scenario-based troubleshooting questions.
- BCM configuration and commit are simulated; actual PXE provisioning, image synchronization, hardware, and cluster administration are **not** simulated.
- The terminal is a limited browser simulation, not a real shell. Unsupported valid commands may still return an unsupported message.
- Some scenario remediation is simplified and must not be used as production runbooks.
- This is unofficial exam preparation and does not replicate protected exam questions.
