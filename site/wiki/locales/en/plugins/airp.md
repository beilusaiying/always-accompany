# AIRP Scene Rendering (beilu-airp)

AIRP turns scene, char, and desc DSL tags into colored text, symbol art, and dynamic scenes. It is useful for companionship, roleplay, and interactive narrative. It is not image generation, and it does not ask the model to perform authoritative numeric state calculations.

## What it separates

- The LLM writes narrative and scene tags.
- Deterministic code applies set, delta, and remove state changes.
- A renderer uses an editable capability profile to build the DOM.
- Numeric commands are hidden from display while state persists in the message extension.

## Good fit

- Character companionship, text adventures, and game narrative
- Editable palettes, tags, positions, moods, and effects
- Worldbook or MVU state influencing presentation

It is unnecessary for plain text or generated raster images. Users sensitive to motion can disable effects, and the renderer respects reduced-motion preferences.

## Default and configuration

The per-user AIRP store defaults to enabled=true. When loaded with a user context, AIRP self-registers for that user. Confirm actual participation through Plugin Management and the message chain.

The effective capability profile merges factory defaults with per-user differences:

| Area | Purpose |
|---|---|
| palette | Semantic color names to CSS values |
| tagSpec | Allowed DSL tags and attributes |
| dynEffects | Glow, rain, flicker, and motion controls |
| layout | Responsive columns and breakpoints |
| fallback | Unknown-tag behavior |

Per-user configuration is stored at:

    data/users/<user>/airp/config.json

## Runtime path

    Editable AIRP configuration / DSL guidance
      ↓ GetPrompt
    Model returns scene tags and airp-patch
      ↓ ReplyHandler
    Deterministic state update + hidden commands
      ↓ GetRenderView
    DOM for the current message

Rendered DOM is a view, not a second chat-log truth source. Persistent state belongs to the message extension.

## Useful combinations

| Combination | Result |
|---|---|
| worldbook + AIRP | Stable setting affects scene presentation |
| MVU + AIRP | Variables drive visual state |
| regex/EJS + AIRP | Rules or templates prepare content |
| memory/P1 + AIRP | Recalled events appear in the current scene |
| eye/STT + companion + AIRP | External input affects narrative presentation |

## Boundaries

- Validate colors and attributes through the capability profile; do not treat arbitrary HTML as DSL.
- Unknown tags should follow fallback instead of removing the whole message.
- Numeric state follows deterministic operations, not the displayed prose.
- Debug the original reply, extension state, and rendered DOM separately.

## Continue

- [MVU](mvu.md)
- [Scripts](scripts.md)
- [Regex](regex.md)
- [Worldbooks](../memory/worldbook-overview.md)
- [Plugin Manual](overview.md)
