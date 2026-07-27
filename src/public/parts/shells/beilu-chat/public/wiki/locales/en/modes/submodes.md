# Submodes & Switching

A second-level mode system within [Code](beilu:mode/files) and [Work](beilu:mode/work) modes that divides the development/work process into multiple stages, each with independently configured AI behavior.

## What Submodes Do

When you switch submodes, the system automatically loads the bindings for that submode:

- **Preset**: Different system Prompts for different stages
- **[API source](beilu:settings/api)**: Use a different AI service provider per stage
- **Model**: Use a different AI model per stage
- **Sampling Parameters**: Temperature, Top-P, etc., configured differently per stage

## Code Mode's 11 Submodes

<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">1. Task Confirmer</div>
<div class="wiki-card-desc"><b>Understand Requirements</b><br>Capture key points, search for similar solutions online, refine and specialize</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">2. Pre-Designer</div>
<div class="wiki-card-desc"><b>Solution Design</b><br>Read specific task code for design, down to exact lines</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">3. Framework Reviewer</div>
<div class="wiki-card-desc"><b>Framework Review</b><br>Review from the perspective of code architecture and overall flow, confirm soundness</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">4. Deep Thinker</div>
<div class="wiki-card-desc"><b>Algorithm & System Reasoning</b><br>Algorithm design, framework logic, pathway logic, experimental validation before handing off to Code Expert</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">5. Code Expert</div>
<div class="wiki-card-desc"><b>Code Implementation</b><br>Focus on code implementation</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">6. Pre-Error Producer</div>
<div class="wiki-card-desc"><b>Syntax & Process Check</b><br>Check for syntax errors, HTML tag errors, review the process, send back if needed</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">7. Test Expert</div>
<div class="wiki-card-desc"><b>Hands-on Testing</b><br>Perform actual testing through script tools and browser DevTools</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-red, #ef4444);">
<div class="wiki-card-title">8. Debugger</div>
<div class="wiki-card-desc"><b>Issue Location & Fix</b><br>Examine the big picture then focus on specifics, insert code or use F12 for rapid diagnosis</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">9. Task Handover</div>
<div class="wiki-card-desc"><b>Documentation & Handover</b><br>Produce markdown files, hand off to the Task Confirmer and verify with the user</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">10. Large Project Coordinator</div>
<div class="wiki-card-desc"><b>Large Project Coordination Hub</b><br>Scope locking, dependency ordering, incremental merging, multi-agent orchestration, complete output</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">11. Frontend Beautifier</div>
<div class="wiki-card-desc"><b>Frontend Design & Polish</b><br>Brief inference, three-knob system, design system, Pre-Flight Check</div>
</div>
</div>

## Work Mode's 11 Submodes

<div class="wiki-grid wiki-grid-3">
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">1. Task Confirmer</div>
<div class="wiki-card-desc"><b>Requirement Confirmation</b><br>Understand requirements, verify understanding, record verbatim, create task files</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">2. Task Designer</div>
<div class="wiki-card-desc"><b>Process Design</b><br>Read task MDs, reverse-engineer the design and execution flow from the desired outcome</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">3. Process Optimizer</div>
<div class="wiki-card-desc"><b>Process Optimization</b><br>Optimize designed processes, reduce token usage, streamline steps</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">4. Framework Reviewer</div>
<div class="wiki-card-desc"><b>Process Review</b><br>Review process designs for errors, anticipate potential issues; only optimize, never reject</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">5. Prompt Designer</div>
<div class="wiki-card-desc"><b>Prompt Writing</b><br>Design Prompts needed for tasks, referencing Prompt guidelines</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">6. Prompt + Preset Designer</div>
<div class="wiki-card-desc"><b>Preset Design</b><br>Design always-accompany Prompts and Presets themselves, with built-in tutorials, examples, and methodologies</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">7. Skill / Script Maker</div>
<div class="wiki-card-desc"><b>Script Creation</b><br>Create scripts, skills, and MCP integrations needed for tasks</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-blue, #3b82f6);">
<div class="wiki-card-title">8. Process Assembler</div>
<div class="wiki-card-desc"><b>Process Assembly</b><br>Assemble Prompts, skills, and scripts into executable flow groups</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-purple, #8b5cf6);">
<div class="wiki-card-title">9. Flow Group Executor</div>
<div class="wiki-card-desc"><b>Flow Execution</b><br>Run assembled flow groups, execute steps in sequence, log execution results</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-green, #22c55e);">
<div class="wiki-card-title">10. Verifier</div>
<div class="wiki-card-desc"><b>Result Verification</b><br>User verification or automated verification of execution results</div>
</div>
<div class="wiki-card" style="border-left-color: var(--wiki-amber, #f59e0b);">
<div class="wiki-card-title">11. Wrap-up & Archive</div>
<div class="wiki-card-desc"><b>Archiving & Wrap-up</b><br>Archive task MDs, update table indexes, record lessons learned, generate completion reports</div>
</div>
</div>

## Submode Switching

### Manual Switching

In Code or Work Mode, switch the current submode through the sidebar or the top submode selector. After switching, the AI's Preset, model, and parameters update automatically.

### Pipeline Auto-Switching

A pipeline (Flow Group) can orchestrate multiple steps into an automated execution sequence. Each step's `steps[].mode` field specifies the target submode:

<div class="wiki-flow-h">
<div class="wiki-box wiki-box-amber"><b>Step 1</b><small>Task Confirmer</small></div>
<div class="wiki-arrow-h">→</div>
<div class="wiki-box wiki-box-amber"><b>Step 2</b><small>Pre-Designer</small></div>
<div class="wiki-arrow-h">→</div>
<div class="wiki-box wiki-box-green"><b>Step 3</b><small>Code Expert</small></div>
<div class="wiki-arrow-h">→</div>
<div class="wiki-box wiki-box-blue"><b>Step 4</b><small>Test Expert</small></div>
</div>

During pipeline execution, the system automatically switches submodes based on the current step's `mode` field, loads the corresponding Preset and parameters, then advances to the next step. The entire process requires no manual intervention.

## Submode Configuration

Each submode's independent configuration options:

| Setting | Description |
|---------|-------------|
| Preset | The system Prompt Preset used by this submode |
| API source | The AI Service Source used by this submode |
| Model | The AI model used by this submode |
| Sampling Parameters | Temperature, Top-P, frequency penalty, and other parameters |

These configurations are independent of the main mode's global configuration. When switching submodes, the submode's configuration takes priority over the main mode's defaults.

## Tips

- **Switch by stage**: During development, switch submodes according to your actual stage to get targeted AI assistance
- **Differentiate configurations**: Assign different models to different submodes — e.g., a strong reasoning model for reviews, a code-capable model for implementation
- **Leverage pipelines**: Repetitive multi-step workflows can be orchestrated as pipelines for automatic progression
