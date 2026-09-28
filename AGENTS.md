# Project workflow

- The owner wants completed implementation milestones committed and pushed to
  `origin` (`https://github.com/alegsdav/ebay.git`), unless they explicitly ask to
  keep work local. Do not leave completed work uncommitted without explaining why.
- Inspect existing changes and remote history first. Preserve unrelated work;
  never force-push or overwrite remote history without explicit authorization.
- Before committing, check for secrets, run relevant tests and builds, and update
  the status/next-step documentation. Never commit private environment files,
  credentials, local databases, or generated dependency/build directories.
- Every handoff must distinguish implemented, tested, committed/pushed, and
  deployed status, and state the user's next manual action or current blocker.
- A Git push is not a deployment. Keep monitoring disabled until provider access,
  the zero-dollar budget controls, and end-to-end collection are verified.
