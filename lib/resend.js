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

export function replyToForMessage(messageId) {
  return `arenewal+${messageId}@${REPLY_DOMAIN}`;
}

export function messageIdFromReplyAddress(address) {
  const match = /^arenewal\+([^@]+)@/.exec(address || "");
  return match ? match[1] : null;
}

export async function sendRenewalEmail({ to, subject, html, text, headers, messageId, attachments = [] }) {
  const resendAttachments = attachments.map((attachment) => ({
    filename: attachment.fileName,
    content: attachment.contentBase64,
  }));

  if (!RESEND_API_KEY) {
    // Local/dev mode preserves the exact attachment handling pipeline: actual
    // bytes are validated and stored in the mock register, while external email
    // transmission itself is simulated.
    return {
      ok: true,
      simulated: true,
      id: `simulated-${Date.now()}`,
      attachmentCount: resendAttachments.length,
    };
  }

  try {
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
        attachments: resendAttachments.length ? resendAttachments : undefined,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      return { ok: false, simulated: false, error: data, attachmentCount: resendAttachments.length };
    }

    return { ok: true, simulated: false, id: data.id, attachmentCount: resendAttachments.length };
  } catch (error) {
    return {
      ok: false,
      simulated: false,
      error: { message: error?.message || "Resend request failed" },
      attachmentCount: resendAttachments.length,
    };
  }
}
