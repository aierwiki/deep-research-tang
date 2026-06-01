# Deep Research Skill

一个通用的迭代式深度研究 skill，教 Agent 通过多轮「探索→总结」循环来系统化地分析复杂问题。

适用于 Claude Code、VS Code Copilot、OpenClaw 等支持 skill 机制的 Agent 框架。

## 安装

将 `SKILL.md` 文件（连同所在文件夹）复制到你使用的 Agent 框架对应的 skill 目录：

### Claude Code

```bash
# 个人级（所有项目可用）
mkdir -p ~/.claude/skills/deep-research
cp SKILL.md ~/.claude/skills/deep-research/

# 项目级（仅当前项目）
mkdir -p .claude/skills/deep-research
cp SKILL.md .claude/skills/deep-research/
```

安装后在 `~/.claude/CLAUDE.md`（个人级）或项目根目录的 `CLAUDE.md`（项目级）中添加引导说明，让 Claude Code 知道有这个 skill：

```markdown
# >>> SKILL: deep-research >>>
# 深度研究 Skill

本机已安装深度研究 skill，路径: ~/.claude/skills/deep-research

当用户要求进行深度研究、深度调研、迭代研究、深入分析时，
请阅读 ~/.claude/skills/deep-research/SKILL.md 获取完整工作流程。
# <<< SKILL: deep-research <<<
```

### VS Code Copilot

```bash
mkdir -p .github/skills/deep-research
cp SKILL.md .github/skills/deep-research/
```

### OpenClaw

```bash
# 需要先安装 OpenClaw，并确保 openclaw、node、python3 在 PATH 中
openclaw --version
node --version
python3 --version

# 从本仓库根目录安装
bash scripts/install_openclaw_deep_research.sh
```

这个脚本会把 skill 和 runtime plugin 一起安装到 OpenClaw：

- 将 [openclaw-plugin](openclaw-plugin) 加入 `plugins.load.paths`
- 将 `deep-research-guard` 加入 `plugins.allow`
- 启用 `plugins.entries.deep-research-guard.enabled`
- 写入必要 hook 权限：
  - `plugins.entries.deep-research-guard.hooks.allowConversationAccess=true`
  - `plugins.entries.deep-research-guard.hooks.allowPromptInjection=true`
- 写入插件配置 `scriptsDir`、`strict`、`guardMode`
- 复制 `SKILL.md`、`scripts/`、`templates/` 到 OpenClaw workspace skills 目录
- 刷新 OpenClaw plugin registry
- 尝试重启 OpenClaw gateway
- 写配置前备份 `~/.openclaw/openclaw.json`

安装后验证：

```bash
openclaw plugins inspect deep-research-guard --runtime --json
openclaw plugins doctor
```

`inspect` 输出中应能看到：

```json
"toolNames": ["deep_research_session"],
"hookCount": 9
```

并且 `typedHooks` 中应包含 `before_agent_finalize`、`before_prompt_build`、`before_tool_call`、`after_tool_call`、`agent_end`。

如果你的系统不能由脚本自动重启 gateway（例如非 macOS/非 launchctl 环境），安装后手动重启 OpenClaw gateway，再运行上面的验证命令。

可选参数：

```bash
bash scripts/install_openclaw_deep_research.sh --dry-run
bash scripts/install_openclaw_deep_research.sh --config-path /path/to/openclaw.json
bash scripts/install_openclaw_deep_research.sh --guard-mode strict
bash scripts/install_openclaw_deep_research.sh --strict false
bash scripts/install_openclaw_deep_research.sh --no-restart
```

### 其他框架

```bash
# 通用路径
mkdir -p .agents/skills/deep-research
cp SKILL.md .agents/skills/deep-research/
```

## 使用

安装后，在与 Agent 对话时使用以下触发词：

- "对 XXX 进行深度研究"
- "深入分析 XXX"
- "迭代研究 XXX 问题"
- `/deep-research`（斜杠命令，部分框架支持）

## 工作原理

