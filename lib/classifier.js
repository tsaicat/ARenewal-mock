// lib/classifier.js
// Deterministic response classifier with conservative negation/conditional handling.

const DEFAULT_ACCEPT_PHRASES = [
  "i accept",
  "yes, renew",
  "yes renew",
  "please renew",
  "confirm renewal",
  "continue my policy",
  "accept the offer",
];

const DEFAULT_DECLINE_PHRASES = [
  "i decline",
  "do not renew",
  "don't renew",
  "do not continue",
  "reject renewal",
  "i found other coverage",
];

const AMBIGUOUS_PATTERNS = [
  /\b(?:cannot|can't|cant|do not|don't|dont|not)\s+accept\b/i,
  /\b(?:before|if|unless|depending on|might|may|could|would)\b[^.!?]{0,60}\baccept\b/i,
  /\baccept(?:ed)?\s+(?:another|other)\b/i,
  /\b(?:question|explain|clarify|change|modify)\b[^.!?]{0,60}\b(?:accept|renew)\b/i,
  /\b(?:cannot|can't|cant|do not|don't|dont|not)\s+decline\b/i,
];

function normalize(text) {
  return (text || "").toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phraseMatches(normalizedText, phrase) {
  const p = normalize(phrase);
  if (!p) return false;
  // Phrase boundaries avoid matching "accept" inside "accepted" while still
  // allowing punctuation around phrases.
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(p).replace(/\\ /g, "\\s+")}($|[^a-z0-9])`, "i");
  return pattern.test(normalizedText);
}

function matchedPhrases(normalizedText, phrases) {
  return [...new Set(phrases)].filter((phrase) => phraseMatches(normalizedText, phrase));
}

export function classifyReply(replyText, responseInstructions = {}) {
  const normalizedText = normalize(replyText);

  if (!normalizedText) {
    return {
      classification: "AMBIGUOUS",
      confidence: 0,
      matchedPhrase: null,
      matchedAccept: [],
      matchedDecline: [],
      reason: "Reply is empty; requires manual review.",
    };
  }

  if (AMBIGUOUS_PATTERNS.some((pattern) => pattern.test(normalizedText))) {
    return {
      classification: "AMBIGUOUS",
      confidence: 0.2,
      matchedPhrase: null,
      matchedAccept: [],
      matchedDecline: [],
      reason: "Reply contains negated, conditional, or context-dependent response language.",
    };
  }

  const acceptPhrases = [...DEFAULT_ACCEPT_PHRASES, ...(responseInstructions.acceptKeywords || [])];
  const declinePhrases = [...DEFAULT_DECLINE_PHRASES, ...(responseInstructions.declineKeywords || [])];
  const matchedAccept = matchedPhrases(normalizedText, acceptPhrases);
  const matchedDecline = matchedPhrases(normalizedText, declinePhrases);

  if (matchedAccept.length && matchedDecline.length) {
    return {
      classification: "AMBIGUOUS",
      confidence: 0.5,
      matchedPhrase: null,
      matchedAccept,
      matchedDecline,
      reason: "Reply contains both acceptance and decline language.",
    };
  }

  if (matchedAccept.length) {
    return {
      classification: "ACCEPT",
      confidence: 1,
      matchedPhrase: matchedAccept[0],
      matchedAccept,
      matchedDecline,
    };
  }

  if (matchedDecline.length) {
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
    reason: "No unambiguous supported accept or decline phrase was found.",
  };
}

export const CLASSIFICATION_TO_PAS_STATUS = {
  ACCEPT: "Accepted",
  DECLINE: "Declined",
  AMBIGUOUS: "Pending",
};

export const CLASSIFICATION_TO_NORMALIZED_DECISION = {
  ACCEPT: "ACCEPTED",
  DECLINE: "DECLINED",
  AMBIGUOUS: "AMBIGUOUS",
};
