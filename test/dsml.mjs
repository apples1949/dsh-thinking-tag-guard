import { strict as assert } from "node:assert";
import { apply, sanitizeDsml, stripDsml } from "../index.js";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

async function collect(stream) {
  const out = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

// --- stripDsml -------------------------------------------------------------

check("complete closing tag", () => {
  assert.equal(stripDsml("a</|DSML|parameter>b"), "ab");
});

check("invoke pair", () => {
  assert.equal(stripDsml('<|DSML|invoke name="x">call</|DSML|invoke>ok'), "callok");
});

check("calls pair", () => {
  assert.equal(stripDsml("x<|DSML|calls>y</|DSML|calls>z"), "xyz");
});

check("endoftext token", () => {
  assert.equal(stripDsml("hi<|endoftext|>"), "hi");
});

check("ordinary html untouched", () => {
  assert.equal(stripDsml('<a href="u">link</a>'), '<a href="u">link</a>');
});

check("comparison operators untouched", () => {
  assert.equal(stripDsml("if (a<b) {}"), "if (a<b) {}");
});

// --- sanitizeDsml ----------------------------------------------------------

check("token split across deltas", async () => {
  async function* source() {
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "先执行</|DS" };
    yield { type: "text-delta", index: 0, text: "ML|parameter> 然后继续" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "先执行</|DSML|parameter> 然后继续" } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
  const out = await collect(sanitizeDsml(source()));
  const deltas = out.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
  assert.equal(deltas, "先执行 然后继续");
  const end = out.find((c) => c.type === "block-end");
  assert.equal(end.block.text, "先执行 然后继续");
});

check("every split point stays clean", async () => {
  const raw = "前</|DSML|parameter>中<|DSML|calls>x</|DSML|calls>后";
  for (let i = 0; i <= raw.length; i += 1) {
    async function* source() {
      yield { type: "text-delta", index: 1, text: raw.slice(0, i) };
      yield { type: "text-delta", index: 1, text: raw.slice(i) };
      yield { type: "block-end", index: 1, block: { type: "text", text: raw } };
    }
    const out = await collect(sanitizeDsml(source()));
    const deltas = out.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
    assert.equal(deltas, "前中x后", `split at ${i}`);
  }
});

check("reasoning channel cleaned too", async () => {
  async function* source() {
    yield { type: "reasoning-delta", index: 0, text: "plan</|DSML|parameter>" };
    yield { type: "block-end", index: 0, block: { type: "reasoning", text: "plan</|DSML|parameter>" } };
  }
  const out = await collect(sanitizeDsml(source()));
  assert.equal(out[0].text, "plan");
  assert.equal(out[1].block.text, "plan");
});

// --- apply wiring ----------------------------------------------------------

check("only the configured provider is sanitized", async () => {
  const handlers = {};
  apply({ on: (name, fn) => { handlers[name] = fn; }, logger: { warn() {} } }, { providers: ["hgapi"] });

  const stream = () => (async function* () {
    yield { type: "text-delta", index: 0, text: "x</|DSML|calls>" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "x</|DSML|calls>" } };
  })();

  const guarded = await collect(handlers["llm/stream"]({ provider: "hgapi" }, stream));
  assert.equal(JSON.stringify(guarded).includes("DSML"), false);

  const passthrough = await collect(handlers["llm/stream"]({ provider: "other" }, stream));
  assert.equal(JSON.stringify(passthrough).includes("DSML"), true);
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
