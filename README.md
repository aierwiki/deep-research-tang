# Deep Research Skill

[中文说明](README.zh-CN.md)

A general-purpose iterative deep research skill that teaches an agent to analyze complex problems through repeated "explore -> summarize" cycles.

It is suitable for agent frameworks with skill support, including Claude Code, VS Code Copilot, OpenClaw, and similar systems.

## Installation

Copy `SKILL.md` together with this folder into the skill directory used by your agent framework.

### Claude Code

```bash
# User-level installation
mkdir -p ~/.claude/skills/deep-research
cp SKILL.md ~/.claude/skills/deep-research/

# Project-level installation
mkdir -p .claude/skills/deep-research
cp SKILL.md .claude/skills/deep-research/
```

After installation, add a short routing note to `~/.claude/CLAUDE.md` for user-level usage or to `CLAUDE.md` at the project root for project-level usage:

```markdown
# >>> SKILL: deep-research >>>
# Deep Research Skill

The deep-research skill is installed on this machine at: ~/.claude/skills/deep-research

When the user asks for deep research, iterative research, or in-depth analysis,
read ~/.claude/skills/deep-research/SKILL.md for the full workflow.
# <<< SKILL: deep-research <<<
```

### VS Code Copilot

```bash
mkdir -p .github/skills/deep-research
cp SKILL.md .github/skills/deep-research/
```

### OpenClaw / Other Frameworks

```bash
mkdir -p .agents/skills/deep-research
cp SKILL.md .agents/skills/deep-research/
```

## Usage

After installation, trigger the skill with prompts such as:

- "Do deep research on XXX"
- "Analyze XXX in depth"
- "Investigate XXX iteratively"
- `/deep-research` (for frameworks that support slash commands)

## How It Works

```text
User asks a question
      |
      v
  +-------------+
  | Breakdown    |  Split the problem into independent exploration tasks
  +------+------+
         |
         v
  +-------------+
  | Exploration |  Execute full exploration tasks, not just search queries
  +------+------+
         |
         v
  +-------------+
  | Summary     |  Synthesize findings and identify the next gaps
  +------+------+
         |
         v
 Need another round? -- yes --> go back to Breakdown with a narrower focus
         |
         no
         |
         v
  +-------------+
  | Final Report|
  +-------------+
```

All process files are archived inside a research directory so the workflow stays fully traceable.

One core rule is that the last round is still a normal research round, not a "wrap-up round". The final synthesis happens only after every round is completed and passes validation.

## Structured Archive Protocol

The current version treats intermediate files as required workflow artifacts rather than optional notes. A recommended directory layout looks like this:

```text
research_20260411_api-gateway/
├── 00_research_brief.md
├── 00_meta.json
├── round_01/
│   ├── 01_seed_clues.json
│   ├── 02_task_registry.json
│   ├── 03_round_summary.md
│   ├── 04_delta_report.json
│   └── tasks/
│       ├── task_01_market-map.md
│       └── task_02_failure-cases.md
├── round_02/
│   └── ...
└── final_report.md
```

The three key machine-readable files are:

- `00_meta.json`: target depth, current round, and overall status
- `02_task_registry.json`: the valid task list for the current round, used to check task independence
- `04_delta_report.json`: new findings from the round and clues passed into the next one

## Templates

The repository provides a full set of archive templates in [`templates/`](templates).

The template set covers:

- Research brief
- Metadata
- Seed clues
- Task registry
- Single-task report
- Round summary
- Delta report
- Final report

## Bootstrap Script

The repository includes [`scripts/init_deep_research_archive.py`](scripts/init_deep_research_archive.py), which creates a research directory, copies templates, and writes the initial metadata. It is recommended over creating the archive manually.

Example from the repository root:

```bash
python scripts/init_deep_research_archive.py \
  --topic api-gateway \
  --question "Should we introduce a unified API gateway?" \
  --target-depth 5 \
  --depth-mode user-specified
```

The script will:

- create `research_<date>_<topic>/`
- initialize `00_research_brief.md`, `00_meta.json`, and `final_report.md`
- initialize `round_01/` with seed clues, task registry, round summary, and delta report templates
- create a task report template under `round_01/tasks/`
- optionally run a non-strict validation pass to confirm the initial scaffold is usable

