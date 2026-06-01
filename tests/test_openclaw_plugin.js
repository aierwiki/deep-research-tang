const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const plugin = require("../openclaw-plugin/index.js");

function makeTempResearchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deep-research-plugin-"));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function writeTaskReport(filePath, taskId) {
  writeText(
    filePath,
    [
      "# 任务报告",
      "",
      "## Task ID",
      "",
      taskId,
      "",
      "## Goal",
      "",
      "- Answer the task question.",
      "",
      "## Executed Actions",
      "",
      "1. Read docs.",
      "2. Cross-check code.",
      "",
      "## Key Evidence",
      "",
      "- Evidence line.",
      "",
      "## Findings",
      "",
      "- Finding line.",
      "",
      "## Open Questions",
      "",
      "- Open question line.",
      "",
      "## Next Leads",
      "",
      "- Next lead line.",
      "",
    ].join("\n"),
  );
}

function writeFinalReport(filePath, sourceRefs = ["R01-T01", "R01-T02"]) {
  writeText(
    filePath,
    [
      "# 最终研究报告",
      "",
      "## 核心结论",
      "",
      "- 综合结论成立。",
      "",
      "## 跨轮综合与证据权重",
      "",
      "- 结论：综合全部轮次后判断成立。",
      `  综合依据：${sourceRefs.join(", ")}`,
      "  证据权重说明：多轮证据一致，反例已纳入评估。",
      "",
      "## 关键发现与证据来源",
      "",
      `- 发现：关键发现一。来源：${sourceRefs.join(", ")}`,
      "",
      "## 时效性与交叉验证",
      "",
      "- 关键时间点：2026-04-21。",
      "  信息日期/数据日期：2026-04-20 / 2026-04-21。",
      "  验证动作：对比多个来源并区分事件发生日与发布日期。",
      "  交叉来源：来源 A，来源 B。",
      "",
      "## 具体建议",
      "",
      "- 采取审慎建议。",
      "",
      "## 局限性与不确定性",
      "",
      "- 仍存在不确定性。",
      "",
    ].join("\n"),
  );
}

test("detectArchiveStage keeps placeholder planning files in planning_placeholders", () => {
  const rdir = makeTempResearchDir();
  writeJson(path.join(rdir, "00_meta.json"), {
    topic: "demo",
    original_question: "q?",
    target_depth: 2,
    depth_mode: "user-specified",
    current_round: 1,
    status: "in_progress",
  });
  writeJson(path.join(rdir, "round_01", "01_seed_clues.json"), {
    round: 1,
    seed_clues: [
      {
        clue_id: "R01-C01",
        source_round: 0,
        source_ref: "original-question",
        question: "replace-with-question",
        why_it_matters: "replace-with-rationale",
      },
    ],
  });
  writeJson(path.join(rdir, "round_01", "02_task_registry.json"), {
    round: 1,
    tasks: [
      {
        task_id: "R01-T01",
        title: "replace-with-task-title",
        task_type: "exploratory",
        research_dimension: "replace-with-dimension",
        key_question: "replace-with-key-question",
        planned_actions: ["action-1", "action-2", "action-3"],
        expected_evidence: ["evidence-1"],
        depends_on: [],
        report_path: "round_01/tasks/task_01_replace-with-slug.md",
      },
    ],
  });

  const meta = JSON.parse(fs.readFileSync(path.join(rdir, "00_meta.json"), "utf8"));
  const stage = plugin.__testing.detectArchiveStage(null, rdir, meta);
  assert.equal(stage.stage, "plan");
});

test("detectArchiveStage reports execution when task reports are missing", () => {
  const rdir = makeTempResearchDir();
  writeJson(path.join(rdir, "00_meta.json"), {
    topic: "demo",
    original_question: "q?",
    target_depth: 2,
    depth_mode: "user-specified",
    current_round: 1,
    status: "in_progress",
  });
  writeJson(path.join(rdir, "round_01", "01_seed_clues.json"), {
    round: 1,
    seed_clues: [
      {
        clue_id: "R01-C01",
        source_round: 0,
        source_ref: "original-question",
        question: "What matters?",
        why_it_matters: "Important",
      },
    ],
  });
  writeJson(path.join(rdir, "round_01", "02_task_registry.json"), {
    round: 1,
    tasks: [
      {
        task_id: "R01-T01",
        title: "Architecture",
        task_type: "exploratory",
        research_dimension: "architecture",
        key_question: "What is the current architecture?",
        planned_actions: ["read docs", "read code", "compare"],
        expected_evidence: ["docs", "code"],
        depends_on: [],
        report_path: "round_01/tasks/task_01_architecture.md",
      },
    ],
  });

  const meta = JSON.parse(fs.readFileSync(path.join(rdir, "00_meta.json"), "utf8"));
  const stage = plugin.__testing.detectArchiveStage(null, rdir, meta);
  assert.equal(stage.stage, "execute");
  assert.match(stage.blockedReason, /missing task reports/);
});

test("detectArchiveStage reports execution when task reports are structurally invalid", () => {
  const rdir = makeTempResearchDir();
  writeJson(path.join(rdir, "00_meta.json"), {
    topic: "demo",
    original_question: "q?",
    target_depth: 2,
    depth_mode: "user-specified",
    current_round: 1,
    status: "in_progress",
  });
  writeJson(path.join(rdir, "round_01", "01_seed_clues.json"), {
    round: 1,
    seed_clues: [
      {
        clue_id: "R01-C01",
        source_round: 0,
        source_ref: "original-question",
        question: "What matters?",
        why_it_matters: "Important",
      },
    ],
  });
  writeJson(path.join(rdir, "round_01", "02_task_registry.json"), {
    round: 1,
    tasks: [
      {
        task_id: "R01-T01",
        title: "Architecture",
        task_type: "exploratory",
        research_dimension: "architecture",
        key_question: "What is the current architecture?",
        planned_actions: ["read docs", "read code", "compare"],
        expected_evidence: ["docs", "code"],
        depends_on: [],
        report_path: "round_01/tasks/task_01_architecture.md",
      },
    ],
  });
  writeText(
    path.join(rdir, "round_01", "tasks", "task_01_architecture.md"),
    "# 任务报告\n\n## Task ID\n\nR01-T01\n",
  );

  const meta = JSON.parse(fs.readFileSync(path.join(rdir, "00_meta.json"), "utf8"));
  const stage = plugin.__testing.detectArchiveStage(null, rdir, meta);
  assert.equal(stage.stage, "execute");
  assert.match(stage.blockedReason, /invalid task reports/i);
  assert.match(stage.blockedReason, /missing section/i);
});

