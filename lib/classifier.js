// lib/classifier.js
//
// Deterministic ACCEPT / DECLINE / AMBIGUOUS classifier, per the
// "Classification rules" section of Auto-Renewal-Email-Mock-App-
// Current-PAS-Handoff.md.
//
// Rules (intentionally simple and deterministic — no ML/LLM call):
//   1. Normalize the reply text (lowercase, collapse whitespace).
//   2. Check it against the ACCEPT and DECLINE keyword/phrase lists.
//      Keyword lists = the message's own `responseInstructions`
//      (acceptKeywords / declineKeywords) sent by the caller, unioned
//      with a default list drawn straight from the handoff doc's
//      examples, so classification still works if a caller didn't
//      supply custom keywords.
//   3. Both accept and decline phrases present -> AMBIGUOUS.
//   4. Only accept phrases present -> ACCEPT.
//   5. Only decline phrases present -> DECLINE.
//   6. Neither present -> AMBIGUOUS (covers "call me", "I have
//      questions", "the price is too high", coverage-change requests,
//      and anything else not explicitly recognized).

const DEFAULT_ACCEPT_PHRASES = [
  "accept",
  "i accept",
  "yes, renew",
  "yes renew",
  "please renew",
  "confirm renewal",
  "continue my policy",
  "accept the offer",
];

const DEFAULT_DECLINE_PHRASES = [
  "decline",
  "i decline",
  "do not renew",
  "don't renew",
  "do not continue",
  "reject renewal",
  "i found other coverage",
];

function normalize(text) {
  return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function anyPhraseMatches(normalizedText, phrases) {
  const matches = [];
  for (const phrase of phrases) {
    const p = normalize(phrase);
    if (p && normalizedText.includes(p)) matches.push(phrase);
  }
  return matches;
}

/**
 * @param {string} replyText - plain-text reply body
 * @param {{acceptKeywords?: string[], declineKeywords?: string[]}} responseInstructions
 * @returns {{classification: 'ACCEPT'|'DECLINE'|'AMBIGUOUS', confidence: number, matchedPhrase: string|null, matchedAccept: string[], matchedDecline: string[]}}
 */
export function classifyReply(replyText, responseInstructions = {}) {
  const normalizedText = normalize(replyText);

  const acceptPhrases = [
    ...DEFAULT_ACCEPT_PHRASES,
    ...(responseInstructions.acceptKeywords || []),
  ];
  const declinePhrases = [
    ...DEFAULT_DECLINE_PHRASES,
    ...(responseInstructions.declineKeywords || []),
  ];

  const matchedAccept = anyPhraseMatches(normalizedText, acceptPhrases);
  const matchedDecline = anyPhraseMatches(normalizedText, declinePhrases);

  if (matchedAccept.length > 0 && matchedDecline.length > 0) {
    return {
      classification: "AMBIGUOUS",
      confidence: 0.5,
      matchedPhrase: null,
      matchedAccept,
      matchedDecline,
      reason: "Reply contains both acceptance and decline language.",
    };
  }

  if (matchedAccept.length > 0) {
    return {
      classification: "ACCEPT",
      confidence: 1,
      matchedPhrase: matchedAccept[0],
      matchedAccept,
      matchedDecline,
    };
  }

  if (matchedDecline.length > 0) {
    return {
      classification: "DECLINE",
      confidence: 1,
      matchedPhrase: matchedDecline[0],
      matchedAccept,
      matchedDecline,
    };
  }

  return {
    classification: "AMBIGUOUS",
    confidence: 0,
    matchedPhrase: null,
    matchedAccept,
    matchedDecline,
    reason: "No recognized accept or decline phrase found; requires manual review.",
  };
}

// Contract's PAS status mapping (customerResponseMapping).
export const CLASSIFICATION_TO_PAS_STATUS = {
  ACCEPT: "Accepted",
  DECLINE: "Declined",
  AMBIGUOUS: "Pending",
};
