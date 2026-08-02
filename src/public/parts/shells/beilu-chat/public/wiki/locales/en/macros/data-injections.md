# Data Injection Entries and Data Macros (*-data)

Dynamic content (data that changes every turn or frequently) enters the conversation exclusively through **tail data injection entries** — these are entries in `injection_prompts` whose id ends with `-data`, with `depth: 0` (injected below the chat history). Template text is editable in the INJ panel; the code only provides the values of data Macros.

## Why Dynamic Content Must Go in the Tail

Prompt caching works by prefix matching: if a single character in the head (system area) changes, the entire cache prefix is invalidated, and every turn is re-billed / re-processed for tens of thousands of tokens. Therefore:

- **Fixed content** (identity, rules, capability descriptions) → head (`depth >= 1`), stable and unchanging, cacheable
- **Dynamic content** (state, retrieval results, task data, Macros that change every turn) → tail (`depth: 0` `*-data` entries), after the cache breakpoint, where changes do not break the cache
- The cache breakpoint is placed automatically by the proxy layer before `*-data` entries (the `-data` suffix is one of the recognition markers for volatile-zone detection)

## Iron Rules and Interception Mechanism

**Prompt text may only exist in INJ entries and Presets; hardcoding prompts in code is forbidden.** The only exemption: system acknowledgements after an AI issues a command (tool execution results, etc.), which naturally appear at the tail of the conversation.

Mechanism enforcement (not relying on self-discipline):

- `getPromptHandler` performs a **whitelist check** before returning: the id of an injection entry must be registered in `injection_prompts`; unregistered injections are intercepted and removed, and a visible warning (`dataInj:hardcodeBlocked`) is left in the diagnostic system
- New injections must first have an entry registered in the config (the template is editable from the frontend); the code only supplies data Macro values through the unified entry point `_pushDataInj`
- A missing entry (replica not seeded / deleted) produces a visible warning `dataInj:entryMissing`; the frontend "Restore Defaults" button can recover it

## Data Injection Entry List

The following entries are injected on demand by the data production point (if there is no data, the entire entry is not injected); Macros in the template are **entry-local data Macros**, valid only within the corresponding entry template:

| Entry id | Content | Data Macros | Trigger condition |
|----------|---------|-------------|-------------------|
| `INJ-p1-act-data` | P1 self-driven recall memory data | `{{p1_act}}` | P1 pipeline has recall results |
| `INJ-p1-recall-usage` | P1 recall memory usage guide | _(static text)_ | linked with INJ-p1-act-data |
| `INJ-p1-retrieval-data` | Memory AI retrieval results | `{{p1_retrieval}}` `{{p1_retrieval_ts}}` | P1 retrieval has results |
| `INJ-p8-web-search-data` | Web search results | `{{p8_results}}` | P8 search has results |
| `INJ-chat-search-data` | Previous-turn chat AI search results | `{{chat_search_results}}` `{{chat_search_ts}}` | Pending search results to inject |
| `INJ-table-edit-feedback-data` | Previous-turn tableEdit failure details | `{{table_edit_failures}}` `{{table_edit_ts}}` | Has failure feedback |
| `INJ-scheduler-due-data` | Due scheduled task reminders | `{{scheduler_due}}` | Has due tasks |
| `INJ-delegate-task-data` | Active delegated task | `{{delegate_seq}}` `{{delegate_from}}` `{{delegate_priority}}` `{{delegate_source_channel}}` `{{delegate_user_message}}` `{{delegate_task}}` `{{delegate_chat_context}}` `{{delegate_report_instruction}}` | Has active delegation |
| `INJ-delegate-report-data` | Delegation completion report | `{{delegate_report_to}}` `{{delegate_report_status}}` `{{delegate_report_task}}` `{{delegate_report_body}}` | Has uninjected report |
| `INJ-parallel-delegate-data` | Parallel delegation results | `{{parallel_count}}` `{{parallel_results}}` | Has parallel results |
| `INJ-approval-results-data` | Approval result feedback | `{{approval_results}}` | Has approval decisions |
| `INJ-async-ai-data` | Background AI results | `{{async_ai_results}}` | Has async results |
| `INJ-flow-group-data` | Flow group execution status | `{{flow_group_name}}` `{{flow_group_progress}}` `{{flow_group_steps}}` `{{flow_group_current}}` `{{flow_group_auto_advance}}` | Flow group is running |

Optional-field "Label: " lines in templates are automatically stripped when the data is empty (mechanism behavior; templates can safely include all fields).

## Dynamic Macros Moved to Tail Entries (Split from Head)

The following entries carry dynamic Macros that were originally mixed into head description blocks (global Macros — see the individual Macro documentation pages):

| Entry id | Content | Macros | Original location |
|----------|---------|--------|-------------------|
| `INJ-browser-status-data` | Browser connection status line | `{{browser_status}}` `{{browser_port}}` | Last line of INJ-browser (head) |
| `INJ-work-submodes-data` | Real-time list of work group sub-modes | `{{work_sub_modes_list}}` | INJ-1-work (head) |
| `INJ-code-submodes-data` | Real-time list of code group sub-modes | `{{code_sub_modes_list}}` | INJ-2-code (head) |

The corresponding head entries have been updated to point to a description ("see the tail injection block for the real-time list"), keeping the head stable across turns.

## Editing and Restoring

- All `*-data` entries are editable in the **INJ injection panel** (content template / depth / order / toggle)
- If an entry is broken, use "Restore Defaults" to recover the factory template
- Disabling an entry (`enabled=false`) means the corresponding data is no longer injected (the data production logic continues running; it just does not enter the conversation)