test("detectArchiveStage accepts markdown-emphasized task ids in reports", () => {
  const rdir = makeTempResearchDir();
  writeText(path.join(rdir, "00_research_brief.md"), "# Brief\n");
  writeJson(path.join(rdir, "00_meta.json"), {
    topic: "demo",
    original_question: "q?",
    target_depth: 2,
    depth_mode: "user-specified",
    current_round: 1,
    status: "in_progress",
  });
  writeJson(path.join(rdir, "round_01", "01_seed_clues.json"), {
    round: 1,
    seed_clues: [
      {
        clue_id: "R01-C01",
        source_round: 0,
        source_ref: "original-question",
        question: "What matters?",
        why_it_matters: "Important",
      },
    ],
  });
  writeJson(path.join(rdir, "round_01", "02_task_registry.json"), {
    round: 1,
    tasks: [
      {
        task_id: "R01-T01",
        title: "Architecture",
        task_type: "exploratory",
        research_dimension: "architecture",
        key_question: "What is the current architecture?",
        planned_actions: ["read docs", "read code", "compare"],
        expected_evidence: ["docs", "code"],
        depends_on: [],
        report_path: "round_01/tasks/task_01_architecture.md",
      },
    ],
  });
  writeTaskReport(path.join(rdir, "round_01", "tasks", "task_01_architecture.md"), "**R01-T01**");
  writeText(path.join(rdir, "round_01", "03_round_summary.md"), "# Summary\n");
  writeJson(path.join(rdir, "round_01", "04_delta_report.json"), {
    round: 1,
    new_findings: [
      { finding_id: "R01-F01", summary: "Finding one" },
      { finding_id: "R01-F02", summary: "Finding two" },
      { finding_id: "R01-F03", summary: "Finding three" },
    ],
    contradictions: [],
    carry_forward_clues: [{ clue_id: "R01-CF01", question: "Next q" }],
    coverage_assessment: "partial",
  });

  const meta = JSON.parse(fs.readFileSync(path.join(rdir, "00_meta.json"), "utf8"));
  const stage = plugin.__testing.detectArchiveStage(null, rdir, meta);
  assert.equal(stage.stage, "advance");
});

test("detectArchiveStage reports planning when task registry schema is invalid", () => {
  const rdir = makeTempResearchDir();
  writeJson(path.join(rdir, "00_meta.json"), {
    topic: "demo",
    original_question: "q?",
    target_depth: 2,
    depth_mode: "user-specified",
    current_round: 1,
    status: "in_progress",
  });
  writeJson(path.join(rdir, "round_01", "01_seed_clues.json"), {
    round: 1,
    seed_clues: [
      {
        clue_id: "R01-C01",
        source_round: 0,
        source_ref: "original-question",
        question: "What matters?",
        why_it_matters: "Important",
      },
    ],
  });
  writeJson(path.join(rdir, "round_01", "02_task_registry.json"), {
    round: 1,
    tasks: [
      {
        task_id: "R01-T01",
        theme: "Legacy task",
        query: "legacy query",
        key_questions: ["What is the current architecture?"],
      },
    ],
  });

  const meta = JSON.parse(fs.readFileSync(path.join(rdir, "00_meta.json"), "utf8"));
  const stage = plugin.__testing.detectArchiveStage(null, rdir, meta);
  assert.equal(stage.stage, "plan");
  assert.match(stage.blockedReason, /task registry schema invalid/i);
  assert.match(stage.blockedReason, /missing required field/i);
});

test("detectArchiveStage enters synthesize after the final round passes", () => {
  const rdir = makeTempResearchDir();
  writeText(path.join(rdir, "00_research_brief.md"), "# Brief\n");
  writeJson(path.join(rdir, "00_meta.json"), {
    topic: "demo",
    original_question: "q?",
    target_depth: 2,
    depth_mode: "user-specified",
    current_round: 2,
    status: "ready_for_final_report",
  });

  for (const round of [1, 2]) {
    const pad = String(round).padStart(2, "0");
    writeJson(path.join(rdir, `round_${pad}`, "01_seed_clues.json"), {
      round,
      seed_clues: [
        {
          clue_id: `R${pad}-C01`,
          source_round: round - 1,
          source_ref: round === 1 ? "original-question" : `R0${round - 1}-CF01`,
          question: "What matters?",
          why_it_matters: "Important",
        },
      ],
    });
    writeJson(path.join(rdir, `round_${pad}`, "02_task_registry.json"), {
      round,
      tasks: [
        {
          task_id: `R${pad}-T01`,
          title: "Architecture",
          task_type: "exploratory",
          research_dimension: "architecture",
          key_question: `What is round ${round}?`,
          planned_actions: ["read docs", "read code", "compare"],
          expected_evidence: ["docs", "code"],
          depends_on: [],
          report_path: `round_${pad}/tasks/task_01_architecture.md`,
        },
      ],
    });
    writeText(path.join(rdir, `round_${pad}`, "03_round_summary.md"), "# Summary\n");
    writeJson(path.join(rdir, `round_${pad}`, "04_delta_report.json"), {
      round,
      new_findings: [
        { finding_id: `R${pad}-F01`, summary: "Finding one" },
        { finding_id: `R${pad}-F02`, summary: "Finding two" },
        { finding_id: `R${pad}-F03`, summary: "Finding three" },
      ],
      contradictions: [],
      carry_forward_clues: [{ clue_id: `R${pad}-CF01`, question: "Next q" }],
      coverage_assessment: "partial",
    });
    writeTaskReport(path.join(rdir, `round_${pad}`, "tasks", "task_01_architecture.md"), `R${pad}-T01`);
  }

  writeText(path.join(rdir, "final_report.md"), fs.readFileSync(path.join(process.cwd(), "templates", "final_report.md"), "utf8"));

  const meta = JSON.parse(fs.readFileSync(path.join(rdir, "00_meta.json"), "utf8"));
  const stage = plugin.__testing.detectArchiveStage(null, rdir, meta);
  assert.equal(stage.stage, "synthesize");
  assert.match(stage.summary, /final synthesis/i);
});

