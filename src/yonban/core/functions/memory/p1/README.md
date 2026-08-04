# P1 self-driven recall

This directory is the single implementation root for P1:

- `node0_recall.mjs` → `node4_rank.mjs`: Node0–4 pipeline.
- `service/`: independent FastAPI host and Python fallback pipeline.
- `serviceRuntime.mjs`: the host's sole service lifecycle owner.
- `bridge/`: lazy helper services on ports 13151–13153.
- `resources/`: bundled source and derived resources.
- `coord/`: offline/runtime coordinate bridge tools.

Persistent P1 state does not live here and does not live in `data`:

- `storage/p1/settings`: global service settings.
- `storage/p1/users/<user>`: user settings, vocab and P9 prompts.
- `storage/p1/users/<user>/characters/<character>`: novelty and character state.
- `storage/p1/runs`, `storage/p1/experiments`: P1 observations.

`data/p1` is disposable runtime state only. Host memory is read-only input and
is resolved by the host's `BEILU_DATA_DIR` / per-user `UserDictionary` contract.
