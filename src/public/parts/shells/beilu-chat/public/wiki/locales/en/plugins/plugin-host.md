# User Plugin Host (beilu-plugin-host)

beilu-plugin-host lets external Python, Node, or standalone programs inject data into the next AI prompt. It is useful for sensors, local services, and existing scripts, but it can start subprocesses and inject content, so deployment permissions matter.

## What it provides

- Per-user plugin discovery
- Process start and stop
- Port allocation
- Per-start authentication tokens
- Status and error reporting
- One-shot data injection into GetPrompt
- Process cleanup on unload

## Directory and manifest

The host scans:

    data/users/<user>/user-plugins/

Each child directory needs plugin.json. A minimal Node manifest:

~~~json
{
  "id": "my-sensor",
  "name": "My Sensor",
  "runtime": {
    "type": "node",
    "entry": "index.js"
  }
}
~~~

Supported runtime types:

| Type | Launch | Fields |
|---|---|---|
| python | python on Windows, python3 elsewhere | entry; optional deps such as requirements.txt |
| node | node | entry |
| executable | Run the file directly | entry |

The host appends port, main-port, and token arguments. Do not log or publish the token.

## Local vs server deployment

- **Local single-user:** owner-placed user plugins may start by design.
- **Multi-user server:** subprocess spawning is blocked by default to prevent server RCE and cross-account impact.
- Only the instance owner can explicitly enable allowUserPluginSpawn or BEILU_USER_PLUGIN_SPAWN=on.

## Data path

    External plugin data
      ↓ localhost POST + plugin token
    /api/user-plugins/<id>/push
      ↓ pending injection (60-second default TTL)
    plugin-host GetPrompt
      ↓ consumed once
    Next AI request

The endpoint accepts localhost only and validates the per-start token. The request requires content and may include hook_target, position, and ttl.

Pending data is consumed once or expires. This fits current sensor readings or fresh events; it is not long-term persistence.

## Built-in plugins vs user-plugin host

| Built-in plugin | User plugin host |
|---|---|
| Implements framework hooks directly | External process pushes data through localhost |
| Lives under source parts/plugins | Lives in per-user data/user-plugins |
| Runs in the built-in loading system | May have its own runtime and process |
| Best for deep pipeline participation | Best for existing programs and services |

See [Plugin Development](../developer/plugin-dev.md) for built-in interfaces. Do not mix the security assumptions of these two models.

## Troubleshooting

- **Not discovered:** verify valid JSON, an id field, and the current user's directory.
- **blocked in server mode:** this is the safety default, not a crash.
- **push returns 401:** use the token from the current start; old tokens do not survive restarts.
- **data never appears:** inspect running status, localhost response, non-empty content, TTL, and whether an earlier turn already consumed it.

## Continue

- [Plugin Development](../developer/plugin-dev.md)
- [Security](../security/overview.md)
- [Plugin Manual](overview.md)