test("detectArchiveStage reaches finalize only after final report and completed meta", () => {
  const rdir = makeTempResearchDir();
  writeText(path.join(rdir, "00_research_brief.md"), "# Brief\n");
  writeJson(path.join(rdir, "00_meta.json"), {
    topic: "demo",
    original_question: "q?",
    target_depth: 1,
    depth_mode: "user-specified",
    current_round: 1,
    status: "completed",
  });
  writeJson(path.join(rdir, "round_01", "01_seed_clues.json"), {
    round: 1,
    seed_clues: [{ clue_id: "R01-C01", source_round: 0, source_ref: "original-question", question: "What matters?", why_it_matters: "Important" }],
  });
  writeJson(path.join(rdir, "round_01", "02_task_registry.json"), {
    round: 1,
    tasks: [
      {
        task_id: "R01-T01",
        title: "Architecture",
        task_type: "exploratory",
        research_dimension: "architecture",
        key_question: "What is the current architecture?",
        planned_actions: ["read docs", "read code", "compare"],
        expected_evidence: ["docs", "code"],
        depends_on: [],
        report_path: "round_01/tasks/task_01_architecture.md",
      },
    ],
  });
  writeText(path.join(rdir, "round_01", "03_round_summary.md"), "# Summary\n");
  writeJson(path.join(rdir, "round_01", "04_delta_report.json"), {
    round: 1,
    new_findings: [
      { finding_id: "R01-F01", summary: "Finding one" },
      { finding_id: "R01-F02", summary: "Finding two" },
      { finding_id: "R01-F03", summary: "Finding three" },
    ],
    contradictions: [],
    carry_forward_clues: [{ clue_id: "R01-CF01", question: "Next q" }],
    coverage_assessment: "full",
  });
  writeTaskReport(path.join(rdir, "round_01", "tasks", "task_01_architecture.md"), "R01-T01");
  writeFinalReport(path.join(rdir, "final_report.md"));

  const meta = JSON.parse(fs.readFileSync(path.join(rdir, "00_meta.json"), "utf8"));
  const stage = plugin.__testing.detectArchiveStage(null, rdir, meta);
  assert.equal(stage.stage, "finalize");
});

test("detectArchiveStage keeps synthesize stage when final report is too thin", () => {
  const rdir = makeTempResearchDir();
  writeText(path.join(rdir, "00_research_brief.md"), "# Brief\n");
  writeJson(path.join(rdir, "00_meta.json"), {
    topic: "demo",
    original_question: "q?",
    target_depth: 2,
    depth_mode: "user-specified",
    current_round: 2,
    status: "completed",
  });

  for (const round of [1, 2]) {
    const pad = String(round).padStart(2, "0");
    writeJson(path.join(rdir, `round_${pad}`, "01_seed_clues.json"), {
      round,
      seed_clues: [
        {
          clue_id: `R${pad}-C01`,
          source_round: round - 1,
          source_ref: round === 1 ? "original-question" : `R0${round - 1}-CF01`,
          question: "What matters?",
          why_it_matters: "Important",
        },
      ],
    });
    writeJson(path.join(rdir, `round_${pad}`, "02_task_registry.json"), {
      round,
      tasks: [
        {
          task_id: `R${pad}-T01`,
          title: "Architecture",
          task_type: "exploratory",
          research_dimension: "architecture",
          key_question: `What is round ${round}?`,
          planned_actions: ["read docs", "read code", "compare"],
          expected_evidence: ["docs", "code"],
          depends_on: [],
          report_path: `round_${pad}/tasks/task_01_architecture.md`,
        },
      ],
    });
    writeText(path.join(rdir, `round_${pad}`, "03_round_summary.md"), "# Summary\n");
    writeJson(path.join(rdir, `round_${pad}`, "04_delta_report.json"), {
      round,
      new_findings: [
        { finding_id: `R${pad}-F01`, summary: "Finding one" },
        { finding_id: `R${pad}-F02`, summary: "Finding two" },
        { finding_id: `R${pad}-F03`, summary: "Finding three" },
      ],
      contradictions: [],
      carry_forward_clues: [{ clue_id: `R${pad}-CF01`, question: "Next q" }],
      coverage_assessment: "partial",
    });
    writeTaskReport(path.join(rdir, `round_${pad}`, "tasks", "task_01_architecture.md"), `R${pad}-T01`);
  }

  writeFinalReport(path.join(rdir, "final_report.md"), ["R01-T01"]);
  const meta = JSON.parse(fs.readFileSync(path.join(rdir, "00_meta.json"), "utf8"));
  const stage = plugin.__testing.detectArchiveStage(null, rdir, meta);
  assert.equal(stage.stage, "synthesize");
  assert.match(stage.blockedReason, /not yet sufficient/i);
  assert.match(stage.blockedReason, /task sources/i);
});

test("shouldBlockToolForStage blocks exploratory tools before summary is complete", () => {
  const blocked = plugin.__testing.shouldBlockToolForStage(
    {
      stage: "plan",
      blockedReason: "planning incomplete",
    },
    "web_search",
    {},
  );
  assert.equal(blocked, true);

  const allowed = plugin.__testing.shouldBlockToolForStage(
    {
      stage: "execute",
      blockedReason: "task execution in progress",
    },
    "web_search",
    {},
  );
  assert.equal(allowed, false);
});

test("buildStagePrompt includes stage and explicit non-completion warning", () => {
  const prompt = plugin.__testing.buildStagePrompt(
    {
      stage: "execute",
      summary: "Round 1 execution is still in progress.",
      nextActions: ["finish task report"],
    },
    {
      current_round: 1,
      target_depth: 3,
      status: "in_progress",
    },
  );
  assert.match(prompt, /Current stage: execute/);
  assert.match(prompt, /Do not declare the research complete/);
  assert.match(prompt, /absolute dates/i);
});

test("maintenance commands are not treated as exploratory tools", () => {
  const exploratory = plugin.__testing.isExploratoryTool("exec_command", {
    cmd: "python scripts/check_deep_research_archive.py --research-dir x --strict",
  });
  assert.equal(exploratory, false);
});

test("validateMetaWrite blocks illegal meta statuses", () => {
  const result = plugin.__testing.validateMetaWrite(
    "write",
    {
      content: JSON.stringify({
        topic: "demo",
        original_question: "q?",
        target_depth: 3,
        current_round: 3,
        status: "finalized",
      }),
    },
    "00_meta.json",
    {},
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /invalid/i);
});

test("validateMetaWrite allows ready_for_final_report only after target depth", () => {
  const allowed = plugin.__testing.validateMetaWrite(
    "write",
    {
      content: JSON.stringify({
        topic: "demo",
        original_question: "q?",
        target_depth: 3,
        current_round: 3,
        status: "ready_for_final_report",
      }),
    },
    "00_meta.json",
    {},
  );
  assert.equal(allowed.ok, true);

  const blocked = plugin.__testing.validateMetaWrite(
    "write",
    {
      content: JSON.stringify({
        topic: "demo",
        original_question: "q?",
        target_depth: 3,
        current_round: 2,
        status: "ready_for_final_report",
      }),
    },
    "00_meta.json",
    {},
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /cannot enter ready_for_final_report/i);
});

