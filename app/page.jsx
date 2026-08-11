"use client";

import { useEffect, useState, useCallback } from "react";

function stampClass(classification) {
  if (classification === "ACCEPT") return "stamp accept";
  if (classification === "DECLINE") return "stamp decline";
  if (classification === "AMBIGUOUS") return "stamp ambiguous";
  return "stamp pending";
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function messageStatusLabel(message) {
  if (message.formsDelivery?.status && message.formsDelivery.status !== "NOT_REQUESTED") {
    return `FORMS ${message.formsDelivery.status.replaceAll("_", " ")}`;
  }
  return String(message.emailDeliveryStatus || message.status || "UNKNOWN").replaceAll("_", " ");
}

function Field({ label, children, mono = false }) {
  return (
    <div className="field-row">
      <div className="k">{label}</div>
      <div className={mono ? "mono" : ""}>{children ?? "—"}</div>
    </div>
  );
}

export default function Page() {
  const [tab, setTab] = useState("inbox");
  const [messages, setMessages] = useState([]);
  const [audit, setAudit] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyFrom, setReplyFrom] = useState("");
  const [posting, setPosting] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadInbox = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/renewal-emails");
    const data = await res.json();
    setMessages(data.messages || []);
    setLoading(false);
  }, []);

  const loadAudit = useCallback(async () => {
    const res = await fetch("/api/audit");
    const data = await res.json();
    setAudit(data.entries || []);
  }, []);

  const loadDetail = useCallback(async (messageId) => {
    const res = await fetch(`/api/messages/${messageId}`);
    if (!res.ok) return;
    const data = await res.json();
    setDetail(data);
    setReplyFrom(data.message?.recipient?.email || "");
  }, []);

  useEffect(() => {
    loadInbox();
    loadAudit();
  }, [loadInbox, loadAudit]);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  async function submitSimulatedReply(e) {
    e.preventDefault();
    if (!selectedId || !replyDraft.trim()) return;
    setPosting(true);
    await fetch(`/api/renewal-emails/${selectedId}/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: replyFrom, plainText: replyDraft }),
    });
    setReplyDraft("");
    setPosting(false);
    loadDetail(selectedId);
    loadInbox();
    loadAudit();
  }

  return (
    <div className="app">
      <div className="masthead">
        <div>
          <h1>Auto-Renewal // Mock Email Register</h1>
          <div className="version-line">v0.4.0 · lifecycle-aware delivery & response provenance</div>
        </div>
        <div className="sub">arenewal@iapasapp.com</div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === "inbox" ? "active" : ""}`} onClick={() => setTab("inbox")}>Inbox</button>
        <button className={`tab ${tab === "audit" ? "active" : ""}`} onClick={() => setTab("audit")}>Audit Log</button>
        <button className={`tab ${tab === "docs" ? "active" : ""}`} onClick={() => setTab("docs")}>API Reference</button>
        <button
          className="tab"
          onClick={() => {
            loadInbox();
            loadAudit();
            if (selectedId) loadDetail(selectedId);
          }}
        >
          ↻ Refresh
        </button>
      </div>

      {tab === "inbox" && (
        <>
          <div className="ledger">
            {loading && <div className="empty">Loading…</div>}
            {!loading && messages.length === 0 && (
              <div className="empty">No renewal offer emails sent yet. POST to /api/renewal-emails to create one.</div>
            )}
            {messages.map((m) => (
              <div className="ledger-row" key={m.messageId} onClick={() => setSelectedId(m.messageId)}>
                <div className="date">{formatDate(m.createdAt)}</div>
                <div>
                  <div className="subject">{m.subject}</div>
                  <div className="meta">
                    {m.offerNumber} · {m.recipient?.email} · {m.noticeMilestone || `${m.milestone ?? "—"}_DAY`}
                    {m.attachments?.length ? ` · 📎 ${m.attachments.length}` : ""}
                  </div>
                </div>
                <div className="status-pill">{messageStatusLabel(m)}</div>
                <div style={{ textAlign: "right" }}>
                  <span className="stamp pending" style={{ fontSize: 10 }}>
                    {m.deliveryMode || (m.resendSimulated ? "SIMULATED" : "REAL PROVIDER")}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {detail && detail.message?.messageId === selectedId && (
            <div className="detail-panel">
              <button className="backlink" onClick={() => setSelectedId(null)}>← close</button>
              <h2>{detail.message.subject}</h2>
              <Field label="Message ID" mono>{detail.message.messageId}</Field>
              <Field label="Thread ID" mono>{detail.message.threadId}</Field>
              <Field label="Request ID" mono>{detail.message.requestId}</Field>
              <Field label="Response token" mono>{detail.message.responseToken}</Field>
              <Field label="Base offer" mono>{detail.message.baseOfferNumber || detail.message.offerNumber}</Field>
              <Field label="Offer number" mono>{detail.message.offerNumber}</Field>
              <Field label="Offer version" mono>{detail.message.offerVersion || 1}</Field>
              <Field label="Offer status" mono>{detail.offerState?.offerStatus || detail.message.offerStatus || "CURRENT"}</Field>
              <Field label="Supersedes" mono>{detail.message.supersedesOfferNumber}</Field>
              <Field label="Milestone" mono>{detail.message.noticeMilestone || detail.message.milestone}</Field>
              <Field label="Recipient">{detail.message.recipient?.name} &lt;{detail.message.recipient?.email}&gt;</Field>
              <Field label="Delivery mode" mono>{detail.message.deliveryMode || (detail.message.resendSimulated ? "SIMULATED" : "REAL_PROVIDER")}</Field>
              <Field label="Email delivery" mono>{detail.message.emailDeliveryStatus || detail.message.status}</Field>
              <Field label="Forms delivery" mono>{detail.message.formsDelivery?.status || "NOT_REQUESTED"}</Field>
              <Field label="Provider Message ID" mono>{detail.message.providerMessageId}</Field>
              <Field label="Provider Event" mono>{detail.message.providerDelivery?.providerEventType}</Field>
              <Field label="Provider Event ID" mono>{detail.message.providerDelivery?.providerEventId}</Field>
              <Field label="Forms Package ID" mono>{detail.message.formsPackageId}</Field>
              <Field label="Package Snapshot ID" mono>{detail.message.formsPackageSnapshotId}</Field>
              <Field label="Current customer response">
                <span className={stampClass(detail.offerState?.emailGateway?.lastClassification)}>
                  {detail.offerState?.customerResponseStatus || "Pending"}
                </span>
              </Field>
              <Field label="Callback status" mono>
                {detail.offerState?.emailGateway?.callbackStatus || "—"} ({detail.offerState?.emailGateway?.callbackAttempts || 0} attempt{detail.offerState?.emailGateway?.callbackAttempts === 1 ? "" : "s"})
              </Field>

              <h2 style={{ marginTop: 20 }}>Attachments ({detail.message.attachments?.length || 0})</h2>
              {!detail.message.attachments?.length && <div className="muted">No Forms attachment on this email.</div>}
              {detail.message.attachments?.map((attachment) => (
                <div className="attachment-card" key={attachment.attachmentId}>
                  <div>
                    <div className="attachment-title">📎 {attachment.fileName}</div>
                    <div className="attachment-meta mono">
                      {formatBytes(attachment.sizeBytes)} · {attachment.contentType} · {attachment.deliveryStatus}
                    </div>
                    <div className="attachment-meta mono">SHA-256: {attachment.checksumSha256}</div>
                  </div>
                  <div className="attachment-actions">
                    <a className="tab" href={`/api/messages/${detail.message.messageId}/attachments/${attachment.attachmentId}`} target="_blank" rel="noreferrer">View</a>
                    <a className="tab" href={`/api/messages/${detail.message.messageId}/attachments/${attachment.attachmentId}?download=1`}>Download</a>
                  </div>
                </div>
              ))}

              <h2 style={{ marginTop: 20 }}>Replies ({detail.replies.length})</h2>
              {detail.replies.length === 0 && <div className="muted">No replies yet.</div>}
              {detail.replies.map((r) => (
                <div className="reply-card" key={r.replyId}>
                  <span className={stampClass(r.classification)}>{r.classification}</span>{" "}
                  <span className="mono" style={{ fontSize: 11, color: "#8991a5" }}>
                    from {r.from} · {formatDate(r.receivedAt)}
                    {r.matchedPhrase ? ` · matched "${r.matchedPhrase}"` : ""}
                  </span>
                  {r.responseApplicability !== "CURRENT" && (
                    <div className="warning-box">Held / review: {r.responseApplicability?.replaceAll("_", " ") || "MANUAL REVIEW"}. This response was not applied to the current actionable offer.</div>
                  )}
                  <div className="body">{r.classifiedText || r.plainText}</div>
                  <div className="attachment-meta mono">
                    Event: {r.eventId || "—"} · Intent: {r.normalizedDecision || r.classification} · Applicability: {r.responseApplicability || "CURRENT"} · Applied: {r.appliedToCurrentOffer ? "Yes" : "No"}
                  </div>
                  <div className="attachment-meta mono">
                    Package: {r.formsPackageId || "—"} · Snapshot: {r.formsPackageSnapshotId || "—"}
                  </div>
                </div>
              ))}

              <h2 style={{ marginTop: 20 }}>Simulate a reply</h2>
              <form onSubmit={submitSimulatedReply}>
                <input
                  className="mono form-control"
                  value={replyFrom}
                  onChange={(e) => setReplyFrom(e.target.value)}
                  placeholder="from@example.test"
                />
                <textarea
                  className="mono form-control reply-input"
                  value={replyDraft}
                  onChange={(e) => setReplyDraft(e.target.value)}
                  placeholder='e.g. "Yes, please renew my policy. I accept the offer."'
                />
                <button className="tab" type="submit" disabled={posting} style={{ marginTop: 8 }}>
                  {posting ? "Sending…" : "Submit reply"}
                </button>
              </form>
            </div>
          )}
        </>
      )}

      {tab === "audit" && (
        <div className="detail-panel">
          <div className="refresh-note">Newest first · {audit.length} entries shown</div>
          {audit.map((entry) => (
            <div className="audit-row" key={entry.auditId}>
              <div>{formatDate(entry.at)}</div>
              <div className="type">{entry.eventType}</div>
              <div style={{ color: "#c9c0a6" }}>
                {entry.offerNumber || entry.messageId || entry.replyId || entry.eventId || ""}
                {entry.formsPackageId ? ` · ${entry.formsPackageId}` : ""}
                {entry.classification ? ` · ${entry.classification}` : ""}
                {entry.status ? ` · ${entry.status}` : ""}
                {(entry.reason || entry.error) && (
                  <div style={{ color: "#c99", marginTop: 4, whiteSpace: "pre-wrap" }}>{entry.reason || entry.error}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "docs" && (
        <div className="detail-panel docs">
          <h2>v0.4 API Reference</h2>
          <p><strong>Delivery truthfulness:</strong> a successful provider send request starts as <code>DELIVERY_PENDING</code>. Only a later Resend <code>email.delivered</code> webhook can set Email/Forms to <code>DELIVERED</code>. Bounce/failure cannot remain delivered.</p>

          <h3>POST /api/renewal-emails</h3>
          <p>Backward-compatible <code>application/json</code> email-only and <code>multipart/form-data</code> metadata + actual PDF attachment modes remain supported.</p>
          <pre>{`{
  "requestId": "AR-EMAIL-REQ-...",
  "baseOfferNumber": "ARN-1001",
  "offerNumber": "ARN-1001-R2",
  "offerVersion": 2,
  "supersedesOfferNumber": "ARN-1001",
  "offerExpirationDate": "2026-09-01T23:59:59Z",
  "noticeMilestone": "15_DAY",
  "communicationType": "NOTICE",
  "formsPackageId": "ARN-FORMS-...",
  "formsPackageSnapshotId": "..."
}`}</pre>

          <h3>Initial provider-backed Forms result</h3>
          <pre>{`{
  "emailDeliveryStatus": "DELIVERY_PENDING",
  "outcome": "EMAIL_SENT_FORMS_PENDING",
  "formsDelivery": { "status": "DELIVERY_PENDING" }
}`}</pre>
          <p><code>email.sent</code> keeps delivery pending; <code>email.delivered</code> confirms delivery; <code>email.delivery_delayed</code>, <code>email.bounced</code>, and <code>email.failed</code> update the stored evidence asynchronously.</p>

          <h3>Simulation</h3>
          <p>No provider credential is never silently treated as real delivery. Local/test simulation requires <code>ALLOW_SIMULATED_EMAIL=true</code> and returns <code>SIMULATED</code>.</p>

          <h3>Offer lineage & response provenance</h3>
          <p>New lineage-aware clients may send <code>baseOfferNumber</code>, <code>offerVersion</code>, and <code>supersedesOfferNumber</code>. Replies return stable <code>eventId</code>, normalized decision, applicability, late/superseded/obsolete flags, and whether the response was actually applied.</p>

          <h3>GET /api/auto-renewal/offers/:baseOfferNumber/responses</h3>
          <p>Returns chronological canonical response history across an offer family and its revisions.</p>

          <h3>Controlled resend</h3>
          <p>Use the existing send endpoint with <code>resend=true</code>, <code>originalMessageId</code>, <code>resendReason</code>, and <code>resendActor</code>. Normal offer-version/milestone sends are semantically idempotent even when a different requestId is supplied.</p>

          <h3>POST /api/messages/:messageId/acknowledgments</h3>
          <p>Sends an <code>ACCEPTANCE</code> or <code>DECLINE</code> acknowledgment correlated to a canonical <code>responseEventId</code>. JSON and optional multipart PDF attachment modes are supported. The Mock canonical thread is preserved; provider-level email-client threading is not guaranteed.</p>

          <h3>Attachment limits</h3>
          <p>PDF only · maximum 3 files · 3 MB per file · 3 MB total. Actual PDF bytes are validated, SHA-256 hashed, persisted, and never exposed as Base64 in normal Inbox JSON.</p>
        </div>
      )}

    </div>
  );
}
