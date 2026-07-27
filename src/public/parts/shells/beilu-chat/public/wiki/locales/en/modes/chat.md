# Chat Mode (Chat / AIRP)

## Entering Chat Mode

| Method | Action |
|--------|--------|
| Top mode selector | Click the "Chat" tab |
| Keyboard shortcut | `Ctrl+2` or `Alt+2` |

Once you enter, simply type a message in the central conversation area to start chatting.

## Basic Operations

- **Everyday conversation**: Just type a message — no special configuration needed
- **Roleplay**: Select a Character Card from the Left Panel, choose a suitable Preset, then start the conversation
- **Parameter tuning**: Fine-tune AI behavior through the model parameter panel in the Right Panel (e.g., lower the temperature for more consistent replies)

## Interface Layout

Three-column layout with collapsible left and right panels:

- **Left Panel**: Conversation list, Character Card selection, conversation management (new / delete / archive)
- **Center**: Main conversation area for message input and display
- **Right Panel**: Configuration panel for the current conversation (Preset, model parameters, regex, etc.)

## What You Can Do

| Goal | How |
|------|-----|
| Create a new conversation | Click the new button in the Left Panel |
| Switch to a previous conversation | Click a conversation in the Left Panel list |
| Load a Character Card | Select a Character Card in the Left Panel |
| Switch Preset | Choose from the Preset management section in the Right Panel |
| Adjust model parameters | Use the model parameter panel in the Right Panel |
| Edit / regenerate a message | Use the action buttons on the message bubble |
| Enable web search | Trigger manually during conversation, or let the AI trigger it autonomously |
| Configure regex processors | In the Right Panel regex rules section — enable/disable individual rules |
| Configure INJ Injection | In the Right Panel INJ section — set up background information for automatic Injection |
| Export conversation history | Export from conversation management |

## Backend Mode Value

Chat Mode corresponds to the backend mode value `chat`. Bot Management, Helper, and other auxiliary views also reuse `chat` as their backend mode value, but display different interfaces on the frontend.
