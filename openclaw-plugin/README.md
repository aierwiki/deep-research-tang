# Deep Research Guard Plugin

OpenClaw runtime plugin for lightweight `deep-research` checkpoints and recovery.

## What It Does

- Injects short active-research status before each agent run
- Keeps normal tool use permissive in the default `lite` mode
- Prevents obvious early finalization while research is unfinished
- Moves hard validation to `advance-round`, `finalize`, and `recover`
- Records audit events for tool usage and unfinished exits
- Writes detailed wake diagnostics to JSONL logs for post-mortem debugging

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
          "guardMode": "lite",
          "strict": true
        }
      }
    }
  }
}
```

The plugin no longer binds a global `researchDir` at install time. Instead, the installed skill starts or activates a research session per topic by writing `.deep-research/active.json` inside the OpenClaw workspace. In v3 markers, the active research is bound to `workspace + research_dir`; session ids are only `last_seen_*` audit metadata.

You can still set `DEEP_RESEARCH_SCRIPTS`, `DEEP_RESEARCH_STRICT`, and `DEEP_RESEARCH_GUARD_MODE` via environment variables.

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

When a round is complete, prefer one atomic lifecycle action instead of hand-editing `00_meta.json`:

```bash
python scripts/openclaw_deep_research_session.py advance-round --strict
```

This validates the current round, updates meta, and scaffolds the next round when another round is still required.

When the final report is truly ready:

```bash
python scripts/openclaw_deep_research_session.py finalize --strict
```

This validates the whole archive and marks the session completed.

If a run stops, changes chat session, or seems confused about the next step:

```bash
python scripts/openclaw_deep_research_session.py recover --strict
```

This runs the checker and returns the next repair or continuation instruction without mutating the research meta.

To continue an existing archive:

```bash
python scripts/openclaw_deep_research_session.py activate \
  --research-dir /absolute/path/to/research_20260417_mmx-cli
```

To clear the active binding after the research is done:

```bash
python scripts/openclaw_deep_research_session.py clear
```

## Lite vs Strict

Default mode is `lite`. It avoids most runtime blocking because OpenClaw sessions, subagents, compaction, and completion delivery can otherwise create fragile edge cases. Lite mode:

- reminds the agent of the active archive and checkpoint commands
- permits normal exploratory and file tools during a round
- blocks only obvious early finalization while `00_meta.json` is not completed
- relies on `advance-round`, `finalize`, and `recover` for validation

Legacy strict mode can still be enabled with:

```json
{
  "plugins": {
    "entries": {
      "deep-research-guard": {
        "config": {
          "guardMode": "strict"
        }
      }
    }
  }
}
```

Strict mode re-enables stage/tool gates, worker write restrictions, spawn/yield enforcement, and automatic wake paths.

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

## Troubleshooting Logs

For wake/resume debugging, the plugin writes newline-delimited JSON logs to:

- Workspace-level (best for missing-research-dir cases): `<workspace>/.deep-research/guard-debug.log`
- Research-level (best for per-archive replay): `<research_dir>/debug/guard-debug.log`
- Existing audit trail: `<research_dir>/audit.log`

When a similar issue happens again, copy these log files and share them directly.
