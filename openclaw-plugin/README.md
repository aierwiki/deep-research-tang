# Deep Research Guard Plugin

OpenClaw runtime plugin for enforcing the `deep-research` archive workflow.

## What It Does

- Injects step-specific workflow guidance before each agent run
- Blocks exploratory tool calls when the archive is not ready
- Detects plain assistant stop attempts with no tool use while research is unfinished
- Enqueues a trusted continuation message and wakes the same session to keep the research moving
- Still allows archive-maintenance commands such as checker/repair scripts
- Records audit events for tool usage and unfinished exits

## Requirements

- OpenClaw runtime plugin loading enabled
- Plugin path included in `plugins.load.paths` or copied into an OpenClaw extensions directory
- A deep-research session activated inside the current OpenClaw workspace

## Recommended Config

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/absolute/path/to/deep-research/openclaw-plugin"
      ]
    },
    "allow": [
      "deep-research-guard"
    ],
    "entries": {
      "deep-research-guard": {
        "enabled": true,
        "config": {
          "scriptsDir": "/absolute/path/to/deep-research/scripts",
          "strict": true
        }
      }
    }
  }
}
```

The plugin no longer binds a global `researchDir` at install time. Instead, the installed skill starts or activates a research session per topic by writing `.deep-research/active.json` inside the OpenClaw workspace.

You can still set `DEEP_RESEARCH_SCRIPTS` and `DEEP_RESEARCH_STRICT` via environment variables.

## One-Command Install

From the repository root:

```bash
bash scripts/install_openclaw_deep_research.sh
```

The installer merges the plugin into `~/.openclaw/openclaw.json`, keeps existing plugin settings, creates a timestamped backup before writing, and installs the full skill bundle into the OpenClaw workspace.

## Runtime Session Model

When the user asks for deep research, the skill should start a fresh session:

```bash
python scripts/openclaw_deep_research_session.py start \
  --topic mmx-cli \
  --question "mmx-cli 是什么" \
  --target-depth 3 \
  --depth-mode user-specified
```

To continue an existing archive:

```bash
python scripts/openclaw_deep_research_session.py activate \
  --research-dir /absolute/path/to/research_20260417_mmx-cli
```

To clear the active binding after the research is done:

```bash
python scripts/openclaw_deep_research_session.py clear
```

## Stop Interception

When a deep-research session is active, the plugin now treats a plain assistant message with no tool use as a potential "I am done" signal.

If the archive state is still before `finalize`, the plugin will:

- block that assistant message from being persisted to the session transcript
- enqueue a trusted system continuation instruction for the same session
- request an immediate heartbeat wake for that session so the agent keeps working

This keeps the design narrow: the plugin does not try to globally ban tools or rewrite the whole run loop. It only intervenes at the exact moment the agent tries to stop early.

There is now a second narrow recovery path as well:

- if a run goes idle immediately after a normal tool result and the archive is still unfinished
- and there was no plain assistant continuation message to intercept
- the plugin enqueues one trusted continuation event and wakes the same session once

This specifically covers the real-world failure mode where the agent stops right after tool completion and only resumes when the user sends another message.

The important stage split is now:

- round stages: `plan` / `execute` / `summarize` / `repair` / `advance`
- post-round synthesis: `synthesize`
- true completion: `finalize`

This means the last required research round is still just a research round. The plugin does not treat "reached target_depth" as "ready to stop". It requires a separate synthesis pass after all rounds are complete, and only then allows final completion.

## Subagent Behavior

The plugin now distinguishes between:

- orchestrator sessions: the main deep-research session that owns round progression, checker gates, and final completion
- worker sessions: OpenClaw subagent sessions created to execute one registered research task

Worker sessions are treated differently on purpose:

- they are not forced to keep running until the whole archive reaches `finalize`
- they may finish normally after completing their assigned task
- they may write only registered task report files under the current `round_N/tasks/` directory
- they may not write `00_meta.json`, seed clues, task registry, round summary, delta report, or `final_report.md`
