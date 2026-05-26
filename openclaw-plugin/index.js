/**
 * deep-research-guard: OpenClaw runtime plugin
 *
 * This plugin does not try to "catch" completion at the end of the run.
 * Instead it shifts enforcement earlier:
 *
 * - before_prompt_build: inject the minimum current-step protocol so the agent
 *   is reminded what phase it is in and what is forbidden right now.
 * - before_tool_call: block exploratory work when archive/state prerequisites
 *   are missing, incomplete, or still placeholder-filled.
 * - before_agent_finalize: (PRIMARY stop guard, 2026.5.18+) intercept finalization
 *   via the native hook relay before Codex/Pi marks the run as done. Returns
 *   { action: "revise" } to force the agent to continue if the archive is incomplete.
 *   This hook must be registered so OpenClaw keeps hooks.Stop active for Codex.
 * - before_message_write: (FALLBACK) catch plain-text stop attempts before the
 *   archive is complete and immediately re-wake the same session with a trusted
 *   continuation nudge. Still useful for the Pi embedded path.
 * - after_tool_call / agent_end: write audit markers for analysis and recovery.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ACTIVE_SESSIONS = new Map();

// --- Robustness: retry and fault-tolerance defaults ---
const DEFAULT_SUBAGENT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 2000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30000;
const RATE_LIMIT_ERROR_PATTERNS = [
  /rate.?limit/i,
  /too many requests/i,
  /429/,
  /throttl/i,
  /quota/i,
];

function getRetryConfig(api) {
  const cfg = pluginConfig(api);
  return {
    maxRetries: Number(cfg.subagentMaxRetries) || DEFAULT_SUBAGENT_MAX_RETRIES,
    baseDelayMs: Number(cfg.retryBaseDelayMs) || DEFAULT_RETRY_BASE_DELAY_MS,
    maxDelayMs: Number(cfg.retryMaxDelayMs) || DEFAULT_RETRY_MAX_DELAY_MS,
  };
}

function looksLikeRateLimit(errorText) {
  if (!errorText) return false;
  const text = String(errorText);
  return RATE_LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function computeRetryDelay(attempt, baseDelayMs, maxDelayMs, isRateLimit) {
  const base = isRateLimit ? baseDelayMs * 3 : baseDelayMs;
  const delay = Math.min(base * Math.pow(2, attempt - 1), maxDelayMs);
  // Add jitter (±25%)
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  return Math.max(100, Math.round(delay + jitter));
}

const PLACEHOLDER_PATTERNS = [
  "replace-with",
  "action-1",
  "action-2",
  "action-3",
  "evidence-1",
];

const ARCHIVE_WRITE_TOOLS = new Set([
  "write",
  "edit",
  "apply_patch",
  "str_replace_editor",
]);

const ARCHIVE_FILE_PATTERNS = [
  /00_meta\.json$/,
  /00_research_brief\.md$/,
  /\d{2}_seed_clues\.json$/,
  /\d{2}_task_registry\.json$/,
  /\d{2}_round_summary\.md$/,
  /\d{2}_delta_report\.json$/,
  /final_report\.md$/,
  /tasks\/task_[\w.-]+\.md$/,
  /tasks\/task_report\.template\.md$/,
  /audit\.log$/,
];

const SESSION_SIGNAL_PREFIX = "DEEP_RESEARCH_SESSION ";
const DEEP_RESEARCH_SESSION_TOOL = "deep_research_session";
const RESEARCH_DIR_NAME_PATTERN = /(^|\/)(research_\d{8}_[^/]+)(?:\/(.+))?$/;

const EXPLORATORY_TOOL_HINTS = [
  "search",
  "fetch",
  "browser",
  "web",
  "http",
  "shell",
  "exec",
  "run",
  "bash",
  "python",
];

const MAINTENANCE_SCRIPT_HINTS = [
  "check_deep_research_archive.py",
  "repair_deep_research_archive.py",
  "init_deep_research_archive.py",
  "openclaw_deep_research_session.py",
];
const TOOL_CALL_BLOCK_TYPES = new Set(["tool_use", "toolcall", "tool_call"]);
const SUBAGENT_SESSION_SEGMENT = ":subagent:";
const LEGAL_META_STATUSES = new Set([
  "initialized",
  "in_progress",
  "round_failed",
  "ready_for_next_round",
  "ready_for_final_report",
  "completed",
]);
const FINAL_SYNTHESIS_PATTERNS = [
  /\bfinal[_ -]?report\b/i,
  /\bfinal synthesis\b/i,
  /final_report\.md/i,
  /最终综合/,
  /最终报告/,
  /综合报告/,
];
const FINAL_REPORT_TEMPLATE = `# 最终研究报告

## 核心结论

- 

## 跨轮综合与证据权重

- 结论：
  综合依据：
  证据权重说明：

## 关键发现与证据来源

- 发现：
  来源：R01-T01, R02-T03

## 时效性与交叉验证

- 关键时间点：
  信息日期/数据日期：
  验证动作：
  交叉来源：

## 具体建议

- 

## 局限性与不确定性

-`;
const REQUIRED_FINAL_REPORT_SECTIONS = [
  "核心结论",
  "跨轮综合与证据权重",
  "关键发现与证据来源",
  "时效性与交叉验证",
  "具体建议",
  "局限性与不确定性",
];
const REQUIRED_TASK_REGISTRY_FIELDS = [
  "task_id",
  "title",
  "task_type",
  "research_dimension",
  "key_question",
  "planned_actions",
  "expected_evidence",
  "depends_on",
  "report_path",
];
const REQUIRED_TASK_REPORT_SECTIONS = [
  "Task ID",
  "Goal",
  "Executed Actions",
  "Key Evidence",
  "Findings",
  "Open Questions",
  "Next Leads",
];

function trimToString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sessionWorkspaceDir(api) {
  return trimToString(api?.config?.agents?.defaults?.workspace) || process.cwd();
}

function pluginConfig(api) {
  return api?.pluginConfig && typeof api.pluginConfig === "object" ? api.pluginConfig : {};
}

function scriptsDir(api) {
  const cfg = pluginConfig(api);
  return (
    trimToString(cfg.scriptsDir) ||
    process.env.DEEP_RESEARCH_SCRIPTS ||
    path.resolve(__dirname, "..", "scripts")
  );
}

function repoRoot() {
  return path.resolve(__dirname, "..");
}

function isStrictMode(api) {
  const cfg = pluginConfig(api);
  if (typeof cfg.strict === "boolean") {
    return cfg.strict;
  }
  return (process.env.DEEP_RESEARCH_STRICT || "1") !== "0";
}

function readMeta(rdir) {
  const mp = path.join(rdir, "00_meta.json");
  if (!fs.existsSync(mp)) return null;
  try {
    return JSON.parse(fs.readFileSync(mp, "utf-8"));
  } catch (_) {
    return null;
  }
}

/**
 * Run check_deep_research_archive.py and return parsed JSON result.
 * Returns null on execution error so gating can degrade to heuristic checks.
 */
function runChecker(api, rdir, opts = {}) {
  const checker = path.join(scriptsDir(api), "check_deep_research_archive.py");
  if (!fs.existsSync(checker)) return null;

  const args = ["--research-dir", rdir];
  if (opts.strict !== false && isStrictMode(api)) args.push("--strict");
  if (opts.round != null) args.push("--round", String(opts.round));

  try {
    execFileSync("python3", [checker, ...args], {
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { result: "PASS", errors: [] };
  } catch (err) {
    const stdout = err.stdout ? err.stdout.toString() : "";
    try {
      return JSON.parse(stdout);
    } catch (_) {
      return { result: "FAIL", errors: [{ code: "ERR_CHECKER_CRASH", detail: stdout.slice(0, 400) }] };
    }
  }
}

/** Append a line to the audit log inside the research dir. */
function auditLog(rdir, entry) {
  if (!rdir) return;
  const logPath = path.join(rdir, "audit.log");
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  try {
    fs.appendFileSync(logPath, line);
  } catch (_) {}
}

function fileLooksPlaceholder(filePath) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  try {
    const text = fs.readFileSync(filePath, "utf-8");
    return PLACEHOLDER_PATTERNS.some((pattern) => text.includes(pattern));
  } catch (_) {
    return false;
  }
}

function isPlaceholderFinalReport(filePath) {
  if (!fs.existsSync(filePath)) {
    return true;
  }
  try {
    const text = fs.readFileSync(filePath, "utf-8").trim();
    return text === FINAL_REPORT_TEMPLATE.trim() || text.includes("replace-with");
  } catch (_) {
    return true;
  }
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (_) {
    return null;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

function makeStage(stage, summary, blockedReason, nextActions, extra = {}) {
  return {
    stage,
    summary,
    blockedReason,
    nextActions,
    ...extra,
  };
}

function existingMissingPaths(paths) {
  return paths.filter((filePath) => !fs.existsSync(filePath));
}

function anyPlaceholder(paths) {
  return paths.some((filePath) => fileLooksPlaceholder(filePath));
}

function listTaskReportPaths(rdir, registryPath) {
  const registry = safeReadJson(registryPath);
  const tasks = Array.isArray(registry?.tasks) ? registry.tasks : [];
  return tasks
    .map((task) => ({
      taskId: trimToString(task?.task_id) || "?",
      relPath: trimToString(task?.report_path),
    }))
    .filter((entry) => entry.relPath)
    .map((entry) => ({
      taskId: entry.taskId,
      relPath: entry.relPath,
      absPath: path.join(rdir, entry.relPath),
    }));
}

function parseMarkdownSections(text) {
  const sections = new Map();
  let current = null;
  for (const line of String(text || "").split("\n")) {
    const match = line.trim().match(/^##\s+(.+?)\s*$/);
    if (match) {
      current = match[1].trim();
      if (!sections.has(current)) {
        sections.set(current, []);
      }
      continue;
    }
    if (current) {
      sections.get(current).push(line);
    }
  }
  return sections;
}

function meaningfulSectionLines(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim())
    .filter((line) => line && line !== "-" && line !== "*" && !line.toLowerCase().includes("replace-with"));
}

function validateTaskReportContent(filePath, taskId) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: `task ${taskId} report file is missing` };
  }
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    return { ok: false, reason: `task ${taskId} report unreadable: ${trimToString(err?.message) || "unknown error"}` };
  }

  const sections = parseMarkdownSections(text);
  for (const section of REQUIRED_TASK_REPORT_SECTIONS) {
    if (!sections.has(section)) {
      return { ok: false, reason: `task ${taskId} report missing section: ${section}` };
    }
  }

  const taskIdLines = meaningfulSectionLines(sections.get("Task ID").join("\n"));
  if (taskIdLines.length === 0 || taskIdLines[0] !== taskId) {
    return { ok: false, reason: `task ${taskId} report Task ID section does not match registry task_id` };
  }

  for (const section of ["Goal", "Key Evidence", "Findings", "Open Questions", "Next Leads"]) {
    if (meaningfulSectionLines(sections.get(section).join("\n")).length === 0) {
      return { ok: false, reason: `task ${taskId} report section is empty or placeholder-only: ${section}` };
    }
  }

  const executedActions = meaningfulSectionLines(sections.get("Executed Actions").join("\n"));
  if (executedActions.length < 2) {
    return { ok: false, reason: `task ${taskId} report Executed Actions must contain at least 2 real actions` };
  }

  return { ok: true };
}

