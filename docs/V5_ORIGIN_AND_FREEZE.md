# V5 origin and freeze record

**Created:** 2026-09-03, India time.
**Source:** `E:/Voice Agent 1/Prodapt IPL project V4`
**Plan:** [`../../research/V5_BUILD_PLAN_NATURAL_VOICE_SMART_TRANSCRIPTS_2026-09-03.md`](../../research/V5_BUILD_PLAN_NATURAL_VOICE_SMART_TRANSCRIPTS_2026-09-03.md)

This file records where V5 came from and proves that making it did not change
anything else. It is not a claim that any V5 feature works.

## In plain terms

We copied V4's working code into a new folder, gave it its own port numbers, its
own demo database and its own browser login keys, then started adding to the
copy. V4 itself was never opened for writing. If V5 turns out to be worse, V4 is
still sitting there, unchanged, ready to run.

## What is frozen

| Project | Role from here on | Touched while building V5? |
|---|---|---|
| `Prodapt IPL project V1` | Emergency demo. | No. Read only. |
| `Prodapt IPL project V2` | Research evidence. | No. Read only. |
| `Prodapt IPL project V3` | Research evidence. | No. Read only. |
| `Prodapt IPL project V4` | **The current demo candidate and the fallback.** | No. Read only. |
| `Prodapt IPL project V5` | **This project.** Natural delivery style + transcript lab. | Yes. All new work lands here. |

V4 was running on ports 5174/4175 throughout the V5 build. No V4 process was
stopped, restarted or reconfigured, and no V4 port was taken.

## How the copy was made

Files were copied one at a time from an explicit list, verified by hash
afterwards, and confirmed to be independent files rather than links:

```
V4 src/main.js  inode 844424931063712
V5 src/main.js  inode 281474977647840
```

Different inodes, so editing V5 cannot edit V4.

### Deliberately NOT copied

| Excluded | Why |
|---|---|
| `.env` | Contains real credentials. V5 has its own `.env.example` template and needs its own `.env`. |
| `data/` (`actionguard.db`, `-shm`, `-wal`) | V4's live customer and call state. V5 seeds a fresh demo database instead. |
| `node_modules/` | Reinstalled from the lockfile so V5's dependency tree is its own. |
| `dist/` | Build product. Rebuilt from V5 source. |
| `.git` | None present. |

No secret value is recorded anywhere in this file or in the manifest below.

## V4 source manifest at copy time

30 files. SHA-256 of the exact bytes copied, excluding secrets, the database,
`node_modules` and build products.

| SHA-256 | File |
|---|---|
| `1d90a5e5c676668e80760285d7879a85ef124d6d3ac40e446561b9e1fc81d8a2` | `AGENTS.md` |
| `3d865f1c196402613d6fc5eb57dac266ecd155a932c2265f4c9e76e6632b9300` | `README.md` |
| `fb67654b972ae4f0c61437e3c493bcefd150e9e30fccfb9e418165616b99aaf8` | `docs/GATE_0_FREEZE.md` |
| `7bfff871b707682630ac6181e73c1dfef5a1b45325d80d255e54bccdbde7cb5f` | `docs/PHYSICAL_TEST_PROTOCOL.md` |
| `69acf221c05249956b666de53cb9e14c8a223fb59385fdf1727ec83a41323e6e` | `index.html` |
| `fe3a7a637938562318ea28ea5f67271b0a6d94bec30d76c6c84c2bec78218673` | `package-lock.json` |
| `bea0208398f9b57fa048a255a8881234bf0a349a5906733515ce1d4c6bf18792` | `package.json` |
| `5f71c9c2b0046c992ca65d06336fdab161cb117e7f6b55d88ae6d12fae22b5a1` | `scripts/gate-report.js` |
| `5bee7ceb2da158339f3e1f5a98e63c6d56924f403c7b72c1de39e2f5eb9ebfb6` | `server/agent/gemini-live.js` |
| `debce65f8a2e644909dc4e5544111422aaf1dcfc209815c05059da1923a0ea6e` | `server/app.js` |
| `79f4cada8d9d2f66cac5cd3ebac5ae523b090771166d6a5e3cb44c9e8547b16d` | `server/auth.js` |
| `cd8a80f67b21aab65c43862dbe846f81c5df63c3fd8e4530c9cf9e3d48d1d29a` | `server/db.js` |
| `14d21f087e20c0fbdc39f11720583f7a954a46d33abb281b435ee0539b042fa7` | `server/flight-recorder/index.js` |
| `60e835c5b400ab9da5fef8c1cbff3341c9e09ea41ba768e30bad85643b90984d` | `server/ledger.js` |
| `78d87b1a8263374ad09ba9cc1ce356f9e82566ed296ce21ceaf76589d8321b2b` | `server/policy.js` |
| `3961ea62561c1c83c61f7243ea09b9827eb4bf8a2949bd1b38d8805dea3240c5` | `server/tools.js` |
| `78690d9469f7ada283cc78c3c714c982caa4a4a762b5a297846c86d6e64310ac` | `src/actionguard.css` |
| `163bf61683822fa96810b73cd7166d7959bc7f5879a161baf18c3ba9c580b50b` | `src/hcr/heard-state.js` |
| `5094ed67ea7de6c274fa60903d9e75899e8091736e8fcca1039320c8fbc0d8be` | `src/hcr/speech-energy-probe.js` |
| `4627c10e3e011abaa03e0f6ff495c07a5cf742b7845b7d7751fe34067be67492` | `src/main.js` |
| `d299867ad58344096dd60b4fa5646760e6bc8733147b06a62ef2c99dbff7ed2e` | `src/recorder/client.js` |
| `5827a2d733e43a0c3d1409abbac991255f4378c4fe6268f1e8a87d7481462535` | `src/styles.css` |
| `cc938faf66be25f714e3943d1237c56176ff95542a9cae23da35d56ce7b28287` | `src/voice/gemini-live.js` |
| `b01c8206e4cb9dde272084a52529554d3591e7f3d2da133d6309455733c554a2` | `src/voice/prompt.js` |
| `d107a2fb6e74d88167612b06fdb73afd14bed3bde18964f169e672406a5ced0c` | `tests/actions.test.js` |
| `17a14071e7537ead4f9ceac593fe2c98605516812a9b1e61e0c34ab517bbafce` | `tests/api.test.js` |
| `d841bceb975d6e38f7059491abd1ff46a9501b6453998abccc4637085b4ee826` | `tests/flight-recorder.test.js` |
| `d922a6eb986f9556640c13ade363994ad3bc68642aea210049de256b37298579` | `tests/heard-state.test.js` |
| `45ff823e3fbee8e1d0cbe8c2e0312aa9b67e21546b52faccc474453eba244d70` | `tests/policy.test.js` |
| `6a6fe350b33a029122af5e9f12b966589e856362e80e0029362b344245d08fcc` | `vite.config.js` |