test("validateFinalRoundRegistryWrite blocks final synthesis tasks in last round", () => {
  const result = plugin.__testing.validateFinalRoundRegistryWrite(
    "write",
    {
      content: JSON.stringify({
        round: 3,
        tasks: [
          {
            task_id: "R03-T01",
            title: "撰写最终报告",
            task_type: "exploratory",
            research_dimension: "synthesis",
            key_question: "给出最终综合结论",
            planned_actions: ["汇总", "改写", "输出"],
            expected_evidence: ["final_report.md"],
            depends_on: [],
            report_path: "final_report.md",
          },
        ],
      }),
    },
    "round_03/02_task_registry.json",
    { target_depth: 3 },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /last round is still a normal exploration round/i);
});

test("validateFinalReportWrite only allows final report updates during synthesis or finalize", () => {
  const blocked = plugin.__testing.validateFinalReportWrite("final_report.md", { stage: "execute" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /independent final synthesis stage/i);

  const allowed = plugin.__testing.validateFinalReportWrite("final_report.md", { stage: "synthesize" });
  assert.equal(allowed.ok, true);
});

test("local read tools are not treated as exploratory tools", () => {
  const exploratory = plugin.__testing.isExploratoryTool("read", {
    path: "/Users/tangyubin/.openclaw/workspace/skills/deep-research/SKILL.md",
  });
  assert.equal(exploratory, false);
});

test("readActiveSession loads workspace marker state", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-research-workspace-"));
  const researchDir = path.join(workspaceDir, "research_20260417_demo");
  fs.mkdirSync(path.join(workspaceDir, ".deep-research"), { recursive: true });
  fs.mkdirSync(researchDir, { recursive: true });
  writeJson(path.join(workspaceDir, ".deep-research", "active.json"), {
    version: 1,
    research_dir: researchDir,
  });

  const session = plugin.__testing.readActiveSession({ workspaceDir });
  assert.equal(session?.researchDir, researchDir);
});

test("activeResearchDir accepts v3 workspace binding from any same-workspace session", () => {
  plugin.__testing.resetGuardActivation();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-research-workspace-"));
  const researchDir = path.join(workspaceDir, "research_20260417_demo");
  fs.mkdirSync(path.join(workspaceDir, ".deep-research"), { recursive: true });
  fs.mkdirSync(researchDir, { recursive: true });
  writeJson(path.join(workspaceDir, ".deep-research", "active.json"), {
    version: 3,
    research_dir: researchDir,
    last_seen_session_key: "agent:main:old",
  });

  const bound = plugin.__testing.activeResearchDir({
    workspaceDir,
    sessionId: "session-new",
    sessionKey: "agent:main:new",
  });
  assert.equal(bound, researchDir);
});

test("legacy v2 activeResearchDir still honors owner binding", () => {
  plugin.__testing.resetGuardActivation();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-research-workspace-"));
  const researchDir = path.join(workspaceDir, "research_20260417_demo");
  fs.mkdirSync(path.join(workspaceDir, ".deep-research"), { recursive: true });
  fs.mkdirSync(researchDir, { recursive: true });
  writeJson(path.join(workspaceDir, ".deep-research", "active.json"), {
    version: 2,
    research_dir: researchDir,
    owner_session_id: "session-owner",
    owner_session_key: "agent:main:main",
    worker_session_keys: [],
  });
  const other = plugin.__testing.activeResearchDir({
    workspaceDir,
    sessionId: "session-new",
    sessionKey: "session-research",
  });
  assert.equal(other, null);
});

test("activeResearchDir uses cached binding for later hooks without workspaceDir", () => {
  plugin.__testing.resetGuardActivation();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-research-workspace-"));
  const researchDir = path.join(workspaceDir, "research_20260417_demo");
  fs.mkdirSync(path.join(workspaceDir, ".deep-research"), { recursive: true });
  fs.mkdirSync(researchDir, { recursive: true });
  writeJson(path.join(workspaceDir, ".deep-research", "active.json"), {
    version: 2,
    research_dir: researchDir,
    owner_session_id: "session-owner",
    owner_session_key: "agent:main:main",
    worker_session_keys: [],
  });

  plugin.__testing.activeResearchDir({
    workspaceDir,
    sessionId: "session-owner",
    sessionKey: "agent:main:main",
  });

  const cached = plugin.__testing.activeResearchDir({ sessionKey: "agent:main:main" });
  assert.equal(cached, researchDir);
});

test("rebindOwnedActiveSession stamps soft last-seen session metadata onto the marker", () => {
  plugin.__testing.resetGuardActivation();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-research-workspace-"));
  const researchDir = path.join(workspaceDir, "research_20260417_demo");
  fs.mkdirSync(path.join(workspaceDir, ".deep-research"), { recursive: true });
  fs.mkdirSync(researchDir, { recursive: true });
  writeJson(path.join(workspaceDir, ".deep-research", "active.json"), {
    version: 1,
    research_dir: researchDir,
    action: "start",
  });

  plugin.__testing.rebindOwnedActiveSession(
    {
      workspaceDir,
      sessionId: "session-owner",
      sessionKey: "agent:main:main",
    },
    {
      action: "start",
      workspace_dir: workspaceDir,
      research_dir: researchDir,
      activated_at: "2026-04-19T10:00:00Z",
    },
  );

  const payload = JSON.parse(
    fs.readFileSync(path.join(workspaceDir, ".deep-research", "active.json"), "utf8"),
  );
  assert.equal(payload.version, 3);
  assert.equal(payload.last_seen_session_id, "session-owner");
  assert.equal(payload.last_seen_session_key, "agent:main:main");
  assert.equal(payload.owner_session_id, undefined);
  assert.equal(payload.worker_session_keys, undefined);
});

test("session lifecycle tool signals update soft binding after advance-round", async () => {
  plugin.__testing.resetGuardActivation();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-research-workspace-"));
  const researchDir = path.join(workspaceDir, "research_20260417_demo");
  fs.mkdirSync(path.join(workspaceDir, ".deep-research"), { recursive: true });
  fs.mkdirSync(researchDir, { recursive: true });
  writeJson(path.join(workspaceDir, ".deep-research", "active.json"), {
    version: 2,
    action: "advance-round",
    workspace_dir: workspaceDir,
    research_dir: researchDir,
  });

  const handlers = {};
  plugin.register({
    registerTool: () => {},
    on: (name, handler) => {
      handlers[name] = handler;
    },
  });

  await handlers.after_tool_call(
    {
      result: {
        signal:
          `DEEP_RESEARCH_SESSION {"action":"advance-round","workspace_dir":${JSON.stringify(workspaceDir)},"research_dir":${JSON.stringify(researchDir)}}`,
      },
      toolName: "deep_research_session",
    },
    {
      workspaceDir,
      sessionId: "session-owner",
      sessionKey: "agent:main:dashboard:owner",
    },
  );

  const payload = JSON.parse(
    fs.readFileSync(path.join(workspaceDir, ".deep-research", "active.json"), "utf8"),
  );
  assert.equal(payload.version, 3);
  assert.equal(payload.last_seen_session_id, "session-owner");
  assert.equal(payload.last_seen_session_key, "agent:main:dashboard:owner");
});

