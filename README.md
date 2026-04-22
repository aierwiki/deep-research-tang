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

### OpenClaw / 其他框架

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

仓库内提供了一组模板文件，放在 [deep-research/templates](deep-research/templates) 中。建议在开始研究时复制一份，然后按轮次填写。

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
│   └── repair_deep_research_archive.py  # 自动修复循环
├── openclaw-plugin/
│   ├── openclaw.plugin.json  # OpenClaw runtime plugin manifest
│   ├── package.json          # OpenClaw 插件包元数据
│   ├── README.md             # OpenClaw 插件接入说明
│   └── index.js              # before_prompt_build / before_tool_call / agent_end 门禁
├── tests/                # 端到端测试
├── examples/             # 检查器通过/失败示例
├── templates/            # 归档模板
└── LICENSE
```

## OpenClaw 插件策略

OpenClaw 没有一个“插件直接给当前 run 追加一条 user message 并原地续跑”的专用 API，但它提供了足够稳定的两段式机制：`before_message_write` 用来识别“assistant 无 tool use 的收工消息”，`system event + heartbeat wake` 用来把同一 session 再唤醒一轮。因此本仓库里的插件采用如下组合：

- `before_prompt_build`：按当前归档阶段注入最小执行约束
- `before_tool_call`：在规划未完成、总结未完成、检查失败等状态下阻断探索型工具
- `before_message_write`：如果检测到 assistant 想以纯文本消息收工，但归档状态还没到 `finalize`，则阻断这次收工，并补一条系统继续指令给同一 session，然后立即唤醒继续执行
- `after_tool_call`：记录工具审计日志
- `agent_end`：记录未完成退出，便于恢复和统计

这样做的目标不是做一个臃肿的大总闸门，而是在最关键的几个收口点上精确干预：流程未满足时，Agent 既拿不到“自然收工”的落点，也会被推回当前研究上下文继续干活。

另外，当前版本已经显式区分两种会话角色：

- orchestrator：主 deep-research 会话，负责轮次推进、检查器、最终收口
- worker：由 OpenClaw subagent 扇出的任务执行会话，只负责单个已登记任务

worker 不再被要求“必须把整个研究做到 finalize 才能停”，否则并行子任务会陷入错误的续跑循环。相反，worker 现在只允许写当前轮已登记的任务报告文件，不能改 `00_meta.json`、轮次总结、增量报告或 `final_report.md`。

### OpenClaw 安装提示

将 [openclaw-plugin](/Users/tangyubin/project/gitee/deep-research/openclaw-plugin) 目录加入 OpenClaw 的 `plugins.load.paths`，并在 `plugins.allow` 中允许 `deep-research-guard`。

当前版本不再在安装阶段绑定某一个固定 `researchDir`。正确模型是：

- 安装时只安装 skill + plugin
- 当用户真的发起一次深度研究时，由 skill 内的会话脚本创建或绑定本次研究目录
- plugin 只对“当前活跃研究会话”生效，而不是对所有普通对话全局生效

详细示例见 [openclaw-plugin/README.md](/Users/tangyubin/project/gitee/deep-research/openclaw-plugin/README.md)。

如果你想直接一键写入 OpenClaw 配置，可以运行：

```bash
bash scripts/install_openclaw_deep_research.sh
```

这个脚本会自动：

- 把 [openclaw-plugin](/Users/tangyubin/project/gitee/deep-research/openclaw-plugin) 加入 `plugins.load.paths`
- 把 `deep-research-guard` 加入 `plugins.allow`
- 启用 `plugins.entries.deep-research-guard.enabled`
- 写入 `scriptsDir`、`strict`
- 把完整 skill bundle 安装到 OpenClaw workspace skills 目录
- 复制 `SKILL.md`、`scripts/`、`templates/`，让 skill 在 OpenClaw 里可独立运行
- 在改写前为 OpenClaw 配置文件创建时间戳备份

## License

MIT
