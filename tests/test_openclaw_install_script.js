const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const installScript = path.join(repoRoot, "scripts", "install_openclaw_deep_research.sh");
const pluginDir = path.join(repoRoot, "openclaw-plugin");
const scriptsDir = path.join(repoRoot, "scripts");
const skillSource = path.join(repoRoot, "SKILL.md");
const sessionScript = path.join(repoRoot, "scripts", "openclaw_deep_research_session.py");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function runInstaller(args, env = {}) {
  execFileSync("bash", [installScript, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
    },
    stdio: "pipe",
  });
}

test("install_openclaw_deep_research writes merged plugin config", () => {
  const tempRoot = makeTempDir("deep-research-install-");
  const configPath = path.join(tempRoot, "openclaw.json");
  const workspaceDir = path.join(tempRoot, "workspace");
  const skillTarget = path.join(workspaceDir, "skills", "deep-research", "SKILL.md");
  const sessionScriptTarget = path.join(
    workspaceDir,
    "skills",
    "deep-research",
    "scripts",
    "openclaw_deep_research_session.py",
  );

  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  runInstaller(["--config-path", configPath, "--no-backup", "--no-restart"]);

  const config = readJson(configPath);
  const entry = config.plugins.entries["deep-research-guard"];

  assert.equal(entry.enabled, true);
  assert.equal(entry.config.scriptsDir, scriptsDir);
  assert.equal(entry.config.strict, true);
  assert.equal("researchDir" in entry.config, false);
  assert.deepEqual(config.plugins.load.paths, [pluginDir]);
  assert.deepEqual(config.plugins.allow, ["deep-research-guard"]);
  assert.equal(fs.existsSync(skillTarget), true);
  assert.equal(fs.readFileSync(skillTarget, "utf8"), fs.readFileSync(skillSource, "utf8"));
  assert.equal(fs.existsSync(sessionScriptTarget), true);
});

test("install_openclaw_deep_research is idempotent and preserves existing plugin config", () => {
  const tempRoot = makeTempDir("deep-research-install-merge-");
  const configPath = path.join(tempRoot, "openclaw.json");
  const existingPluginDir = path.join(tempRoot, "existing-plugin");
  const workspaceDir = path.join(tempRoot, "workspace");
  const skillTarget = path.join(workspaceDir, "skills", "deep-research", "SKILL.md");
  const sessionScriptTarget = path.join(
    workspaceDir,
    "skills",
    "deep-research",
    "scripts",
    "openclaw_deep_research_session.py",
  );

  fs.mkdirSync(existingPluginDir, { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
        plugins: {
          load: {
            paths: [pluginDir, existingPluginDir],
          },
          allow: ["existing-plugin", "deep-research-guard"],
          entries: {
            "deep-research-guard": {
              enabled: false,
              config: {
                customNote: "keep-me",
                strict: false,
                researchDir: "/tmp/old-research",
              },
            },
          },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  runInstaller(["--config-path", configPath, "--no-backup", "--no-restart"]);
  runInstaller(["--config-path", configPath, "--no-backup", "--no-restart"]);

  const config = readJson(configPath);
  const entry = config.plugins.entries["deep-research-guard"];

  assert.equal(entry.enabled, true);
  assert.equal(entry.config.customNote, "keep-me");
  assert.equal(entry.config.scriptsDir, scriptsDir);
  assert.equal(entry.config.strict, true);
  assert.equal("researchDir" in entry.config, false);
  assert.deepEqual(config.plugins.load.paths, [pluginDir, existingPluginDir]);
  assert.deepEqual(config.plugins.allow, ["existing-plugin", "deep-research-guard"]);
  assert.equal(fs.existsSync(skillTarget), true);
  assert.equal(fs.readFileSync(skillTarget, "utf8"), fs.readFileSync(skillSource, "utf8"));
  assert.equal(fs.existsSync(sessionScriptTarget), true);
  assert.equal(fs.readFileSync(sessionScriptTarget, "utf8"), fs.readFileSync(sessionScript, "utf8"));
});
