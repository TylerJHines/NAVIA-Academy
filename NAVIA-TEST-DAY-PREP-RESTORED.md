# NAVIA – Test Day Prep infographic restoration

## Fixed
- Restored **Test Day Prep** as a first-class navigation tab with a stable `#PREP` route.
- Added the original user-uploaded 1536 × 1024 PNG, stored at `assets/nvidia-exam-day-strategy.png` (byte-for-byte preserved).
- The image displays responsively and links to its full-resolution file.
- Restored the NAVIA academy name in the page title and header.
- Updated the main academy CSS/JS URL versions to avoid a stale script or stylesheet when published.
- Supported direct `#PREP`, `#TEST-DAY-PREP`, and `#TESTDAY` bookmarked links.

## Preservation
This package is based on **NAVIA-Academy-AIO-AIN-FINAL-2026-11-19.zip**.
Existing AIO and AIN files are byte-for-byte unchanged. Only `index.html`, `academy.js`, and `academy.css` were modified; the PNG and this document were added.

## Validation run
- Exact PNG checksum matches the provided user image.
- Chromium DOM and image-render testing: 1536-pixel desktop and 390-pixel mobile viewport.
- Tab navigation, direct linking, route persistence on fresh load (three supported hashes) and transitions across all six certification pages.
- No runtime JS exceptions detected in the simulated-browser root UI tests.
- AIO: 15 / 15 tested guided-lab recovery paths; 4 / 4 mock variants tested.
- AIN: 14 / 14 tested guided-lab paths; 4 / 4 mock variants tested.
- All 14 JavaScript files passed `node --check`.
- ZIP CRC integrity checked after packaging.

## Deployment
Copy **all contents of `NAVIA-Academy-main/`** to the root of the GitHub Pages repository (including the new `assets/` directory), commit and publish. Deploying only the HTML/JS files without the image directory will result in a broken infographic.

## Scope of verification
The tests exercise synthetic browser execution and the local packaged source. Live GitHub Pages rollout, production Google login and backend permissions were not directly tested. Verify against the live GitHub branch before overwriting any unpublished changes.
