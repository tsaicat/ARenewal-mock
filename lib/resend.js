// lib/resend.js
//
// Thin wrapper around the Resend API. Requires RESEND_API_KEY, and the
// sending domain (iapasapp.com) must be verified in the Resend
// dashboard, with arenewal@iapasapp.com as the configured sender.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SENDER = process.env.RESEND_SENDER || "arenewal@iapasapp.com";
const SENDER_DOMAIN = SENDER.split("@")[1] || "iapasapp.com";

// Plus-addressing the Reply-To lets the inbound webhook recover the
// messageId directly from the "to" address of the reply, with no
// dependency on the customer preserving email threading headers.
export function replyToForMessage(messageId) {
  return `arenewal+${messageId}@${SENDER_DOMAIN}`;
}

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
