// Regression suite for @apples1949/dsh-thinking-tag-guard.
//
// The guard rewrites an `llm/stream` chunk stream, so every assertion here feeds
// chunks through `guard()` and checks what a real `BlockAssembler` commits —
// not what the guard "intends" to emit. That distinction matters: the guard can
// only reclassify a block if the assembler accepts the corrected `block-end`
// payload, so the assembler is the oracle.
//
// Usage:
//   node test/run.mjs
//   DSH_LLM=/path/to/@deepseek-ai/dsh-llm/lib/index.js node test/run.mjs
//
// `BlockAssembler` belongs to DSH, not to this plugin, so the suite resolves it
// from the running install. Set `DSH_LLM` when the harness lives somewhere the
// lookup below cannot guess.

import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(TEST_DIR);
const PLUGIN = join(ROOT, "index.js");

/** The harness's own `@deepseek-ai/dsh-llm/lib/index.js`, relative to an install root. */
const llmLib = (installRoot) =>
  join(installRoot, "app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js");

/** Candidate locations of the harness's own `@deepseek-ai/dsh-llm`. */
const ASSEMBLER_CANDIDATES = [
  process.env.DSH_LLM,
  // Installed as one more package inside a profile: the sibling is right there.
  join(ROOT, "node_modules/@deepseek-ai/dsh-llm/lib/index.js"),
  // Windows desktop app, the documented default location.
  process.env.LOCALAPPDATA &&
    llmLib(join(process.env.LOCALAPPDATA, "Programs/DeepSeek Harness/resources")),
  // Escape hatches for a relocated install.
  process.env.DSH_RESOURCES && llmLib(process.env.DSH_RESOURCES),
  process.env.DSH_INSTALL_DIR &&
    join(process.env.DSH_INSTALL_DIR, "dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js"),
].filter((candidate) => typeof candidate === "string" && candidate.length > 0);

const llmPath = ASSEMBLER_CANDIDATES.find((candidate) => existsSync(candidate));
if (llmPath === undefined) {
  console.error(
    "Cannot locate @deepseek-ai/dsh-llm/lib/index.js.\n" +
      "Set DSH_LLM to its absolute path and re-run, e.g.\n" +
      '  DSH_LLM="/path/to/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js" node test/run.mjs',
  );
  process.exit(2);
}
console.log(`assembler: ${llmPath}\nplugin:    ${PLUGIN}\n`);

const mod = await import(pathToFileURL(PLUGIN).href);
const { guard, resolveOptions, detectLeak } = mod;
const { BlockAssembler } = await import(pathToFileURL(llmPath).href);

const opts = resolveOptions({ providers: ["hgapi"] });

let failures = 0;

function check(label, ok, detail) {
  if (!ok) failures += 1;
  const line = `  ${ok ? "PASS" : "FAIL"}  ${label}`;
  console.log(detail === undefined ? line : `${line}  ${detail}`);
}

/** A stream that yields after a macrotask, like a real adapter does. */
async function* source(chunks) {
  for (const chunk of chunks) {
    await new Promise((resolve) => setImmediate(resolve));
    yield chunk;
  }
}

/** Feed chunks through the guard into a real assembler; return committed blocks. */
async function assemble(chunks, options = opts) {
  const assembler = new BlockAssembler();
  for await (const chunk of guard(source(chunks), options)) assembler.push(chunk);
  return assembler.blocks();
}

const types = (blocks) => blocks.map((block) => block.type);

function textBlock(index, text, { withTool = false } = {}) {
  const chunks = [
    { type: "block-start", index, blockType: "text" },
    { type: "text-delta", index, text },
    { type: "block-end", index, block: { type: "text", text } },
  ];
  if (withTool) {
    chunks.push(
      { type: "block-start", index: index + 1, blockType: "tool-call" },
      { type: "tool-call-delta", index: index + 1, id: "c1", name: "ops_bash", argumentsDelta: "{}" },
      { type: "block-end", index: index + 1, block: { type: "tool-call", id: "c1", name: "ops_bash", arguments: "{}" } },
    );
  }
  chunks.push({ type: "finish", reason: { kind: "stop" } });
  return chunks;
}