function collectAllTaskIds(rdir) {
  const taskIds = [];
  for (const entry of fs.readdirSync(rdir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^round_\d+$/.test(entry.name)) {
      continue;
    }
    const registry = safeReadJson(path.join(rdir, entry.name, "02_task_registry.json"));
    const tasks = Array.isArray(registry?.tasks) ? registry.tasks : [];
    for (const task of tasks) {
      const taskId = trimToString(task?.task_id);
      if (taskId) {
        taskIds.push(taskId);
      }
    }
  }
  return taskIds;
}

function validateFinalReportContent(filePath, rdir, meta) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: "final_report.md is missing" };
  }
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    return { ok: false, reason: `final_report.md unreadable: ${trimToString(err?.message) || "unknown error"}` };
  }
  if (isPlaceholderFinalReport(filePath)) {
    return { ok: false, reason: "final_report.md is still placeholder-filled" };
  }

  const sections = parseMarkdownSections(text);
  for (const section of REQUIRED_FINAL_REPORT_SECTIONS) {
    if (!sections.has(section)) {
      return { ok: false, reason: `final_report.md missing section: ${section}` };
    }
  }

  for (const section of REQUIRED_FINAL_REPORT_SECTIONS) {
    if (meaningfulSectionLines(sections.get(section).join("\n")).length === 0) {
      return { ok: false, reason: `final_report.md section is empty or placeholder-only: ${section}` };
    }
  }

  const sourceRefs = new Set(
    (sections.get("关键发现与证据来源").join("\n").match(/R\d{2}-T\d{2}/g) || []).map((ref) => ref.trim()),
  );
  const allTaskIds = collectAllTaskIds(rdir);
  const minRequired = allTaskIds.length === 0
    ? 1
    : allTaskIds.length === 1
      ? 1
      : Math.min(allTaskIds.length, (Number(meta?.current_round) || 0) + 1);
  if (sourceRefs.size < minRequired) {
    return {
      ok: false,
      reason: `final_report.md cites only ${sourceRefs.size} task sources, need >= ${minRequired} across the completed research`,
    };
  }

  const timelinessLines = meaningfulSectionLines(sections.get("时效性与交叉验证").join("\n"));
  if (timelinessLines.length < 3) {
    return {
      ok: false,
      reason: "final_report.md 时效性与交叉验证 section must include concrete dates and validation notes",
    };
  }
  if (!/\b20\d{2}-\d{2}-\d{2}\b/.test(sections.get("时效性与交叉验证").join("\n"))) {
    return {
      ok: false,
      reason: "final_report.md 时效性与交叉验证 section must include at least one absolute date like YYYY-MM-DD",
    };
  }

  return { ok: true };
}

function validateRegistrySchema(registry) {
  const tasks = Array.isArray(registry?.tasks) ? registry.tasks : [];
  if (tasks.length === 0) {
    return { ok: true };
  }
  for (const task of tasks) {
    const taskId = trimToString(task?.task_id) || "?";
    for (const field of REQUIRED_TASK_REGISTRY_FIELDS) {
      if (!(field in task)) {
        return {
          ok: false,
          reason: `task ${taskId} missing required field: ${field}`,
        };
      }
    }
    if (!trimToString(task?.title)) {
      return { ok: false, reason: `task ${taskId} missing required field: title` };
    }
    if (!trimToString(task?.task_type)) {
      return { ok: false, reason: `task ${taskId} missing required field: task_type` };
    }
    if (!trimToString(task?.research_dimension)) {
      return { ok: false, reason: `task ${taskId} missing required field: research_dimension` };
    }
    if (!trimToString(task?.key_question)) {
      return { ok: false, reason: `task ${taskId} missing required field: key_question` };
    }
    if (!trimToString(task?.report_path)) {
      return { ok: false, reason: `task ${taskId} missing required field: report_path` };
    }
    if (!Array.isArray(task?.planned_actions) || task.planned_actions.length < 3) {
      return { ok: false, reason: `task ${taskId} planned_actions must contain at least 3 actions` };
    }
    if (!Array.isArray(task?.expected_evidence) || task.expected_evidence.length === 0) {
      return { ok: false, reason: `task ${taskId} expected_evidence must be a non-empty list` };
    }
    if (!Array.isArray(task?.depends_on)) {
      return { ok: false, reason: `task ${taskId} depends_on must be a list` };
    }
  }
  return { ok: true };
}

function resolveRoundPaths(rdir, roundNumber) {
  const pad = String(roundNumber).padStart(2, "0");
  const roundDir = path.join(rdir, `round_${pad}`);
  return {
    pad,
    roundDir,
    seedPath: path.join(roundDir, "01_seed_clues.json"),
    registryPath: path.join(roundDir, "02_task_registry.json"),
    summaryPath: path.join(roundDir, "03_round_summary.md"),
    deltaPath: path.join(roundDir, "04_delta_report.json"),
  };
}

