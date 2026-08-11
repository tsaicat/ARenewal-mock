// lib/resend.js — thin Resend REST wrapper with explicit simulation semantics.

const SENDER = process.env.RESEND_SENDER || "arenewal@iapasapp.com";
const SENDER_DOMAIN = SENDER.split("@")[1] || "iapasapp.com";
const REPLY_DOMAIN = process.env.RESEND_REPLY_DOMAIN || SENDER_DOMAIN;

function isProductionLike() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}

function simulationAllowed() {
  return String(process.env.ALLOW_SIMULATED_EMAIL || "").toLowerCase() === "true";
}

export function replyToForMessage(messageId) {
  return `arenewal+${messageId}@${REPLY_DOMAIN}`;
}

export function messageIdFromReplyAddress(address) {
  const match = /^arenewal\+([^@]+)@/.exec(address || "");
  return match ? match[1] : null;
}

export async function sendRenewalEmail({ to, subject, html, text, headers, messageId, attachments = [] }) {
  const apiKey = process.env.RESEND_API_KEY;
  const resendAttachments = attachments.map((attachment) => ({
    filename: attachment.fileName,
    content: attachment.contentBase64,
  }));

  if (!apiKey) {
    if (isProductionLike() || !simulationAllowed()) {
      return {
        ok: false,
        simulated: false,
        deliveryMode: "REAL_PROVIDER",
        error: {
          code: "EMAIL_PROVIDER_NOT_CONFIGURED",
          message: isProductionLike()
            ? "RESEND_API_KEY is required in production. Simulated delivery is disabled even if a local simulation flag is present."
            : "RESEND_API_KEY is not configured. Set ALLOW_SIMULATED_EMAIL=true only for explicit local/test simulation.",
        },
        attachmentCount: resendAttachments.length,
      };
    }

    return {
      ok: true,
      simulated: true,
      deliveryMode: "SIMULATED",
      id: `simulated-${Date.now()}`,
      attachmentCount: resendAttachments.length,
    };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
      return {
        ok: false,
        simulated: false,
        deliveryMode: "REAL_PROVIDER",
        error: data?.error || data || { message: `Resend returned HTTP ${res.status}` },
        attachmentCount: resendAttachments.length,
      };
    }

    return {
      ok: true,
      simulated: false,
      deliveryMode: "REAL_PROVIDER",
      id: data.id,
      attachmentCount: resendAttachments.length,
    };
  } catch (error) {
    return {
      ok: false,
      simulated: false,
      deliveryMode: "REAL_PROVIDER",
      error: { message: error?.message || "Resend request failed" },
      attachmentCount: resendAttachments.length,
    };
  }
}