test("legacy workspace-only markers stay dormant until re-activated", () => {
  plugin.__testing.resetGuardActivation();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-research-workspace-"));
  const researchDir = path.join(workspaceDir, "research_20260417_demo");
  fs.mkdirSync(path.join(workspaceDir, ".deep-research"), { recursive: true });
  fs.mkdirSync(researchDir, { recursive: true });
  writeJson(path.join(workspaceDir, ".deep-research", "active.json"), {
    version: 1,
    research_dir: researchDir,
  });

  const activated = plugin.__testing.activeResearchDir({
    workspaceDir,
    sessionId: "session-owner",
    sessionKey: "agent:main:main",
  });
  assert.equal(activated, null);
});

test("linked worker sessions inherit access without broadening to new main sessions", () => {
  plugin.__testing.resetGuardActivation();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-research-workspace-"));
  const researchDir = path.join(workspaceDir, "research_20260417_demo");
  fs.mkdirSync(path.join(workspaceDir, ".deep-research"), { recursive: true });
  fs.mkdirSync(researchDir, { recursive: true });
  writeJson(path.join(workspaceDir, ".deep-research", "active.json"), {
    version: 2,
    research_dir: researchDir,
    owner_session_id: "session-owner",
    owner_session_key: "agent:main:main",
    worker_session_keys: [],
  });

  plugin.__testing.activeResearchDir({
    workspaceDir,
    sessionId: "session-owner",
    sessionKey: "agent:main:main",
  });
  plugin.__testing.linkWorkerSession("agent:main:main", "agent:main:subagent:worker-1");

  const worker = plugin.__testing.activeResearchDir({
    workspaceDir,
    sessionId: "worker-session",
    sessionKey: "agent:main:subagent:worker-1",
  });
  assert.equal(worker, researchDir);

  const unrelated = plugin.__testing.activeResearchDir({
    workspaceDir,
    sessionId: "session-new",
    sessionKey: "agent:main:main",
  });
  assert.equal(unrelated, null);
});

test("v3 linked worker sessions do not restrict unrelated same-workspace chats", () => {
  plugin.__testing.resetGuardActivation();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-research-workspace-"));
  const researchDir = path.join(workspaceDir, "research_20260417_demo");
  fs.mkdirSync(path.join(workspaceDir, ".deep-research"), { recursive: true });
  fs.mkdirSync(researchDir, { recursive: true });
  writeJson(path.join(workspaceDir, ".deep-research", "active.json"), {
    version: 3,
    research_dir: researchDir,
    last_seen_session_key: "agent:main:main",
  });

  plugin.__testing.activeResearchDir({
    workspaceDir,
    sessionId: "session-owner",
    sessionKey: "agent:main:main",
  });
  plugin.__testing.linkWorkerSession("agent:main:main", "agent:main:subagent:worker-1");

  assert.equal(
    plugin.__testing.activeResearchDir({
      workspaceDir,
      sessionId: "session-new",
      sessionKey: "agent:main:other",
    }),
    researchDir,
  );
});

test("unlinkWorkerSession removes child access from the marker and cache", () => {
  plugin.__testing.resetGuardActivation();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-research-workspace-"));
  const researchDir = path.join(workspaceDir, "research_20260417_demo");
  fs.mkdirSync(path.join(workspaceDir, ".deep-research"), { recursive: true });
  fs.mkdirSync(researchDir, { recursive: true });
  writeJson(path.join(workspaceDir, ".deep-research", "active.json"), {
    version: 2,
    research_dir: researchDir,
    owner_session_id: "session-owner",
    owner_session_key: "agent:main:main",
    worker_session_keys: ["agent:main:subagent:worker-1"],
  });

  plugin.__testing.bindActiveResearch(
    { sessionKey: "agent:main:subagent:worker-1" },
    researchDir,
    path.join(workspaceDir, ".deep-research", "active.json"),
  );
  plugin.__testing.unlinkWorkerSession("agent:main:subagent:worker-1");

  const payload = JSON.parse(
    fs.readFileSync(path.join(workspaceDir, ".deep-research", "active.json"), "utf8"),
  );
  assert.deepEqual(payload.worker_session_keys, []);
  assert.equal(
    plugin.__testing.activeResearchDir({ sessionKey: "agent:main:subagent:worker-1" }),
    null,
  );
});

test("parseSessionSignal extracts activation payload from tool output", () => {
  const parsed = plugin.__testing.parseSessionSignal({
    content: [
      {
        type: "text",
        text: 'DEEP_RESEARCH_SESSION {"action":"start","research_dir":"/tmp/research_1"}',
      },
    ],
  });
  assert.equal(parsed?.action, "start");
  assert.equal(parsed?.research_dir, "/tmp/research_1");
});

test("parseSessionSignal extracts activation payload from session tool result objects", () => {
  const parsed = plugin.__testing.parseSessionSignal({
    ok: true,
    signal:
      'DEEP_RESEARCH_SESSION {"action":"start","research_dir":"/tmp/research_2","workspace_dir":"/tmp"}',
  });
  assert.equal(parsed?.action, "start");
  assert.equal(parsed?.research_dir, "/tmp/research_2");
});

test("deep research session tool exposes lifecycle actions", () => {
  const tool = plugin.__testing.createDeepResearchSessionTool({});
  assert.deepEqual(tool.parameters.properties.action.enum, [
    "start",
    "activate",
    "advance-round",
    "finalize",
    "recover",
    "status",
    "clear",
  ]);
});

test("parseArchiveTarget recognizes deep-research archive files", () => {
  const parsed = plugin.__testing.parseArchiveTarget(
    "/Users/tangyubin/.openclaw/workspace/research_20260420_demo/round_01/02_task_registry.json",
  );
  assert.equal(parsed?.researchDir, "/Users/tangyubin/.openclaw/workspace/research_20260420_demo");
  assert.equal(parsed?.relPath, "round_01/02_task_registry.json");
});

test("validateInactiveArchiveBootstrap blocks manual archive bootstrap without a bound session", () => {
  const result = plugin.__testing.validateInactiveArchiveBootstrap(
    "write",
    {
      path: "/Users/tangyubin/.openclaw/workspace/research_20260420_demo/00_meta.json",
      content: "{}",
    },
    "/Users/tangyubin/.openclaw/workspace",
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /deep_research_session/);
});