function detectArchiveStage(api, rdir, meta) {
  const currentRound = Number.isInteger(meta?.current_round) ? meta.current_round : 0;
  if (currentRound <= 0) {
    return makeStage(
      "bootstrap",
      "No round has started yet. Initialize round_01 before exploration.",
      "Research archive is not yet planned.",
      [
        "write 00_research_brief.md if missing",
        "start round_01 by creating 01_seed_clues.json and 02_task_registry.json",
      ],
    );
  }

  const paths = resolveRoundPaths(rdir, currentRound);
  const planningPaths = [paths.seedPath, paths.registryPath];
  const missing = existingMissingPaths(planningPaths).map((filePath) => path.relative(rdir, filePath));
  if (missing.length > 0) {
    return makeStage(
      "plan",
      `Round ${currentRound} planning is incomplete.`,
      `Round ${currentRound} prerequisites missing: ${missing.join(", ")}`,
      [
        "finish 01_seed_clues.json",
        "finish 02_task_registry.json",
      ],
      { round: currentRound, missing },
    );
  }

  if (anyPlaceholder(planningPaths)) {
    return makeStage(
      "plan",
      `Round ${currentRound} planning still contains template placeholders.`,
      `Round ${currentRound} planning files still contain template placeholders.`,
      [
        "replace placeholder seed clues",
        "replace placeholder task registry fields",
      ],
      { round: currentRound },
    );
  }

  const registrySchema = validateRegistrySchema(safeReadJson(paths.registryPath));
  if (!registrySchema.ok) {
    return makeStage(
      "plan",
      `Round ${currentRound} task registry schema is invalid.`,
      `Round ${currentRound} task registry schema invalid: ${registrySchema.reason}`,
      [
        "rewrite 02_task_registry.json using the current template schema",
        "ensure every task has key_question, report_path, and planned_actions",
      ],
      { round: currentRound },
    );
  }

  const taskReports = listTaskReportPaths(rdir, paths.registryPath);
  const missingReports = taskReports
    .filter((entry) => !fs.existsSync(entry.absPath))
    .map((entry) => entry.relPath);
  const placeholderReports = taskReports
    .filter((entry) => fileLooksPlaceholder(entry.absPath))
    .map((entry) => entry.relPath);
  const invalidReports = taskReports
    .map((entry) => ({
      ...entry,
      validation: validateTaskReportContent(entry.absPath, entry.taskId),
    }))
    .filter((entry) => !entry.validation.ok)
    .map((entry) => ({
      relPath: entry.relPath,
      reason: entry.validation.reason,
    }));

  if (
    taskReports.length === 0 ||
    missingReports.length > 0 ||
    placeholderReports.length > 0 ||
    invalidReports.length > 0
  ) {
    const blockedReason =
      missingReports.length > 0
        ? `Round ${currentRound} still has missing task reports: ${missingReports.join(", ")}`
        : placeholderReports.length > 0
          ? `Round ${currentRound} still has placeholder task reports: ${placeholderReports.join(", ")}`
          : invalidReports.length > 0
            ? `Round ${currentRound} still has invalid task reports: ${invalidReports.map((entry) => `${entry.relPath} (${entry.reason})`).join(", ")}`
          : `Round ${currentRound} has no registered task reports yet.`;
    return makeStage(
      "execute",
      `Round ${currentRound} execution is still in progress.`,
      blockedReason,
      [
        "write missing task reports",
        "replace placeholder task reports with real evidence",
        "rewrite invalid task reports to match the task report template",
        "continue exploration tied to registered tasks only",
      ],
      { round: currentRound, missingReports, placeholderReports, invalidReports },
    );
  }

  const summaryPaths = [paths.summaryPath, paths.deltaPath];
  const missingSummaryFiles = existingMissingPaths(summaryPaths).map((filePath) =>
    path.relative(rdir, filePath),
  );
  if (missingSummaryFiles.length > 0) {
    return makeStage(
      "summarize",
      `Round ${currentRound} task execution is complete but summary artifacts are missing.`,
      `Round ${currentRound} summary artifacts missing: ${missingSummaryFiles.join(", ")}`,
      [
        "write round summary",
        "write delta report",
        "run checker after both files exist",
      ],
      { round: currentRound, missing: missingSummaryFiles },
    );
  }

  if (anyPlaceholder(summaryPaths)) {
    return makeStage(
      "summarize",
      `Round ${currentRound} summary artifacts still contain template placeholders.`,
      `Round ${currentRound} summary artifacts still contain template placeholders.`,
      [
        "replace placeholder findings, contradictions, and coverage text",
        "run checker once the round summary is real",
      ],
      { round: currentRound },
    );
  }

  const checker = runChecker(api, rdir, { round: currentRound });
  if (checker && checker.result === "FAIL") {
    return makeStage(
      "repair",
      `Round ${currentRound} failed validation and must be repaired before moving on.`,
      `Round ${currentRound} validation failed: ${(checker.errors || []).map((e) => e.code).join(", ")}`,
      [
        "fix only the files named by the checker",
        "rerun checker",
        "do not start the next round yet",
      ],
      { round: currentRound, errors: checker.errors || [] },
    );
  }

  const targetDepth = Number(meta?.target_depth) || 0;
  if (meta?.depth_mode === "user-specified" && currentRound < targetDepth) {
    return makeStage(
      "advance",
      `Round ${currentRound} is valid. Another round is still required.`,
      `Current round is valid but research is not complete: ${currentRound}/${targetDepth} rounds done.`,
      [
        `start round_${String(currentRound + 1).padStart(2, "0")} by writing new seed clues`,
        "derive the next round from carry-forward clues",
      ],
      { round: currentRound },
    );
  }

  const finalReportPath = path.join(rdir, "final_report.md");
  const finalReportReady = fs.existsSync(finalReportPath) && !isPlaceholderFinalReport(finalReportPath);
  const finalReportValidation = finalReportReady
    ? validateFinalReportContent(finalReportPath, rdir, meta)
    : { ok: false, reason: "final_report.md is still missing or placeholder-filled" };
  const metaStatus = trimToString(meta?.status);
  if (!finalReportReady || !finalReportValidation.ok || metaStatus !== "completed") {
    const blockedReason = !finalReportReady
      ? "All rounds are complete, but final_report.md is still missing or placeholder-filled."
      : !finalReportValidation.ok
        ? `final_report.md is not yet sufficient: ${finalReportValidation.reason}`
        : "final_report.md exists, but 00_meta.json is not yet marked completed.";
    return makeStage(
      "synthesize",
      "All research rounds are complete. Produce the final synthesis only now.",
      blockedReason,
      [
        "read all round summaries, delta reports, and task reports before synthesizing",
        "verify dates explicitly and cross-check time-sensitive claims with multiple sources",
        "synthesize findings across all rounds and tasks",
        "write or refine final_report.md using only completed research evidence",
        "mark 00_meta.json as completed only after the final report is real",
      ],
      { round: currentRound },
    );
  }

  return makeStage(
    "finalize",
    "Research archive is fully complete and ready for user-facing delivery.",
    null,
    [
      "answer the user from final_report.md",
      "reference round and task sources in the final answer",
    ],
    { round: currentRound },
  );
}

function isArchiveTool(api, toolName, params) {
  if (ARCHIVE_WRITE_TOOLS.has(toolName)) {
    const target = params?.path || params?.file_path || params?.filename || params?.target || "";
    return ARCHIVE_FILE_PATTERNS.some(re => re.test(target));
  }
  return false;
}

function extractStructuredWriteText(toolName, params) {
  if (!params || typeof params !== "object") {
    return "";
  }
  const directKeys = ["content", "text", "data", "new_content", "newText"];
  for (const key of directKeys) {
    const value = trimToString(params[key]);
    if (value) {
      return value;
    }
  }
  if (toolName === "apply_patch") {
    return trimToString(params?.patch);
  }
  const replacementKeys = ["replacement", "new_str", "replace", "insert"];
  for (const key of replacementKeys) {
    const value = trimToString(params[key]);
    if (value) {
      return value;
    }
  }
  return "";
}

function tryParseJsonText(text) {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function collectStringLeaves(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringLeaves(item, out);
    }
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectStringLeaves(item, out);
    }
  }
  return out;
}

function sessionSignalLine(payload) {
  return `${SESSION_SIGNAL_PREFIX}${JSON.stringify(payload)}`;
}

function sessionToolParametersSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["start", "activate", "advance-round", "finalize", "status", "clear"],
        description: "Session action to perform.",
      },
      topic: {
        type: "string",
        description: "Short topic slug for a new research run. Required for action=start.",
      },
      question: {
        type: "string",
        description: "Original user question. Required for action=start.",
      },
      target_depth: {
        type: "integer",
        minimum: 1,
        description: "Required research depth/round count. Required for action=start.",
      },
      depth_mode: {
        type: "string",
        enum: ["auto", "user-specified"],
        description: "Depth resolution mode for action=start. Defaults to auto.",
      },
      research_dir_name: {
        type: "string",
        description: "Optional archive directory name override for action=start.",
      },
      research_dir: {
        type: "string",
        description: "Absolute research directory path. Required for action=activate. Optional for action=advance-round/finalize when an active session already exists.",
      },
      no_check: {
        type: "boolean",
        description: "Skip validator after init for action=start.",
      },
      strict: {
        type: "boolean",
        description: "Run the validator in strict mode for action=advance-round or action=finalize.",
      },
    },
    required: ["action"],
  };
}

function sessionToolArgs(rawParams, api) {
  const action = trimToString(rawParams?.action);
  const workspaceDir = sessionWorkspaceDir(api);
  if (!action) {
    throw new Error("deep_research_session requires action");
  }

  const args = [action, "--workspace-dir", workspaceDir];
  if (action === "start") {
    const topic = trimToString(rawParams?.topic);
    const question = trimToString(rawParams?.question);
    const targetDepth = Number(rawParams?.target_depth);
    const depthMode = trimToString(rawParams?.depth_mode) || "auto";
    const researchDirName = trimToString(rawParams?.research_dir_name);
    if (!topic) {
      throw new Error("deep_research_session(start) requires topic");
    }
    if (!question) {
      throw new Error("deep_research_session(start) requires question");
    }
    if (!Number.isInteger(targetDepth) || targetDepth <= 0) {
      throw new Error("deep_research_session(start) requires target_depth > 0");
    }
    args.push(
      "--topic",
      topic,
      "--question",
      question,
      "--target-depth",
      String(targetDepth),
      "--depth-mode",
      depthMode,
      "--output-root",
      workspaceDir,
    );
    if (researchDirName) {
      args.push("--research-dir-name", researchDirName);
    }
    if (rawParams?.no_check === true) {
      args.push("--no-check");
    }
    return args;
  }

  if (action === "activate") {
    const researchDir = trimToString(rawParams?.research_dir);
    if (!researchDir) {
      throw new Error("deep_research_session(activate) requires research_dir");
    }
    args.push("--research-dir", researchDir);
    return args;
  }

  if (action === "advance-round" || action === "finalize") {
    const researchDir = trimToString(rawParams?.research_dir);
    if (researchDir) {
      args.push("--research-dir", researchDir);
    }
    const strict = typeof rawParams?.strict === "boolean" ? rawParams.strict : isStrictMode(api);
    if (strict) {
      args.push("--strict");
    }
    return args;
  }

  if (action === "status" || action === "clear") {
    return args;
  }

  throw new Error(`Unsupported deep_research_session action: ${action}`);
}

function formatExecError(err) {
  const stderr = err?.stderr ? err.stderr.toString().trim() : "";
  const stdout = err?.stdout ? err.stdout.toString().trim() : "";
  const detail = stderr || stdout || trimToString(err?.message) || "unknown error";
  return detail;
}

