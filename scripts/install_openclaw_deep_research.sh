#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="deep-research-guard"

usage() {
  cat <<'EOF'
Usage:
  install_openclaw_deep_research.sh [options]

Options:
  --config-path PATH    OpenClaw config file path. Defaults to $OPENCLAW_CONFIG_PATH or ~/.openclaw/openclaw.json.
  --strict BOOL         Plugin strict mode: true/false. Default: true.
  --guard-mode MODE     Guard mode: lite/strict. Default: lite.
  --dry-run             Validate the merged config without writing it.
  --no-backup           Do not create a timestamped backup before writing.
  --no-registry-refresh Do not refresh OpenClaw's persisted plugin registry.
  --no-restart          Do not restart the OpenClaw gateway service after install.
  -h, --help            Show this help.

Examples:
  bash scripts/install_openclaw_deep_research.sh
  bash scripts/install_openclaw_deep_research.sh --dry-run
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

bool_json() {
  local value
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    1|true|yes|on) printf 'true' ;;
    0|false|no|off) printf 'false' ;;
    *) die "invalid boolean value: $1" ;;
  esac
}

expand_path() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${1#~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

restart_openclaw_gateway() {
  local uid domain label launchd_target
  uid="$(id -u)"
  domain="gui/${uid}"
  label="ai.openclaw.gateway"
  launchd_target="${domain}/${label}"

  if command -v launchctl >/dev/null 2>&1 && launchctl print "$launchd_target" >/dev/null 2>&1; then
    launchctl kickstart -k "$launchd_target"
    echo "Restarted OpenClaw gateway via launchctl (${launchd_target})."
    return 0
  fi

  echo "OpenClaw gateway service was not auto-restarted. Restart it manually if needed."
  return 0
}

config_get_or_default() {
  local path="$1"
  local fallback="$2"
  local out err
  out="$(mktemp)"
  err="$(mktemp)"
  if OPENCLAW_CONFIG_PATH="$CONFIG_PATH" openclaw config get "$path" >"$out" 2>"$err"; then
    cat "$out"
    rm -f "$out" "$err"
    return 0
  fi

  if grep -q "Config path not found" "$err"; then
    printf '%s\n' "$fallback"
    rm -f "$out" "$err"
    return 0
  fi

  cat "$err" >&2
  rm -f "$out" "$err"
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/openclaw-plugin"
SCRIPTS_DIR="$REPO_ROOT/scripts"
SKILL_SOURCE="$REPO_ROOT/SKILL.md"
SKILL_NAME="deep-research"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
STRICT_JSON='true'
GUARD_MODE='lite'
DRY_RUN='false'
CREATE_BACKUP='true'
RESTART_GATEWAY='true'
REFRESH_REGISTRY='true'
WORKSPACE_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config-path)
      [[ $# -ge 2 ]] || die "--config-path requires a value"
      CONFIG_PATH="$2"
      shift 2
      ;;
    --strict)
      [[ $# -ge 2 ]] || die "--strict requires a value"
      STRICT_JSON="$(bool_json "$2")"
      shift 2
      ;;
    --guard-mode)
      [[ $# -ge 2 ]] || die "--guard-mode requires a value"
      MODE_VALUE="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
      case "$MODE_VALUE" in
        lite|strict) GUARD_MODE="$MODE_VALUE" ;;
        *) die "invalid guard mode: $2" ;;
      esac
      shift 2
      ;;
    --dry-run)
      DRY_RUN='true'
      shift
      ;;
    --no-backup)
      CREATE_BACKUP='false'
      shift
      ;;
    --no-registry-refresh)
      REFRESH_REGISTRY='false'
      shift
      ;;
    --no-restart)
      RESTART_GATEWAY='false'
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

command -v openclaw >/dev/null 2>&1 || die "openclaw is not installed or not on PATH"
command -v node >/dev/null 2>&1 || die "node is required"
[[ -d "$PLUGIN_DIR" ]] || die "plugin directory not found: $PLUGIN_DIR"
[[ -f "$PLUGIN_DIR/openclaw.plugin.json" ]] || die "plugin manifest not found: $PLUGIN_DIR/openclaw.plugin.json"
[[ -f "$SKILL_SOURCE" ]] || die "skill file not found: $SKILL_SOURCE"

CONFIG_PATH="$(expand_path "$CONFIG_PATH")"
PLUGIN_DIR="$(cd "$PLUGIN_DIR" && pwd)"
SCRIPTS_DIR="$(cd "$SCRIPTS_DIR" && pwd)"
SKILL_SOURCE="$(cd "$(dirname "$SKILL_SOURCE")" && pwd)/$(basename "$SKILL_SOURCE")"

mkdir -p "$(dirname "$CONFIG_PATH")"

LOAD_JSON="$(config_get_or_default "plugins.load.paths" '[]')"
ALLOW_JSON="$(config_get_or_default "plugins.allow" '[]')"
PLUGIN_CFG_JSON="$(config_get_or_default "plugins.entries.${PLUGIN_ID}.config" '{}')"
WORKSPACE_DIR="$(config_get_or_default "agents.defaults.workspace" "$HOME/.openclaw/workspace")"
[[ -n "$WORKSPACE_DIR" ]] || die "agents.defaults.workspace resolved to an empty value"
WORKSPACE_DIR="$(expand_path "$WORKSPACE_DIR")"
SKILL_TARGET_DIR="$WORKSPACE_DIR/skills/$SKILL_NAME"
SKILL_TARGET_FILE="$SKILL_TARGET_DIR/SKILL.md"
SKILL_SCRIPTS_TARGET_DIR="$SKILL_TARGET_DIR/scripts"
SKILL_TEMPLATES_TARGET_DIR="$SKILL_TARGET_DIR/templates"

