# Bundled sound sources (tutorial typing blips)

The 32 .ogg files in this directory come from two OpenGameArt collections:

1. **Dialog vocal samples** — MirceaKitsune, **CC0** (public domain)
   https://opengameart.org/content/dialog-vocal-samples
2. **Dialogue Blips** — nicolebutspooky, **CC-BY 4.0** (attribution required — credited here and in the project README "Sound assets" section)
   https://opengameart.org/content/dialogue-blips

Per-file attribution follows the source pages above.

## Not bundled (user-layer, auto-downloaded)

**Soundeffect-Lab (効果音ラボ)** — https://soundeffect-lab.info/
Free for personal/commercial use, but redistribution as part of an application is prohibited by its terms. Therefore these files are NOT in the repository: the backend endpoint `sounds-download` (main.mjs) downloads them on first editor open into `data/tutorials/sounds/` (git-ignored, local-only).

Files starting with `_` in this directory are metadata, not sounds (excluded from the sound list by main.mjs).
