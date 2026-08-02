# Browser Automation (beilu-browser)

beilu-browser lets the AI control a real Chrome browser. The AI issues browser operations via `<browser_op>` tags; the plugin parses the tags, executes the operations, and injects the results into the next conversation round.

> History note: earlier versions had a separate channel where the frontend triggered browser page snapshots to be injected into messages; it was removed on 2026-07-16. Browser automation now goes exclusively through the in-conversation `<browser_op>` tag protocol described on this page — the plugin itself is still actively maintained and was not removed along with the old channel.

## How It Works

```
AI reply contains a <browser_op> tag
    ↓
ReplyHandler parses the tag
    ↓
browser-driver executes the operation (CDP WebSocket → Chrome)
    ↓
Result is stored in the pending-injection queue (isolated per conversation)
    ↓
Next round's GetPrompt injects the result into the conversation
    ↓
AI sees the result and decides the next operation
```

## Prerequisites

Chrome must be started in remote debugging mode. The easiest way: click the **Launch Chrome** button in the "Extra Plugins → Browser Automation" panel (it auto-detects the Chrome path and launches it with the correct arguments).

Equivalent manual launch command:

```
chrome --remote-debugging-port=9222 --user-data-dir=data/browser-profile
```

- `--remote-debugging-port`: the port number can be changed in the plugin configuration
- `--user-data-dir`: a dedicated user data directory (defaults to a folder under the beilu data directory, configurable in the panel) that preserves login sessions

## Operation Tags

### Navigation

| Tag | Description |
|------|------|
| `<browser_op type="goto" url="https://..." />` | Open the specified URL |
| `<browser_op type="tabs" />` | List all tabs |
| `<browser_op type="newtab" url="https://..." />` | Open a new tab |
| `<browser_op type="closetab" />` | Close the current tab |
| `<browser_op type="sync" />` | Sync to the tab you are currently browsing (human and AI share the same browser; the AI continues from the page you are on) |

### Page Inspection

| Tag | Description |
|------|------|
| `<browser_op type="snapshot" />` | Get the page accessibility tree; every element carries an @N reference number |
| `<browser_op type="screenshot" />` | Take a screenshot of the page, saved as PNG |

### Interaction

Use the @N reference numbers returned by snapshot to locate elements:

| Tag | Description |
|------|------|
| `<browser_op type="click" target="@3" />` | Click an element |
| `<browser_op type="type" target="@3" value="text to type" />` | Type text into an input field |
| `<browser_op type="press" key="Enter" />` | Press a keyboard key |
| `<browser_op type="scroll" dy="300" />` | Scroll the page (positive dy scrolls down, negative scrolls up) |

### JavaScript Execution

```xml
<browser_op type="eval">document.title</browser_op>
```

### Wait

```xml
<browser_op type="wait" selector="css:.result" timeout="5000" />
```

### Browsing History Recording

```xml
<browser_op type="history" />
```

With "Browsing History Recording" enabled, the page URL, title, and result summary of every browser operation are recorded to a local file (default `data/browser-history.jsonl`). The AI reads back recent records via the `history` operation, giving it cross-round browsing memory; the recording switch and the read-back count are configurable in the panel.

## Typical Workflow

1. `goto` — navigate to the target page
2. `snapshot` — inspect the page structure and get the @N reference numbers of elements
3. `click` / `type` — interact with the page
4. `snapshot` — inspect again to confirm the operation succeeded
5. Repeat until the task is done

## Macros

beilu-browser provides the following macros via macro_env, usable in INJ entries or presets:

| Macro | Description |
|----|------|
| `{{browser_status}}` | Browser connection status (connected / disconnected) |
| `{{browser_port}}` | CDP debugging port number |

## INJ Entry

On first load the plugin automatically creates an `INJ-browser` entry containing the AI's browser-operation capability description. You are free to modify its content, depth, mode gating, and other settings in the INJ editor.

- **Default depth**: 1 (system region)
- **Default mode**: always (active in all modes)
- **Macro support**: the content may use macros such as `{{browser_status}}` and `{{browser_port}}`

## Configuration

All options can be set in the "Extra Plugins → Browser Automation" panel:

| Option | Default | Description |
|------|--------|------|
| enabled | true | Plugin master switch |
| port | 9222 | Chrome remote debugging port |
| snapshotMaxLines | 200 | Maximum snapshot lines (prevents very long pages from blowing up the context) |
| chromePath | empty (auto-detect) | Path to the Chrome executable |
| userDataDir | data/browser-profile | Chrome user data directory (relative to the beilu data directory) |
| driverPath | empty (built-in driver) | Leave empty to use the built-in driver shipped with beilu, or specify an external driver file:// URL |
| defaultTimeout | 5000 | Default timeout for the wait operation (ms) |
| defaultScrollDy | 300 | Default scroll amount (px) |
| gotoWaitUntil | load | Navigation wait strategy (load / domcontentloaded / commit) |
| resultLabel / resultSeparator | — | Section title and separator for result injection |
| autoReconnect | true | Automatically reconnect after a failed operation |
| recordBrowsing | true | Browsing history recording switch |
| historyFile | data/browser-history.jsonl | File the browsing records are written to |
| historyMaxRead | 30 | Default number of records the history operation reads back |

## Security

- **Intranet protection**: URLs for `goto` / `newtab` pass through the unified outbound safety check (safe_fetch); private-network, loopback, and cloud-metadata addresses are always rejected — the AI cannot drive the browser to probe your intranet.
- **Content boundary**: external content such as page titles, snapshots, and eval results is passed through the untrusted-content boundary (angle-bracket neutralization + random nonce boundary markers) before being injected into the AI, blocking indirect prompt injection from web content.

## Technical Architecture

The underlying driver is bundled inside the plugin directory (`beilu-browser/driver/`, shipped with the beilu core, zero external dependencies) and controls the browser directly over native Chrome DevTools Protocol (CDP) WebSocket:

- No dependency on Playwright/Puppeteer, zero npm dependencies
- Supports a Playwright-style Locator API (CSS / role / text / xpath)
- Input Probe fallback: when native CDP events fail, synthetic events are automatically re-sent
- Session self-healing: automatically re-attaches after a tab is closed or navigated; preferredTarget follows the switch