## Checker

The repository also includes [`scripts/check_deep_research_archive.py`](scripts/check_deep_research_archive.py). It is recommended to run it after each round:

```bash
python scripts/check_deep_research_archive.py --research-dir path/to/research_xxx --strict
```

The checker currently focuses on:

- whether target depth matches the completed round count
- whether every round contains the required files
- whether tasks in the registry are independent and free of invalid dependencies
- whether task result files match the task registry
- whether the next round's clues reference the previous round's delta report

If validation fails, fix the archive first before starting the next round. This significantly reduces missing-round and non-independent-task issues.

Recommended loop:

1. Create the research archive with the bootstrap script.
2. Fill in the current round's archive files.
3. Run the checker.
4. If it fails, fix the archive and rerun the checker.
5. Only start the next round after the checker passes. Once all rounds are complete, move to a separate synthesis stage instead of treating the last round as the final report.

## Project Structure

```text
deep-research/
├── SKILL.md
├── README.md
├── README.zh-CN.md
├── scripts/
│   ├── deep_research_state_machine.py
│   ├── init_deep_research_archive.py
│   ├── check_deep_research_archive.py
│   ├── repair_deep_research_archive.py
│   ├── openclaw_deep_research_session.py
│   └── install_openclaw_deep_research.sh
├── openclaw-plugin/
│   ├── openclaw.plugin.json
│   ├── package.json
│   ├── README.md
│   └── index.js
├── tests/
├── examples/
├── templates/
└── LICENSE
```

## OpenClaw Plugin Strategy

OpenClaw does not expose a single API that appends a user message to the current run and resumes in place, but it does provide a reliable two-stage mechanism: `before_message_write` can detect a plain assistant stop attempt, and `system event + heartbeat wake` can resume the same session. This repository's plugin uses that model:

- `before_prompt_build`: injects minimal stage-aware execution constraints
- `before_tool_call`: blocks exploratory tools when planning, summary, or validation prerequisites are missing
- `before_message_write`: intercepts a plain-text completion attempt when the archive is not yet at `finalize`, blocks the stop, enqueues a trusted continuation instruction, and wakes the same session
- `after_tool_call`: records tool audit events
- `agent_end`: records unfinished exits for recovery and auditing

The goal is not to build a bloated global gatekeeper, but to intervene precisely at the few points where premature completion would break the workflow.

The current version also distinguishes between two session roles:

- `orchestrator`: the main deep-research session that owns round progression, checker gates, and final completion
- `worker`: a task-execution session spawned by an OpenClaw subagent for one registered task

Workers are intentionally treated differently. They are not required to keep running until the full research reaches `finalize`. Instead, they are only allowed to write registered task report files under the current `round_N/tasks/` directory, and they must not modify `00_meta.json`, round summaries, delta reports, or `final_report.md`.

### OpenClaw Installation Notes

Add [`openclaw-plugin/`](openclaw-plugin) to OpenClaw's `plugins.load.paths`, and allow `deep-research-guard` in `plugins.allow`.

The current version no longer binds a fixed `researchDir` during installation. The intended model is:

- install the skill and plugin once
- when a user starts a real deep-research task, the session script creates or activates the research directory for that task
- the plugin applies only to the current active deep-research session, not to every normal conversation

See [`openclaw-plugin/README.md`](openclaw-plugin/README.md) for full details.

If you want to update OpenClaw configuration in one step, run:

```bash
bash scripts/install_openclaw_deep_research.sh
```

That installer will:

- add [`openclaw-plugin/`](openclaw-plugin) to `plugins.load.paths`
- add `deep-research-guard` to `plugins.allow`
- enable `plugins.entries.deep-research-guard.enabled`
- write `scriptsDir` and `strict`
- install the full skill bundle into the OpenClaw workspace skills directory
- copy `SKILL.md`, `scripts/`, and `templates/` so the skill can run independently inside OpenClaw
- create a timestamped backup of the OpenClaw config before writing

## License

Apache License 2.0