BATCH_FILE="$(mktemp)"
export LOAD_JSON ALLOW_JSON PLUGIN_CFG_JSON PLUGIN_DIR SCRIPTS_DIR STRICT_JSON GUARD_MODE PLUGIN_ID BATCH_FILE

node <<'NODE'
const fs = require("fs");
const path = require("path");

function parseJson(name, fallback) {
  const raw = process.env[name];
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function uniqStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function resolveComparablePath(value) {
  try {
    return fs.realpathSync(value);
  } catch (_) {
    return path.resolve(value);
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return undefined;
  }
}

function pluginIdForLoadPath(loadPath) {
  const manifest = readJsonFile(path.join(loadPath, "openclaw.plugin.json"));
  const manifestId =
    typeof manifest?.id === "string"
      ? manifest.id.trim()
      : typeof manifest?.name === "string"
        ? manifest.name.trim()
        : "";
  if (manifestId) {
    return manifestId;
  }

  const pkg = readJsonFile(path.join(loadPath, "package.json"));
  return typeof pkg?.name === "string" ? pkg.name.trim() : "";
}

function isSamePath(left, right) {
  return resolveComparablePath(left) === resolveComparablePath(right);
}

function keepLoadPath(loadPath) {
  if (isSamePath(loadPath, process.env.PLUGIN_DIR)) {
    return true;
  }
  return pluginIdForLoadPath(loadPath) !== process.env.PLUGIN_ID;
}

const loadPaths = parseJson("LOAD_JSON", []);
const allow = parseJson("ALLOW_JSON", []);
const currentPluginConfig = parseJson("PLUGIN_CFG_JSON", {});

if (!Array.isArray(loadPaths)) {
  throw new Error("plugins.load.paths exists but is not an array");
}
if (!Array.isArray(allow)) {
  throw new Error("plugins.allow exists but is not an array");
}
if (currentPluginConfig === null || Array.isArray(currentPluginConfig) || typeof currentPluginConfig !== "object") {
  throw new Error("plugins.entries.deep-research-guard.config exists but is not an object");
}

const nextPluginConfig = {
  ...currentPluginConfig,
  scriptsDir: process.env.SCRIPTS_DIR,
  strict: process.env.STRICT_JSON === "true",
  guardMode: process.env.GUARD_MODE || "lite",
};
delete nextPluginConfig.researchDir;

const batch = [
  {
    path: "plugins.load.paths",
    value: uniqStrings([...loadPaths.filter(keepLoadPath), process.env.PLUGIN_DIR]),
  },
  {
    path: "plugins.allow",
    value: uniqStrings([...allow, process.env.PLUGIN_ID]),
  },
  {
    path: `plugins.entries.${process.env.PLUGIN_ID}.enabled`,
    value: true,
  },
  {
    path: `plugins.entries.${process.env.PLUGIN_ID}.hooks.allowConversationAccess`,
    value: true,
  },
  {
    path: `plugins.entries.${process.env.PLUGIN_ID}.hooks.allowPromptInjection`,
    value: true,
  },
  {
    path: `plugins.entries.${process.env.PLUGIN_ID}.config`,
    value: nextPluginConfig,
  },
];

fs.writeFileSync(process.env.BATCH_FILE, JSON.stringify(batch, null, 2) + "\n", "utf8");
NODE

if [[ "$DRY_RUN" != 'true' && -f "$CONFIG_PATH" && "$CREATE_BACKUP" == 'true' ]]; then
  BACKUP_PATH="${CONFIG_PATH}.bak.$(date +%Y%m%d%H%M%S)"
  cp "$CONFIG_PATH" "$BACKUP_PATH"
  echo "Backup created: $BACKUP_PATH"
fi

SET_ARGS=(config set --batch-file "$BATCH_FILE")
if [[ "$DRY_RUN" == 'true' ]]; then
  SET_ARGS+=(--dry-run)
fi

OPENCLAW_CONFIG_PATH="$CONFIG_PATH" openclaw "${SET_ARGS[@]}"

rm -f "$BATCH_FILE"

if [[ "$DRY_RUN" == 'true' ]]; then
  echo "Dry run passed."
  echo "Skill target: $SKILL_TARGET_FILE"
else
  mkdir -p "$SKILL_TARGET_DIR"
  rm -rf "$SKILL_SCRIPTS_TARGET_DIR" "$SKILL_TEMPLATES_TARGET_DIR"
  cp "$SKILL_SOURCE" "$SKILL_TARGET_FILE"
  cp -R "$REPO_ROOT/scripts" "$SKILL_SCRIPTS_TARGET_DIR"
  cp -R "$REPO_ROOT/templates" "$SKILL_TEMPLATES_TARGET_DIR"
  echo "Installed ${PLUGIN_ID} into ${CONFIG_PATH}"
  echo "Installed skill ${SKILL_NAME} into ${SKILL_TARGET_DIR}"
  if [[ "$REFRESH_REGISTRY" == 'true' ]]; then
    if OPENCLAW_CONFIG_PATH="$CONFIG_PATH" openclaw plugins registry --refresh >/dev/null; then
      echo "Refreshed OpenClaw plugin registry."
    else
      echo "Warning: OpenClaw plugin registry refresh failed. Run: OPENCLAW_CONFIG_PATH=\"$CONFIG_PATH\" openclaw plugins registry --refresh" >&2
    fi
  else
    echo "Skipped OpenClaw plugin registry refresh (--no-registry-refresh)."
  fi
  if [[ "$RESTART_GATEWAY" == 'true' ]]; then
    restart_openclaw_gateway
  else
    echo "Skipped OpenClaw gateway restart (--no-restart)."
  fi
fi
