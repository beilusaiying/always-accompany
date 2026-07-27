# Platform Reach (beilu-reach)

beilu-reach lets the AI fetch structured data from 13 internet platforms — deeper than generic web scraping (API/CLI-level data rather than HTML body text). The AI invokes it via the `<reach>` tag, and the results are injected into the next conversation round.

## Three Trigger Paths

```
① Direct AI invocation: the reply contains <reach platform="..." action="...">query</reach>
② Automatic search routing: a search query containing site:<known platform domain> → structured results from that platform are added automatically
③ Smart URL extraction: <browse> on a known platform URL → the platform adapter is tried first for structured data, falling back to generic fetching on failure
```

## Tag Format

```xml
<reach platform="v2ex" action="hot">latest</reach>
<reach platform="github" action="search-repos" limit="5">AI agent</reach>
<reach platform="bilibili" action="video">BV1xx411c7mD</reach>
```

## Platform Overview

| Platform | Actions | Backend | Configuration |
|------|------|------|------|
| V2EX | hot / node / topic / user | Public API | Zero config |
| RSS/Atom | read | Native parsing | Zero config |
| Jina Reader | read | r.jina.ai | Zero config |
| GitHub | search-repos / search-code / repo / issues / prs | gh CLI | Token optional (raises rate limits) |
| YouTube | info / subtitle / search | yt-dlp | Cookie source browser optional |
| Bilibili | search / video / hot / rank | bili-cli / opencli / public API | SESSDATA optional |
| Twitter/X | search / read / user / feed | twitter-cli / opencli | Cookie |
| Reddit | search / read / subreddit / hot | opencli / rdt-cli | — |
| Xiaohongshu | search / note / comments / feed | opencli / mcporter | Cookie |
| Xueqiu | quote / search-stock / hot-posts / hot-stocks | Public API | Cookie (xq_a_token) |
| Facebook | search / profile / feed | opencli | — |
| Instagram | search / profile / user / explore | opencli | — |
| LinkedIn | profile / search-people / search-jobs / company | mcporter / Jina | — |

The "Platform Status" card in the panel probes each platform's tool availability in real time (the actual actions and backends of every platform are as shown on the status card — the single source of truth is the backend registry).

## Configuration

In the "Extra Plugins → Platform Reach" panel:

- **Basic switches**: master switch / search platform routing / smart URL extraction
- **Platform credentials**: per-platform Cookie / Token (used only when the server requests the platform; never appears in the AI context)
- **Network & security**: CLI proxy address, command timeout, platform allowlist (restricts which platforms the AI may use)

Configuration changes sync to the backend immediately and are persisted to disk; they survive restarts.

## Security

- **SSRF protection**: URL-type parameters supplied by the AI (feed addresses, video links, etc.) pass through the unified outbound safety check; private-network, loopback, and cloud-metadata addresses are always rejected.
- **Content boundary**: content returned by platforms is passed through the untrusted-content boundary (angle-bracket neutralization + nonce boundary markers) before being injected into the AI, blocking indirect prompt injection from platform content.
- **Credential isolation**: Cookies/Tokens are used only inside the adapters for requests and never enter the AI-visible context.
- **Command injection protection**: external CLIs are always invoked with argument arrays, never through a shell.

## Capability Guidance

The AI's `<reach>` usage description goes through the injection-text configuration chain (the `reach.capabilities` key) and can be edited in the injection-text editor in Settings; the list of available platforms is generated dynamically from real-time backend probing and is not hard-coded into the text.
