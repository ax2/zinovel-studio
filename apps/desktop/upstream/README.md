# Official desktop source provenance

The following files are copied byte-for-byte from `deepseek-ai/deepseek-harness`
at commit `687f282e8625c6b8d11ff58211a90524be2e4317`:

- `apps/desktop/src/single-instance.ts` → `single-instance.ts`
- `apps/desktop/src/node-environment.ts` → `node-environment.ts`
- upstream root `LICENSE` → `LICENSE`

ZiNovel's desktop main, preload and writing renderer are purpose-specific code.
It derives the official single-instance and Electron-as-Node lifecycle, and uses
the official same-version DSH CLI, SDK and agent-loop. It does **not** claim to
ship or validate the complete upstream desktop UI/Office host. The choice to
use its supported SDK profile inside this derived desktop avoids activating
unrelated Office, terminal, account-browser and coding UI features.

`node scripts/check-upstream.mjs` checks source hashes against the provenance
manifest. `node scripts/fetch-upstream.mjs` recreates the ignored source checkout
for audits; application builds consume pinned published packages.
