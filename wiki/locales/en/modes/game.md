# Game Companion (Companion)

Configure desktop pets and Live2D characters. AI characters accompany you as desktop pets, displaying dynamic expressions and actions through Live2D models, with support for screen awareness and AI autonomous speech.

## How to Enter

Access the Companion view through the auxiliary menu.

## Interface Layout

The Companion view is organized into 8 section tabs. Click a tab to jump to the corresponding section:

| Section | Overview |
|---------|----------|
| Launch Binding | Character Card, conversation file, screenshot frequency, and other startup bindings |
| Live2D | Live2D model selection, scaling, position, idle animations |
| Image Pack | Static image pack management, expression keys, batch image upload |
| Touch Interaction | Hotzone configuration, part selection, hit detection |
| Screen Awareness | Auto-screenshot, target window, image quality settings |
| Security | Security-related configuration |
| Companion Messages | Chat bubble style, display duration, game pass-through |
| Tutorial | Usage guides and instructions |

## Core Features

### Launch Binding

Configure the core parameters used when starting the desktop pet:

| Control | Description |
|---------|-------------|
| Character Card dropdown | Select the Character Card for the desktop pet |
| Conversation file | Bind a conversation archive |
| Conversation mode | Select the conversation interaction style |
| Screenshot frequency | Auto-screenshot trigger interval |
| Polling interval | Interval for the AI to proactively check status |
| Adaptive frequency | Automatically adjust polling frequency based on user activity |

### Desktop Pet Appearance

Control the display style and appearance of the desktop pet:

| Control | Description |
|---------|-------------|
| Enable toggle | Show or hide the desktop pet |
| Appearance mode | Choose Live2D or Image Pack |
| Model dropdown | Select the model / image pack to use |
| Position | Docking position (top-left / top-right / bottom-left / bottom-right) |
| Idle expression | Default expression when idle |
| Expression tag name | Mapping between expressions and AI output tags |
| Action tag name | Mapping between actions and AI output tags |

### Live2D

Fine-tune Live2D models:

- **Model selection** — Switch between installed Live2D models
- **Scaling** — Adjust model size
- **Position** — Adjust the model's position on screen
- **Idle animation** — Set the animation that loops when idle
- **Save adjustments** — Save the current parameter adjustments
- **Drag positioning** — Drag the model directly to the desired position
- **Per-parameter tuning** — Individually adjust each model parameter

### Image Pack

Use static images as the desktop pet appearance (no Live2D model required):

- **Pack selection** — Select an existing image pack
- **New** — Create a new image pack
- **Default expression** — Set the fallback image shown when no expression matches
- **Scaling** — Adjust image display size
- **Expression key management** — Bind images to different expression names
- **Batch image upload** — Upload multiple expression images at once

### Touch Interaction

Configure interactive reactions when the user clicks different parts of the desktop pet:

- **Hotzone list** — View and manage all configured touch hotzones
- **Part selection** — Click on the model to select which part to configure
- **Draw hotzone** — Manually draw interactive regions on the model
- **Enlarged editor** — Zoom in for precise hotzone positioning
- **Hit detection frequency** — Set how often user clicks are detected

### Companion Messages (Chat Bubble)

Customize the appearance and behavior of the desktop pet's chat bubble:

| Control | Description |
|---------|-------------|
| Bubble preview | Real-time preview of the bubble appearance |
| Opacity | Bubble background opacity |
| Display duration | How long a message stays visible before auto-hiding |
| Border radius | Bubble corner roundness |
| Background color | Bubble background color |
| Text color | Message text color |
| Border color | Bubble border color |
| Name label | Whether to show a character name label |
| Game pass-through | When enabled, mouse clicks pass through the bubble to the game beneath |
| Banner | Banner-style message display |
| Sound | Notification sound when a message arrives |

### Screen Awareness

Let the AI "see" what is on the user's screen:

| Control | Description |
|---------|-------------|
| Auto-screenshot | Enable or disable automatic screen capture |
| Frequency | Screenshot interval |
| Resolution | Screenshot resolution |
| Target window | Specify which window to capture (full screen or a specific application) |
| Image quality | Screenshot compression quality |

### AI Autonomous

Configure the AI's ability to proactively initiate conversations and actions:

- **Backend-driven toggle list** — Enable or disable individual autonomous behaviors
- **Dwell interval** — Set the minimum wait interval between AI-initiated messages

When enabled, the AI can proactively start conversations during idle time and autonomously choose appropriate actions and expressions based on screen awareness content and context.

## Backend Mode Value

The Companion view's frontend Tab is `companion`; it does not map to a backend mode value. This means entering the Companion view does not change the backend mode state — only the frontend interface switches.

## Tips

- **Choose an appearance**: Decide whether to use Live2D or an Image Pack first, then import the corresponding resources
- **Configure touch**: Set up hotzones for different parts of the model to make interactions feel more natural
- **Adjust bubbles**: Tune bubble opacity and colors based on your game/desktop background to ensure readability
- **Screen awareness**: Enabling this lets the AI understand what you are doing, but it consumes additional API calls
- **AI autonomous**: Enabling autonomous settings makes the desktop pet more lively, but also increases API call usage
