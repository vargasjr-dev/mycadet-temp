/**
 * Quoted history for reply sends: the "On <date>, <from> wrote:" tail a
 * composing mail client normally appends. The gateway composes the fresh
 * body and sends exactly what it builds — without this tail a reply lands
 * in every client (and in this same history) showing no prior context,
 * which is what a thread looks like when it is losing memory.
 *
 * Ported from mycadet-cloud's email-quote.ts (the two products share the
 * reply shape); promote to a shared package when a third consumer appears.
 * The gateway's webhook payloads are text-only, so html passes through
 * null and the quote is a "> " block.
 */

export interface QuoteRow {
  fromAddress: string;
  createdAt: Date;
}

export interface QuoteBody {
  text: string | null;
  html: string | null;
}

/** The header line's date. UTC — the sender's zone is unknowable. */
export function formatQuoteDate(date: Date): string {
  return `${new Intl.DateTimeFormat(
    "en-US",
    {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    },
  ).format(date)} UTC`;
}

export function buildQuotedHistory(
  row: QuoteRow,
  body: QuoteBody | null,
): { text: string; html: string } {
  const wrote = `On ${formatQuoteDate(row.createdAt)}, ${row.fromAddress} wrote:`;
  const parentText = body?.text ?? "";
  const quotedText = parentText
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
  return { text: `${wrote}\n${quotedText}`, html: "" };
}
