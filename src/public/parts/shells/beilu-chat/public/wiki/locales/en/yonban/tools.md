# Tool List

YonBan provides 30+ tools. The AI calls them during conversations via `<ideToolCall>` tags. Write operations require Approval before execution.

## File Operations (7)

| Tool | Function | Key Parameters | Read/Write |
|------|----------|----------------|------------|
| read_file | Read file content (supports pagination and xlsx/docx/pptx/pdf document parsing) | path, offset, limit | Read |
| write_file | Write/create a file | path, content | Write |
| list_files | List directory contents | path, recursive | Read |
| replace_lines | Replace content by line number range | path, start_line, end_line, new_content | Write |
| insert_at_line | Insert content at a specified line number | path, line, content | Write |
| fuzzy_edit | Fuzzy match replacement (tolerates indentation/blank line differences) | path, old_string, new_string | Write |
| edit_xlsx | Read/write Excel files | path, sheet, operations | Write |

## Search (4)

| Tool | Function | Key Parameters | Read/Write |
|------|----------|----------------|------------|
| search_files | Regex/text search of file content | pattern, path, regex | Read |
| search_by_name | Search by file name pattern | pattern, path | Read |
| smart_search | Semantic search (combining file name + content + path) | query, path | Read |
| ast_search | AST structure search (function/class/variable definitions) | pattern, language | Read |

## Command Execution (2)

| Tool | Function | Key Parameters | Read/Write |
|------|----------|----------------|------------|
| run_command | Execute a command in the IDE terminal | command, cwd | Write |
| run_script | Execute a script file | path, args | Write |

## Diagnostics (5)

| Tool | Function | Key Parameters | Read/Write |
|------|----------|----------------|------------|
| get_diagnostics | Get IDE diagnostic information (errors/warnings) | path | Read |
| get_status | Get IDE status (open files/active editor) | — | Read |
| get_project_summary | Get project structure summary | path | Read |
| validate_html | Validate an HTML file | path | Read |
| lint_code | Code lint check | path, rules | Read |

## Navigation (2)

| Tool | Function | Key Parameters | Read/Write |
|------|----------|----------------|------------|
| goto_definition | Jump to symbol definition | path, line, character | Read |
| find_references | Find all references to a symbol | path, line, character | Read |

## TODO (2)

| Tool | Function | Key Parameters | Read/Write |
|------|----------|----------------|------------|
| todo_read | Read the TODO list | filter | Read |
| todo_write | Write/update TODO items | items | Write |

## Git (9)

| Tool | Function | Key Parameters | Read/Write |
|------|----------|----------------|------------|
| git_status | View workspace status | cwd | Read |
| git_diff | View change diffs | staged, path, cwd | Read |
| git_log | View commit history | maxCount, cwd | Read |
| git_add | Stage files | paths, path, cwd | Write |
| git_commit | Commit | message, all, cwd | Write |
| git_branch | Create/list branches | create, cwd | Write |
| git_checkout | Switch branches | branch, cwd | Write |
| git_stash | Stash workspace | action, message, ref, cwd | Write |
| git_merge | Merge branches | branch, noFf, cwd | Write |

All git tools accept an optional `cwd` (repository directory, a path within the workspace): specify it when the repository is in a workspace subdirectory; defaults to executing at the workspace root.

## Internal Tools

Tools prefixed with `_` are for internal system use and are not called directly by the AI:

| Tool | Function |
|------|----------|
| _checkpoint_start | Start a snapshot transaction |
| _checkpoint_commit | Commit a snapshot transaction |
| _checkpoint_revert | Revert to a specified snapshot |
| _checkpoint_revert_to_message | Revert to the state corresponding to a specific message |
| _checkpoint_revert_diff | Revert by diff |
| _checkpoint_list | List all snapshots |
| _checkpoint_can_replay | Query whether a snapshot can be replayed |
| _checkpoint_get_ops | Get operation records of a snapshot |
| _checkpoint_get_diff | Get snapshot diff |
| _get_operation_log | Read operation logs |
| _reveal | Open/highlight a specified file in the IDE |

Snapshot tools support the operation timeline feature of Code Mode — the AI automatically creates a snapshot before each file modification, and users can revert to any historical node via the timeline panel.

## Navigation

- [YonBan Overview](overview.md) — Installation and connection
- [Approval and Permissions](approval.md) — Which tools require Approval
- [Execution Pipeline](architecture.md) — Complete tool call execution flow
