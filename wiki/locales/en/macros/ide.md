# IDE/Code Macros

Macros exclusive to [Code Mode (IDE)](beilu:mode/files), providing the AI with submode information, code file content, tool descriptions, execution results, and other programming context. They are replaced when the Preset engine builds prompt entries.

## Mode Information Macros

| Macro | Description | Example Output |
|-------|-------------|----------------|
| `{{sub_mode}}` | Name of the current submode | `code_review` |
| `{{sub_mode_desc}}` | Description of the current submode | `Code review mode: analyze code quality...` |

Code Mode has multiple [submodes](beilu:wiki/modes/submodes.md) (code writing, review, debugging, etc.). These two Macros tell the AI which submode is currently active and its behavioral description.

## Memory and File Macros

| Macro | Description |
|-------|-------------|
| `{{codeHotLayer}}` | Code hot-layer memory |
| `{{code_file:filename}}` | Reference the content of a specified md file |
| `{{code_files_list}}` | List of currently active files |

### {{codeHotLayer}}

Hot-layer memory exclusive to Code Mode, similar to `{{hotMemory}}` (see [Memory System Macros](beilu:wiki/macros/memory.md)), specifically storing programming context (project structure, tech stack, coding conventions, etc.).

### {{code_file:filename}}

Embeds the content of a specified markdown file directly into the prompt. Used to provide the AI with specific reference documents, coding standards, project descriptions, etc.

Example:
```
{{code_file:coding_guidelines}}
```
This reads the content of the corresponding `coding_guidelines.md` file and replaces it at this position.

### {{code_files_list}}

Lists the active files in the current coding session. Lets the AI know which files the user is working on.

## Tool and Environment Macros

| Macro | Description |
|-------|-------------|
| `{{ide_tools}}` | Description of available IDE tools |
| `{{ide_tool_results}}` | Tool execution results |
| `{{client_env}}` | Client environment information |
| `{{ide_workspace}}` | IDE workspace information |

### {{ide_tools}}

Describes the currently available IDE toolset. always-accompany's Code Mode can provide file read/write, search, terminal execution, and other tool capabilities. This Macro injects descriptions of these tools into the prompt, letting the AI know "what tools it can use."

### {{ide_tool_results}}

After the AI requests to use an IDE tool, the tool's execution result is injected into subsequent prompts via this Macro, forming a "request tool -> get result -> continue reasoning" loop.

### {{client_env}}

Injects client environment information such as OS type, browser info, etc. Helps the AI give suggestions that match the user's environment (e.g., Windows vs macOS path differences).

### {{ide_workspace}}

Injects information about the current IDE workspace, letting the AI understand its workspace context.

## Processing Pipeline

IDE Macros are replaced when the Preset engine builds prompt entries:

```
User sends a message in Code Mode
  -> Preset engine (PresetEngine) builds prompt entries
  -> Reads current submode configuration
  -> Collects active files, tool descriptions, environment information
  -> Replaces {{sub_mode}}, {{code_file:x}}, {{ide_tools}}, etc.
  -> Sends the assembled prompt to the AI
```

## Notes

- IDE Macros only take effect in Code Mode; in regular conversation mode, these Macros have no data source
- Files referenced by `{{code_file:filename}}` must exist in the project's designated directory
- IDE Macros are replaced by the Preset engine when building entries, as part of backend Macro replacement
- Tool-related Macros (`{{ide_tools}}`, `{{ide_tool_results}}`) form the data pipeline for AI-tool interaction in Code Mode
