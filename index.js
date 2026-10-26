/**
 * Route-scoped guard for gateways that intermittently stream reasoning as
 * assistant text.
 *
 * The dieqiyun gateway sometimes returns a model's reasoning in the `content`
 * channel instead of `reasoning_content`, dressed in reasoning scaffolding:
 * `<thinking>…</thinking>`, `thinking … /thinking`, `<summary>…</summary>`, split
 * across many deltas, sometimes carrying only one side, sometimes with no angle
 * brackets at all. It also sometimes replays the whole reasoning verbatim as one
 * long text delta. pi-ai's inbound parser only reads `reasoning_content` /
 * `reasoning` / `reasoning_text`, so nothing downstream can recover it: the
 * scaffolding would be rendered as literal assistant text.
 *
 * Worse, the turn then ends *silently*: the leaked step contains no tool-call
 * block, so `dsh-agent-loop`'s `step()` takes
 * `if (toolCalls.length === 0) return { kind: "completed" }` and the turn
 * closes with `{ kind: "completed" }` — no error, no notice.
 *
 * Two layers fix this, both scoped to `providers`:
 *
 * 1. `llm/stream` — rewrites leaked reasoning back into reasoning blocks before
 *    assembly. The adapter's block index is kept for the first segment; every
 *    later segment gets a synthetic index, so one index never carries two block
 *    types and the `BlockAssembler`'s first-touch rule and `block-end.block`
 *    stay in agreement.
 *
 * 2. `agent/turn-stopping` — the documented hook that runs before an otherwise
 *    completed turn closes and can steer to keep it open. When a turn is about
 *    to close on a step that called no tool and whose text is a leaked
 *    reasoning / tool-call artifact, the guard steers the agent to continue
 *    instead of letting the turn end silently. It also nudges a turn that is
 *    about to end on English-only prose back into the user's language.
 *
 * ## Marker grammar (layer 1)
 *
 * A marker is any name in {@link MARKER_NAMES}, case-insensitively, in any of
 * these spellings — with or without angle brackets:
 *
 * | where                                      | accepted spellings                    |
 * | ------------------------------------------ | ------------------------------------- |
 * | block head (after leading whitespace)       | `<name>`, `</name>`, `name`, `/name`  |
 * | block tail (its very end)                   | `</name>`, `/name`                    |
 * | inside a block, paired with its close tag   | `<name>` … `</name>`                  |
 *
 * So all of these move their payload into the reasoning channel:
 *
 * - `<thinking>why …</thinking>`
 * - `thinking why … /thinking` — no brackets on either side
 * - `thinking why …` — the opening word alone
 * - `why … /thinking` — the closing word alone, at the end of the block
 * - `<summary>…</summary>`, `summary …`, `<analysis>…</analysis>`, `analyse …`, …
 *
 * A head marker is routed while the block still streams. Two shapes cannot be
 * known before the block is complete: a lone closing marker at the very end
 * (whole block was reasoning), and a mid-block pair. The tail case finishes by
 * rewriting the block's `block-end` payload into a reasoning block, so the
 * durable assistant message keeps the leaked text in the reasoning channel
 * (the live view may have shown it as text until the step committed); the pair
 * case only splits once its closing tag actually arrived, so a lone quoted
 * `<thinking>` mention in ordinary prose stays text. Both are switchable with
 * `tailMarkers: false` / `bareMarkers: false`.
 *
 * @module @apples1949/dsh-thinking-tag-guard
 */

import { randomUUID } from "node:crypto";

/** Cordis plugin name used by Loader diagnostics. */
const name = "thinking-tag-guard";

/** The `llm` service owns the `llm/stream` waterfall this plugin joins. */
const inject = ["llm"];

/** Reasoning scaffolding that is routed into the reasoning channel, in any spelling. */
const MARKER_NAMES = [
  "thinking",
  "thought",
  "reasoning",
  "reflection",
  "summary",
  "analysis",
  "analyse",
  "scratchpad",
];

/**
 * Names that never legitimately open an assistant answer, so a bare
 * `name: …` head counts as leaked narration too.
 */
const NARRATION_NAMES = ["thinking", "thought", "reasoning", "reflection", "scratchpad"];

/** Provider routes this guard applies to when neither config nor env narrows it. */
const DEFAULT_PROVIDERS = ["dieqiyun"];

/** Synthetic index base for a segment split out of the adapter's text block. */
const SYNTHETIC_INDEX_BASE = 1_000_000;

const WHITESPACE = /\s/;

const NAMES = MARKER_NAMES.join("|");
const NARRATION = NARRATION_NAMES.join("|");

/** `<thinking>`, `<summary >`, … at the head of a block. */
const BRACKETED_OPEN = new RegExp(`^<\\s*(?:${NAMES})\\s*>`, "i");

/** `</thinking>`, `</summary >`, … at the head of a block. */
const BRACKETED_CLOSE = new RegExp(`^</\\s*(?:${NAMES})\\s*>`, "i");

/** Bare `thinking`, `summary`, … at the head of a block, bounded by a non-word character. */
const BARE_OPEN = new RegExp(`^(?:${NAMES})(?![A-Za-z0-9_-])`, "i");

/** `/thinking`, `/thinking>`, … — the bracket-less closing spelling. */
const SLASH_CLOSE = new RegExp(`^/\\s*(?:${NAMES})(?![A-Za-z0-9_-])\\s*>?`, "i");

/** Any bracketed opening marker, i.e. the left half of a pair. */
const ANY_BRACKETED_OPEN = new RegExp(`<\\s*(?:${NAMES})\\s*>`, "i");

/** The same, for stripping every nested marker out of routed reasoning text. */
const ANY_BRACKETED_OPEN_GLOBAL = new RegExp(`<\\s*(?:${NAMES})\\s*>`, "gi");

