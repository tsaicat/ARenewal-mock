import { createHmac, timingSafeEqual } from "crypto";

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export function verifySvixSignature({ rawBody, id, timestamp, signature, secret, nowMs = Date.now() }) {
  if (!id || !timestamp || !signature) throw new Error("Missing Svix signature headers");

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) throw new Error("Invalid Svix timestamp");
  if (Math.abs(Math.floor(nowMs / 1000) - timestampSeconds) > WEBHOOK_TOLERANCE_SECONDS) {
    throw new Error("Webhook timestamp is outside the allowed tolerance");
  }

  const encodedSecret = String(secret || "").startsWith("whsec_")
    ? String(secret).slice("whsec_".length)
    : String(secret || "");
  if (!encodedSecret) throw new Error("Webhook secret is empty");

  const key = Buffer.from(encodedSecret, "base64");
  if (!key.length) throw new Error("Webhook secret is invalid");

  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", key).update(signedContent).digest("base64");
  const expectedBytes = Buffer.from(expected);

  const matched = String(signature)
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1,"))
    .map((part) => part.slice(3))
    .some((candidate) => {
      const candidateBytes = Buffer.from(candidate);
      return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
    });

  if (!matched) throw new Error("Invalid webhook signature");
  return true;
}
