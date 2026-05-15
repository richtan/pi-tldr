/**
 * @fileoverview Terminal-safe text sanitization for model-generated TLDRs.
 *
 * TLDR text is model-controlled and is rendered into a terminal widget. The
 * model prompt asks for plain text, but that is not a security boundary: this
 * module removes terminal controls before text reaches pi-tui.
 */

/** Maximum printable characters accepted for one rendered TLDR. */
export const MAX_SAFE_TLDR_CHARS = 240;

const ESC = 0x1b;
const BEL = 0x07;
const ST = 0x9c;

/** Returns true for C0/C1 control characters that should never render. */
function isControlCharacter(code: number): boolean {
  return (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
}

/** Returns true for whitespace controls that should become ordinary spaces. */
function isWhitespaceControl(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0x0d
  );
}

/** Skips a CSI control sequence starting just after its introducer. */
function skipCsiSequence(text: string, startIndex: number): number {
  for (let index = startIndex; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
  }

  return text.length;
}

/** Skips OSC/DCS/APC/PM/SOS string controls starting after their introducer. */
function skipStringControl(text: string, startIndex: number): number {
  for (let index = startIndex; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === BEL || code === ST) return index + 1;
    if (code === ESC && text.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
  }

  return text.length;
}

/** Skips short ESC controls such as charset designators and RIS. */
function skipEscapeSequence(text: string, escapeIndex: number): number {
  const nextCode = text.charCodeAt(escapeIndex + 1);
  if (Number.isNaN(nextCode)) return escapeIndex + 1;

  switch (nextCode) {
    case 0x5b: // CSI: ESC [
      return skipCsiSequence(text, escapeIndex + 2);
    case 0x5d: // OSC: ESC ]
    case 0x50: // DCS: ESC P
    case 0x58: // SOS: ESC X
    case 0x5e: // PM: ESC ^
    case 0x5f: // APC: ESC _
      return skipStringControl(text, escapeIndex + 2);
    default:
      if (
        nextCode === 0x20 ||
        nextCode === 0x23 ||
        nextCode === 0x25 ||
        (nextCode >= 0x28 && nextCode <= 0x2f)
      ) {
        return Math.min(text.length, escapeIndex + 3);
      }

      return Math.min(text.length, escapeIndex + 2);
  }
}

/** Truncates printable text to a code-point cap, preserving valid Unicode. */
function truncatePrintableText(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";

  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  if (maxChars === 1) return "…";
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

/**
 * Converts untrusted model text into safe, compact terminal widget text.
 *
 * The sanitizer strips terminal control sequences rather than trusting the TUI
 * wrapper to treat them as inert. It then removes leftover controls, flattens
 * whitespace, and caps printable length so a bad model response cannot write a
 * large or stateful payload into the user's terminal.
 */
export function sanitizeTldrText(
  text: string,
  maxChars = MAX_SAFE_TLDR_CHARS,
): string {
  let stripped = "";

  for (let index = 0; index < text.length; ) {
    const code = text.charCodeAt(index);

    if (code === ESC) {
      index = skipEscapeSequence(text, index);
      continue;
    }

    if (code === 0x9b) {
      index = skipCsiSequence(text, index + 1);
      continue;
    }

    if (
      code === 0x90 ||
      code === 0x98 ||
      code === 0x9d ||
      code === 0x9e ||
      code === 0x9f
    ) {
      index = skipStringControl(text, index + 1);
      continue;
    }

    if (isControlCharacter(code)) {
      if (isWhitespaceControl(code)) stripped += " ";
      index++;
      continue;
    }

    stripped += text[index];
    index++;
  }

  return truncatePrintableText(stripped.replace(/\s+/gu, " ").trim(), maxChars);
}