function runDeepResearchSession(api, rawParams) {
  const script = path.join(scriptsDir(api), "openclaw_deep_research_session.py");
  if (!fs.existsSync(script)) {
    throw new Error(`session script not found: ${script}`);
  }

  const args = sessionToolArgs(rawParams, api);
  let stdout;
  try {
    stdout = execFileSync("python3", [script, ...args], {
      cwd: sessionWorkspaceDir(api),
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  } catch (err) {
    throw new Error(formatExecError(err));
  }

  const payload = parseSessionSignal(stdout);
  if (!payload) {
    throw new Error("session script did not emit DEEP_RESEARCH_SESSION payload");
  }
  const researchDir = trimToString(payload.research_dir);
  let archive = null;
  if (researchDir) {
    const meta = readMeta(researchDir);
    if (meta) {
      const stageInfo = detectArchiveStage(api, researchDir, meta);
      archive = {
        research_dir: researchDir,
        current_round: meta.current_round,
        target_depth: meta.target_depth,
        status: meta.status,
        stage: stageInfo.stage,
        summary: stageInfo.summary,
        blocked_reason: stageInfo.blockedReason,
        next_actions: stageInfo.nextActions,
      };
    }
  }
  return {
    ok: true,
    action: payload.action,
    session: payload,
    archive,
    signal: sessionSignalLine(payload),
  };
}

function createDeepResearchSessionTool(api) {
  return {
    name: DEEP_RESEARCH_SESSION_TOOL,
    label: "Deep Research Session",
    description:
      "Start, activate, advance, finalize, inspect, or clear the active OpenClaw deep-research session. Use this instead of manually editing 00_meta.json or stitching together round transitions.",
    parameters: sessionToolParametersSchema(),
    execute: async (_toolCallId, rawParams) => runDeepResearchSession(api, rawParams),
  };
}

function sessionCacheKey(ctx) {
  return trimToString(ctx?.sessionKey) || trimToString(ctx?.sessionId) || trimToString(ctx?.agentId) || null;
}

function sessionRole(ctx) {
  const sessionKey = trimToString(ctx?.sessionKey).toLowerCase();
  if (sessionKey.includes(SUBAGENT_SESSION_SEGMENT)) {
    return "worker";
  }
  return "orchestrator";
}

function workspaceDirFromCtx(ctx) {
  return trimToString(ctx?.workspaceDir) || "";
}

function activeSessionFile(ctx) {
  const workspaceDir = workspaceDirFromCtx(ctx);
  if (!workspaceDir) return null;
  return path.join(workspaceDir, ".deep-research", "active.json");
}

function normalizeWorkerSessionKeys(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => trimToString(entry)).filter(Boolean))];
}

function makeCachedSession(session) {
  const previous =
    session?.previous && typeof session.previous === "object" ? session.previous : null;
  if (!session?.researchDir) {
    return null;
  }
  const next = session && typeof session === "object" ? { ...session } : {};
  delete next.previous;
  return {
    ...(previous || {}),
    ...next,
    marker: session.marker || null,
    researchDir: session.researchDir,
  };
}

function getCachedSessionState(key) {
  const cached = ACTIVE_SESSIONS.get(key);
  if (!cached || typeof cached !== "object") {
    return null;
  }
  const researchDir = trimToString(cached.researchDir);
  if (!researchDir) {
    return null;
  }
  return {
    ...cached,
    marker: trimToString(cached.marker) || null,
    researchDir,
  };
}

function getCachedSession(key) {
  const cached = getCachedSessionState(key);
  if (!cached) {
    return null;
  }
  return {
    marker: cached.marker,
    researchDir: cached.researchDir,
  };
}

function cacheSession(key, session) {
  const previous = getCachedSessionState(key);
  const cached = makeCachedSession({ ...session, previous });
  if (!key || !cached) {
    return;
  }
  ACTIVE_SESSIONS.set(key, cached);
}

function updateCachedSession(key, mutate) {
  if (!key || typeof mutate !== "function") {
    return null;
  }
  const current = getCachedSessionState(key);
  if (!current) {
    return null;
  }
  const next = mutate(current);
  if (!next || typeof next !== "object") {
    return null;
  }
  const cached = makeCachedSession({
    ...next,
    previous: current,
    marker: trimToString(next.marker) || current.marker,
    researchDir: trimToString(next.researchDir) || current.researchDir,
  });
  if (!cached) {
    return null;
  }
  ACTIVE_SESSIONS.set(key, cached);
  return cached;
}

function updateActiveSessionMarker(marker, mutate) {
  if (!marker || typeof mutate !== "function") {
    return null;
  }
  const payload = safeReadJson(marker);
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const nextPayload = mutate(payload);
  if (!nextPayload || typeof nextPayload !== "object") {
    return null;
  }
  const researchDir = trimToString(nextPayload.research_dir);
  if (!researchDir) {
    return null;
  }
  writeJson(marker, nextPayload);
  return {
    marker,
    payload: nextPayload,
    researchDir,
  };
}

function sessionOwnsResearch(payload, ctx) {
  const ownerSessionId = trimToString(payload?.owner_session_id);
  const currentSessionId = trimToString(ctx?.sessionId);
  if (!ownerSessionId || !currentSessionId) {
    return false;
  }
  return ownerSessionId === currentSessionId;
}

function workerCanAccessResearch(payload, ctx) {
  const sessionKey = trimToString(ctx?.sessionKey);
  if (!sessionKey) {
    return false;
  }
  const workerKeys = normalizeWorkerSessionKeys(payload?.worker_session_keys);
  return workerKeys.includes(sessionKey);
}

function sessionMatchesActiveResearch(payload, ctx) {
  if (sessionRole(ctx) === "worker") {
    return workerCanAccessResearch(payload, ctx);
  }
  return sessionOwnsResearch(payload, ctx);
}

function rebindOwnedActiveSession(ctx, signal) {
  const workspaceDir = trimToString(signal?.workspace_dir) || workspaceDirFromCtx(ctx);
  const researchDir = trimToString(signal?.research_dir);
  if (!workspaceDir || !researchDir) {
    return null;
  }

  const marker = path.join(workspaceDir, ".deep-research", "active.json");
  const rebound = updateActiveSessionMarker(marker, (payload) => ({
    ...payload,
    version: Math.max(Number(payload?.version) || 1, 2),
    workspace_dir: trimToString(payload?.workspace_dir) || workspaceDir,
    research_dir: researchDir,
    owner_session_id: trimToString(ctx?.sessionId),
    owner_session_key: trimToString(ctx?.sessionKey) || undefined,
    worker_session_keys: [],
    activated_at: trimToString(signal?.activated_at) || trimToString(payload?.activated_at) || new Date().toISOString(),
  }));

  if (!rebound) {
    return null;
  }
  cacheSession(sessionCacheKey(ctx), rebound);
  return rebound;
}

function linkWorkerSession(requesterSessionKey, childSessionKey) {
  const requesterKey = trimToString(requesterSessionKey);
  const childKey = trimToString(childSessionKey);
  if (!requesterKey || !childKey) {
    return null;
  }

  const requesterSession = getCachedSession(requesterKey);
  const marker = requesterSession?.marker;
  if (!marker) {
    return null;
  }

  const linked = updateActiveSessionMarker(marker, (payload) => {
    const ownerSessionKey = trimToString(payload?.owner_session_key);
    const workerKeys = new Set(normalizeWorkerSessionKeys(payload?.worker_session_keys));
    if (requesterKey !== ownerSessionKey && !workerKeys.has(requesterKey)) {
      return null;
    }
    workerKeys.add(childKey);
    return {
      ...payload,
      version: Math.max(Number(payload?.version) || 1, 2),
      worker_session_keys: [...workerKeys],
    };
  });

  if (!linked) {
    return null;
  }
  cacheSession(childKey, linked);
  return linked;
}

function unlinkWorkerSession(targetSessionKey) {
  const targetKey = trimToString(targetSessionKey);
  if (!targetKey) {
    return null;
  }

  const targetSession = getCachedSession(targetKey);
  const marker = targetSession?.marker;
  ACTIVE_SESSIONS.delete(targetKey);
  if (!marker) {
    return null;
  }

  return updateActiveSessionMarker(marker, (payload) => ({
    ...payload,
    version: Math.max(Number(payload?.version) || 1, 2),
    worker_session_keys: normalizeWorkerSessionKeys(payload?.worker_session_keys).filter((key) => key !== targetKey),
  }));
}

function readActiveSession(ctx) {
  const marker = activeSessionFile(ctx);
  if (!marker || !fs.existsSync(marker)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(marker, "utf-8"));
    if (!payload || typeof payload !== "object") return null;
    const rdir = trimToString(payload.research_dir);
    if (!rdir) return null;
    return {
      marker,
      payload,
      researchDir: rdir,
    };
  } catch (_) {
    return null;
  }
}

function activeResearchDir(ctx) {
  const key = sessionCacheKey(ctx);
  const session = readActiveSession(ctx);
  if (session) {
    if (sessionMatchesActiveResearch(session.payload, ctx)) {
      cacheSession(key, session);
      return session.researchDir;
    }
    if (key) ACTIVE_SESSIONS.delete(key);
    return null;
  }
  if (workspaceDirFromCtx(ctx)) {
    if (key) ACTIVE_SESSIONS.delete(key);
    return null;
  }
  if (key) {
    return getCachedSession(key)?.researchDir || null;
  }
  return null;
}

function bindActiveResearch(ctx, researchDir, marker = null) {
  const key = sessionCacheKey(ctx);
  if (!key) return;
  if (researchDir) {
    cacheSession(key, { researchDir, marker });
    return;
  }
  ACTIVE_SESSIONS.delete(key);
}

