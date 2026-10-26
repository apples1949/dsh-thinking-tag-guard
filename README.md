# dsh-thinking-tag-guard

把网关漏进正文的思考过程搬回思考通道，并在回合本该静默收尾时把它拉回来。

| 项目 | 内容 |
| --- | --- |
| 包名 | `@apples1949/dsh-thinking-tag-guard` |
| 版本 | **不声明版本号**：跟随 `main` 分支，见 [更新与支持](#更新与支持) |
| 类型 | DSH Host 插件（不是客户端插件，无 UI） |
| 生效范围 | `llm/stream` + `agent/turn-stopping` 两个挂载点 |
| 默认只守 | `providers: [hgapi]` |
| 分发 | 只从本仓库装（没有发布到 npm）；也可通过自建格式 1 索引源在「插件 → 发现」里看到 |

## 它解决什么

模型走某些网关时，**思考内容会漏进正文**。表现是：界面上本该是「思考」的过程被当成回答正文渲染出来，用户看到一大段英文规划独白——"Let me check…"、"Confirmed the pattern…"——中间还夹着半截工具调用标记。真正面向用户的答案要么被冲淡，要么根本没出现。

更糟的是这类泄漏常常伴随**回合静默结束**：最后一个步骤没有调用工具，正文里却只有泄漏的思考，于是回合就这么关了，任务其实没做完。

本插件在流式输出阶段和回合收尾阶段各设一道闸。

## 两层机制

### 第一层：`llm/stream`（流内归位）

`apply()` 里注册一个 waterfall 监听器，只接管 `options.provider` 命中白名单的流：

```js
ctx.on("llm/stream", (options, next) => {
  const stream = next();
  if (!opts.providers.includes(options.provider)) return stream;
  if (opts.skipPurposes.includes(options.purpose)) return stream;
  return guard(stream, opts);
});
```

`guard()` 是个异步生成器，逐个 chunk 判断三件事：

1. **带标记的思考**——`thinking` / `summary` / `analysis` / `analyse` / `thought` / `reasoning` / `reflection` / `scratchpad`，带尖括号、只有开头单词、只有结尾 `/name`、或块内成对出现，都识别。命中的段整段改判为 `reasoning`。
2. **原样回放的思考**——如果正文文本就是刚刚已经流过的 reasoning，丢弃（网关的复读特征）。
3. **无标记的叙事独白**（`narrationGuard`）——没有标记、纯英文、但内容是在讲自己下一步要干什么。这种只有在本响应**同时调用了工具**时才改判，因为「调了工具说明还没说完，这段只是过程」。反之，一个不调工具的响应里那段英文就是**答案本身**，不能动。

改判的实现方式值得说明：不动已经流出的 `text-delta`，而是把 `block-end` 的 payload 改成 `{ type: "reasoning", text }`。DSH 的 `BlockAssembler` 在 `block-end` 时直接采用 payload 里的 `type`，所以这是官方路径内可用的修正点。代价是 `block-end` 必须推迟到「本响应是否调用过工具」这件事确定之后，代码里用 `deferred` 数组承担这件事。

### 第二层：`agent/turn-stopping`（收尾拦截）

回合即将结束、最后一个 `assistant/message` 已落盘时触发。判定泄漏的规则：

- `empty-answer`：没有正文可交付的内容
- `marker`：正文里出现了只有在泄漏时才会出现的脚手架哨兵串
- `duplicate`：正文基本等于已经流过的 reasoning
- `thinking-prefix`：正文以「思考」自述开头

命中就用 `agent.steer()` 塞一条 user 角色的催促消息，让回合继续。每回合配额 `maxContinuePerTurn: 2`，避免死循环。

另有一条独立规则：最终答案**整段是英文**时，steer 一句「用中文回答我」，每回合最多 `maxLanguageNudgesPerTurn: 1` 次。

### 第三层：`llm/stream` 外层的 DSML 清洗（v1.2.0）

`apply()` 返回的是 `sanitizeDsml(guard(stream, opts))`——清洗包在归位之外，所以**正文与思考两个通道都会被清**：

- 删掉网关私有的特殊标记：`<|DSML|parameter …>`、`</|DSML|invoke>`、`<|DSML|calls>`、`<|endoftext|>` 等（正则 `<\/?\|[A-Za-z0-9_.:-]{1,32}\|[^<>]{0,400}?>`）。
- **跨分片也认**：每个块索引留一段未释放的尾巴，最后一个 `<` 之后还没见到 `>` 就先压住（上限 420 字符），到 `block-end` 才放出来。所以 `x</|DS` + `ML|parameter>` 这种被 delta 切成两半的 token 不会漏。
- `block-end.block.text` 只做清洗后写回**落盘记录**，绝不把整块当 delta 重发（否则用户会看到重复文本）。
- 用 `dsmlSanitize: false` 关掉；它同样只在 `providers` 命中时生效。

## 配置项

全部可写进插件的 `config`，也可用同名环境变量覆盖。

| 配置键 | 默认 | 说明 |
| --- | --- | --- |
| `providers` | `["dieqiyun"]` | 只守这些 provider 路由；**实际部署时填你用的那条** |
| `intervene` | `true` | 关掉则第二层完全不启用 |
| `narrationGuard` | `true` | 关掉则第一层不再改判无标记英文叙事 |
| `dedupeReasoning` | `true` | 关掉则不再丢弃原样回放的思考 |
| `bareMarkers` | `true` | 是否识别不带尖括号的标记 |
| `tailMarkers` | `true` | 是否识别结尾单独的闭标记 |
| `minReplayDelta` | `200` | 判定「回放」的最小 reasoning 长度 |
| `minEnglishLength` | `100` | 英文叙事改判的长度下限，短于此不处理 |
| `minNarrationLength` | `40` | 以「让我查一下」这类计划口吻开头的英文，改用这个更低的门槛 |
| `maxContinuePerTurn` | `2` | 每回合最多催促几次继续 |
| `maxLanguageNudgesPerTurn` | `1` | 每回合最多催几次改用中文 |
| `continuePrompt` | 见源码 | 催促继续时发的那句话 |
| `languageNudge` | `继续，用中文回答我` | 催用中文时发的那句话，`false` 关闭 |
| `dsmlSanitize` | `true` | 是否清洗 `<|DSML|…>` 这类网关私有标记（v1.2.0，只能写在 config 里） |

环境变量形如 `DSH_THINKING_TAG_GUARD_NARRATION=off`、`DSH_THINKING_TAG_GUARD_PROVIDERS=hgapi,other`。

## 安装

插件包里带一个 bundle patch（`dsh.bundle.patch` 指向 `cordis.patch.yml`），所以安装有两条路。

**一、作为 profile 依赖（能被插件管理页看到、能开关）**

```jsonc
// <profile>/package.json
{
  "dependencies": {
    "@apples1949/dsh-thinking-tag-guard": "link:../../plugins/dsh-thinking-tag-guard"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "@apples1949/dsh-thinking-tag-guard"]
    }
  }
}
```

然后在该 profile 目录下 `pnpm install`。

注意三点：

- **本地路径必须用 `link:`（或 `file:`），不能用版本号**。这个包**没有发布到 npm**，写 `"1.2.0"` 会让 pnpm 直接 `ERR_PNPM_FETCH_404`；要从仓库装就走 `pnpm add github:apples1949/dsh-thinking-tag-guard`（见下）。
- **`link:` 的源目录不能删**。pnpm 把它物化成符号链接，源目录消失后任何后续 `pnpm add` 都会报 `ENOENT`。
- 想出现在插件列表里，**`dependencies` 和 `dsh.profile.bundles` 两处都要有**——管理页按 `installed && enabled` 过滤，少一处就不显示。

**二、直接放进 profile 的 `node_modules`**

把目录拷到 `<profile>/node_modules/@apples1949/dsh-thinking-tag-guard/`，再往 `<profile>/cordis.patch.yml` 追加同样的 insert 行。这条路径不经过 pnpm，升级 DSH 不会被覆盖，但插件管理页看不到它，也没有开关。

两种方式**不要同时用**，否则同一个 `id` 会被插入两次。

**三、直接从 GitHub 仓库装**

```sh
dsh plugin --profile <profile> add github:apples1949/dsh-thinking-tag-guard
# 或手写进 profile 的 dependencies
pnpm add "github:apples1949/dsh-thinking-tag-guard#<sha>"
```

装完确认它在 profile 的 `dsh.profile.bundles` 里（`dsh plugin add` 一般会自动登记；没有就手动加包名），否则 loader 不会挂载它。

> ⚠️ **先卸掉旧的那份再装。** 本插件的 loader 入口 id 固定是 `thinking-tag-guard`，同一个 id 在组合树里出现两次会让宿主**启动失败**。如果之前用的是别处的副本（比如 `@local/dsh-thinking-tag-guard`），先从 `dependencies`、`dsh.profile.bundles`、`node_modules` 里清干净。

**生效需要重启宿主进程。** HMR 只监听 `cordis.patch.yml` 和 manifest，不监听插件源码（`hmr` 条目的 `root` 是空数组），所以改完 `index.js` 必须重启 DSH 才能加载新代码。

## 测试

```bash
node test/run.mjs     # 回归基线，需要 DSH 的 BlockAssembler 当 oracle
node test/dsml.mjs    # DSML 私有标记清洗，纯函数，无依赖
```

`test/dsml.mjs` 不需要任何 DSH 包，`node` 直接跑，覆盖：完整/成对的 `<|DSML|…>`、`<|endoftext|>`、普通 HTML 与 `a<b` 不受影响、token 被 delta 切开、**每一个**切分点都干净、reasoning 通道同样清洗、以及 provider 白名单（`hgapi` 清、`other` 原样透传）。

`test/run.mjs` 需要能读到 DSH 自己的 `@deepseek-ai/dsh-llm`（测试用它的 `BlockAssembler` 当判定基准——guard 只能改 `block-end` 的 payload，能不能生效取决于 assembler 是否接受，所以必须以 assembler 的实际产出为准）。

脚本会按顺序找：`$DSH_LLM` → 同目录 `node_modules` → Windows 桌面版默认安装位置 → `$DSH_RESOURCES` / `$DSH_INSTALL_DIR`。找不到就带上 `DSH_LLM` 重跑。

> Windows 桌面版的 harness 装在 `app.asar` 里，**普通 `node` 读不进去**，得用 Electron 自带的 node：
>
> ```bash
> ELECTRON_RUN_AS_NODE=1 "C:/Users/<you>/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" test/run.mjs
> ```

测试覆盖七组：

1. 泄漏叙事被改判（含 `narrationGuard: false` 的对照）
2. 真正的答案保持不动（短英文、中文、带工具的中文）
3. 尖括号标记仍归位
4. CJK 正文里**引用**哨兵串不算泄漏（英文里出现才算）
5. 协议边界：delta-only 流、被截断的流（不能把缓冲的内容吞掉）
6. `compaction` / `session-title` 这类产出数据的内部调用绝不改写
7. 真实样本回放：`fixtures/real-leaks.json` 的 **42** 条泄漏必须全部拦下，`fixtures/no-tool-answers.json` 的 **11** 条无工具回答必须全部原样通过

第 7 组的样本抓自真实会话，是这套规则唯一可靠的回归基线——合成用例容易写成「刚好符合规则」的文本。两组样本的 CJK 占比天然分开（泄漏 0.000–0.033，正常回答 0.44–0.74），`CJK_SHARE = 0.15` 落在这段空档中间，不是靠调参凑出来的。

### 为什么不用「包含任意汉字」判断中文

最初的实现用 `CJK.test(text)`：只要文中出现一个汉字就判定为中文正文。这在真实数据上直接失效——泄漏文本里常夹着一句被引用的中文、一个路径、一个 UI 标签，几千字符的英文规划里混进 8 个汉字，就被当成了中文而不予改判（实测漏掉 11 条）。改成按比例判断后全部命中，且 11 条真实中文答案一条未误伤。

## 已知边界

- 泄漏叙事**短于门槛**时不处理：普通英文要求 `minEnglishLength`（100 字符），以「Let me / I'll / Now let me」这类计划口吻开头的才放宽到 `minNarrationLength`（40 字符）。真实泄漏最短 65 字符，正好落在这个区间内。短英文更可能是真答案，所以不能无脑降门槛。
- 无标记英文叙事那条规则只对**纯英文**生效。中文的内部独白（"关键问题是…接下来查一下…"）目前不会被第一层改判，因为中文语料里内部独白和面向用户的短句太难区分，硬判会误伤。这类依靠第二层在回合收尾时兜底。
- 第一层的改判只在响应**调用过工具**时发生（哨兵串和 reasoning 标记除外，它们无条件改判）。一个纯英文、不调工具、也不带任何泄漏特征的回答会被当作最终答案保留——即使它其实是泄漏。这是准确的取舍：没有这些信号时，插件无法从文本本身区分「泄漏的思考」和「用户的答案」。
- 判据是启发式的语言特征，不是模型级的意图理解。换一种模型或换一种网关，泄漏的文本形状可能变，届时第 7 组的基线样本需要重新采集。
- 流层的哨兵串扫描（`isScaffolding`）**没有**中文门槛，而回合收尾的 `detectLeak` 有（那里中文正文引用哨兵串不算泄漏）。所以一段以中文为主的正文里只要出现一个未闭合的 `<thinking>`，整块仍会被搬进思考通道——讨论协议/写教程时要注意。
- 正文以 `summary:`、`analysis:` 之类**裸词**开头会被当成标记，整块搬进思考。这是"识别不带尖括号的标记"的代价；不想要就关 `bareMarkers`。

## 更新与支持

- **不声明版本号。** `package.json` 里的 `version` 只是包管理器的技术要求，不是发版节奏，也不构成兼容性承诺；这个仓库没有 `releases`、没有更新日志承诺。
- **仅按维护者自己的需求更新**，不保证会继续更新，也不保证跟进新版 DSH。能用就用，别把它当有 SLA 的依赖。
- 想要稳定就钉提交：`github:apples1949/dsh-thinking-tag-guard#<sha>`。
- 通过自建索引源安装时，条目钉在某个 commit 上——只有索引被手动刷新时才会变。

## 许可证

MIT
