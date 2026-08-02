# Variable System (beilu-mvu)

beilu-mvu (Model-View-Update) is always-accompany's variable system plugin. It allows Presets, Character Cards, and AI replies to read and write variables, enabling cross-turn state tracking. For example, a character's affinity level, HP, task progress, and other dynamic values can all be managed through the variable system.

## Variable Types

| Type | Scope | Lifetime | Macro Syntax |
|------|-------|----------|--------------|
| Local variable | Current conversation | Duration of the conversation | `{{getvar::name}}` / `{{setvar::name::value}}` |
| Global variable | Cross-conversation | Persistent | `{{getglobalvar::name}}` / `{{setglobalvar::name::value}}` |

## Variable Macros

### Reading Variables

```
{{getvar::hp}}           → Read local variable hp's value
{{getglobalvar::score}}  → Read global variable score's value
```

### Writing Variables

```
{{setvar::hp::100}}           → Set local variable hp = 100
{{setglobalvar::score::50}}   → Set global variable score = 50
```

### Arithmetic Operations

```
{{addvar::hp::-10}}           → Decrease hp by 10
{{addglobalvar::score::5}}    → Increase score by 5
```

## Pipeline Interfaces

### GetPrompt

beilu-mvu's GetPrompt interface can inject the current variable state into the prompt, letting the AI know the current variable values.

### TweakPrompt

During the TweakPrompt phase, beilu-mvu processes variable Macro substitution within messages.

### ReplyHandler

After the AI reply arrives, beilu-mvu parses variable operation commands in the reply (if the AI used specific variable operation tags) and executes the corresponding read/write operations.

## Relationship with the Macro System

beilu-mvu's variable Macros are a subset of the Macro system. Variable Macros are executed during the backend substitution phase (before sending to the AI). The Macro substitution engine `evaluateMacros` calls beilu-mvu's read/write functions when it encounters variable Macros.

See [Variable Macros](../macros/variables.md) for details.

## Use Cases

| Scenario | Variable Examples |
|----------|-------------------|
| RPG game | HP, MP, gold, level |
| Affinity system | Affinity score, relationship stage |
| Task tracking | Task status (in progress / completed), progress percentage |
| Counters | Conversation turn count, event trigger count |
| Conditional branching | Determine AI reply style based on variable values |

## Data Storage

- Local variables are stored with the conversation
- Global variables are persisted via SetData

## Navigation

- [Plugin Overview](overview.md) -- Plugin system introduction
- [Variable Macros](../macros/variables.md) -- Detailed variable Macro syntax
- [Script Engine](scripts.md) -- More complex logic control
