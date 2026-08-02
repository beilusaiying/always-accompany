# Entries & Trigger Mechanisms

Complete field reference and three trigger modes for World Book entries. Entries are created and managed in the [World Book Editor](beilu:editor/worldbook).

## Entry Structure

Each World Book entry consists of the following fields:

### Core Fields

| Field | Type | Description |
|-------|------|-------------|
| **key** | String/Array | Primary keywords, used for trigger matching |
| **keysecondary** | String/Array | Secondary keywords, used in conjunction with primary keywords |
| **content** | String | Information content injected to the AI |

### Trigger Control Fields

| Field | Type | Description |
|-------|------|-------------|
| **constant** | Boolean | Whether this is a constant entry (injected every turn) |
| **useRegex** | Boolean | Whether keywords use regular expression matching |
| **selective** | Boolean | Whether to enable joint evaluation with secondary keywords |

### Injection Control Fields

| Field | Type | Description |
|-------|------|-------------|
| **position** | Enum | Injection position: before (before character description) / after (after character description) / atDepth (specified depth in chat history) / AN / EM |
| **depth** | Number | When position is atDepth, specifies the insertion depth (before the Nth conversation turn) |

### Probability & Pacing Fields

| Field | Type | Description |
|-------|------|-------------|
| **probability** | Number (0-100) | Trigger probability; 100 means always triggers |
| **sticky** | Number | Number of turns to continue injecting after triggering |
| **cooldown** | Number | Number of turns to cool down after triggering (will not trigger again during cooldown) |
| **delay** | Number | Number of turns to wait after matching before actually injecting |

### Toggle Fields

| Field | Type | Description |
|-------|------|-------------|
| **enabled** | Boolean | Global enable switch, shared across characters |
| **boundCharName** | String | Character binding; only takes effect with the specified character |

## Three Trigger Modes in Detail

### 1. constant (Always-On Mode)

```
constant: true
```

The entry is always injected; keywords are not checked. Suitable for:
- Fundamental world-setting information
- Universal behavior rules
- Information the AI always needs to know

### 2. regex (Keyword / Regex Matching Mode)

```
constant: false
useRegex: true/false
selective: true/false
```

Triggers based on matching keywords against conversation content.

**Matching logic**:

- `useRegex: false`: Keywords are matched as plain text (triggers on containment)
- `useRegex: true`: Keywords are matched as regular expressions

**selective behavior**:

- `selective: false`: Only primary keywords (key) are checked; any match triggers
- `selective: true`: Both primary keywords (key) and secondary keywords (keysecondary) must match to trigger

Selective mode is used for precise trigger control. For example: key set to "magic" and keysecondary set to "forbidden" -- the entry about forbidden magic is only injected when both "magic" and "forbidden" appear in the conversation.

### 3. dynamic (Dynamic Check Mode)

Dynamic mode does not check conversation text; instead, it checks specific values in Memory Tables. For example:

- Check whether the "location" field in #0 Time & Space table equals "forest"
- Check whether the "affinity" in #2 Social table exceeds a certain threshold

This allows World Book entries to take effect dynamically based on the character's current state.

## Injection Position Details

### before / after

Injected before or after the character description. These positions are close to the system prompt, so the AI gives them higher attention.

### atDepth

Injected at a specified depth within the chat history. The meaning of depth:

- `depth: 0`: After the most recent message
- `depth: 1`: Before the most recent message
- `depth: N`: Before the Nth conversation turn

The smaller the depth, the closer to the latest message, and the more attention the AI pays to it.

### AN / EM

AN (Author's Note) and EM are native injection positions defined by the upstream framework.

## Probability & Pacing Control

Probability and pacing fields work together to create natural information appearance patterns:

**Example: Random event**
- `probability: 30`, `sticky: 3`, `cooldown: 10`
- 30% chance to trigger each turn; after triggering, continues injecting for 3 turns; then cools down for 10 turns

**Example: Delayed foreshadowing**
- `delay: 5`
- After keyword match, delays 5 turns before injecting, creating a "revealed later" effect

## Dual Toggle Interaction

```
enabled: true  + boundCharName: ""      → Active for all characters
enabled: true  + boundCharName: "Alice"  → Active only for character Alice
enabled: false + (any)                   → Completely inactive
```

enabled is the global switch, shared across characters. boundCharName is a character-level filter. They have an AND relationship.

## Processing Pipeline

```
System constructs context
    ↓
Iterates through all World Book entries
    ↓
For each entry:
  1. Check enabled → skip if false
  2. Check boundCharName → skip if no match
  3. Check cooldown → skip if cooling down
  4. Determine trigger mode:
     - constant → pass directly
     - regex → match against conversation content
     - dynamic → check Memory Table values
  5. Check probability → random determination
  6. Check delay → do not inject yet if not reached
    ↓
Entries that pass are placed at their corresponding position in context by position and depth
    ↓
Update sticky / cooldown counters
```