To confirm V4 is still untouched, recompute this list against V4 and diff it
against the table above. Any difference means something wrote to V4 and must be
investigated before trusting a V5 result.

## What was changed to make V5 separate

| Concern | V4 | V5 |
|---|---|---|
| Vite dev server | 5174 | **5175** |
| Express API | 4175 | **4176** |
| Vite `/api` proxy target | `http://127.0.0.1:4175` | **`http://127.0.0.1:4176`** |
| Database file | `data/actionguard.db` | **`data/actionguard-v5.db`** |
| Session storage keys | `actionguard_token`, `actionguard_role` | **`v5_actionguard_token`, `v5_actionguard_role`** |
| Sign-out behaviour | `sessionStorage.clear()` | **removes only the two `v5_` keys** |
| Package identity | `hcr-actionguard@0.4.0` | **`hcr-actionguard-v5@0.5.0`** |
| Page title | `HCR ActionGuard · Interruption-Safe Voice Core` | **`HCR ActionGuard V5 · Natural Voice & Transcript Lab`** |

Ports 5175 and 4176 were confirmed free before being chosen. No process was
terminated to free a port.

### A new guard against writing to V1-V4

`server/db-path-guard.js` refuses any database path outside this project
directory. This matters because `openDatabase()` **migrates and seeds** whatever
file it opens, so merely pointing a reporting script at another version's
database would write to it. `scripts/gate-report.js` now runs its `--db`
argument through that guard. Verified:

```
$ node scripts/gate-report.js --db "e:/Voice Agent 1/Prodapt IPL project V4/data/actionguard.db"
Error: Refusing to open a database outside this V5 project.
  requested: e:\Voice Agent 1\Prodapt IPL project V4\data\actionguard.db
  V5 root:   E:\Voice Agent 1\Prodapt IPL project V5
```

## Fresh demo database, not a continuation

`data/actionguard-v5.db` is created by V5's own `openDatabase()` from the same
schema and seed logic V4 used. It contains the seeded demo accounts and nothing
else. **It is not a continuation of V4's customer state.** V4's call history,
prepared intents and review requests are not present in V5, and V5's are not
present in V4. Any billing scenario run in V5 starts from the seeded state.

## Dependencies

Installed with `npm ci` from the inherited lockfile, so the resolved versions are
V4's. Only the lockfile's root `name`/`version` fields were edited, to match the
new package identity; no dependency version was changed and no upgrade was run.

| Package | Resolved |
|---|---|
| `@google/genai` | **2.20.0** |
| `express` | 5.2.1 |
| `zod` | 4.5.4 |
| `vite` (dev) | 8.2.2 |
| `concurrently` (dev) | 10.0.5 |

`@google/genai` 2.20.0 is the version the V5 research was performed against.
Note that 2.21.0 was published 2026-09-02; V5 deliberately stays on 2.20.0 so a
behaviour change cannot be confused with a feature change. If that pin is ever
moved, re-run the baseline before attributing anything to a V5 feature.

## Baseline before any feature change

Run on the fresh copy, before the first V5 edit:

```
$ npm ci      -> added 143 packages, 0 vulnerabilities
$ npm test    -> 51 tests, 51 pass, 0 fail
$ npm run build -> built in 445 ms
```

Zero inherited failures. No test was deleted, skipped or loosened.

## What this file does NOT say

- It does not say any V5 feature works. See
  [`V5_TEST_RESULTS.md`](V5_TEST_RESULTS.md).
- It does not carry V4's gate labels over. V4's `AGENTS.md` marked Gate 0 and
  Gate 4 "done"; those were V4 results, achieved on V4's code, and they are not
  V5 results.
- It does not claim V5 has been physically tested. Nothing here needed a
  microphone.
