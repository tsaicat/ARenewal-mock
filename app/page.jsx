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
        <h1>Auto-Renewal // Mock Email Register</h1>
        <div className="sub">arenewal@iapasapp.com</div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === "inbox" ? "active" : ""}`} onClick={() => setTab("inbox")}>
          Inbox
        </button>
        <button className={`tab ${tab === "audit" ? "active" : ""}`} onClick={() => setTab("audit")}>
          Audit Log
        </button>
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
                    {m.offerNumber} · {m.recipient?.email} · milestone: {m.milestone ?? "—"}-day
                  </div>
                </div>
                <div className="status-pill">{m.status}</div>
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
              <button className="backlink" onClick={() => setSelectedId(null)}>
                ← close
              </button>
              <h2>{detail.message.subject}</h2>
              <div className="field-row">
                <div className="k">Message ID</div>
                <div className="mono">{detail.message.messageId}</div>
              </div>
              <div className="field-row">
                <div className="k">Offer number</div>
                <div className="mono">{detail.message.offerNumber}</div>
              </div>
              <div className="field-row">
                <div className="k">Recipient</div>
                <div>
                  {detail.message.recipient?.name} &lt;{detail.message.recipient?.email}&gt;
                </div>
              </div>
              <div className="field-row">
                <div className="k">Current customer response</div>
                <div>
                  <span className={stampClass(detail.offerState?.emailGateway?.lastClassification)}>
                    {detail.offerState?.customerResponseStatus || "Pending"}
                  </span>
                </div>
              </div>
              <div className="field-row">
                <div className="k">Callback status</div>
                <div className="mono">
                  {detail.offerState?.emailGateway?.callbackStatus || "—"} (
                  {detail.offerState?.emailGateway?.callbackAttempts || 0} attempt
                  {detail.offerState?.emailGateway?.callbackAttempts === 1 ? "" : "s"})
                </div>
              </div>

              <h2 style={{ marginTop: 20 }}>Replies ({detail.replies.length})</h2>
              {detail.replies.length === 0 && <div className="meta" style={{ color: "#9098ab" }}>No replies yet.</div>}
              {detail.replies.map((r) => (
                <div className="reply-card" key={r.replyId}>
                  <span className={stampClass(r.classification)}>{r.classification}</span>{" "}
                  <span className="mono" style={{ fontSize: 11, color: "#8991a5" }}>
                    from {r.from} · {formatDate(r.receivedAt)}
                    {r.matchedPhrase ? ` · matched "${r.matchedPhrase}"` : ""}
                  </span>
                  <div className="body">{r.classifiedText || r.plainText}</div>
                  {r.classifiedText && r.plainText && r.classifiedText !== r.plainText && (
                    <details style={{ marginTop: 8 }}>
                      <summary className="mono" style={{ fontSize: 10, color: "#6b7280", cursor: "pointer" }}>
                        full email (quoted original included, not used for classification)
                      </summary>
                      <div className="body" style={{ color: "#6b7280", marginTop: 4 }}>
                        {r.plainText}
                      </div>
                    </details>
                  )}
                </div>
              ))}

              <h2 style={{ marginTop: 20 }}>Simulate a reply</h2>
              <form onSubmit={submitSimulatedReply}>
                <input
                  className="mono"
                  style={{ width: "100%", padding: 8, marginBottom: 8, background: "#0f1420", border: "1px solid #2b3346", color: "#efe9da" }}
                  value={replyFrom}
                  onChange={(e) => setReplyFrom(e.target.value)}
                  placeholder="from@example.test"
                />
                <textarea
                  className="mono"
                  style={{ width: "100%", minHeight: 80, padding: 8, background: "#0f1420", border: "1px solid #2b3346", color: "#efe9da" }}
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
                {entry.classification ? ` · ${entry.classification}` : ""}
                {entry.status ? ` · ${entry.status}` : ""}
                {(entry.reason || entry.error) && (
                  <div style={{ color: "#c99", marginTop: 4, whiteSpace: "pre-wrap" }}>
                    {entry.reason || entry.error}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
