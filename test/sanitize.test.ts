import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeTldrText } from "../src/sanitize.js";

describe("sanitizeTldrText", () => {
  it("strips terminal control sequences and normalizes whitespace", () => {
    assert.equal(
      sanitizeTldrText(
        [
          "\u001b[31mInspecting\u001b[0m",
          "files",
          "\u001b]8;;https://evil.test\u001b\\link\u001b]8;;\u001b\\",
          "\u001b]52;c;Y2xpcGJvYXJk\u0007",
          "done\u0000\u0007",
        ].join("\n"),
      ),
      "Inspecting files link done",
    );
  });

  it("strips C1 string controls and caps printable output", () => {
    assert.equal(
      sanitizeTldrText(
        `A\u009dwindow title\u0007B\u0090ignored\u009cC${"x".repeat(20)}`,
        8,
      ),
      "ABCxxxx…",
    );
  });

  it("returns empty text when output contains only controls", () => {
    assert.equal(sanitizeTldrText("\u001b[2J\u001b]52;c;abc\u0007\u0000"), "");
  });
});