```
用户提出问题
      │
      ▼
  ┌─────────┐
  │ 问题拆解 │  分解成若干可独立执行的探索任务
  └────┬────┘
       │
       ▼
  ┌─────────┐
     │ 并行探索 │  执行完整探索任务，而不只是简单搜索 query
  └────┬────┘
       │
       ▼
  ┌─────────┐
  │ 阶段总结 │  综合分析，提炼发现，识别问题
  └────┬────┘
       │
       ▼
   需要继续？ ──是──► 回到"问题拆解"（更聚焦）
       │
       否
       │
       ▼
  ┌─────────┐
  │ 最终报告 │
  └─────────┘
```

所有过程文件归档在研究文件夹中，完整可追溯。

一个关键原则是：最后一轮不是“收尾轮”，而仍然是普通研究轮。只有全部轮次都完成并通过检查后，才进入额外的最终综合阶段去回答用户问题。

## 协议化归档

当前版本不再把中间文件当作“可选记录”，而是把它们升级为研究流程的前置条件。推荐目录结构如下：

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

其中最关键的是三类机器可检文件：

- `00_meta.json`：记录目标轮数、当前轮次和状态
- `02_task_registry.json`：记录本轮合法任务清单，用于检查任务独立性
- `04_delta_report.json`：记录本轮新增发现和传递到下一轮的线索
- `round_N/tasks/task_report.template.md`：单任务报告模板。任务文件不只检查是否存在，也检查是否包含 `Task ID / Goal / Executed Actions / Key Evidence / Findings / Open Questions / Next Leads` 这些 section
- `final_report.md`：最终综合报告。不是最后一轮的简化收尾，而是要综合全部轮次与任务结果；对强时效性问题还要显式写出关键日期与交叉验证说明

## 模板

仓库内提供了一组模板文件，放在 [templates](templates) 中。建议在开始研究时复制一份，然后按轮次填写。

模板覆盖：

- 研究说明
- 元数据
- 线索输入
- 任务登记表
- 单任务记录
- 轮次总结
- 增量发现
- 最终报告

## 初始化脚手架

仓库内提供了初始化脚本 [scripts/init_deep_research_archive.py](scripts/init_deep_research_archive.py)，用于创建研究目录、复制模板并写入最基本的元数据。推荐优先使用它，而不是手工建目录。

示例（在仓库根目录 `deep-research/` 下运行）：

```bash
python scripts/init_deep_research_archive.py \
     --topic api-gateway \
     --question "是否应该引入统一 API gateway" \
     --target-depth 5 \
     --depth-mode user-specified
```

脚本会完成以下动作：

- 生成 `research_<日期>_<topic>/` 目录
- 初始化 `00_research_brief.md`、`00_meta.json`、`final_report.md`
- 初始化 `round_01/` 及其种子线索、任务登记、轮次总结、增量发现模板
- 在 `round_01/tasks/` 下放置任务报告模板
- 可选地自动跑一遍非严格检查，确保初始骨架可用

## 检查器

仓库内提供了研究归档检查脚本 [scripts/check_deep_research_archive.py](scripts/check_deep_research_archive.py)。建议每轮完成后运行一次（在 `deep-research/` 下运行）：

```bash
python scripts/check_deep_research_archive.py --research-dir path/to/research_xxx --strict
```

检查器当前重点覆盖：

- 目标轮数与已完成轮数是否匹配
- 每轮是否具备必需文件
- 任务登记表中的任务是否独立、是否存在非法依赖
- 任务结果文件是否与任务登记表对齐
- 下一轮线索是否引用上一轮增量发现

如果检查未通过，建议先补齐归档，再继续下一轮。这样能显著降低“轮数不够”和“任务拆分不独立”的问题。

推荐闭环如下：

1. 用初始化脚本创建研究目录。
2. 填写本轮归档文件。
3. 运行检查器。
4. 若失败，则根据失败原因修复归档文件并重跑检查器。
5. 只有在检查器通过后，才允许开启下一轮；若全部轮次都已完成，则进入独立的最终综合阶段，而不是把最后一轮直接当成最终报告。

## 项目结构

