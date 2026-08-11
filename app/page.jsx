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
          <div className="version-line">v0.3.0 · Forms package delivery enabled</div>
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
                <div className="status-pill">{m.formsDelivery?.status === "DELIVERED" ? "FORMS DELIVERED" : m.status}</div>
                <div style={{ textAlign: "right" }}>
                  <span className="stamp pending" style={{ fontSize: 10 }}>
                    {m.resendSimulated ? "SIMULATED" : "SENT"}
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
              <Field label="Offer number" mono>{detail.message.offerNumber}</Field>
              <Field label="Milestone" mono>{detail.message.noticeMilestone || detail.message.milestone}</Field>
              <Field label="Recipient">{detail.message.recipient?.name} &lt;{detail.message.recipient?.email}&gt;</Field>
              <Field label="Email delivery" mono>{detail.message.emailDeliveryStatus || detail.message.status}</Field>
              <Field label="Forms delivery" mono>{detail.message.formsDelivery?.status || "NOT_REQUESTED"}</Field>
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
                  {r.obsoletePackageResponse && (
                    <div className="warning-box">Held: this response references an obsolete Forms package snapshot and was not applied to the current offer.</div>
                  )}
                  <div className="body">{r.classifiedText || r.plainText}</div>
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
          <h2>POST /api/renewal-emails</h2>
          <p>Two backward-compatible request modes are supported.</p>

          <h3>Email only</h3>
          <p><code>Content-Type: application/json</code> keeps the original PAS email contract unchanged.</p>

          <h3>Email + Auto-Renewal Forms</h3>
          <p><code>Content-Type: multipart/form-data</code> with one <code>metadata</code> JSON part and one or more <code>attachments</code> PDF file parts.</p>
          <pre>{`metadata = {
  "requestId": "AR-EMAIL-REQ-...",
  "offerNumber": "ARN-1001",
  "sourcePolicyId": "PA2027000001-00",
  "customerRef": "CUST-1001",
  "recipient": { "name": "QA Customer", "email": "qa@example.com" },
  "noticeMilestone": "60_DAY",
  "formsPackageId": "ARN-FORMS-ARN-1001",
  "formsPackageSnapshotId": "ARN-1001:auto-renewal-forms:...",
  "responseInstructions": { "responseToken": "AR-EMAIL-TOKEN-..." },
  "offer": { "noticeMilestone": 60, "offeredPremium": 1200 }
}
attachments = <actual PDF bytes>`}</pre>

          <h3>Attachment limits</h3>
          <p>PDF only. Maximum 3 files, 3 MB per file, and 3 MB total. The API checks MIME type and PDF file signature, sanitizes filenames, calculates SHA-256, and stores actual file content.</p>

          <h3>Successful Forms response</h3>
          <pre>{`{
  "messageId": "AR-EMAIL-MSG-...",
  "threadId": "AR-EMAIL-THREAD-...",
  "requestId": "AR-EMAIL-REQ-...",
  "responseToken": "AR-EMAIL-TOKEN-...",
  "emailDeliveryStatus": "SENT",
  "outcome": "EMAIL_SENT_FORMS_DELIVERED",
  "formsDelivery": {
    "status": "DELIVERED",
    "formsPackageId": "ARN-FORMS-ARN-1001",
    "formsPackageSnapshotId": "...",
    "attachmentIds": ["AR-EMAIL-ATTACHMENT-..."],
    "attachmentCount": 1,
    "deliveredAt": "..."
  }
}`}</pre>

          <h3>Validation / failure codes</h3>
          <p className="mono">ATTACHMENT_REQUIRED · ATTACHMENT_TOO_LARGE · ATTACHMENT_COUNT_EXCEEDED · UNSUPPORTED_ATTACHMENT_TYPE · PACKAGE_CORRELATION_MISSING · PACKAGE_SNAPSHOT_MISMATCH · ATTACHMENT_STORAGE_FAILED · IDEMPOTENCY_CONFLICT · EMAIL_SENT_FORMS_FAILED · EMAIL_FAILED</p>

          <h3>Response correlation</h3>
          <p>Replies remain tied to offerNumber, Forms Package ID, Forms Package Snapshot ID, responseToken, messageId, and threadId. A response to an obsolete snapshot is stored and audited but held from the current offer.</p>
        </div>
      )}
    </div>
  );
}
