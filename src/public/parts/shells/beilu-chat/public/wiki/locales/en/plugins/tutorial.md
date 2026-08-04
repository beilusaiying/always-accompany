# Tutorial / Visual Novel: Turn Documentation into an Interactive Flow

beilu-tutorial is more than a Wiki renderer. It stores, edits, and plays tutorial or visual-novel sequences with character art, branching dialogue, UI guidance, text pacing, choices, and sound.

Use it when a new user must complete a setup in order, when a real UI element needs contextual guidance, or when onboarding should feel like a character-led scene. For two or three static sentences, a normal Wiki page is easier to maintain.

## End-to-end path

```text
tutorial JSON
  → list and editor
  → block / scene / dialog parsing
  → character, text panel, choices, UI guidance, and sound
  → user chooses the next step or branch
```

Tutorials can be created, updated, and deleted. IDs accept only letters, numbers, underscores, and hyphens within a bounded length, so arbitrary paths cannot become tutorial file names.

## Storage and sharing

- Scripts live under `data/tutorials/`.
- They are currently global shared data, not per-user records.
- `_defaults.json` can override editor capability limits and defaults.
- System files beginning with `_` do not appear in the normal list.
- Image packs reuse the Eye image-pack API.
- Deleting a tutorial deletes its JSON; preserve any copy you need first.

## Two sound layers

1. Redistributable sounds shipped with the plugin.
2. User-local sounds under `data/tutorials/sounds/`, which override built-ins by name.

The editor can download additional effects from an external sound site into the user-data layer. Downloading is a network action, and a local copy does not automatically grant redistribution rights. Check each asset license before publishing a tutorial.

An effective tutorial starts with the outcome, asks for one action per scene, binds guidance to real UI, branches only for real user choices, ends with a real task, and keeps a searchable Wiki page for later reference.

See [Quick Start](../getting-started/overview.md), [Eye](eye.md), and [Plugin Combinations](combinations.md).
