// lib/templates.js
//
// Notice templates per BRD-005 §6.1 cycle-date derivation:
//   renewalGenerationDate = expirationDate - 60 days  -> "60-day" first notice
//   noticeSendDate        = expirationDate - 45 days  -> "45-day" reminder
//   offerExpirationDate /
//   responseDueDate       = expirationDate - 15 days  -> "15-day" final notice
//
// The milestone is auto-selected from the offer payload:
//   1. Explicit `offer.noticeMilestone` (60 | 45 | 15) always wins, if sent.
//   2. Otherwise it's derived from days-remaining between now and
//      offer.responseDueDate (falls back to offer.renewalEffectiveDate,
//      which BRD-005 defines as defaulting to the policy expirationDate).

function daysBetween(fromIso, toIso) {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  return Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

export function selectMilestone(offer = {}, now = new Date()) {
  if ([60, 45, 15].includes(Number(offer.noticeMilestone))) {
    return Number(offer.noticeMilestone);
  }

  // responseDueDate is expirationDate - 15. Reconstruct an approximate
  // expirationDate from whichever reference date we have, then measure
  // days remaining until it from `now`.
  const reference = offer.responseDueDate || offer.offerExpirationDate;
  const effective = offer.renewalEffectiveDate;

  let daysUntilExpiration;
  if (reference) {
    daysUntilExpiration = daysBetween(now.toISOString(), reference) + 15;
  } else if (effective) {
    daysUntilExpiration = daysBetween(now.toISOString(), effective);
  } else {
    daysUntilExpiration = 60; // no dates supplied — default to earliest notice
  }

  if (daysUntilExpiration > 50) return 60;
  if (daysUntilExpiration > 20) return 45;
  return 15;
}

function money(n) {
  if (typeof n !== "number") return String(n ?? "");
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function premiumChangeLine(offer) {
  const amt = offer.premiumChangeAmount ?? 0;
  const pct = offer.premiumChangePercent ?? 0;
  if (!amt) return "Your premium is unchanged from your current term.";
  const direction = amt > 0 ? "increased" : "decreased";
  return `Your premium has ${direction} by ${money(Math.abs(amt))} (${Math.abs(pct)}%) from your current term.`;
}

const MILESTONE_COPY = {
  60: {
    label: "Renewal offer generated",
    urgency: "Take a moment to review your upcoming renewal — no action is needed yet.",
    subjectPrefix: "Your renewal offer for policy",
  },
  45: {
    label: "Renewal notice",
    urgency: "Please review your renewal offer and let us know how you'd like to proceed.",
    subjectPrefix: "Renewal notice for policy",
  },
  15: {
    label: "Final notice — response required",
    urgency: "Your response is due soon. Please reply to this email to accept or decline your renewal.",
    subjectPrefix: "Final notice: renewal response needed for policy",
  },
};

/**
 * Builds subject + plainText + html for a renewal offer email, unless the
 * caller already supplied a `body` in the request (in which case that is
 * used as-is — see route handler).
 */
export function buildRenewalEmail({ sourcePolicyId, recipient, offer = {} }) {
  const milestone = selectMilestone(offer);
  const copy = MILESTONE_COPY[milestone];

  const subject = `${copy.subjectPrefix} ${sourcePolicyId}`;

  const plainText = [
    `Hi ${recipient?.name || "there"},`,
    "",
    `${copy.label} — ${copy.urgency}`,
    "",
    `Policy: ${sourcePolicyId}`,
    `Offered premium: ${money(offer.offeredPremium)}`,
    premiumChangeLine(offer),
    offer.renewalEffectiveDate ? `Renewal effective date: ${offer.renewalEffectiveDate}` : null,
    offer.responseDueDate ? `Response due: ${offer.responseDueDate}` : null,
    "",
    "To accept, reply ACCEPT. To decline, reply DECLINE.",
  ]
    .filter(Boolean)
    .join("\n");

  const html = `
    <div style="font-family: -apple-system, Arial, sans-serif; max-width: 560px; margin: 0 auto;">
      <p>Hi ${recipient?.name || "there"},</p>
      <p><strong>${copy.label}</strong> — ${copy.urgency}</p>
      <table style="width:100%; border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding:4px 0; color:#555;">Policy</td><td style="padding:4px 0;"><strong>${sourcePolicyId}</strong></td></tr>
        <tr><td style="padding:4px 0; color:#555;">Offered premium</td><td style="padding:4px 0;">${money(offer.offeredPremium)}</td></tr>
        <tr><td style="padding:4px 0; color:#555;" colspan="2">${premiumChangeLine(offer)}</td></tr>
        ${offer.renewalEffectiveDate ? `<tr><td style="padding:4px 0; color:#555;">Renewal effective</td><td style="padding:4px 0;">${offer.renewalEffectiveDate}</td></tr>` : ""}
        ${offer.responseDueDate ? `<tr><td style="padding:4px 0; color:#555;">Response due</td><td style="padding:4px 0;">${offer.responseDueDate}</td></tr>` : ""}
      </table>
      <p>To accept, reply <strong>ACCEPT</strong>. To decline, reply <strong>DECLINE</strong>.</p>
    </div>
  `.trim();

  return { milestone, subject, plainText, html };
}
