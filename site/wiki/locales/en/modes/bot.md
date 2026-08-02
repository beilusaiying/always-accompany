# Bot Mode

Manage AI characters running automatically and replying to messages across multiple external platforms (Discord, Telegram, LINE, etc.).

## How to Enter

Access the Bot Management view through the auxiliary menu.

## Interface Layout

### Activity Bar Buttons (3)

| Button | Name | Panel |
|--------|------|-------|
| list | Bot List | Configuration and management of all Bot instances |
| log | Log | Bot runtime logs |
| monitor | Monitor | Real-time Bot status monitoring |

## Core Features

### Multi-Platform Configuration

The Bot List panel has 10 platform tabs at the top. Click to switch to a platform's configuration area:

| Platform | Required Credential Fields |
|----------|---------------------------|
| Discord | Bot Token, Application ID |
| Telegram | Bot Token |
| Slack | Bot Token, App Token, Signing Secret |
| LINE | Channel Access Token, Channel Secret |
| X (Twitter) | API Key, API Secret, Access Token, Access Secret, Bearer Token |
| Kaiheila | Bot Token |
| Feishu | App ID, App Secret |
| DingTalk | App Key, App Secret |
| WeCom | Corp ID, Agent ID, Secret |
| WeChat | App ID, App Secret |

Fill in the corresponding credentials for each platform to bring the bot online.

**Action buttons**:
- Save — Save the current platform's credential configuration
- Start — Start the Bot and begin listening for messages
- Stop — Stop the Bot
- View Monitor — Jump to the monitor panel to view runtime status

### C6 Trigger Rules

Configure whose messages the Bot responds to:

| Option | Description |
|--------|-------------|
| Everyone | Respond to messages from anyone |
| Primary user only | Only respond to the primary user's messages |
| Primary user + allowlist | Respond to messages from the primary user and users on the allowlist |

### Permission Tiers (L0 – L3)

| Tier | Description |
|------|-------------|
| L0 | Minimum permissions — basic conversation only |
| L1 | Basic permissions — access to some features |
| L2 | Advanced permissions — access to most features |
| L3 | Maximum permissions — full feature access |

Different users or roles can be assigned different permission tiers, controlling the scope of Bot capabilities they can trigger.

### Two-Layer Character Card Management

Bot Mode uses a two-layer structure for Character Cards:

**Outer layer — Window mode categories**: Character Cards are grouped by always-accompany's window modes:
- chat — Character Cards for Chat Mode
- code — Character Cards for Code Mode
- work — Character Cards for Work Mode

**Inner layer — Character Card instances**: Each Character Card instance includes:
- Persistent link — The binding between the Bot and Character Card is persisted; it auto-restores after restart
- Conversation list — All conversations under this Character Card
- Task list — Tasks associated with this Character Card

Bind different Character Cards to different platforms/channels, so each character maintains its own persona and conversation context.

## Backend Mode Value

The Bot Management view's frontend Tab is `bot`, corresponding to backend mode value `chat` (reusing Chat Mode's backend logic).

## Tips

- **Start with one platform**: Configure one platform first to verify everything works, then expand to more
- **Permission control**: In production, set up trigger allowlists and permission tiers to prevent misuse
- **Character differentiation**: Configure different Character Cards for different platforms/scenarios so the AI's behavior matches each platform's style
