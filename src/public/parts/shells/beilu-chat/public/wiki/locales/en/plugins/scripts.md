# Script Engine

always-accompany provides EJS template rendering capability (beilu-ejs plugin), allowing you to use EJS template syntax in Preset entries and Character Cards to write dynamic content. This is more powerful than simple Macro substitution, enabling conditional logic, loops, complex calculations, and more.

## EJS Template Engine (beilu-ejs)

### Basic Syntax

EJS (Embedded JavaScript) allows embedding JavaScript code within text:

| Tag | Description | Example |
|-----|-------------|---------|
| `<% %>` | Execute JS code (no output) | `<% if (x > 5) { %>` |
| `<%= %>` | Output expression result (HTML-escaped) | `<%= user %>` |
| `<%- %>` | Output expression result (unescaped) | `<%- rawHtml %>` |

### Available Template Variables

EJS templates can access variables from the Macro environment at execution time, including:

- `char` -- character name
- `user` -- user name
- Custom variables (variables set via beilu-mvu)
- Other values from the Macro environment

### Sandbox Security

beilu-ejs executes EJS templates in a sandbox by default, restricting accessible global objects and APIs to prevent malicious code execution.

**sandboxOptOut** is a security-sensitive switch: disabling the sandbox allows EJS to access the full Node.js environment (including the file system, network, etc.), which poses serious security risks in multi-user environments. Therefore, modifying sandboxOptOut requires instance owner permission.

### Use Cases

| Scenario | Description |
|----------|-------------|
| Conditional instructions | Switch between different system prompts based on mode/variable values |
| Dynamic lists | Generate character lists based on relationship data |
| Complex formatting | Render structured data into AI-friendly text |
| Calculations & statistics | Perform numerical computations within Presets |

## User Plugin Scripts (beilu-plugin-host)

### Overview

beilu-plugin-host allows users to write and load custom JavaScript plugin scripts. User plugins have the same interface capabilities as built-in plugins (GetPrompt / TweakPrompt / ReplyHandler, etc.).

### Security Restrictions

User plugin script execution is also governed by security policies. In server deployment mode, subprocess spawning by user plugins requires explicit owner authorization.

## change-prompt Generator

change-prompt is a special service generator that allows `${}` syntax for template evaluation within Preset entries. It is also protected by the deployGatedAllow gate.

## Script Execution Timing

| Engine | Execution Phase | Description |
|--------|----------------|-------------|
| EJS (beilu-ejs) | Macro substitution phase | Executes during the evaluateMacros process |
| Regex (beilu-regex) | TweakPrompt / ReplyHandler | Executes before message sending / after reply |
| User plugins (plugin-host) | GetPrompt / TweakPrompt / ReplyHandler | Same timing as built-in plugins |

## Navigation

- [Plugin Overview](overview.md) -- Plugin system introduction
- [Regex Enhancement (beilu-regex)](regex.md) -- Regex script engine
- [Variable System (beilu-mvu)](mvu.md) -- Variable read/write
- [Plugin Development](../developer/plugin-dev.md) -- Writing custom plugins
