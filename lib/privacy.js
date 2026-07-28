// lib/privacy.js
//
// Enforces the `privacyExclusions` list from
// auto-renewal-email-contract-starter.json. These fields must never be
// stored, echoed back in an API response, put into an email body, or
// forwarded to a callback — regardless of whether the caller included
// them in the request. This is a hard rule (contract-driven, not a
// preference), so it strips recursively at any nesting depth and by key
// name alone, matched case-insensitively.

export const PRIVACY_EXCLUSIONS = [
  "ssn",
  "ssnLast4",
  "dateOfBirth",
  "paymentAccount",
  "insuranceScoreRawResponse",
  "occupancyInsightRawResponse",
];

const EXCLUDED_KEYS = new Set(PRIVACY_EXCLUSIONS.map((k) => k.toLowerCase()));

/**
 * Deep-clones `value` while dropping any object key that matches a
 * privacy-excluded field name (case-insensitive), at any depth.
 */
export function stripPrivacyFields(value) {
  if (Array.isArray(value)) {
    return value.map(stripPrivacyFields);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (EXCLUDED_KEYS.has(key.toLowerCase())) continue;
      out[key] = stripPrivacyFields(val);
    }
    return out;
  }
  return value;
}

/**
 * Returns the list of excluded field names actually present in `value`
 * (for audit logging — so we can prove what was stripped, without
 * logging the stripped values themselves).
 */
export function findPrivacyFieldsPresent(value, found = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((v) => findPrivacyFieldsPresent(v, found));
  } else if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      if (EXCLUDED_KEYS.has(key.toLowerCase())) found.add(key);
      findPrivacyFieldsPresent(val, found);
    }
  }
  return Array.from(found);
}