function parseSessionSignal(value) {
  const lines = collectStringLeaves(value)
    .flatMap((text) => String(text).split("\n"))
    .map((line) => line.trim())
    .filter(Boolean);

  const raw = lines.find((line) => line.startsWith(SESSION_SIGNAL_PREFIX));
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw.slice(SESSION_SIGNAL_PREFIX.length));
    if (!payload || typeof payload !== "object") return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function resolveWriteTarget(target, workspaceDir = "") {
  const raw = trimToString(target).replace(/\\/g, "/");
  if (!raw) {
    return "";
  }
  if (path.isAbsolute(raw)) {
    return path.resolve(raw).replace(/\\/g, "/");
  }
  if (!workspaceDir) {
    return raw;
  }
  return path.resolve(workspaceDir, raw).replace(/\\/g, "/");
}

function parseArchiveTarget(target, workspaceDir = "") {
  const resolved = resolveWriteTarget(target, workspaceDir);
  if (!resolved) {
    return null;
  }
  const match = resolved.match(RESEARCH_DIR_NAME_PATTERN);
  if (!match) {
    return null;
  }
  const relPath = trimToString(match[3]);
  if (!relPath) {
    return null;
  }
  if (!ARCHIVE_FILE_PATTERNS.some((pattern) => pattern.test(relPath))) {
    return null;
  }
  return {
    absPath: resolved,
    researchDir: resolved.slice(0, resolved.length - relPath.length - 1),
    relPath,
  };
}

function validateInactiveArchiveBootstrap(toolName, params, workspaceDir = "") {
  const targets = extractWriteTargets(toolName, params);
  for (const target of targets) {
    const archiveTarget = parseArchiveTarget(target, workspaceDir);
    if (!archiveTarget) {
      continue;
    }
    return {
      ok: false,
      reason:
        `[deep-research-guard] Cannot write ${archiveTarget.relPath} under ${archiveTarget.researchDir} ` +
        `without an active deep-research session. Call ${DEEP_RESEARCH_SESSION_TOOL} with action=start or action=activate first.`,
    };
  }
  return { ok: true };
}

function isMaintenanceTool(params) {
  const leaves = collectStringLeaves(params).map((text) => text.toLowerCase());
  return MAINTENANCE_SCRIPT_HINTS.some((hint) =>
    leaves.some((text) => text.includes(hint.toLowerCase())),
  );
}

function isExploratoryTool(toolName, params) {
  const normalized = trimToString(toolName).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (isMaintenanceTool(params)) {
    return false;
  }
  return EXPLORATORY_TOOL_HINTS.some((hint) => normalized.includes(hint));
}

function buildStagePrompt(stageInfo, meta) {
  const lines = [
    "Deep-research guard is active.",
    "Schema authority lives in templates/ and scripts/, not memory or prior runs.",
    `Use ${DEEP_RESEARCH_SESSION_TOOL} for lifecycle transitions instead of manually editing 00_meta.json.`,
    `Current stage: ${stageInfo.stage}.`,
    stageInfo.summary,
  ];
  if (meta && Number.isInteger(meta.current_round)) {
    lines.push(
      `Meta status: current_round=${meta.current_round}, target_depth=${meta.target_depth}, status=${meta.status}.`,
    );
  }
  if (Array.isArray(stageInfo.nextActions) && stageInfo.nextActions.length > 0) {
    lines.push("Next actions:");
    for (const action of stageInfo.nextActions) {
      lines.push(`- ${action}`);
    }
  }
  if (stageInfo.stage !== "finalize") {
    lines.push(
      "Do not declare the research complete unless the archive state reaches finalize.",
    );
  }
  if (stageInfo.stage === "plan" || stageInfo.stage === "advance") {
    lines.push(
      "Dynamic task planning: design this round's tasks based on what was actually discovered so far, not on a pre-fixed plan. " +
      "Each round should adapt its exploration directions to the latest findings and gaps.",
    );
  }
  if (stageInfo.stage === "execute") {
    lines.push(
      "For time-sensitive facts, prefer fresher evidence, record absolute dates, and distinguish event dates from publish dates.",
    );
    lines.push(
      "Cross-check important claims with multiple sources before treating them as settled evidence.",
    );
    lines.push(
      "Fault tolerance: if a sub-task fails after retries (max 3), write a partial task report noting the failure reason, " +
      "then continue with remaining tasks. Missing info from failed tasks can be supplemented in a later round.",
    );
  }
  if (stageInfo.stage === "synthesize") {
    lines.push(
      "Final synthesis must integrate evidence across all completed rounds, not just the latest round.",
    );
    lines.push(
      "For time-sensitive claims, verify dates explicitly, prefer newer evidence, and cross-check key facts with multiple sources before writing final_report.md.",
    );
    lines.push(
      "The final report must cite round/task sources broadly enough to reflect the full deep-research archive.",
    );
  }
  return lines.join("\n");
}

function buildWorkerPrompt(stageInfo, meta) {
  const lines = [
    "Deep-research task-worker guard is active.",
    "You are a subagent helping an active deep-research session.",
    "Schema authority lives in templates/ and scripts/, not memory or prior runs.",
    `Coordinator stage: ${stageInfo.stage}.`,
    stageInfo.summary,
    "Your job is to complete only the assigned task and hand control back to the requester.",
    "Allowed archive writes: only registered round task reports under round_N/tasks/.",
    "Forbidden archive writes: 00_meta.json, seed clues, task registry, round summary, delta report, final_report.md.",
    "Do not advance rounds, rewrite the task registry, or declare the full research complete.",
    `Lifecycle transitions belong to the requester via ${DEEP_RESEARCH_SESSION_TOOL}.`,
  ];
  if (meta && Number.isInteger(meta.current_round)) {
    lines.push(
      `Coordinator status: current_round=${meta.current_round}, target_depth=${meta.target_depth}, status=${meta.status}.`,
    );
  }
  if (stageInfo.stage === "execute") {
    lines.push(
      "If the task is time-sensitive, record exact dates and cross-check key facts instead of trusting the first source.",
    );
    lines.push(
      "If you encounter rate-limiting or transient errors, wait briefly and retry up to 3 times before giving up.",
    );
  }
  return lines.join("\n");
}