/** Any closing marker, bracketed or bracket-less. */
const ANY_CLOSE = new RegExp(`</\\s*(?:${NAMES})\\s*>|/\\s*(?:${NAMES})(?![A-Za-z0-9_-])\\s*>?`, "i");

/** A closing marker at the very end of a block, which makes the whole block reasoning. */
const TAIL_CLOSE = new RegExp(`(?:</\\s*(?:${NAMES})\\s*>|/\\s*(?:${NAMES})(?![A-Za-z0-9_-])\\s*>?)\\s*$`, "i");

/** Any bracketed marker, used by the committed-message leak scan. */
const BRACKETED_MARKER_ANYWHERE = new RegExp(`</?\\s*(?:${NAMES})\\s*>`, "i");

/** Whitespace and an optional `:` a bracket-less marker leaves behind. */
const MARKER_SEPARATOR = /^[\s\u00a0]*(?:[:：]\s*)?/;

/** Longest closing marker: the tail a reasoning writer must hold back. */
const MAX_CLOSE_LEN = Math.max(...MARKER_NAMES.map((marker) => `</${marker}>`.length));

/** Longest opening marker plus slack: the tail a text segment must hold back. */
const TEXT_HOLD = Math.max(...MARKER_NAMES.map((marker) => `<${marker}>`.length)) + 4;

/**
 * Text shapes that only ever appear when a gateway leaked its own scaffolding
 * into the assistant text channel: raw tool-call sentinels, unclosed tool-call
 * XML, compaction wrappers, and any bracketed reasoning marker.
 */
const LEAK_PATTERNS = [
  /｜｜\s*DSML/,
  /DSML\s*｜｜/,
  /<parameter\s+name=/,
  /<\/parameter>/,
  /<function_calls>|antml:invoke/,
  /<(?:compacted|context)-summary>/i,
  BRACKETED_MARKER_ANYWHERE,
];

/** An answer that opens by narrating a marker instead of addressing the user. */
const THINKING_PREFIX = new RegExp(
  `^\\s*(?:</?\\s*(?:${NAMES})\\s*>|/\\s*(?:${NAMES})(?![A-Za-z0-9_-])|(?:${NARRATION})\\s*[:：\\n])`,
  "i",
);

/**
 * Openers that only ever begin the model narrating its own next move.
 *
 * The length floor below cannot catch these on its own: real leaks in the
 * recorded sessions ran as short as 73 characters ("I'll start by looking at
 * the zip file…"). A plan always *starts* by announcing itself, so the opener
 * is the reliable signal — a finished answer does not open with "let me".
 * Deliberately excludes conclusion openers such as "Done." / "Confirmed.",
 * which do open real answers.
 */