```
deep-research/
├── SKILL.md              # 核心 skill 文件
├── README.md             # 安装、模板、检查器说明
├── scripts/
│   ├── deep_research_state_machine.py   # 状态机与 meta 读写
│   ├── init_deep_research_archive.py    # 初始化脚手架
│   ├── check_deep_research_archive.py   # 严格归档检查器
│   ├── repair_deep_research_archive.py  # 自动修复循环
│   ├── openclaw_deep_research_session.py # 会话生命周期脚本（start/activate/advance-round/finalize）
│   └── install_openclaw_deep_research.sh # 一键写入 OpenClaw 配置
├── openclaw-plugin/
│   ├── openclaw.plugin.json  # OpenClaw runtime plugin manifest
│   ├── package.json          # OpenClaw 插件包元数据
│   ├── README.md             # OpenClaw 插件接入说明
│   └── index.js              # before_agent_finalize / before_prompt_build / before_tool_call /
│                             #   before_message_write / after_tool_call / agent_end 等 hook 门禁
│                             #   + deep_research_session 工具注册
├── tests/                # 端到端测试
├── examples/             # 检查器通过/失败示例
├── templates/            # 归档模板
└── LICENSE
```

## OpenClaw 插件策略

插件默认使用 `guardMode=lite`，目标是降低运行时脆弱性：不再在每个工具调用上做复杂阶段拦截，而是在轮次 checkpoint 上校验。

- `before_prompt_build`：只注入当前 active research 的简短状态和下一步 checkpoint 提醒
- `before_tool_call`：lite 模式下只阻止未绑定会话时手工 bootstrap `research_*`，不再按阶段阻断搜索、exec、write 等正常操作
- `before_agent_finalize`：如果 active research 尚未 `completed`，阻止明显提前停止，并提示调用 `deep_research_session status/recover` 继续
- `after_tool_call`：解析 `deep_research_session` 信号、更新 active marker、写审计日志
- `advance-round` / `finalize`：真正的强校验点，失败时返回检查器错误，由 Agent 修复后重试
- `recover`：读取当前归档、运行检查器并返回下一步修复建议

active research 现在绑定到 `workspace + research_dir`，chat/session id 只作为 `last_seen_session_*` 审计信息，不再作为访问控制边界。这样同一个 OpenClaw workspace 里的新会话可以显式 `status` / `recover` / `activate` 后继续研究。

如果确实需要旧的强管控模式，可安装或配置：

```bash
bash scripts/install_openclaw_deep_research.sh --guard-mode strict
```

### OpenClaw 安装提示

推荐使用一键安装脚本：

```bash
bash scripts/install_openclaw_deep_research.sh
```

不要只手工复制 `SKILL.md`。OpenClaw 下必须同时安装 runtime plugin，否则 `before_agent_finalize` 等止停门禁不会生效。

当前版本不再在安装阶段绑定某一个固定 `researchDir`。正确模型是：

- 安装时只安装 skill + plugin
- 当用户真的发起一次深度研究时，由 skill 内的会话脚本创建或绑定本次研究目录
- plugin 只对“当前活跃研究会话”生效，而不是对所有普通对话全局生效

详细示例见 [openclaw-plugin/README.md](openclaw-plugin/README.md)。

这个脚本会自动：

- 把 [openclaw-plugin](openclaw-plugin) 加入 `plugins.load.paths`
- 把 `deep-research-guard` 加入 `plugins.allow`
- 启用 `plugins.entries.deep-research-guard.enabled`
- 写入 `plugins.entries.deep-research-guard.hooks.allowConversationAccess=true`
- 写入 `plugins.entries.deep-research-guard.hooks.allowPromptInjection=true`
- 写入 `scriptsDir`、`strict`、`guardMode`
- 把完整 skill bundle 安装到 OpenClaw workspace skills 目录
- 复制 `SKILL.md`、`scripts/`、`templates/`，让 skill 在 OpenClaw 里可独立运行
- 刷新 OpenClaw plugin registry
- 在改写前为 OpenClaw 配置文件创建时间戳备份

安装后建议验证：

```bash
openclaw plugins inspect deep-research-guard --runtime --json
openclaw plugins doctor
```

其中 `inspect` 应显示 `toolNames` 包含 `deep_research_session`，`hookCount` 为非 0，并且 `typedHooks` 中包含 `before_agent_finalize`。

## License

MIT