function normalizeType(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isAssistantMessage(message) {
  return trimToString(message?.role).toLowerCase() === "assistant";
}

function hasToolCall(message) {
  const directToolName = trimToString(message?.toolName || message?.tool_name);
  if (directToolName) {
    return true;
  }
  const content = message?.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((entry) => TOOL_CALL_BLOCK_TYPES.has(normalizeType(entry?.type)));
}

function isTerminalAssistantMessage(message) {
  if (!isAssistantMessage(message)) {
    return false;
  }
  const stopReason = trimToString(message?.stopReason).toLowerCase();
  if (stopReason === "error" || stopReason === "aborted") {
    return false;
  }
  return !hasToolCall(message);
}

function buildContinuationEvent(stageInfo, meta) {
  const lines = [
    `Deep-research guard blocked an attempted stop because the archive is still at stage ${stageInfo.stage}.`,
  ];
  if (stageInfo.blockedReason) {
    lines.push(stageInfo.blockedReason);
  } else if (stageInfo.summary) {
    lines.push(stageInfo.summary);
  }
  if (meta && Number.isInteger(meta.current_round)) {
    lines.push(`Current round: ${meta.current_round}.`);
  }
  if (Array.isArray(stageInfo.nextActions) && stageInfo.nextActions.length > 0) {
    lines.push(`Continue with: ${stageInfo.nextActions.join("; ")}.`);
  }
  lines.push("Use tools as needed. Do not stop until the archive reaches finalize.");
  return lines.join(" ");
}

function queueContinuationWake(api, ctx, text, contextKey, reason = "wake") {
  const sessionKey = trimToString(ctx?.sessionKey);
  const agentId = trimToString(ctx?.agentId);
  let queued = false;
  try {
    const runtimeSystem = api?.runtime?.system;
    if (runtimeSystem?.enqueueSystemEvent && sessionKey) {
      runtimeSystem.enqueueSystemEvent(text, { sessionKey, contextKey });
      queued = true;
    }
    if (runtimeSystem?.requestHeartbeatNow && (sessionKey || agentId)) {
      runtimeSystem.requestHeartbeatNow({
        reason,
        ...(sessionKey ? { sessionKey } : {}),
        ...(agentId ? { agentId } : {}),
      });
      queued = true;
    }
  } catch (_) {}
  return queued;
}

function clearPendingToolContinuation(ctx) {
  if (sessionRole(ctx) !== "orchestrator") {
    return null;
  }
  const key = sessionCacheKey(ctx);
  return updateCachedSession(key, (current) => ({
    ...current,
    pendingToolContinuation: false,
  }));
}

function markToolActivity(ctx, event) {
  if (sessionRole(ctx) !== "orchestrator") {
    return null;
  }
  const toolName = trimToString(event?.toolName);
  if (!toolName || toolName === "sessions_yield") {
    return null;
  }
  const key = sessionCacheKey(ctx);
  return updateCachedSession(key, (current) => ({
    ...current,
    pendingToolContinuation: true,
    lastToolName: toolName,
    lastToolCallId: trimToString(event?.toolCallId) || null,
    lastToolAt: Date.now(),
  }));
}

function maybeResumeUnfinishedResearch(api, ctx, rdir, meta, stageInfo, message) {
  if (!rdir || !stageInfo || stageInfo.stage === "finalize") {
    return null;
  }
  if (sessionRole(ctx) !== "orchestrator") {
    return null;
  }
  if (!isTerminalAssistantMessage(message)) {
    return null;
  }

  const continuationEvent = buildContinuationEvent(stageInfo, meta);
  const contextKey = [
    "deep-research-stop-guard",
    stageInfo.stage,
    Number.isInteger(meta?.current_round) ? meta.current_round : "na",
  ].join(":");

  queueContinuationWake(api, ctx, continuationEvent, contextKey, "wake");
  updateCachedSession(sessionCacheKey(ctx), (current) => ({
    ...current,
    pendingToolContinuation: false,
    lastContinuationKey: contextKey,
    lastContinuationAt: Date.now(),
  }));

  auditLog(rdir, {
    hook: "before_message_write",
    action: "BLOCK_STOP",
    stage: stageInfo.stage,
    round: meta?.current_round,
    stopReason: trimToString(message?.stopReason) || null,
  });

  return {
    block: true,
    reason: continuationEvent,
  };
}

function buildPostToolContinuationEvent(stageInfo, meta, cached) {
  const toolName = trimToString(cached?.lastToolName) || "a tool";
  const lines = [
    `Deep-research guard detected that the run went idle immediately after ${toolName} completed.`,
    `The archive is still at stage ${stageInfo.stage}, so the research must continue.`,
  ];
  if (stageInfo.blockedReason) {
    lines.push(stageInfo.blockedReason);
  } else if (stageInfo.summary) {
    lines.push(stageInfo.summary);
  }
  if (meta && Number.isInteger(meta.current_round)) {
    lines.push(`Current round: ${meta.current_round}.`);
  }
  if (Array.isArray(stageInfo.nextActions) && stageInfo.nextActions.length > 0) {
    lines.push(`Continue with: ${stageInfo.nextActions.join("; ")}.`);
  }
  lines.push("Use the latest tool results, take the next required step, and do not stop until the archive reaches finalize.");
  return lines.join(" ");
}

function maybeResumeAfterToolIdle(api, ctx, rdir, meta, stageInfo, event) {
  if (!rdir || !stageInfo || stageInfo.stage === "finalize") {
    return null;
  }
  if (sessionRole(ctx) !== "orchestrator") {
    return null;
  }
  // On error/failure, still attempt recovery wake instead of silently giving up.
  // The orchestrator needs to know something failed so it can retry or skip.
  const isErrorEvent = event?.success === false || !!trimToString(event?.error);

  const key = sessionCacheKey(ctx);
  const cached = getCachedSessionState(key);
  if (!isErrorEvent && (!cached?.pendingToolContinuation || !trimToString(cached?.lastToolCallId))) {
    return null;
  }

  const contextKey = [
    "deep-research-post-tool",
    isErrorEvent ? "error" : stageInfo.stage,
    Number.isInteger(meta?.current_round) ? meta.current_round : "na",
    trimToString(cached?.lastToolCallId) || String(Date.now()),
  ].join(":");
  if (cached && trimToString(cached.lastContinuationKey) === contextKey) {
    return null;
  }

  const continuationEvent = isErrorEvent
    ? buildErrorRecoveryContinuationEvent(stageInfo, meta, event)
    : buildPostToolContinuationEvent(stageInfo, meta, cached);
  queueContinuationWake(api, ctx, continuationEvent, contextKey, isErrorEvent ? "deep-research-error-recovery" : "deep-research-post-tool");
  updateCachedSession(key, (current) => ({
    ...current,
    pendingToolContinuation: false,
    lastContinuationKey: contextKey,
    lastContinuationAt: Date.now(),
  }));

  auditLog(rdir, {
    hook: "agent_end",
    action: isErrorEvent ? "ERROR_RECOVERY" : "AUTO_RESUME",
    trigger: isErrorEvent ? "error_event" : "post_tool_idle",
    stage: stageInfo.stage,
    round: meta?.current_round,
    tool: trimToString(cached?.lastToolName) || null,
    toolCallId: trimToString(cached?.lastToolCallId) || null,
    error: isErrorEvent ? trimToString(event?.error) : null,
  });
  return {
    queued: true,
    contextKey,
    reason: continuationEvent,
  };
}

function buildErrorRecoveryContinuationEvent(stageInfo, meta, event) {
  const errorText = trimToString(event?.error) || "unknown error";
  const isRateLimit = looksLikeRateLimit(errorText);
  const lines = [
    `Deep-research guard detected a sub-agent or tool failure: ${errorText}.`,
  ];
  if (isRateLimit) {
    lines.push(
      "This appears to be a rate-limiting error. Wait briefly before retrying the failed task.",
    );
  }
  lines.push(
    `The archive is still at stage ${stageInfo.stage}, so the research must continue.`,
  );
  lines.push(
    "Fault-tolerance policy: if a sub-task failed after retries, mark it as failed in the task report with the error reason, " +
    "then continue with the remaining tasks. Missing information from failed tasks can be recovered in a later round via new tasks.",
  );
  if (meta && Number.isInteger(meta.current_round)) {
    lines.push(`Current round: ${meta.current_round}.`);
  }
  if (Array.isArray(stageInfo.nextActions) && stageInfo.nextActions.length > 0) {
    lines.push(`Continue with: ${stageInfo.nextActions.join("; ")}.`);
  }
  lines.push(
    "Do not stop. Assess which tasks are still pending, retry or skip the failed one, and proceed.",
  );
  return lines.join(" ");
}

function buildSubagentFailureContinuationEvent(stageInfo, meta, event) {
  const errorText = trimToString(event?.error) || trimToString(event?.reason) || "sub-agent ended unexpectedly";
  const taskId = trimToString(event?.taskId) || "";
  const isRateLimit = looksLikeRateLimit(errorText);
  const lines = [
    `Deep-research guard: a sub-agent worker has failed or timed out.`,
  ];
  if (taskId) {
    lines.push(`Failed task: ${taskId}.`);
  }
  lines.push(`Error: ${errorText}.`);
  if (isRateLimit) {
    lines.push(
      "This looks like a rate-limit/throttling error. Consider waiting before retrying.",
    );
  }
  lines.push(
    `The archive is at stage ${stageInfo.stage}. Research must continue.`,
  );
  lines.push(
    "Fault-tolerance: if the task has been retried " + DEFAULT_SUBAGENT_MAX_RETRIES + " times already, " +
    "write a partial task report noting the failure, then continue with remaining tasks. " +
    "The missing information can be recovered in a subsequent round.",
  );
  if (Array.isArray(stageInfo.nextActions) && stageInfo.nextActions.length > 0) {
    lines.push(`Next actions: ${stageInfo.nextActions.join("; ")}.`);
  }
  lines.push("Do not stop until the archive reaches finalize.");
  return lines.join(" ");
}

function extractApplyPatchTargets(patchText) {
  if (typeof patchText !== "string" || !patchText) {
    return [];
  }
  const matches = [];
  const patterns = [
    /^\*\*\* Add File:\s+(.+)$/gm,
    /^\*\*\* Update File:\s+(.+)$/gm,
    /^\*\*\* Delete File:\s+(.+)$/gm,
    /^\*\*\* Move to:\s+(.+)$/gm,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(patchText)) !== null) {
      matches.push(match[1].trim());
    }
  }
  return matches;
}

function extractWriteTargets(toolName, params) {
  if (!ARCHIVE_WRITE_TOOLS.has(toolName)) {
    return [];
  }
  const keys = ["path", "file_path", "filename", "target"];
  const targets = [];
  for (const key of keys) {
    const value = trimToString(params?.[key]);
    if (value) {
      targets.push(value);
    }
  }
  if (toolName === "apply_patch") {
    targets.push(...extractApplyPatchTargets(params?.patch));
  }
  return [...new Set(targets.map((target) => target.replace(/\\/g, "/")))];
}

function allowedTaskReportTargets(rdir, meta) {
  if (!rdir || !Number.isInteger(meta?.current_round) || meta.current_round <= 0) {
    return [];
  }
  const { registryPath } = resolveRoundPaths(rdir, meta.current_round);
  return listTaskReportPaths(rdir, registryPath).map((entry) => entry.relPath.replace(/\\/g, "/"));
}

function validateWorkerArchiveWrite(toolName, params, rdir, meta) {
  const targets = extractWriteTargets(toolName, params);
  if (targets.length === 0) {
    return { ok: true };
  }

  const allowedTargets = new Set(allowedTaskReportTargets(rdir, meta));
  const disallowed = targets.filter((target) => {
    const normalized = target.replace(/\\/g, "/");
    const looksLikeArchiveTarget = ARCHIVE_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
    if (!looksLikeArchiveTarget) {
      return false;
    }
    if (allowedTargets.size === 0) {
      return true;
    }
    for (const allowed of allowedTargets) {
      if (normalized === allowed || normalized.endsWith(`/${allowed}`)) {
        return false;
      }
    }
    return true;
  });

  if (disallowed.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    reason:
      "[deep-research-guard] Subagent task workers may only write registered task reports under the current round tasks/ directory. " +
      `Blocked targets: ${disallowed.join(", ")}`,
  };
}

function extractStatusStrings(text) {
  if (!text) {
    return [];
  }
  const matches = [];
  const pattern = /"status"\s*:\s*"([^"\n]+)"/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    matches.push(match[1].trim());
  }
  return [...new Set(matches.filter(Boolean))];
}