const NARRATION_HEAD =
  /^(?:let me|let's|i'll|i will|i'm going to|i should|i need to|now let me|now i'll|now let's|next,? let me|first,? let me|so let me|okay,? let me|ok,? let me|checking|looking at)/i;

/** Shortest text pair that may be judged "the gateway replayed the reasoning". */
const MIN_DUPLICATE_LENGTH = 120;

/** Defaults for every knob `resolveOptions` understands. */
const DEFAULT_OPTIONS = {
  intervene: true,
  dedupeReasoning: true,
  bareMarkers: true,
  tailMarkers: true,
  narrationGuard: true,
  /** Call purposes whose output is data (a summary, a title), never a reply. */
  skipPurposes: ["compaction", "session-title"],
  minReplayDelta: 200,
  minEnglishLength: 100,
  /** Lower floor for prose that opens by narrating its own plan. */
  minNarrationLength: 40,
  maxContinuePerTurn: 2,
  maxLanguageNudgesPerTurn: 1,
  continuePrompt:
    "继续。上一步没有调用任何工具，只是把思考过程（或工具调用的原始标记）漏进了正文，这一步不算完成。请忽略上面那段泄漏文本，继续用工具推进当前任务；如果任务确实已经完成，请重新给出简洁的最终结论。",
  languageNudge: "继续，用中文回答我",
};

/**
 * CJK ideographs, kana, Hangul, and the ideographic-symbol blocks.
 *
 * The punctuation ranges are deliberately absent. Both users of this regex ask
 * "does this text carry CJK *words*?": the leak scan uses it to tell a Chinese
 * answer that quotes a sentinel from an English leak, and the language check
 * uses it to tell prose from an all-English answer. A fullwidth vertical bar or
 * fullwidth bracket is punctuation that the sentinels themselves are built from
 * — counting it as CJK made an English leak read as Chinese and slip through.
 */
const CJK_CHARS =
  /[\u2E80-\u2EFF\u3040-\u30FF\u3100-\u312F\u31A0-\u31BF\u3200-\u32FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/** The same ranges, global, for counting rather than testing. */
const CJK_CHARS_GLOBAL = new RegExp(CJK_CHARS.source, "g");

/**
 * Share of visible characters that must be CJK before text counts as Chinese.
 *
 * A boolean "contains any CJK" test is wrong for both callers: the recorded
 * leaks carry a handful of CJK characters (a quoted Chinese sentence, a path, a
 * UI label) inside thousands of characters of English planning — 0.0000 to
 * 0.033 in the fixtures — while recorded Chinese answers start at 0.44. The gap
 * is an order of magnitude wide, so a low threshold separates them cleanly
 * without being sensitive to exactly where it lands.
 */
const CJK_SHARE = 0.15;

/**
 * Whether a text is predominantly CJK, ignoring code and whitespace.
 *
 * @param text - the text to judge.
 * @returns whether the text is a Chinese-language body.
 */
function isCJKText(text) {
  const prose = stripCode(text);
  const visible = prose.replace(/\s/g, "");
  if (visible.length === 0) return false;
  const matches = prose.match(CJK_CHARS_GLOBAL);
  if (matches === null) return false;
  return matches.length / visible.length >= CJK_SHARE;
}

/**
 * Whether a partial word could still become a marker name.
 *
 * @param word - the letters seen so far.
 * @returns whether some marker name starts with them.
 */
function viableNamePrefix(word) {
  if (word.length === 0) return true;
  const lower = word.toLowerCase();
  return MARKER_NAMES.some((marker) => marker.startsWith(lower));
}

/**
 * Whether a head that has not matched a marker yet could still grow into one,
 * so the guard must keep buffering instead of committing to ordinary text.
 *
 * @param rest - the head after leading whitespace.
 * @returns whether more deltas could complete a marker.
 */
function couldBecomeMarker(rest) {
  let index = 0;
  if (rest[index] === "<") {
    index += 1;
    if (rest[index] === "/") index += 1;
  } else if (rest[index] === "/") {
    index += 1;
  }
  while (index < rest.length && WHITESPACE.test(rest[index])) index += 1;
  const start = index;
  while (index < rest.length && /[A-Za-z]/.test(rest[index])) index += 1;
  const word = rest.slice(start, index);
  if (!MARKER_NAMES.some((marker) => marker === word.toLowerCase())) {
    // The name is still incomplete: viable only while no non-letter arrived.
    if (index !== rest.length) return false;
    return viableNamePrefix(word);
  }
  // The name is complete: what follows decides, so more input is needed.
  while (index < rest.length && WHITESPACE.test(rest[index])) index += 1;
  return index === rest.length || rest[index] === ">";
}

/**
 * Decide what an accumulated text-block head is.
 *
 * @param buffer - everything seen for the block so far.
 * @param final - whether the block has ended, so a bare name at its end counts.
 * @param opts - resolved options.
 * @returns the matched marker (its length and whether it was bracket-less),
 *   `null` for ordinary text, or `undefined` while more input is needed.
 */
function classifyHead(buffer, final, opts) {
  let start = 0;
  while (start < buffer.length && WHITESPACE.test(buffer[start])) start += 1;
  const rest = buffer.slice(start);
  if (rest.length === 0) return undefined;

  const bracketed = BRACKETED_OPEN.exec(rest) ?? BRACKETED_CLOSE.exec(rest);
  if (bracketed !== null) return { length: start + bracketed[0].length, bare: false };
  const slash = SLASH_CLOSE.exec(rest);
  if (slash !== null) return { length: start + slash[0].length, bare: true };
  if (opts.bareMarkers) {
    const bare = BARE_OPEN.exec(rest);
    if (bare !== null) {
      // A bare name needs the character after it: `thinking…` is a marker only
      // once something other than a word character (or the block end) follows.
      if (final || bare[0].length < rest.length) return { length: start + bare[0].length, bare: true };
      return undefined;
    }
  }
  if (couldBecomeMarker(rest)) return undefined;
  return null;
}

/**
 * Drop the whitespace (and an optional colon) a bracket-less marker leaves in
 * front of its payload.
 *
 * @param text - the text after the marker.
 * @param bare - whether the marker had no angle brackets.
 * @returns the payload to route.
 */
function stripSeparator(text, bare) {
  return bare ? text.replace(MARKER_SEPARATOR, "") : text;
}

/**
 * Streams reasoning content, holding back a short tail so a closing marker
 * split across deltas is never emitted, and reporting what followed it.
 */
class ReasoningWriter {
  constructor() {
    this.pending = "";
    this.closed = false;
  }

  /**
   * Feed one delta.
   *
   * @param delta - the incoming text.
   * @returns reasoning text safe to emit, plus any text that followed the
   *   closing marker.
   */
  push(delta) {
    if (this.closed) return { reasoning: "", trailing: delta };
    this.pending += delta;
    const match = ANY_CLOSE.exec(this.pending);
    if (match !== null) {
      const reasoning = this.pending.slice(0, match.index);
      const trailing = this.pending.slice(match.index + match[0].length);
      this.pending = "";
      this.closed = true;
      return { reasoning, trailing };
    }
    // No closing marker yet: emit all but a tail that could begin one.
    const keep = MAX_CLOSE_LEN - 1;
    if (this.pending.length > keep) {
      const reasoning = this.pending.slice(0, this.pending.length - keep);
      this.pending = this.pending.slice(this.pending.length - keep);
      return { reasoning, trailing: "" };
    }
    return { reasoning: "", trailing: "" };
  }

  /** Flush whatever is still held back, e.g. at block end. */
  flush() {
    if (this.closed) return { reasoning: "", trailing: "" };
    const reasoning = this.pending;
    this.pending = "";
    return { reasoning, trailing: "" };
  }
}

/**
 * Routes one adapter text block into reasoning and text segments.
 *
 * The adapter's index is reused for the first segment; every later segment gets
 * a synthetic index so that one index never carries two block types.
 */
class BlockRouter {
  /**
   * @param origin - the adapter's block index.
   * @param opts - resolved options.
   * @param hooks - `nextIndex()` for synthetic segments,
   *   `rememberReasoning(text)` for the replay-dedupe ledger, and
   *   `isReplay(text)` to recognise a verbatim reasoning replay.
   */
  constructor(origin, opts, hooks) {
    this.origin = origin;
    this.opts = opts;
    this.hooks = hooks;
    /** `unclassified` | `text` | `reasoning` */
    this.mode = "unclassified";
    this.pending = "";
    this.segments = 0;
    this.index = undefined;
    this.type = undefined;
    /** Visible content of the current segment, markers already stripped. */
    this.text = "";
    /** How many characters of `text` were emitted as deltas. */
    this.emitted = 0;
    this.writer = null;
    /** Set while an opening marker waits for its closing partner. */
    this.pair = undefined;
    /** Whether the adapter's `block-end` (or the stream end) already closed this block. */
    this.done = false;
    /**
     * Whether this block closed as one whole ordinary text segment, so the
     * guard may still reclassify it once the response shape is known.
     */
    this.plainText = false;
  }

  /**
   * Open a segment and emit its `block-start`.
   *
   * @param type - the block type to open.
   * @param out - the chunk sink.
   */
  open(type, out) {
    this.segments += 1;
    this.index = this.segments === 1 ? this.origin : this.hooks.nextIndex();
    this.type = type;
    this.text = "";
    this.emitted = 0;
    this.pair = undefined;
    this.writer = type === "reasoning" ? new ReasoningWriter() : null;
    this.plainText = false;
    out.push({ type: "block-start", index: this.index, blockType: type });
  }

  /**
   * Close the current segment.
   *
   * @param out - the chunk sink.
   * @param block - an explicit payload, used when the block type is corrected.
   */
  close(out, block) {
    out.push({ type: "block-end", index: this.index, block: block ?? { type: this.type, text: this.text } });
    this.index = undefined;
    this.type = undefined;
    this.text = "";
    this.emitted = 0;
    this.pair = undefined;
    this.writer = null;
  }

  /**
   * Append reasoning content and emit it as `reasoning-delta`, without any
   * nested scaffolding marker that leaked along with it.
   *
   * @param text - the reasoning content.
   * @param out - the chunk sink.
   */
  emitReasoning(text, out) {
    if (text.length === 0) return;
    const clean = text.replace(ANY_BRACKETED_OPEN_GLOBAL, "");
    this.text += clean;
    this.emitted += clean.length;
    this.hooks.rememberReasoning(clean);
    if (clean.length > 0) out.push({ type: "reasoning-delta", index: this.index, text: clean });
  }

  /**
   * Stream reasoning until a closing marker, then route whatever followed it.
   *
   * @param delta - the incoming text.
   * @param out - the chunk sink.
   */
  feedReasoning(delta, out) {
    if (delta.length === 0) return;
    const { reasoning, trailing } = this.writer.push(delta);
    this.emitReasoning(reasoning, out);
    if (trailing.length === 0) return;
    this.close(out, { type: "reasoning", text: this.text });
    this.mode = "unclassified";
    this.pending = "";
    this.feedUnclassified(trailing, out);
  }

  /**
   * Stream ordinary text, splitting out a bracketed pair once it is complete.
   *
   * @param out - the chunk sink.
   */
  flushText(out) {
    for (;;) {
      if (this.pair !== undefined) {
        const after = this.text.slice(this.pair.at + this.pair.markerLength);
        const close = this.pairClose(after);
        if (close === null) return; // wait for the partner or the block end
        const head = this.text.slice(0, this.pair.at);
        const inner = after.slice(0, close.index);
        const rest = after.slice(close.index + close.length);
        this.pair = undefined;
        this.close(out, { type: "text", text: head });
        this.mode = "reasoning";
        this.open("reasoning", out);
        this.emitReasoning(inner, out);
        this.close(out, { type: "reasoning", text: this.text });
        this.mode = "unclassified";
        this.feedUnclassified(rest, out);
        return;
      }

      const window = this.text.slice(this.emitted);
      const match = ANY_BRACKETED_OPEN.exec(window);
      if (match !== null) {
        const before = window.slice(0, match.index);
        if (before.length > 0) {
          this.emitted += before.length;
          out.push({ type: "text-delta", index: this.index, text: before });
        }
        // Hold from the opening marker until its partner proves the pair; the
        // partner may already be sitting in this same delta.
        this.pair = { at: this.emitted, markerLength: match[0].length };
        continue;
      }
      // Hold back a tail that could still begin a marker in the next delta.
      const keep = Math.min(TEXT_HOLD, window.length);
      if (window.length <= keep) return;
      const emit = window.slice(0, window.length - keep);
      this.emitted += emit.length;
      out.push({ type: "text-delta", index: this.index, text: emit });
      return;
    }
  }

  /**
   * Find the closing marker that completes the pending pair.
   *
   * @param after - the text following the opening marker.
   * @returns the match with its `length`, or `null` while it may still arrive.
   */
  pairClose(after) {
    const match = ANY_CLOSE.exec(after);
    if (match === null) return null;
    return { index: match.index, length: match[0].length };
  }

  /**
   * Buffer a head until it can be classified, then commit to a segment type.
   *
   * @param delta - the incoming text.
   * @param out - the chunk sink.
   */
  feedUnclassified(delta, out) {
    this.pending += delta;
    const decision = classifyHead(this.pending, false, this.opts);
    if (decision === undefined) return; // still undecided: keep buffering

    const buffered = this.pending;
    this.pending = "";
    if (decision === null) {
      if (this.hooks.isReplay(buffered)) {
        // The gateway replayed the reasoning as one long "content" delta. Keep
        // it in the reasoning channel: it is not an answer.
        this.mode = "reasoning";
        this.open("reasoning", out);
        this.feedReasoning(buffered, out);
        return;
      }
      this.mode = "text";
      this.open("text", out);
      this.text += buffered;
      this.flushText(out);
      return;
    }
    const payload = stripSeparator(buffered.slice(decision.length), decision.bare);
    if (payload.trim().length === 0) return; // a marker alone routes nothing
    this.mode = "reasoning";
    this.open("reasoning", out);
    this.feedReasoning(payload, out);
  }

  /**
   * Feed one adapter text delta.
   *
   * @param delta - the incoming text.
   * @param out - the chunk sink.
   */
  push(delta, out) {
    if (this.mode === "unclassified") {
      this.feedUnclassified(delta, out);
      return;
    }
    if (this.mode === "text") {
      this.text += delta;
      this.flushText(out);
      return;
    }
    this.feedReasoning(delta, out);
  }

  /**
   * Finish the block: close the last segment and apply the tail rule.
   *
   * @param out - the chunk sink.
   */
  end(out) {
    if (this.done) return; // a closing straggler must not reopen the block
    this.done = true;
    if (this.mode === "unclassified") {
      const decision = classifyHead(this.pending, true, this.opts);
      const buffered = this.pending;
      this.pending = "";
      // A leftover that carries nothing (the empty tail after a nested close)
      // must not open an empty segment.
      if (this.segments > 0 && buffered.trim().length === 0) return;
      if (decision === null || decision === undefined) {
        if (this.hooks.isReplay(buffered)) {
          this.mode = "reasoning";
          this.open("reasoning", out);
          this.feedReasoning(buffered, out);
        } else {
          this.mode = "text";
          this.open("text", out);
          this.text += buffered;
          this.flushText(out);
        }
      } else {
        const payload = stripSeparator(buffered.slice(decision.length), decision.bare);
        if (payload.trim().length === 0) return; // a marker alone routes nothing
        this.mode = "reasoning";
        this.open("reasoning", out);
        this.feedReasoning(payload, out);
      }
    }

    if (this.mode === "reasoning") {
      this.emitReasoning(this.writer.flush().reasoning, out);
      this.close(out, { type: "reasoning", text: this.text });
      return;
    }

    if (this.mode === "text") {
      const tail = this.opts.tailMarkers ? TAIL_CLOSE.exec(this.text) : null;
      if (tail !== null) {
        // A closing marker at the very end and nothing else: the whole block was
        // leaked reasoning. The text deltas already streamed stay recorded; the
        // durable block is this corrected payload.
        const text = this.text.replace(TAIL_CLOSE, "").trimEnd();
        this.hooks.rememberReasoning(text);
        this.close(out, { type: "reasoning", text });
        return;
      }
      const window = this.text.slice(this.emitted);
      if (window.length > 0) {
        this.emitted += window.length;
        out.push({ type: "text-delta", index: this.index, text: window });
      }
      // One whole text segment with no marker anywhere: the only shape the guard
      // may still reclassify at stream end, once it knows the response called a
      // tool (narration) or did not (a real answer, left alone).
      this.plainText = this.segments === 1;
      this.close(out, { type: "text", text: this.text });
    }
  }
}

/**
 * Rewrite one provider's chunk stream so leaked reasoning stays reasoning.
 *
 * @param stream - the downstream chunk stream.
 * @param opts - resolved options.
 * @returns the rewritten stream.
 */
const DSML_TAG_RE = /<\/?\|[A-Za-z0-9_.:-]{1,32}\|[^<>]{0,400}?>/g;

/** Longest tail kept back while waiting for a tag that may span chunks. */
const DSML_TAIL_LIMIT = 420;

/**
 * Remove the gateway's private special tokens (`<|DSML|parameter ...>`,
 * `</|DSML|invoke>`, `<|endoftext|>`, ...) from one chunk of text.
 *
 * The client never renders them; when a relay forgets to mask them they end up
 * in the visible answer or in the thinking pane as literal noise.
 *
 * @param text - raw text.
 * @returns the text without well-formed special tokens.
 */
function stripDsml(text) {
  return text.replace(DSML_TAG_RE, "");
}

/**
 * How much of `text` must stay buffered because it may be the head of a special
 * token cut in half by the chunk boundary.
 *
 * A lone `<` at the very end is held back; as soon as a `>` arrives the tail can
 * no longer grow into a token and is released. Plain `<` inside ordinary text
 * costs at most one chunk of latency and is always released.
 *
 * @param text - buffered text after token removal.
 * @returns the index where the releasable prefix ends.
 */
function releasablePrefix(text) {
  const head = text.lastIndexOf("<");
  if (head < 0) return text.length;
  const tail = text.slice(head);
  if (tail.includes(">")) return text.length;
  return tail.length <= DSML_TAIL_LIMIT ? head : text.length;
}

/**
 * Drop private special tokens from a chunk stream, including tokens split
 * across deltas.
 *
 * Sits outside `guard()` so it also cleans text the guard moved into the
 * reasoning channel, and cleans both channels alike.
 *
 * @param stream - the downstream chunk stream.
 * @returns the cleaned stream.
 */
function sanitizeDsml(stream) {
  return (async function* () {
    /** index -> un-releasable tail */
    const pending = new Map();

    const emitDelta = function* (chunk, text) {
      const previous = pending.get(chunk.index) ?? "";
      const merged = stripDsml(previous + text);
      const cut = releasablePrefix(merged);
      pending.set(chunk.index, merged.slice(cut));
      const out = merged.slice(0, cut);
      if (out.length > 0) yield { ...chunk, text: out };
    };

    for await (const chunk of stream) {
      const type = chunk?.type;
      if ((type === "text-delta" || type === "reasoning-delta") && typeof chunk.text === "string") {
        yield* emitDelta(chunk, chunk.text);
        continue;
      }
      if (type === "block-end" && chunk.block !== undefined) {
        // Release whatever the block still holds before closing it.
        const tail = pending.get(chunk.index) ?? "";
        pending.delete(chunk.index);
        const text = typeof chunk.block.text === "string" ? chunk.block.text : undefined;
        if (text !== undefined) {
          // `block.text` is the whole block, already streamed as deltas: only
          // clean it for the persisted record, never re-emit it as a delta.
          const tailClean = stripDsml(tail);
          if (tailClean.length > 0) {
            const channel = chunk.block.type === "reasoning" ? "reasoning-delta" : "text-delta";
            yield { type: channel, index: chunk.index, text: tailClean };
          }
          yield { ...chunk, block: { ...chunk.block, text: stripDsml(text) } };
          continue;
        }
        if (tail.length > 0) {
          yield { type: "text-delta", index: chunk.index, text: stripDsml(tail) };
        }
        yield chunk;
        continue;
      }
      yield chunk;
    }

    for (const [index, tail] of pending) {
      const rest = stripDsml(tail);
      if (rest.length > 0) yield { type: "text-delta", index, text: rest };
    }
  })();
}

function guard(stream, opts) {
  return (async function* () {
    /** index -> state */
    const states = new Map();
    let syntheticCounter = 0;
    /** Every reasoning delta this response has produced, verbatim. */
    let reasoningText = "";
    /** Whether this response called a tool, i.e. kept working after the text. */
    let sawToolCall = false;
    /** Text block-ends held back until the response shape is known. */
    const deferred = [];

    const hooks = {
      nextIndex() {
        syntheticCounter += 1;
        return SYNTHETIC_INDEX_BASE + syntheticCounter;
      },
      rememberReasoning(text) {
        reasoningText += text;
      },
      isReplay(text) {
        return isReasoningReplay(text, reasoningText, opts);
      },
    };

    /** Whether a text block carries leaked scaffolding rather than an answer. */
    const isScaffolding = (text) => opts.leakPatterns.some((pattern) => pattern.test(stripCode(text)));

    /** Whether a closing text block is worth holding back: it may still leak. */
    const isCandidate = (block) => {
      const text = typeof block?.text === "string" ? block.text : "";
      if (text.trim().length === 0) return false;
      if (isScaffolding(text)) return true;
      return opts.narrationGuard && isEnglishProse(text, opts);
    };

    /**
     * Emit the held-back block-ends, now that the response shape is known.
     *
     * A text block that only ever leaked scaffolding, or that narrated in
     * English while the step kept calling tools, is not an answer: hand it to
     * the reasoning channel. A text block in a response that called no tool is
     * the answer itself and is emitted unchanged.
     */
    function* flushDeferred() {
      for (const chunk of deferred) {
        const block = chunk.block;
        const text = typeof block.text === "string" ? block.text : "";
        const leaked =
          isScaffolding(text) || (opts.narrationGuard && sawToolCall && isEnglishProse(text, opts));
        yield leaked ? { type: "block-end", index: chunk.index, block: { type: "reasoning", text } } : chunk;
      }
      deferred.length = 0;
    }

    /** Close one router, holding its block-end back when it may still leak. */
    function* endRouter(state) {
      const out = [];
      state.router.end(out);
      const last = out[out.length - 1];
      if (last !== undefined && last.type === "block-end" && state.router.plainText && isCandidate(last.block)) {
        out.pop();
        deferred.push(last);
      }
      yield* out;
    }

    for await (const chunk of stream) {
      switch (chunk.type) {
        case "block-start": {
          if (chunk.blockType === "tool-call") sawToolCall = true;
          if (chunk.blockType !== "text") {
            states.set(chunk.index, { kind: "passthrough" });
            yield chunk;
            break;
          }
          states.set(chunk.index, { kind: "router", router: new BlockRouter(chunk.index, opts, hooks) });
          break; // the block-start is deferred until the head is classified
        }

        case "text-delta": {
          let state = states.get(chunk.index);
          if (state === undefined) {
            // Delta-only protocol: guard the block even without a block-start.
            state = { kind: "router", router: new BlockRouter(chunk.index, opts, hooks) };
            states.set(chunk.index, state);
          }
          if (state.kind !== "router") {
            yield chunk;
            break;
          }
          const out = [];
          state.router.push(chunk.text, out);
          yield* out;
          break;
        }

        case "block-end": {
          const state = states.get(chunk.index);
          if (state === undefined || state.kind !== "router") {
            yield chunk;
            break;
          }
          yield* endRouter(state);
          break;
        }

        case "finish": {
          // A response that finishes is complete: close every block still open
          // (a delta-only protocol sends no `block-end` at all), then settle the
          // held-back ones, so the assembler sees them all before the terminal
          // chunk rather than after it.
          for (const state of states.values()) {
            if (state.kind === "router") yield* endRouter(state);
          }
          yield* flushDeferred();
          yield chunk;
          break;
        }

        default: {
          // Native reasoning deltas never pass through the text classifier, so
          // remember them here: they are what a leaked replay is compared to.
          if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
            reasoningText += chunk.text;
          }
          if (chunk.type === "tool-call-delta") sawToolCall = true;
          yield chunk;
          break;
        }
      }
    }

    // A delta-only stream may end without ever closing its blocks: finish every
    // open block so nothing held back is lost.
    for (const state of states.values()) {
      if (state.kind !== "router") continue;
      yield* endRouter(state);
    }
    yield* flushDeferred();
  })();
}

/** Concatenate the visible answer text of a committed assistant message. */
function textOf(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Concatenate the reasoning text of a committed assistant message. */
function reasoningOf(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block && block.type === "reasoning" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Whether a text block is the reasoning we already streamed, replayed verbatim.
 *
 * The gateway emits the leaked copy as a *single* long delta, while a genuine
 * answer always opens with a few characters, so requiring a long head keeps
 * this from ever delaying or misclassifying normal output.
 *
 * @param text - the accumulated head of the candidate text block.
 * @param reasoningText - everything the stream already delivered as reasoning.
 * @param opts - resolved options.
 * @returns whether the block is a replay of the reasoning.
 */
function isReasoningReplay(text, reasoningText, opts) {
  if (!opts.dedupeReasoning) return false;
  const candidate = text.trim();
  if (candidate.length < opts.minReplayDelta) return false;
  const reasoning = reasoningText.trim();
  if (reasoning.length < opts.minReplayDelta) return false;
  if (candidate === reasoning) return true;
  if (candidate.startsWith(reasoning)) return true;
  if (reasoning.startsWith(candidate) && candidate.length >= reasoning.length * 0.8) return true;
  return false;
}

/**
 * Classify a committed assistant message as a leaked step.
 *
 * Only meaningful when the step called no tool: any tool call means the turn
 * continues normally and nothing was stopped silently.
 *
 * @param text - the visible answer text.
 * @param reasoningText - the reasoning text.
 * @param opts - resolved options.
 * @returns the reason name, or `undefined` when the step looks like a real answer.
 */
function detectLeak(text, reasoningText, opts) {
  if (text.length === 0) return "empty-answer"; // nothing to say == nothing said
  // Scaffolding sentinels only ever leak in English-shaped output; a CJK answer
  // that merely quotes one is discussing the protocol, not leaking it.
  const prose = stripCode(text);
  const scaffoldable = !isCJKText(text);
  for (const pattern of opts.leakPatterns) {
    if (scaffoldable && pattern.test(prose)) return "marker";
  }
  if (TAIL_CLOSE.test(text.trimEnd())) return "marker";
  const answer = text.trim();
  const reasoning = reasoningText.trim();
  const shorter = Math.min(answer.length, reasoning.length);
  const longer = Math.max(answer.length, reasoning.length);
  if (longer >= MIN_DUPLICATE_LENGTH && shorter / longer >= 0.5) {
    if (answer === reasoning || reasoning.includes(answer) || answer.includes(reasoning)) {
      return "duplicate";
    }
  }
  if (answer.length >= 200 && opts.thinkingPrefix.test(answer)) return "thinking-prefix";
  return undefined;
}

/** Remove fenced and inline code so code identifiers cannot skew the check. */
function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

/**
 * Whether a text is English-shaped prose, ignoring code and inline snippets.
 *
 * @param text - the text to judge.
 * @param opts - resolved options.
 * @returns whether the text is prose carrying essentially no CJK.
 */
function isEnglishProse(text, opts) {
  if (isCJKText(text)) return false; // a Chinese body is not an English answer
  const prose = stripCode(text);
  // A short leak announces itself as a plan ("Let me check…"), so a narration
  // opener earns a much lower length floor than ordinary prose.
  const floor = NARRATION_HEAD.test(prose.trim()) ? opts.minNarrationLength : opts.minEnglishLength;
  if (prose.trim().length < floor) return false;
  const letters = (prose.match(/[A-Za-z]/g) ?? []).length;
  const visible = prose.replace(/\s/g, "").length;
  if (visible === 0) return false;
  return letters / visible >= 0.5;
}

/**
 * Whether the final output is entirely English.
 *
 * @param text - the visible answer text.
 * @param opts - resolved options.
 * @returns whether the answer should be nudged back into Chinese.
 */
function isEnglishOnly(text, opts) {
  if (!opts.languageNudge) return false;
  return isEnglishProse(text, opts);
}

/**
 * The last assistant message committed to a session.
 *
 * `agent/turn-stopping` runs after the step's `assistant/message` is appended
 * and before `turn/end`, so this is always the message that ended the step.
 *
 * @param session - the agent's session.
 * @returns the message with its turn/step, or `undefined`.
 */
function lastAssistantMessage(session) {
  let events;
  try {
    events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : session?.log;
  } catch {
    return undefined;
  }
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "assistant/message") continue;
    const data = event.data;
    if (!data || typeof data !== "object") continue;
    if (!data.message || typeof data.message !== "object") continue;
    return { turn: data.turn, step: data.step, message: data.message };
  }
  return undefined;
}

/** A user-role steer message authored by this plugin. */
function createNudge(text) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: name },
  };
}

