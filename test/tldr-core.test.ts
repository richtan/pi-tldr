import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractSummary,
  factField,
  formatFact,
  stripAnsi,
  truncateText,
} from "../src/tldr-core.js";

describe("tldr text formatting", () => {
  it("strips ANSI codes and truncates fact values at the boundary", () => {
    assert.equal(
      factField(
        "command",
        "\u001b[31mANTHROPIC_API_KEY=sk-ant-example\u001b[0m",
        24,
      ),
      "command=ANTHROPIC_API_KEY=sk-an…",
    );
    assert.equal(stripAnsi("\u001b[32mok\u001b[0m"), "ok");
    assert.equal(truncateText("abcdef", 4), "abc…");
  });
});

describe("fact formatting", () => {
  it("omits undefined fields and preserves structured event lines", () => {
    assert.equal(
      formatFact("tool_start", [
        { name: "tool", value: "read" },
        { name: "path", value: "src/index.ts" },
        { name: "limit", value: undefined },
      ]),
      "event=tool_start\ntool=read\npath=src/index.ts",
    );
  });
});

describe("summary extraction", () => {
  it("accepts one plain sentence", () => {
    assert.equal(
      extractSummary("Inspecting the extension lifecycle state.", 180),
      "Inspecting the extension lifecycle state.",
    );
  });

  it("rejects markdown, structured data, multi-line output, and overlong text", () => {
    assert.equal(extractSummary("- Inspecting files", 180), undefined);
    assert.equal(extractSummary('{"status":"running"}', 180), undefined);
    assert.equal(extractSummary("Line one\nLine two", 180), undefined);
    assert.equal(extractSummary("a".repeat(181), 180), undefined);
  });
});