function validateMetaWrite(toolName, params, target, meta) {
  if (!/00_meta\.json$/.test(target)) {
    return { ok: true };
  }

  const text = extractStructuredWriteText(toolName, params);
  const parsed = tryParseJsonText(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const status = trimToString(parsed.status);
    if (status && !LEGAL_META_STATUSES.has(status)) {
      return {
        ok: false,
        reason:
          `[deep-research-guard] 00_meta.json status "${status}" is invalid. ` +
          `Use only: ${[...LEGAL_META_STATUSES].join(", ")}.`,
      };
    }

    const currentRound = Number(parsed.current_round);
    const targetDepth = Number(parsed.target_depth);
    if (
      Number.isFinite(currentRound) &&
      Number.isFinite(targetDepth) &&
      status === "ready_for_final_report" &&
      currentRound < targetDepth
    ) {
      return {
        ok: false,
        reason:
          `[deep-research-guard] 00_meta.json cannot enter ready_for_final_report at ${currentRound}/${targetDepth} rounds.`,
      };
    }
    if (
      Number.isFinite(currentRound) &&
      Number.isFinite(targetDepth) &&
      status === "completed" &&
      currentRound < targetDepth
    ) {
      return {
        ok: false,
        reason:
          `[deep-research-guard] 00_meta.json cannot enter completed at ${currentRound}/${targetDepth} rounds.`,
      };
    }
    if (
      Number.isFinite(currentRound) &&
      Number.isFinite(targetDepth) &&
      status === "ready_for_next_round" &&
      currentRound >= targetDepth
    ) {
      return {
        ok: false,
        reason:
          `[deep-research-guard] 00_meta.json cannot stay ready_for_next_round when current_round=${currentRound} already reached target_depth=${targetDepth}.`,
      };
    }
    return { ok: true };
  }

  const statuses = extractStatusStrings(text);
  const invalid = statuses.find((status) => !LEGAL_META_STATUSES.has(status));
  if (!invalid) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      `[deep-research-guard] 00_meta.json status "${invalid}" is invalid. ` +
      `Use only: ${[...LEGAL_META_STATUSES].join(", ")}.`,
  };
}

function taskLooksLikeFinalSynthesis(task) {
  const fields = [
    task?.title,
    task?.key_question,
    task?.report_path,
    ...(Array.isArray(task?.expected_evidence) ? task.expected_evidence : []),
  ]
    .map((value) => trimToString(value))
    .filter(Boolean);
  const haystack = fields.join("\n");
  return FINAL_SYNTHESIS_PATTERNS.some((pattern) => pattern.test(haystack));
}

function extractRoundNumberFromTarget(target, fileName) {
  const escaped = fileName.replace(".", "\\.");
  const match = String(target).replace(/\\/g, "/").match(new RegExp(`round_(\\d+)/${escaped}$`));
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

function validateFinalRoundRegistryWrite(toolName, params, target, meta) {
  if (!/02_task_registry\.json$/.test(target)) {
    return { ok: true };
  }

  const targetRound = extractRoundNumberFromTarget(target, "02_task_registry.json");
  const targetDepth = Number(meta?.target_depth) || 0;
  if (!targetRound || !targetDepth || targetRound !== targetDepth) {
    return { ok: true };
  }

  const text = extractStructuredWriteText(toolName, params);
  const parsed = tryParseJsonText(text);
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.tasks)) {
    const offendingTask = parsed.tasks.find((task) => taskLooksLikeFinalSynthesis(task));
    if (!offendingTask) {
      return { ok: true };
    }
    return {
      ok: false,
      reason:
        `[deep-research-guard] round_${String(targetRound).padStart(2, "0")}/02_task_registry.json ` +
        "cannot contain final synthesis or final report tasks. The last round is still a normal exploration round.",
    };
  }

  if (!text || !FINAL_SYNTHESIS_PATTERNS.some((pattern) => pattern.test(text))) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      `[deep-research-guard] round_${String(targetRound).padStart(2, "0")}/02_task_registry.json ` +
      "cannot contain final synthesis or final report tasks. The last round is still a normal exploration round.",
  };
}

function validateFinalReportWrite(target, stageInfo) {
  if (!/final_report\.md$/.test(target)) {
    return { ok: true };
  }
  if (stageInfo.stage === "synthesize" || stageInfo.stage === "finalize") {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      `[deep-research-guard] final_report.md can only be written during the independent final synthesis stage. Current stage: ${stageInfo.stage}.`,
  };
}

function validateArchiveWrite(toolName, params, rdir, meta, stageInfo) {
  const targets = extractWriteTargets(toolName, params);
  for (const target of targets) {
    const normalized = target.replace(/\\/g, "/");
    if (!ARCHIVE_FILE_PATTERNS.some((pattern) => pattern.test(normalized))) {
      continue;
    }

    const metaWrite = validateMetaWrite(toolName, params, normalized, meta);
    if (!metaWrite.ok) {
      return metaWrite;
    }

    const registryWrite = validateFinalRoundRegistryWrite(toolName, params, normalized, meta);
    if (!registryWrite.ok) {
      return registryWrite;
    }

    const finalReportWrite = validateFinalReportWrite(normalized, stageInfo);
    if (!finalReportWrite.ok) {
      return finalReportWrite;
    }
  }
  return { ok: true };
}

function shouldBlockToolForStage(stageInfo, toolName, params) {
  if (!isExploratoryTool(toolName, params)) {
    return false;
  }
  return stageInfo.stage !== "execute" && stageInfo.stage !== "finalize";
}