/** Per-turn intervention counters, keyed by agent so one turn cannot loop. */
const turnCounters = new WeakMap();

/**
 * Claim one intervention slot for a turn.
 *
 * @param agent - the running agent.
 * @param turn - the turn index the slot belongs to.
 * @param key - which counter to claim.
 * @param max - the per-turn cap for that counter.
 * @returns whether the slot was granted.
 */
function takeSlot(agent, turn, key, max) {
  let state = turnCounters.get(agent);
  if (state === undefined || state.turn !== turn) {
    state = { turn, continues: 0, languages: 0 };
    turnCounters.set(agent, state);
  }
  if (state[key] >= max) return false;
  state[key] += 1;
  return true;
}

/**
 * Keep a turn open when it is about to close on a leaked or non-Chinese step.
 *
 * @param ctx - plugin context (for logging).
 * @param payload - the `agent/turn-stopping` payload (carries `agent`).
 * @param opts - resolved options.
 */
function intervene(ctx, payload, opts) {
  const agent = payload?.agent;
  if (!agent || typeof agent.steer !== "function") return;
  if (payload.signal?.aborted) return;

  const latest = lastAssistantMessage(agent.session);
  if (!latest) return;
  const turn = typeof payload.turn === "number" ? payload.turn : latest.turn;
  if (typeof latest.turn === "number" && typeof payload.turn === "number" && latest.turn !== payload.turn) {
    ctx.logger.warn(
      `thinking-tag-guard: turn-stopping turn ${payload.turn} but latest assistant message is turn ${latest.turn}`,
    );
  }

  const blocks = latest.message?.content;
  // `agent/turn-stopping` only runs for a step that called no tool, but never
  // second-guess a step that did: those turns continue on their own.
  if (Array.isArray(blocks) && blocks.some((block) => block?.type === "tool-call")) return;
  const text = textOf(blocks);
  const reasoningText = reasoningOf(blocks);
  // An answer carried by some other block kind (an image, say) is not an empty
  // answer, so the "empty-answer" rule must not fire for it.
  const answeredWithoutText = (blocks ?? []).some((block) => block?.type !== "text" && block?.type !== "reasoning");

  let leak = detectLeak(text, reasoningText, opts);
  if (leak === "empty-answer" && answeredWithoutText) leak = undefined;
  if (leak !== undefined) {
    if (!takeSlot(agent, turn, "continues", opts.maxContinuePerTurn)) {
      ctx.logger.warn(
        `thinking-tag-guard: turn ${turn} leaked again (${leak}) and the continue budget is spent; letting it close`,
      );
      return;
    }
    agent.steer(createNudge(opts.continuePrompt));
    ctx.logger.warn(
      `thinking-tag-guard: turn ${turn} would close silently on a leaked step (${leak}: text=${text.length}, reasoning=${reasoningText.length}); steering to continue`,
    );
    return;
  }

  if (isEnglishOnly(text, opts)) {
    if (!takeSlot(agent, turn, "languages", opts.maxLanguageNudgesPerTurn)) return;
    agent.steer(createNudge(opts.languageNudge));
    ctx.logger.warn(
      `thinking-tag-guard: turn ${turn} would close on English-only output (${text.length} chars); steering for Chinese`,
    );
  }
}