// English planning monologue: the shape the gateway leaked in the reported
// screenshot. No marker anywhere, so only the narration rule can catch it.
const NARRATION =
  "Confirmed the pattern. Let me check whether the profile layer intercepts the resolver before native resolution, then read the assembler to see how block-end is committed.";

console.log("\n1. leaked narration is reclassified");
check(
  "english narration + tool-call -> no text block",
  !types(await assemble(textBlock(0, NARRATION, { withTool: true }))).includes("text"),
  JSON.stringify(types(await assemble(textBlock(0, NARRATION, { withTool: true }))))
);
check(
  "english narration without a tool-call stays text (the step never kept working)",
  types(await assemble(textBlock(0, NARRATION))).includes("text"),
);
check(
  "narrationGuard: false keeps it as text",
  types(await assemble(textBlock(0, NARRATION, { withTool: true }), resolveOptions({ providers: ["hgapi"], narrationGuard: false }))).includes("text"),
);

console.log("\n2. genuine answers are left alone");
check(
  "short english answer below the length floor stays text",
  types(await assemble(textBlock(0, "Done. Restart the app to load the new plugin code."))).includes("text"),
);
check(
  "english answer with a tool-call is treated as narration",
  !types(await assemble(textBlock(0, NARRATION, { withTool: true }))).includes("text"),
);
check(
  "chinese answer stays text",
  types(await assemble(textBlock(0, "改好了。插件现在会把没有标记的英文独白归到思考通道，最终答案不受影响。"))).includes("text"),
);
check(
  "chinese text alongside a tool-call stays text",
  types(await assemble(textBlock(0, "先确认一下这个文件的实际内容，再决定改哪几行。", { withTool: true }))).includes("text"),
);

console.log("\n3. bracketed markers still route to reasoning");
{
  const blocks = await assemble(
    textBlock(0, "<thinking>The resolver walks upward. I should read the profile layer first.</thinking>现在把解析顺序讲清楚。"),
  );
  check(
    "marker pair -> reasoning + text",
    types(blocks).includes("reasoning") && types(blocks).includes("text"),
    JSON.stringify(types(blocks)),
  );
}

console.log("\n4. sentinel quoting is not a leak (CJK prose)");
check(
  "inline-code quote -> not a leak",
  detectLeak("这个插件靠识别 `\uFF5C\uFF5CDSML\uFF5C\uFF5C` 这类哨兵串来判断泄漏，判定时还会先剔除代码块。", "", opts) !== "marker",
);
check(
  "bare-prose CJK quote -> not a leak",
  detectLeak("它会先匹配 \uFF5C\uFF5CDSML\uFF5C\uFF5C 这类哨兵串，再决定是否接管。", "", opts) !== "marker",
);
check(
  "english sentinel leak -> is a leak",
  detectLeak("Let me run it. </ \uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>", "", opts) === "marker",
);

console.log("\n5. protocol edge shapes");
{
  // A delta-only adapter sends no block-start/block-end at all: the guard has to
  // synthesise the closing chunks, and they must land before `finish`.
  const chunks = [
    { type: "text-delta", index: 0, text: NARRATION },
    { type: "block-start", index: 1, blockType: "tool-call" },
    { type: "tool-call-delta", index: 1, id: "c1", name: "ops_bash", argumentsDelta: "{}" },
    { type: "finish", reason: { kind: "stop" } },
  ];
  const emitted = [];
  for await (const chunk of guard(source(chunks), opts)) emitted.push(chunk);
  const ends = emitted.filter((chunk) => chunk.type === "block-end");
  const finishAt = emitted.findIndex((chunk) => chunk.type === "finish");
  check(
    "delta-only: synthesised block-end is reasoning and precedes finish",
    ends.some((chunk) => chunk.block.type === "reasoning") && finishAt > emitted.indexOf(ends.at(-1)),
    JSON.stringify(ends.map((chunk) => chunk.block.type)),
  );
}
{
  // A truncated stream ends without a finish chunk: held-back blocks must still
  // be flushed, or the text would vanish from the transcript entirely.
  const chunks = [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: NARRATION },
    { type: "block-start", index: 1, blockType: "tool-call" },
  ];
  const emitted = [];
  for await (const chunk of guard(source(chunks), opts)) emitted.push(chunk);
  const ends = emitted.filter((chunk) => chunk.type === "block-end");
  check(
    "truncated stream: held-back block is still emitted",
    ends.length === 1 && ends[0].block.type === "reasoning",
    JSON.stringify(ends.map((chunk) => chunk.block.type)),
  );
}

