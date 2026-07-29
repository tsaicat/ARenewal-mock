// lib/resend.js
//
// Thin wrapper around the Resend API. Requires RESEND_API_KEY, and the
// sending domain (iapasapp.com, or whatever RESEND_SENDER's domain is)
// must be verified in the Resend dashboard for *sending*.
//
// Receiving (inbound replies) is a SEPARATE Resend capability from
// sending, and Resend recommends verifying it on its own subdomain
// (e.g. reply.iapasapp.com) rather than the root domain, to avoid
// clobbering the root domain's existing MX records. RESEND_REPLY_DOMAIN
// lets that receiving domain differ from the sending domain. If unset,
// it defaults to the sending domain, which only works if receiving is
// also enabled there.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SENDER = process.env.RESEND_SENDER || "arenewal@iapasapp.com";
const SENDER_DOMAIN = SENDER.split("@")[1] || "iapasapp.com";
const REPLY_DOMAIN = process.env.RESEND_REPLY_DOMAIN || SENDER_DOMAIN;

// Plus-addressing the Reply-To lets the inbound webhook recover the
// messageId directly from the "to" address of the reply, with no
// dependency on the customer preserving email threading headers. The
// domain here must match wherever Resend Receiving + the MX record are
// actually configured (RESEND_REPLY_DOMAIN), not necessarily the
// sending domain.
export function replyToForMessage(messageId) {
  return `arenewal+${messageId}@${REPLY_DOMAIN}`;
}

// Domain-agnostic on purpose: Resend only routes email.received events
// for domains it's configured to receive on, so by the time this parses
// an inbound address, the domain has already been validated upstream.
// Matching on local-part alone keeps this working even if
// RESEND_REPLY_DOMAIN changes later without a code change here.
export function messageIdFromReplyAddress(address) {
  const match = /^arenewal\+([^@]+)@/.exec(address || "");
  return match ? match[1] : null;
}

export async function sendRenewalEmail({ to, subject, html, text, headers, messageId }) {
  if (!RESEND_API_KEY) {
    // Allows local/dev/demo use (and the Postman collection) without a
    // real Resend account. The message is still stored and returned as
    // if delivered, just flagged so it's obvious in the audit trail.
    return {
      ok: true,
      simulated: true,
      id: `simulated-${Date.now()}`,
    };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `Auto-Renewal <${SENDER}>`,
      to: [to],
      reply_to: messageId ? replyToForMessage(messageId) : undefined,
      subject,
      html,
      text,
      headers,
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    return { ok: false, simulated: false, error: data };
  }

  return { ok: true, simulated: false, id: data.id };
}