test("validateInactiveArchiveBootstrap allows non-archive writes without a bound session", () => {
  const result = plugin.__testing.validateInactiveArchiveBootstrap(
    "write",
    {
      path: "/Users/tangyubin/.openclaw/workspace/notes.md",
      content: "# notes",
    },
    "/Users/tangyubin/.openclaw/workspace",
  );
  assert.equal(result.ok, true);
});

test("default lite before_tool_call allows exploratory tools during planning", async () => {
  plugin.__testing.resetGuardActivation();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-research-workspace-"));
  const researchDir = path.join(workspaceDir, "research_20260417_demo");
  fs.mkdirSync(path.join(workspaceDir, ".deep-research"), { recursive: true });
  fs.mkdirSync(researchDir, { recursive: true });
  writeJson(path.join(workspaceDir, ".deep-research", "active.json"), {
    version: 3,
    workspace_dir: workspaceDir,
    research_dir: researchDir,
  });
  writeJson(path.join(researchDir, "00_meta.json"), {
    topic: "demo",
    original_question: "q?",
    target_depth: 2,
    depth_mode: "user-specified",
    current_round: 1,
    status: "in_progress",
  });

  const handlers = {};
  plugin.register({
    pluginConfig: {},
    registerTool: () => {},
    on: (name, handler) => {
      handlers[name] = handler;
    },
  });

  const result = await handlers.before_tool_call(
    { toolName: "exec", params: { command: "mmx search demo" } },
    { workspaceDir, sessionKey: "agent:main:new", sessionId: "session-new" },
  );
  assert.deepEqual(result, {});
});

test("strict before_tool_call keeps legacy stage blocking", async () => {
  plugin.__testing.resetGuardActivation();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-research-workspace-"));
  const researchDir = path.join(workspaceDir, "research_20260417_demo");
  fs.mkdirSync(path.join(workspaceDir, ".deep-research"), { recursive: true });
  fs.mkdirSync(researchDir, { recursive: true });
  writeJson(path.join(workspaceDir, ".deep-research", "active.json"), {
    version: 3,
    workspace_dir: workspaceDir,
    research_dir: researchDir,
  });
  writeJson(path.join(researchDir, "00_meta.json"), {
    topic: "demo",
    original_question: "q?",
    target_depth: 2,
    depth_mode: "user-specified",
    current_round: 1,
    status: "in_progress",
  });

  const handlers = {};
  plugin.register({
    pluginConfig: { guardMode: "strict" },
    registerTool: () => {},
    on: (name, handler) => {
      handlers[name] = handler;
    },
  });

  const result = await handlers.before_tool_call(
    { toolName: "exec", params: { command: "mmx search demo" } },
    { workspaceDir, sessionKey: "agent:main:new", sessionId: "session-new" },
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /Round 1 prerequisites missing/i);
});

test("isTerminalAssistantMessage detects plain stop replies without tool use", () => {
  assert.equal(
    plugin.__testing.isTerminalAssistantMessage({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "done" }],
    }),
    true,
  );

  assert.equal(
    plugin.__testing.isTerminalAssistantMessage({
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "tool_use", name: "web_search" }],
    }),
    false,
  );
});

test("maybeResumeUnfinishedResearch blocks stop and schedules continuation wake", () => {
  const rdir = makeTempResearchDir();
  writeJson(path.join(rdir, "00_meta.json"), {
    topic: "demo",
    original_question: "q?",
    target_depth: 2,
    depth_mode: "user-specified",
    current_round: 1,
    status: "in_progress",
  });
  writeJson(path.join(rdir, "round_01", "01_seed_clues.json"), {
    round: 1,
    seed_clues: [{ clue_id: "R01-C01", question: "What matters?", why_it_matters: "Important" }],
  });
  writeJson(path.join(rdir, "round_01", "02_task_registry.json"), {
    round: 1,
    tasks: [
      {
        task_id: "R01-T01",
        title: "Architecture",
        task_type: "exploratory",
        research_dimension: "architecture",
        key_question: "What is the current architecture?",
        planned_actions: ["read docs", "read code", "compare"],
        expected_evidence: ["docs", "code"],
        depends_on: [],
        report_path: "round_01/tasks/task_01_architecture.md",
      },
    ],
  });

  const systemCalls = [];
  const wakeCalls = [];
  const api = {
    runtime: {
      system: {
        enqueueSystemEvent: (text, meta) => systemCalls.push({ text, meta }),
        requestHeartbeatNow: (params) => wakeCalls.push(params),
      },
    },
  };
  const meta = JSON.parse(fs.readFileSync(path.join(rdir, "00_meta.json"), "utf8"));
  const stageInfo = plugin.__testing.detectArchiveStage(api, rdir, meta);

  const result = plugin.__testing.maybeResumeUnfinishedResearch(
    api,
    { sessionKey: "agent:main:main", agentId: "main" },
    rdir,
    meta,
    stageInfo,
    {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "research complete" }],
    },
  );

  assert.equal(result?.block, true);
  assert.equal(systemCalls.length, 1);
  assert.match(systemCalls[0].text, /blocked an attempted stop/);
  assert.equal(systemCalls[0].meta.sessionKey, "agent:main:main");
  assert.equal(wakeCalls.length, 1);
  assert.equal(wakeCalls[0].reason, "wake");
  assert.equal(wakeCalls[0].sessionKey, "agent:main:main");
});

test("maybeResumeUnfinishedResearch ignores finalize stage", () => {
  const res = plugin.__testing.maybeResumeUnfinishedResearch(
    { runtime: { system: {} } },
    { sessionKey: "agent:main:main", agentId: "main" },
    "/tmp/research",
    { current_round: 2 },
    { stage: "finalize", summary: "done", nextActions: [] },
    {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "final answer" }],
    },
  );
  assert.equal(res, null);
});