console.log("\n6. internal data-producing calls are never rewritten");
{
  // Compaction and session-title output is data, not a reply. Reclassifying it
  // would silently empty a summary, so `apply()` must hand the stream back
  // untouched for those purposes. The text chosen here is one the guard *would*
  // rewrite, so an unchanged result proves the purpose check, not luck.
  const leaky = "Let me run it. </ \uFF5C\uFF5CDSML\uFF5C\uFF5C parameter> and then read the file.";
  const chunks = [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: leaky },
    { type: "block-end", index: 0, block: { type: "text", text: leaky } },
    { type: "finish", reason: { kind: "stop" } },
  ];
  let handler;
  mod.apply(
    { on(event, fn) { if (event === "llm/stream") handler = fn; }, logger: { warn() {} } },
    { providers: ["hgapi"] },
  );
  const throughHandler = async (options) => {
    async function* passthrough() {
      for (const chunk of chunks) yield chunk;
    }
    const assembler = new BlockAssembler();
    for await (const chunk of handler(options, passthrough)) assembler.push(chunk);
    return types(assembler.blocks());
  };
  for (const purpose of ["compaction", "session-title"]) {
    const result = await throughHandler({ provider: "hgapi", purpose });
    check(`apply() leaves purpose=${purpose} untouched`, result.includes("text"), JSON.stringify(result));
  }
  const ordinary = await throughHandler({ provider: "hgapi" });
  check("apply() still guards an ordinary turn", !ordinary.includes("text"), JSON.stringify(ordinary));
  const otherProvider = await throughHandler({ provider: "some-other-route" });
  check("apply() leaves unlisted providers untouched", otherProvider.includes("text"), JSON.stringify(otherProvider));
}

console.log("\n7. recorded real-world samples");
{
  // Both sets are taken from real sessions rather than written to fit the rules.
  //
  //   real-leaks.json     — text that cannot be a finished answer: it carries the
  //                         raw tool-call sentinels (the call never parsed into a
  //                         block) or ends on a reasoning close tag, plus plain
  //                         English planning from steps that kept calling tools.
  //                         Every one must be reclassified, whatever its length;
  //                         the shortest is 65 characters, which is why narration
  //                         openers get their own length floor.
  //   no-tool-answers.json — final answers from steps that called no tool and
  //                         carry no leak shape. A tool-less step's text IS the
  //                         answer, so it must survive untouched.
  const load = (file) => JSON.parse(readFileSync(join(TEST_DIR, "fixtures", file), "utf8"));

  const leaks = load("real-leaks.json");
  let caught = 0;
  const missed = [];
  for (const item of leaks) {
    const result = types(await assemble(textBlock(0, item.text, { withTool: true })));
    if (!result.includes("text")) caught += 1;
    else missed.push(`${item.len}ch (turn ${item.turn} step ${item.step})`);
  }
  check(
    `all ${leaks.length} recorded leaks reclassified`,
    caught === leaks.length,
    missed.length === 0 ? `${caught}/${leaks.length}` : `missed ${missed.join(", ")}`,
  );

  const answers = load("no-tool-answers.json");
  let kept = 0;
  const lost = [];
  for (const item of answers) {
    const result = types(await assemble(textBlock(0, item.text)));
    if (result.includes("text")) kept += 1;
    else lost.push(`${item.len}ch (turn ${item.turn} step ${item.step})`);
  }
  check(
    `all ${answers.length} recorded answers pass through`,
    kept === answers.length,
    lost.length === 0 ? `${kept}/${answers.length}` : `reclassified: ${lost.join(", ")}`,
  );
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
