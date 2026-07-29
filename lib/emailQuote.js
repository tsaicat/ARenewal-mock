// lib/emailQuote.js
//
// Most email clients (Gmail, Outlook, Apple Mail...) append the quoted
// original message below a reply by default. If the classifier reads
// that quoted text too, it will see whatever keywords the ORIGINAL
// offer email contained — including, in this app's case, the literal
// instructional text "To accept, reply ACCEPT. To decline, reply
// DECLINE." That guarantees every reply matches both ACCEPT and
// DECLINE and gets misclassified as AMBIGUOUS, regardless of what the
// person actually wrote.
//
// This strips the quoted portion before classification, keeping only
// the text the person actually typed above the quote marker.

const QUOTE_HEADER_PATTERNS = [
  // Gmail: "On <date> at <time> <name> <email> wrote:"
  /^On .+ wrote:\s*$/i,
  // Outlook / generic
  /^-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  // Some clients: a "From:" header block starting a quoted reply
  /^From:\s.+$/i,
];

export function stripQuotedReplyText(text) {
  if (!text) return "";

  const lines = text.split(/\r?\n/);
  const kept = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (QUOTE_HEADER_PATTERNS.some((re) => re.test(line))) break;
    // Lines starting with ">" are quoted content (standard email
    // quoting convention, used by Gmail's plaintext export and most
    // other clients).
    if (line.startsWith(">")) break;

    kept.push(rawLine);
  }

  return kept.join("\n").trim();
}