test("maybeResumeAfterToolIdle schedules continuation wake for post-tool idle exits", () => {
  const rdir = makeTempResearchDir();
  writeJson(path.join(rdir, "00_meta.json"), {
    topic: "demo",
    original_question: "q?",
    target_depth: 2,
    depth_mode: "user-specified",
    current_round: 1,
    status: "in_progress",
  });
  writeJson(path.join(rdir, "round_01", "01_seed_clues.json"), {
    round: 1,
    seed_clues: [{ clue_id: "R01-C01", question: "What matters?", why_it_matters: "Important" }],
  });
  writeJson(path.join(rdir, "round_01", "02_task_registry.json"), {
    round: 1,
    tasks: [
      {
        task_id: "R01-T01",
        title: "Architecture",
        task_type: "exploratory",
        research_dimension: "architecture",
        key_question: "What is the current architecture?",
        planned_actions: ["read docs", "read code", "compare"],
        expected_evidence: ["docs", "code"],
        depends_on: [],
        report_path: "round_01/tasks/task_01_architecture.md",
      },
    ],
  });

  const systemCalls = [];
  const wakeCalls = [];
  const api = {
    runtime: {
      system: {
        enqueueSystemEvent: (text, meta) => systemCalls.push({ text, meta }),
        requestHeartbeatNow: (params) => wakeCalls.push(params),
      },
    },
  };
  const ctx = {
    sessionKey: "agent:main:main",
    agentId: "main",
  };
  plugin.__testing.bindActiveResearch(ctx, rdir);
  plugin.__testing.markToolActivity(ctx, {
    toolName: "read",
    toolCallId: "call_read_1",
  });

  const meta = JSON.parse(fs.readFileSync(path.join(rdir, "00_meta.json"), "utf8"));
  const stageInfo = plugin.__testing.detectArchiveStage(api, rdir, meta);
  const result = plugin.__testing.maybeResumeAfterToolIdle(api, ctx, rdir, meta, stageInfo, {
    success: true,
  });

  assert.equal(result?.queued, true);
  assert.equal(systemCalls.length, 1);
  assert.match(systemCalls[0].text, /run went idle immediately after read completed/i);
  assert.equal(systemCalls[0].meta.sessionKey, "agent:main:main");
  assert.equal(wakeCalls.length, 1);
  assert.equal(wakeCalls[0].reason, "deep-research-post-tool");
  assert.equal(wakeCalls[0].sessionKey, "agent:main:main");
});

test("maybeResumeAfterToolIdle ignores sessions_yield-driven exits", () => {
  const rdir = makeTempResearchDir();
  writeJson(path.join(rdir, "00_meta.json"), {
    topic: "demo",
    original_question: "q?",
    target_depth: 2,
    depth_mode: "user-specified",
    current_round: 1,
    status: "in_progress",
  });
  const api = { runtime: { system: {} } };
  const ctx = {
    sessionKey: "agent:main:main",
    agentId: "main",
  };
  plugin.__testing.bindActiveResearch(ctx, rdir);
  plugin.__testing.markToolActivity(ctx, {
    toolName: "sessions_yield",
    toolCallId: "call_yield_1",
  });
  const meta = JSON.parse(fs.readFileSync(path.join(rdir, "00_meta.json"), "utf8"));
  const res = plugin.__testing.maybeResumeAfterToolIdle(
    api,
    ctx,
    rdir,
    meta,
    { stage: "execute", summary: "in progress", nextActions: ["finish task report"] },
    { success: true },
  );
  assert.equal(res, null);
});

test("sessionRole treats subagent sessions as worker mode", () => {
  assert.equal(plugin.__testing.sessionRole({ sessionKey: "agent:main:subagent:worker-1" }), "worker");
  assert.equal(plugin.__testing.sessionRole({ sessionKey: "agent:main:main" }), "orchestrator");
});

test("worker prompt tells subagents to finish only their assigned task", () => {
  const prompt = plugin.__testing.buildWorkerPrompt(
    {
      stage: "execute",
      summary: "Round 1 execution is still in progress.",
    },
    {
      current_round: 1,
      target_depth: 3,
      status: "in_progress",
    },
  );
  assert.match(prompt, /task-worker guard/i);
  assert.match(prompt, /only the assigned task/i);
  assert.match(prompt, /Forbidden archive writes/i);
});

test("stage prompt prefers lifecycle tool over manual meta edits", () => {
  const prompt = plugin.__testing.buildStagePrompt(
    {
      stage: "advance",
      summary: "Round 1 is valid. Another round is still required.",
      nextActions: ["start round_02"],
    },
    {
      current_round: 1,
      target_depth: 2,
      status: "ready_for_next_round",
    },
  );
  assert.match(prompt, /deep_research_session/i);
  assert.match(prompt, /00_meta\.json/i);
});

test("maybeResumeUnfinishedResearch does not intercept worker stop messages", () => {
  const res = plugin.__testing.maybeResumeUnfinishedResearch(
    { runtime: { system: {} } },
    { sessionKey: "agent:main:subagent:worker-1", agentId: "main" },
    "/tmp/research",
    { current_round: 1 },
    { stage: "execute", summary: "in progress", nextActions: ["finish task report"] },
    {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "task complete" }],
    },
  );
  assert.equal(res, null);
});

test("worker archive writes are limited to registered task reports", () => {
  const rdir = makeTempResearchDir();
  writeJson(path.join(rdir, "00_meta.json"), {
    topic: "demo",
    original_question: "q?",
    target_depth: 2,
    depth_mode: "user-specified",
    current_round: 1,
    status: "in_progress",
  });
  writeJson(path.join(rdir, "round_01", "01_seed_clues.json"), {
    round: 1,
    seed_clues: [{ clue_id: "R01-C01", question: "What matters?", why_it_matters: "Important" }],
  });
  writeJson(path.join(rdir, "round_01", "02_task_registry.json"), {
    round: 1,
    tasks: [
      {
        task_id: "R01-T01",
        title: "Architecture",
        task_type: "exploratory",
        research_dimension: "architecture",
        key_question: "What is the current architecture?",
        planned_actions: ["read docs", "read code", "compare"],
        expected_evidence: ["docs", "code"],
        depends_on: [],
        report_path: "round_01/tasks/task_01_architecture.md",
      },
    ],
  });

  const meta = JSON.parse(fs.readFileSync(path.join(rdir, "00_meta.json"), "utf8"));

  const allowed = plugin.__testing.validateWorkerArchiveWrite(
    "write",
    { path: "round_01/tasks/task_01_architecture.md" },
    rdir,
    meta,
  );
  assert.equal(allowed.ok, true);

  const blocked = plugin.__testing.validateWorkerArchiveWrite(
    "write",
    { path: "final_report.md" },
    rdir,
    meta,
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /only write registered task reports/i);
});

// --- Auto-yield enforcement tests ---

test("isSpawnTool recognizes spawn-related tool names", () => {
  assert.equal(plugin.__testing.isSpawnTool("sessions_spawn"), true);
  assert.equal(plugin.__testing.isSpawnTool("sessions_create"), true);
  assert.equal(plugin.__testing.isSpawnTool("subagent_spawn"), true);
  assert.equal(plugin.__testing.isSpawnTool("create_subagent"), true);
  assert.equal(plugin.__testing.isSpawnTool("spawn_worker"), true);
  assert.equal(plugin.__testing.isSpawnTool("read"), false);
  assert.equal(plugin.__testing.isSpawnTool("write"), false);
  assert.equal(plugin.__testing.isSpawnTool("sessions_yield"), false);
  assert.equal(plugin.__testing.isSpawnTool(""), false);
});

