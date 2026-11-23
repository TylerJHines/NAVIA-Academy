NAVIA AIO MOCK EXAMS — QUESTIONS-ONLY PATCH

Apply this patch to your reverted ORIGINAL NAVIA Academy (the original
NAVIA-Academy-main (1).zip supplied in this conversation). It modifies
only aio/app.js. It does not update AIO labs, AIN, navigation, Google
login, homepage, or exam-day infographic. Do NOT upload an old full-site
ZIP over your current site; that could overwrite those features.

INSTALL ON GITHUB:
1. Back up your currently working aio/app.js.
2. Replace ONLY aio/app.js with the file in this ZIP, preserving its path.
3. Commit and deploy. Leave all other repository files exactly as they are.
4. Reload the AIO page and start a NEW mock exam; previous in-progress
   mocks may retain their already-selected question snapshots.
5. If you still see the old questions, force a page refresh (Ctrl+Shift+R).

QUESTION BANK:
- 4 separately defined sets; 30 questions per mock = 120 unique stems.
- In each mock: 9 Installation/Deployment, 7 Administration,
  7 Workload Management, 7 Troubleshooting/Optimization.
- Question order and answer positions are randomized, but the four tests
  use distinct question sets. Lab selection/scoring are unchanged.
- These questions are ORIGINAL and cover concepts visible in the four
  uploaded paid practice-test review videos and NVIDIA's published AIO
  blueprint. They do not reproduce copyrighted Udemy items verbatim.
- Explanations are included in the existing end-of-exam review.

VALIDATION:
- node --check passed.
- Headless Chromium isolated-page checks: all four tests, all 120 unique
  questions, four answer choices/one correct per question, 9/7/7/7 domain
  mix, 100% scored when all answer keys selected, lab transition, result
  screen, and existing lab-library navigation passed.
- No JavaScript runtime errors detected in isolated-page tests.
- Isolated-page tests do not verify the live GitHub deployment or the
  paid Udemy platform, nor claim actual NVIDIA exam-question equivalence.
- Original AIO non-question code audited byte-for-byte after stripping
  the question-bank replacement and three exam-selector text/behavior edits.

Source requirements: https://www.nvidia.com/en-us/learn/certification/ai-operations-professional/
