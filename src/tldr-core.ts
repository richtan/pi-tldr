const SUMMARY_FORMAT_PATTERN =
  /^['"`]|['"`]$|```|\[[^\]]+]\([^)]*\)|^\s*[-*+]\s+|^\s*#{1,6}\s+|<[^>]+>/;
const STRUCTURED_TOKEN_PATTERN = /[{}[\]":,]/;
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
export interface FactField {
  readonly name: string;
  readonly value: string | number | boolean | undefined;
  readonly maxChars?: number;
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function truncateText(text: string, maxChars?: number): string {
  const normalized = normalizeText(text);
  if (maxChars === undefined) return normalized;
  if (maxChars <= 0) return "";
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars - 1)}…`;
}

export function factField(
  name: string,
  value: string | number | boolean,
  maxChars?: number,
): string {
  return `${name}=${truncateText(stripAnsi(String(value)), maxChars)}`;
}

export function formatFact(
  eventName: string,
  fields: readonly FactField[],
): string {
  return [
    `event=${eventName}`,
    ...fields
      .filter((field) => field.value !== undefined)
      .map((field) =>
        factField(
          field.name,
          field.value as string | number | boolean,
          field.maxChars,
        ),
      ),
  ].join("\n");
}

function looksLikeStructuredData(text: string): boolean {
  const trimmed = text.trim();
  return (
    ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) &&
    STRUCTURED_TOKEN_PATTERN.test(trimmed)
  );
}

function hasInvalidSummaryFormat(rawText: string, summary: string): boolean {
  const raw = rawText.trim();
  return (
    !raw ||
    SUMMARY_FORMAT_PATTERN.test(raw) ||
    SUMMARY_FORMAT_PATTERN.test(summary) ||
    looksLikeStructuredData(raw) ||
    looksLikeStructuredData(summary)
  );
}

export function extractSummary(
  response: string,
  maxSummaryChars: number,
): string | undefined {
  const lines = response.trim().split(/\r?\n/);
  if (lines.length !== 1) return undefined;

  const rawLine = lines[0] ?? "";
  const summary = normalizeText(stripAnsi(rawLine));
  return summary &&
    summary.length <= maxSummaryChars &&
    !hasInvalidSummaryFormat(rawLine, summary)
    ? summary
    : undefined;
}