function register(api) {
  if (typeof api.registerTool === "function") {
    api.registerTool(createDeepResearchSessionTool(api));
  }

  api.on("before_prompt_build", async (_event, ctx) => {
    const rdir = activeResearchDir(ctx);
    if (!rdir) {
      bindActiveResearch(ctx, null);
      return {};
    }
    bindActiveResearch(ctx, rdir);

    const meta = readMeta(rdir);
    if (!meta) {
      return {
        prependContext:
          "Deep-research session is active, but 00_meta.json is missing or unreadable. Repair or reinitialize the active archive before broad exploration.",
      };
    }

    const stageInfo = detectArchiveStage(api, rdir, meta);
    auditLog(rdir, {
      hook: "before_prompt_build",
      role: sessionRole(ctx),
      stage: stageInfo.stage,
      round: meta.current_round,
    });
    return {
      prependContext:
        sessionRole(ctx) === "worker"
          ? buildWorkerPrompt(stageInfo, meta)
          : buildStagePrompt(stageInfo, meta),
    };
  });

  api.on("before_tool_call", async (event, ctx) => {
    const inactiveBootstrap = validateInactiveArchiveBootstrap(
      event.toolName,
      event.params,
      workspaceDirFromCtx(ctx),
    );
    const rdir = activeResearchDir(ctx);
    if (!rdir) {
      bindActiveResearch(ctx, null);
      if (!inactiveBootstrap.ok) {
        return { block: true, blockReason: inactiveBootstrap.reason };
      }
      return {};
    }
    bindActiveResearch(ctx, rdir);

    const meta = readMeta(rdir);
    if (!meta) {
      if (!isExploratoryTool(event.toolName, event.params)) {
        return {};
      }
      const reason =
        "[deep-research-guard] 00_meta.json is missing or unreadable. Initialize the research archive before using exploratory tools.";
      auditLog(rdir, { hook: "before_tool_call", action: "BLOCK", tool: event.toolName, reason });
      return { block: true, blockReason: reason };
    }

    const { toolName, params } = event;

    if (sessionRole(ctx) === "worker") {
      const workerWrite = validateWorkerArchiveWrite(toolName, params, rdir, meta);
      if (!workerWrite.ok) {
        auditLog(rdir, {
          hook: "before_tool_call",
          role: "worker",
          action: "BLOCK",
          tool: toolName,
          reason: workerWrite.reason,
        });
        return { block: true, blockReason: workerWrite.reason };
      }
    }

    const stageInfo = detectArchiveStage(api, rdir, meta);
    const archiveWrite = validateArchiveWrite(toolName, params, rdir, meta, stageInfo);
    if (!archiveWrite.ok) {
      auditLog(rdir, {
        hook: "before_tool_call",
        role: sessionRole(ctx),
        action: "BLOCK",
        tool: toolName,
        reason: archiveWrite.reason,
      });
      return { block: true, blockReason: archiveWrite.reason };
    }

    if (isArchiveTool(api, toolName, params)) return {};

    const shouldBlock =
      sessionRole(ctx) === "worker"
        ? stageInfo.stage !== "execute" && isExploratoryTool(toolName, params)
        : shouldBlockToolForStage(stageInfo, toolName, params);
    if (shouldBlock) {
      const reason = `[deep-research-guard] ${stageInfo.blockedReason}`;
      auditLog(rdir, { hook: "before_tool_call", action: "BLOCK", tool: toolName, reason });
      return { block: true, blockReason: reason };
    }

    auditLog(rdir, {
      hook: "before_tool_call",
      role: sessionRole(ctx),
      action: "ALLOW",
      tool: toolName,
      stage: stageInfo.stage,
    });
    return {};
  });

  api.on("after_tool_call", async (event, ctx) => {
    const signal = parseSessionSignal(event.result);
    if (signal?.action === "clear") {
      bindActiveResearch(ctx, null);
    } else if (signal?.action === "start" || signal?.action === "activate") {
      const rebound = rebindOwnedActiveSession(ctx, signal);
      if (rebound) {
        bindActiveResearch(ctx, rebound.researchDir, rebound.marker);
      }
    }

    const rdir = activeResearchDir(ctx);
    if (!rdir) return;
    markToolActivity(ctx, event);
    const { toolName, toolCallId, durationMs } = event;
    auditLog(rdir, { hook: "after_tool_call", role: sessionRole(ctx), tool: toolName, toolCallId, durationMs });
  });

  // PRIMARY stop guard for Codex path (OpenClaw 2026.5.18+).
  // Without this hook registered, OpenClaw sets hooks.Stop=[] which lets Codex
  // stop without calling the relay at all, making before_message_write too late.
  // For the Pi embedded path this is the cleanest interception point as well.
  api.on("before_agent_finalize", async (_event, ctx) => {
    const rdir = activeResearchDir(ctx);
    if (!rdir) {
      bindActiveResearch(ctx, null);
      return;
    }
    bindActiveResearch(ctx, rdir);

    const meta = readMeta(rdir);
    if (!meta) {
      return; // no meta — allow finalization
    }

    // Workers are allowed to finalize their individual sub-tasks
    if (sessionRole(ctx) !== "orchestrator") {
      return;
    }

    const stageInfo = detectArchiveStage(api, rdir, meta);
    if (stageInfo.stage === "finalize") {
      auditLog(rdir, {
        hook: "before_agent_finalize",
        action: "ALLOW",
        stage: stageInfo.stage,
        round: meta.current_round,
      });
      return; // archive is complete — allow normal finalization
    }

    const reason = buildContinuationEvent(stageInfo, meta);
    const idempotencyKey = `deep-research-finalize:${stageInfo.stage}:${meta.current_round ?? 0}`;
    updateCachedSession(sessionCacheKey(ctx), (current) => ({
      ...current,
      pendingToolContinuation: false,
      lastContinuationKey: idempotencyKey,
      lastContinuationAt: Date.now(),
    }));
    auditLog(rdir, {
      hook: "before_agent_finalize",
      action: "REVISE",
      stage: stageInfo.stage,
      round: meta.current_round,
    });
    // maxAttempts controls how many times we force "revise" per stage+round
    // before giving up and letting the agent stop. The default when omitted is 1,
    // which is far too tight for research tasks with many sub-steps. 12 gives
    // enough room for a round with many tasks while still providing a safety
    // ceiling if the agent is genuinely stuck (tool failures, loop, etc.).
    return {
      action: "revise",
      reason,
      retry: {
        instruction: reason, // required — without this the retry is silently ignored
        idempotencyKey,
        maxAttempts: 12,
      },
    };
  });

  // FALLBACK stop guard — catches plain-text stop attempts in the Pi embedded
  // path and through transcript mirroring. Still fires after before_agent_finalize
  // in most scenarios; kept as a second line of defence.
  api.on("before_message_write", (event, ctx) => {
    const rdir = activeResearchDir(ctx);
    if (!rdir) {
      bindActiveResearch(ctx, null);
      return {};
    }
    bindActiveResearch(ctx, rdir);

    const meta = readMeta(rdir);
    if (!meta) {
      return {};
    }
    if (isAssistantMessage(event?.message)) {
      clearPendingToolContinuation(ctx);
    }
    const stageInfo = detectArchiveStage(api, rdir, meta);
    const interception = maybeResumeUnfinishedResearch(
      api,
      ctx,
      rdir,
      meta,
      stageInfo,
      event?.message,
    );
    if (!interception) {
      return {};
    }
    return { block: true };
  });

  api.on("agent_end", async (event, ctx) => {
    const rdir = activeResearchDir(ctx);
    if (!rdir) return {};

    const meta = readMeta(rdir);
    const stageInfo = meta ? detectArchiveStage(api, rdir, meta) : { stage: "unknown", summary: "" };
    maybeResumeAfterToolIdle(api, ctx, rdir, meta, stageInfo, event);
    auditLog(rdir, {
      hook: "agent_end",
      role: sessionRole(ctx),
      success: event.success,
      stage: stageInfo.stage,
      round: meta?.current_round,
      status: meta?.status,
      error: event.error,
      durationMs: event.durationMs,
    });
  });

  api.on("session_end", (_event, ctx) => {
    const key = sessionCacheKey(ctx);
    if (key) {
      ACTIVE_SESSIONS.delete(key);
    }
  });

  api.on("subagent_spawned", (event, ctx) => {
    const requesterSessionKey = trimToString(ctx?.requesterSessionKey) || trimToString(event?.requesterSessionKey);
    const childSessionKey = trimToString(ctx?.childSessionKey) || trimToString(event?.childSessionKey);
    linkWorkerSession(requesterSessionKey, childSessionKey);
  });

  api.on("subagent_ended", (event, ctx) => {
    const targetSessionKey = trimToString(event?.targetSessionKey) || trimToString(ctx?.childSessionKey);
    const requesterSessionKey = trimToString(event?.requesterSessionKey) || trimToString(ctx?.requesterSessionKey);
    unlinkWorkerSession(targetSessionKey);

    // --- Robustness: wake orchestrator if sub-agent failed/timed out ---
    const success = event?.success !== false && !trimToString(event?.error);
    if (success) {
      return; // sub-agent completed normally, nothing to do
    }

    // Find the orchestrator's research dir from the requester session or workspace
    const orchestratorKey = requesterSessionKey || null;
    let rdir = null;
    if (orchestratorKey) {
      const cached = getCachedSession(orchestratorKey);
      rdir = cached?.researchDir || null;
    }
    if (!rdir) {
      // Try workspace-based lookup
      const workspaceDir = workspaceDirFromCtx(ctx);
      if (workspaceDir) {
        const markerPath = path.join(workspaceDir, ".deep-research", "active.json");
        if (fs.existsSync(markerPath)) {
          const payload = safeReadJson(markerPath);
          rdir = trimToString(payload?.research_dir) || null;
        }
      }
    }
    if (!rdir) return;

    const meta = readMeta(rdir);
    if (!meta) return;

    const stageInfo = detectArchiveStage(api, rdir, meta);
    if (stageInfo.stage === "finalize") return;

    // Record the failure in task_failures tracking
    const retryConfig = getRetryConfig(api);
    const failureKey = targetSessionKey || `subagent-${Date.now()}`;
    const taskId = trimToString(event?.taskId) || "";
    const errorText = trimToString(event?.error) || "sub-agent failed or timed out";
    const isRateLimit = looksLikeRateLimit(errorText);

    // Track retries in the session cache for the orchestrator
    if (orchestratorKey) {
      updateCachedSession(orchestratorKey, (current) => {
        const failures = current.taskFailures || {};
        const existing = failures[failureKey] || { count: 0, taskId, errors: [] };
        existing.count += 1;
        existing.errors.push({ error: errorText, at: Date.now() });
        existing.taskId = taskId || existing.taskId;
        existing.isRateLimit = isRateLimit;
        failures[failureKey] = existing;
        return {
          ...current,
          taskFailures: failures,
          lastSubagentFailure: {
            sessionKey: targetSessionKey,
            taskId,
            error: errorText,
            isRateLimit,
            retryCount: existing.count,
            maxRetries: retryConfig.maxRetries,
            at: Date.now(),
          },
        };
      });
    }

    // Build continuation event to wake orchestrator
    const continuationEvent = buildSubagentFailureContinuationEvent(stageInfo, meta, {
      error: errorText,
      taskId,
      isRateLimit,
    });
    const contextKey = [
      "deep-research-subagent-failure",
      stageInfo.stage,
      meta.current_round ?? 0,
      failureKey,
    ].join(":");

    // Wake the orchestrator via system event
    const orchestratorCtx = {
      sessionKey: orchestratorKey,
      agentId: trimToString(ctx?.requesterAgentId) || trimToString(event?.requesterAgentId),
    };
    queueContinuationWake(api, orchestratorCtx, continuationEvent, contextKey, "deep-research-subagent-failure");

    if (orchestratorKey) {
      updateCachedSession(orchestratorKey, (current) => ({
        ...current,
        pendingToolContinuation: false,
        lastContinuationKey: contextKey,
        lastContinuationAt: Date.now(),
      }));
    }

    auditLog(rdir, {
      hook: "subagent_ended",
      action: "WAKE_ORCHESTRATOR",
      trigger: "subagent_failure",
      stage: stageInfo.stage,
      round: meta.current_round,
      targetSessionKey,
      taskId: taskId || null,
      error: errorText,
      isRateLimit,
    });
  });
}

module.exports = {
  id: "deep-research-guard",
  name: "Deep Research Guard",
  description:
    "Enforces deep-research archive discipline with prompt guidance, tool gating, stop interception, and audit logging.",
  version: "1.7.0",
  register,
  __testing: {
    detectArchiveStage,
    shouldBlockToolForStage,
    isExploratoryTool,
    fileLooksPlaceholder,
    buildStagePrompt,
    buildWorkerPrompt,
    buildContinuationEvent,
    buildPostToolContinuationEvent,
    buildErrorRecoveryContinuationEvent,
    buildSubagentFailureContinuationEvent,
    hasToolCall,
    isTerminalAssistantMessage,
    maybeResumeAfterToolIdle,
    maybeResumeUnfinishedResearch,
    sessionRole,
    extractWriteTargets,
    validateWorkerArchiveWrite,
    validateMetaWrite,
    validateFinalRoundRegistryWrite,
    validateFinalReportWrite,
    validateArchiveWrite,
    validateInactiveArchiveBootstrap,
    parseArchiveTarget,
    createDeepResearchSessionTool,
    activeResearchDir,
    bindActiveResearch,
    parseSessionSignal,
    validateRegistrySchema,
    validateFinalReportContent,
    rebindOwnedActiveSession,
    linkWorkerSession,
    unlinkWorkerSession,
    markToolActivity,
    clearPendingToolContinuation,
    getRetryConfig,
    looksLikeRateLimit,
    computeRetryDelay,
    resetGuardActivation: () => ACTIVE_SESSIONS.clear(),
    readActiveSession,
  },
};
