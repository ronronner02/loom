/**
 * What a reviewer turn said, read from its final message.
 *
 * A reviewer returns one fenced JSON block, and the last block in the message is the report: an
 * earlier block may be a quotation or an example the reviewer reasoned over. Two shapes share
 * that transport — a findings report and a paused/dropped task report — and the two readers
 * below differ only in which shape they accept.
 */

/** The last fenced JSON block of a message, or null when it holds none that parses as an object. */
export function reviewerOutput(message: string | null): Record<string, unknown> | null {
  if (message === null) return null;
  const blocks = [...message.matchAll(/```json\s*([\s\S]*?)^[ \t]*```[ \t]*\r?$/gim)];
  const block = blocks.at(-1)?.[1];
  if (block === undefined) return null;
  try {
    const value = JSON.parse(block) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The final JSON report a reviewer turn must return for automatic verdict recording. */
export function extractReviewerReport(message: string | null): Record<string, unknown> | null {
  const value = reviewerOutput(message);
  return value && "findings" in value ? value : null;
}