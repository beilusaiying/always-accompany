# Hot Layer Memory

The Hot Layer (hot) is the memory layer closest to the AI. Information in the Hot Layer is **automatically injected into the context every conversation turn** -- the AI sees it without needing to actively recall. This is where the information AI most urgently needs is stored.

## Hot Layer Files

The Hot Layer consists of the following core files:

| File | Content | Description |
|------|---------|-------------|
| **forever.json** | Permanent memory | Important information marked as "remember forever"; never migrated |
| **appointments.json** | Appointments / Schedule | Time-related plans and commitments |
| **user_profile.json** | User Persona | User preferences, habits, and personal information |
| **Monthly index** | Current month's memory index | Index of recent memory entries organized by month |

Additionally, the active tables for each mode (#0-#9 / C0-C5 / W0-W4) also belong to the Hot Layer.

## Auto-Injection Mechanism

Injection flow for each conversation turn:

```
User sends a message
    ↓
System constructs context
    ↓
Reads from the hot layer:
  - forever.json (permanent memory)
  - appointments.json (schedule)
  - user_profile.json (User Persona)
  - Active table contents for the current mode
  - Relevant entries from the monthly index
    ↓
Assembles Hot Layer content into the designated position in context
    ↓
Sends to AI
```

## forever.json

Stores information marked by the AI as "remember forever." This information is considered core and should not be forgotten, for example:

- Important promises between characters
- Things the user explicitly asked the AI to remember
- Key settings and rules

Content in forever.json **does not participate in migration** and always remains in the Hot Layer.

## user_profile.json

Stores User Persona information, including:

- User's preferred form of address
- Interaction habits (preferred reply style, etc.)
- Personal background information (voluntarily shared by the user)

## appointments.json

Stores time-related plans:

- Appointments and schedules
- Timed reminders
- Recurring events

## Monthly Index

Memory index files organized by month. The index records summaries and locations of recent memory entries for quick lookup and recall. The current month's index belongs to the Hot Layer; past months' indexes reside in the warm or cold layer.

## Hot Layer Capacity Management

Hot Layer content directly consumes context space, so capacity must be controlled:

- Memory Table entries are automatically migrated to the warm layer over time
- Expired schedule entries are cleaned up
- Monthly indexes roll by month; old months are moved out of the Hot Layer

See [Memory Archival & Retrieval](archival.md) for migration details.

## What This Means for Users

- You do not need to manually manage the Hot Layer; the system maintains it automatically
- If you want the AI to always remember something, explicitly tell the AI to "remember this forever" -- the AI will write it to forever.json
- Having too much Hot Layer information squeezes conversation space; the system automatically balances this