test("isYieldTool recognizes sessions_yield", () => {
  assert.equal(plugin.__testing.isYieldTool("sessions_yield"), true);
  assert.equal(plugin.__testing.isYieldTool("yield"), false);
  assert.equal(plugin.__testing.isYieldTool("sessions_spawn"), false);
});

test("markSubagentSpawned tracks unyielded spawn count", () => {
  plugin.__testing.resetGuardActivation();
  const rdir = makeTempResearchDir();
  writeJson(path.join(rdir, "00_meta.json"), {
    topic: "demo", original_question: "q?",
    target_depth: 2, depth_mode: "user-specified",
    current_round: 1, status: "in_progress",
  });
  const ctx = { sessionKey: "agent:main:main", agentId: "main" };
  plugin.__testing.bindActiveResearch(ctx, rdir);

  // Initially no unyielded spawns
  assert.equal(plugin.__testing.hasUnyieldedSpawns(ctx), false);

  // After one spawn
  plugin.__testing.markSubagentSpawned("agent:main:main");
  assert.equal(plugin.__testing.hasUnyieldedSpawns(ctx), true);

  // After second spawn (batch)
  plugin.__testing.markSubagentSpawned("agent:main:main");
  assert.equal(plugin.__testing.hasUnyieldedSpawns(ctx), true);
});

test("clearUnyieldedSpawns resets spawn state after yield", () => {
  plugin.__testing.resetGuardActivation();
  const rdir = makeTempResearchDir();
  writeJson(path.join(rdir, "00_meta.json"), {
    topic: "demo", original_question: "q?",
    target_depth: 2, depth_mode: "user-specified",
    current_round: 1, status: "in_progress",
  });
  const ctx = { sessionKey: "agent:main:main", agentId: "main" };
  plugin.__testing.bindActiveResearch(ctx, rdir);

  plugin.__testing.markSubagentSpawned("agent:main:main");
  plugin.__testing.markSubagentSpawned("agent:main:main");
  assert.equal(plugin.__testing.hasUnyieldedSpawns(ctx), true);

  plugin.__testing.clearUnyieldedSpawns(ctx);
  assert.equal(plugin.__testing.hasUnyieldedSpawns(ctx), false);
});

test("enforceSpawnYieldDiscipline blocks non-spawn non-yield tools", () => {
  plugin.__testing.resetGuardActivation();
  const rdir = makeTempResearchDir();
  writeJson(path.join(rdir, "00_meta.json"), {
    topic: "demo", original_question: "q?",
    target_depth: 2, depth_mode: "user-specified",
    current_round: 1, status: "in_progress",
  });
  const ctx = { sessionKey: "agent:main:main", agentId: "main" };
  plugin.__testing.bindActiveResearch(ctx, rdir);
  plugin.__testing.markSubagentSpawned("agent:main:main");

  // Should block read tool
  const blocked = plugin.__testing.enforceSpawnYieldDiscipline(ctx, "read");
  assert.equal(blocked?.block, true);
  assert.match(blocked.blockReason, /sessions_yield/);
  assert.match(blocked.blockReason, /1 sub-agent has/);

  // Should allow another spawn
  const allowSpawn = plugin.__testing.enforceSpawnYieldDiscipline(ctx, "sessions_spawn");
  assert.equal(allowSpawn, null);

  // Should allow sessions_yield
  const allowYield = plugin.__testing.enforceSpawnYieldDiscipline(ctx, "sessions_yield");
  assert.equal(allowYield, null);
});

test("enforceSpawnYieldDiscipline allows everything when no spawns pending", () => {
  plugin.__testing.resetGuardActivation();
  const rdir = makeTempResearchDir();
  writeJson(path.join(rdir, "00_meta.json"), {
    topic: "demo", original_question: "q?",
    target_depth: 2, depth_mode: "user-specified",
    current_round: 1, status: "in_progress",
  });
  const ctx = { sessionKey: "agent:main:main", agentId: "main" };
  plugin.__testing.bindActiveResearch(ctx, rdir);

  // No spawns → no blocking
  assert.equal(plugin.__testing.enforceSpawnYieldDiscipline(ctx, "read"), null);
  assert.equal(plugin.__testing.enforceSpawnYieldDiscipline(ctx, "write"), null);
  assert.equal(plugin.__testing.enforceSpawnYieldDiscipline(ctx, "exec"), null);
});

test("enforceSpawnYieldDiscipline does not affect worker sessions", () => {
  plugin.__testing.resetGuardActivation();
  const rdir = makeTempResearchDir();
  writeJson(path.join(rdir, "00_meta.json"), {
    topic: "demo", original_question: "q?",
    target_depth: 2, depth_mode: "user-specified",
    current_round: 1, status: "in_progress",
  });
  const workerCtx = { sessionKey: "agent:main:subagent:worker-1", agentId: "main" };
  plugin.__testing.bindActiveResearch(workerCtx, rdir);

  // Workers are never blocked by spawn-yield discipline
  assert.equal(plugin.__testing.enforceSpawnYieldDiscipline(workerCtx, "read"), null);
});

test("full spawn-yield cycle: spawn multiple → block → yield → unblock", () => {
  plugin.__testing.resetGuardActivation();
  const rdir = makeTempResearchDir();
  writeJson(path.join(rdir, "00_meta.json"), {
    topic: "demo", original_question: "q?",
    target_depth: 2, depth_mode: "user-specified",
    current_round: 1, status: "in_progress",
  });
  const ctx = { sessionKey: "agent:main:main", agentId: "main" };
  plugin.__testing.bindActiveResearch(ctx, rdir);

  // Spawn two sub-agents (batch)
  plugin.__testing.markSubagentSpawned("agent:main:main");
  plugin.__testing.markSubagentSpawned("agent:main:main");

  // Regular tools are blocked
  const blocked = plugin.__testing.enforceSpawnYieldDiscipline(ctx, "write");
  assert.equal(blocked?.block, true);
  assert.match(blocked.blockReason, /2 sub-agents have/);

  // Yield clears the state
  plugin.__testing.clearUnyieldedSpawns(ctx);

  // Now regular tools are allowed again
  assert.equal(plugin.__testing.enforceSpawnYieldDiscipline(ctx, "write"), null);
  assert.equal(plugin.__testing.hasUnyieldedSpawns(ctx), false);
});
