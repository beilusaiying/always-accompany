# Regex Enhancement (beilu-regex)

beilu-regex is a regex script engine used to match and replace text in AI replies before and after they reach the user. It is compatible with SillyTavern's regex script format, allowing you to import regex scripts from the ST community.

## How It Works

beilu-regex operates at two stages in the message pipeline:

### TweakPrompt Phase (Before Sending)

During the dl=0 round (final round) of TweakPrompt, beilu-regex can perform regex processing on messages about to be sent to the AI.

### ReplyHandler Phase (After Reply)

After the AI reply arrives, beilu-regex executes regex rules on the reply text for matching, replacement, filtering, and more.

## Rule Structure

Each regex rule contains:

| Field | Description |
|-------|-------------|
| Name | Display name of the rule |
| Match pattern | Regular expression (supports standard regex syntax) |
| Replacement text | Content to replace with on match |
| Scope | Applies to AI reply / user input / both |
| Enabled state | Whether this rule is active |
| Applicable Presets | Which Presets this rule is bound to |

## Rule Management

### CRUD Operations

Rules are managed via different `_action` values through the SetData interface:

- Create rule
- Edit rule
- Delete rule
- Enable/disable rule
- Adjust rule order

### Importing from SillyTavern

beilu-regex provides an `importFromSTFormat` function that directly imports SillyTavern-format regex scripts. Field formats are automatically converted during import.

When importing Character Cards, if the card contains regex scripts, they are also automatically imported and registered with beilu-regex.

## Regex Guard (ReDoS Protection)

beilu-regex has a built-in regexGuard security mechanism to prevent malicious or accidental regular expressions from causing ReDoS (Regular Expression Denial of Service) attacks:

- Detects potentially catastrophic backtracking patterns
- Execution timeout protection
- The safety switch `regexGuard.enabled` is protected by owner permission

## Preset Binding

Regex rules can be bound to specific Presets. When switching Presets, only rules associated with the current Preset take effect. This allows different characters/scenarios to use different regex processing rules.

When switching Presets, beilu-preset calls `_resyncPresetRegex` to synchronize the activation state of regex rules.

## Typical Uses

| Use Case | Description |
|----------|-------------|
| Format cleanup | Remove extra blank lines, special markers from AI replies |
| Content filtering | Filter out unwanted reply fragments |
| Tag conversion | Convert AI's custom tags to HTML or other formats |
| Character name replacement | Replace variant spellings of character names before display |
| Chain-of-thought hiding | Hide reasoning process tags in AI replies |

## Data Storage

Rule data is stored in `config_data.json` in the plugin directory (data does not migrate with code; it stays in place).

## Navigation

- [Plugin Overview](overview.md) -- Plugin system introduction
- [Script Engine](scripts.md) -- EJS template rendering
- [Plugin Development](../developer/plugin-dev.md) -- Writing custom plugins