/**
 * Read a boolean from config or env.
 *
 * @param value - the raw value.
 * @param fallback - the default.
 * @returns the resolved boolean.
 */
function booleanOr(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

/**
 * Read a non-negative integer from config or env.
 *
 * @param value - the raw value.
 * @param fallback - the default.
 * @returns the resolved number.
 */
function integerOr(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

/**
 * Resolve the provider routes this guard applies to.
 *
 * @param config - the plugin row's config, when present.
 * @returns the provider route names to guard.
 */
function resolveProviders(config) {
  const configured = config && Array.isArray(config.providers) ? config.providers : undefined;
  if (configured !== undefined && configured.length > 0) {
    return configured.filter((value) => typeof value === "string" && value.length > 0);
  }
  const fromEnv = process.env.DSH_THINKING_TAG_GUARD_PROVIDERS;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  }
  return DEFAULT_PROVIDERS;
}

/**
 * Merge config and env over the defaults.
 *
 * @param config - the plugin row's config.
 * @returns the resolved options.
 */
function resolveOptions(config) {
  const raw = config && typeof config === "object" ? config : {};
  const env = process.env;
  const languageNudgeOff = raw.languageNudge === false || env.DSH_THINKING_TAG_GUARD_LANGUAGE_NUDGE === "off";
  return {
    providers: resolveProviders(raw),
    intervene: booleanOr(raw.intervene ?? env.DSH_THINKING_TAG_GUARD_INTERVENE, DEFAULT_OPTIONS.intervene),
    dedupeReasoning: booleanOr(raw.dedupeReasoning ?? env.DSH_THINKING_TAG_GUARD_DEDUPE, DEFAULT_OPTIONS.dedupeReasoning),
    bareMarkers: booleanOr(raw.bareMarkers ?? env.DSH_THINKING_TAG_GUARD_BARE_MARKERS, DEFAULT_OPTIONS.bareMarkers),
    tailMarkers: booleanOr(raw.tailMarkers ?? env.DSH_THINKING_TAG_GUARD_TAIL_MARKERS, DEFAULT_OPTIONS.tailMarkers),
    narrationGuard: booleanOr(
      raw.narrationGuard ?? env.DSH_THINKING_TAG_GUARD_NARRATION,
      DEFAULT_OPTIONS.narrationGuard,
    ),
    minReplayDelta: integerOr(raw.minReplayDelta ?? env.DSH_THINKING_TAG_GUARD_MIN_REPLAY, DEFAULT_OPTIONS.minReplayDelta),
    minEnglishLength: integerOr(
      raw.minEnglishLength ?? env.DSH_THINKING_TAG_GUARD_MIN_ENGLISH,
      DEFAULT_OPTIONS.minEnglishLength,
    ),
    minNarrationLength: integerOr(
      raw.minNarrationLength ?? env.DSH_THINKING_TAG_GUARD_MIN_NARRATION,
      DEFAULT_OPTIONS.minNarrationLength,
    ),
    maxContinuePerTurn: integerOr(
      raw.maxContinuePerTurn ?? env.DSH_THINKING_TAG_GUARD_MAX_CONTINUE,
      DEFAULT_OPTIONS.maxContinuePerTurn,
    ),
    maxLanguageNudgesPerTurn: integerOr(
      raw.maxLanguageNudgesPerTurn ?? env.DSH_THINKING_TAG_GUARD_MAX_LANGUAGE,
      DEFAULT_OPTIONS.maxLanguageNudgesPerTurn,
    ),
    continuePrompt:
      typeof raw.continuePrompt === "string" && raw.continuePrompt.length > 0
        ? raw.continuePrompt
        : DEFAULT_OPTIONS.continuePrompt,
    languageNudge: languageNudgeOff
      ? false
      : (typeof raw.languageNudge === "string" && raw.languageNudge.length > 0
        ? raw.languageNudge
        : (env.DSH_THINKING_TAG_GUARD_LANGUAGE_NUDGE || DEFAULT_OPTIONS.languageNudge)),
    leakPatterns: LEAK_PATTERNS,
    thinkingPrefix: THINKING_PREFIX,
    skipPurposes: DEFAULT_OPTIONS.skipPurposes,
    dsmlSanitize: raw.dsmlSanitize !== false,
  };
}

/**
 * Install the guard on `llm/stream` and the turn-stopping intervention.
 *
 * @param ctx - plugin context owning the listeners.
 * @param config - the plugin row's config.
 */
function apply(ctx, config) {
  const opts = resolveOptions(config);

  ctx.on("llm/stream", (options, next) => {
    const stream = next();
    if (!opts.providers.includes(options.provider)) return stream;
    // Compaction and session-title calls ask the model for data, not for a
    // reply: their output is a summary or a title, so reclassifying any of it
    // as reasoning would silently empty it. `purpose` is only ever set by
    // those internal callers; an ordinary turn never sets it.
    if (opts.skipPurposes.includes(options.purpose)) return stream;
    const guarded = guard(stream, opts);
    return opts.dsmlSanitize === false ? guarded : sanitizeDsml(guarded);
  });

  if (!opts.intervene) return;

  // `agent/turn-stopping` is dispatched with `serial`, so the handler receives
  // the payload only — there is no `next` to call.
  ctx.on("agent/turn-stopping", (payload) => {
    try {
      intervene(ctx, payload, opts);
    } catch (error) {
      ctx.logger.warn(`thinking-tag-guard: turn-stopping intervention failed: ${error?.message ?? error}`);
    }
  });
}

export {
  apply,
  inject,
  name,
  detectLeak,
  guard,
  sanitizeDsml,
  stripDsml,
  isEnglishOnly,
  isEnglishProse,
  isReasoningReplay,
  reasoningOf,
  resolveOptions,
  textOf,
};
