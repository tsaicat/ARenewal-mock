"use client";

import { useCallback, useEffect, useState } from "react";

function stampClass(classification) {
  if (classification === "ACCEPT") return "stamp accept";
  if (classification === "DECLINE") return "stamp decline";
  if (classification === "AMBIGUOUS") return "stamp ambiguous";
  return "stamp pending";
}
function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
function messageStatusLabel(message) {
  if (message.formsDelivery?.status && message.formsDelivery.status !== "NOT_REQUESTED") return `FORMS ${message.formsDelivery.status.replaceAll("_", " ")}`;
  return String(message.emailDeliveryStatus || message.status || "UNKNOWN").replaceAll("_", " ");
}
function Field({ label, children, mono = false }) {
  return <div className="field-row"><div className="k">{label}</div><div className={mono ? "mono" : ""}>{children ?? "—"}</div></div>;
}

export default function Page() {
  const [session, setSession] = useState(null);
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [tab, setTab] = useState("inbox");
  const [messages, setMessages] = useState([]);
  const [audit, setAudit] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyFrom, setReplyFrom] = useState("");
  const [posting, setPosting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [health, setHealth] = useState(null);
  const [capabilities, setCapabilities] = useState(null);

  const loadSession = useCallback(async () => {
    const res = await fetch("/api/auth/session", { cache: "no-store" });
    setSession(await res.json());
  }, []);
  const loadDiagnostics = useCallback(async () => {
    const [healthRes, capabilitiesRes] = await Promise.all([fetch("/api/health", { cache: "no-store" }), fetch("/api/capabilities", { cache: "no-store" })]);
    setHealth(await healthRes.json().catch(() => ({})));
    setCapabilities(await capabilitiesRes.json().catch(() => ({})));
  }, []);
  const loadInbox = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/renewal-emails", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { await loadSession(); setLoading(false); return; }
    setMessages(data.messages || []); setLoading(false);
  }, [loadSession]);
  const loadAudit = useCallback(async () => {
    const res = await fetch("/api/audit", { cache: "no-store" });
    if (!res.ok) return;
    setAudit((await res.json()).entries || []);
  }, []);
  const loadDetail = useCallback(async (messageId) => {
    const res = await fetch(`/api/messages/${messageId}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json(); setDetail(data); setReplyFrom(data.message?.recipient?.email || "");
  }, []);

  useEffect(() => { loadSession(); loadDiagnostics(); }, [loadSession, loadDiagnostics]);
  useEffect(() => { if (session?.authenticated) { loadInbox(); loadAudit(); } }, [session?.authenticated, loadInbox, loadAudit]);
  useEffect(() => { if (selectedId && session?.authenticated) loadDetail(selectedId); }, [selectedId, session?.authenticated, loadDetail]);

  async function login(e) {
    e.preventDefault(); setAuthError("");
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setAuthError(data.error || "Login failed"); return; }
    setPassword(""); await loadSession();
  }
  async function logout() { await fetch("/api/auth/logout", { method: "POST" }); setMessages([]); setAudit([]); setDetail(null); setSelectedId(null); await loadSession(); }
  async function submitSimulatedReply(e) {
    e.preventDefault(); if (!selectedId || !replyDraft.trim()) return;
    setPosting(true);
    const res = await fetch(`/api/renewal-emails/${selectedId}/replies`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: replyFrom, plainText: replyDraft }) });
    setPosting(false);
    if (res.ok) { setReplyDraft(""); loadDetail(selectedId); loadInbox(); loadAudit(); }
  }
  function refresh() { loadDiagnostics(); if (session?.authenticated) { loadInbox(); loadAudit(); if (selectedId) loadDetail(selectedId); } }

  if (!session) return <div className="app"><div className="empty dark-empty">Loading QA access…</div></div>;
  if (!session.authenticated) {
    return <div className="app"><div className="masthead"><div><h1>Auto-Renewal // Mock Email Register</h1><div className="version-line">v0.5.0 · secured QA operations</div></div></div>
      <div className="login-panel"><h2>QA Inbox Sign In</h2><p>This deployed Inbox is protected. Enter the configured QA password; the server returns an HttpOnly signed session cookie.</p>
        <form onSubmit={login}><input className="mono form-control" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="QA Inbox password" autoComplete="current-password"/><button className="tab active" type="submit">Sign In</button></form>
        {authError && <div className="warning-box">{authError}</div>}
        {!session.authenticationConfigured && <div className="warning-box">QA authentication is required but not configured. Configure QA_INBOX_PASSWORD and QA_SESSION_SECRET.</div>}
      </div></div>;
  }

  return <div className="app">
    <div className="masthead"><div><h1>Auto-Renewal // Mock Email Register</h1><div className="version-line">v0.5.0 · secure retention & QA operations</div></div><div className="sub">arenewal@iapasapp.com</div></div>
    {(health?.warnings || []).map((warning) => <div className="warning-box" key={warning}>{warning.replaceAll("_", " ")}</div>)}
    <div className="tabs">
      <button className={`tab ${tab === "inbox" ? "active" : ""}`} onClick={() => setTab("inbox")}>Inbox</button>
      <button className={`tab ${tab === "audit" ? "active" : ""}`} onClick={() => setTab("audit")}>Audit Log</button>
      <button className={`tab ${tab === "diagnostics" ? "active" : ""}`} onClick={() => setTab("diagnostics")}>Diagnostics</button>
      <button className={`tab ${tab === "docs" ? "active" : ""}`} onClick={() => setTab("docs")}>API Reference</button>
      <button className="tab" onClick={refresh}>↻ Refresh</button>
      {session.authenticationRequired && <button className="tab" onClick={logout}>Sign Out</button>}
    </div>

    {tab === "inbox" && <>
      <div className="ledger">
        {loading && <div className="empty">Loading…</div>}
        {!loading && messages.length === 0 && <div className="empty">No renewal offer emails sent yet.</div>}
        {messages.map((m) => <div className="ledger-row" key={m.messageId} onClick={() => setSelectedId(m.messageId)}>
          <div className="date">{formatDate(m.createdAt)}</div><div><div className="subject">{m.subject}</div><div className="meta">{m.offerNumber} · {m.recipient?.email} · {m.noticeMilestone || `${m.milestone ?? "—"}_DAY`}{m.attachments?.length ? ` · 📎 ${m.attachments.length}` : ""}</div></div>
          <div className="status-pill">{messageStatusLabel(m)}</div><div style={{textAlign:"right"}}><span className="stamp pending" style={{fontSize:10}}>{m.deliveryMode || (m.resendSimulated ? "SIMULATED" : "REAL PROVIDER")}</span></div>
        </div>)}
      </div>
      {detail && detail.message?.messageId === selectedId && <div className="detail-panel"><button className="backlink" onClick={() => setSelectedId(null)}>← close</button><h2>{detail.message.subject}</h2>
        <Field label="Message ID" mono>{detail.message.messageId}</Field><Field label="Thread ID" mono>{detail.message.threadId}</Field><Field label="Request ID" mono>{detail.message.requestId}</Field><Field label="Response token" mono>{detail.message.responseToken}</Field>
        <Field label="Base offer" mono>{detail.message.baseOfferNumber || detail.message.offerNumber}</Field><Field label="Offer number" mono>{detail.message.offerNumber}</Field><Field label="Offer version" mono>{detail.message.offerVersion || 1}</Field><Field label="Offer status" mono>{detail.offerState?.offerStatus || detail.message.offerStatus || "CURRENT"}</Field>
        <Field label="Milestone" mono>{detail.message.noticeMilestone || detail.message.milestone}</Field><Field label="Recipient">{detail.message.recipient?.name} &lt;{detail.message.recipient?.email}&gt;</Field><Field label="Delivery mode" mono>{detail.message.deliveryMode || "REAL_PROVIDER"}</Field><Field label="Email delivery" mono>{detail.message.emailDeliveryStatus || detail.message.status}</Field><Field label="Forms delivery" mono>{detail.message.formsDelivery?.status || "NOT_REQUESTED"}</Field>
        <Field label="Provider Message ID" mono>{detail.message.providerMessageId}</Field><Field label="Provider Event" mono>{detail.message.providerDelivery?.providerEventType}</Field><Field label="Provider Event ID" mono>{detail.message.providerDelivery?.providerEventId}</Field><Field label="Forms Package ID" mono>{detail.message.formsPackageId}</Field><Field label="Package Snapshot ID" mono>{detail.message.formsPackageSnapshotId}</Field><Field label="Retention expires" mono>{detail.message.retentionExpiresAt}</Field>
        <Field label="Current customer response"><span className={stampClass(detail.offerState?.emailGateway?.lastClassification)}>{detail.offerState?.customerResponseStatus || "Pending"}</span></Field>
        <h2 style={{marginTop:20}}>Attachments ({detail.message.attachments?.length || 0})</h2>{!detail.message.attachments?.length && <div className="muted">No Forms attachment on this email.</div>}
        {detail.message.attachments?.map((a) => <div className="attachment-card" key={a.attachmentId}><div><div className="attachment-title">📎 {a.fileName}</div><div className="attachment-meta mono">{formatBytes(a.sizeBytes)} · {a.contentType} · delivery {a.deliveryStatus} · retained {a.retentionStatus || "AVAILABLE"}</div><div className="attachment-meta mono">SHA-256: {a.checksumSha256}</div></div><div className="attachment-actions">{a.retentionStatus !== "PURGED" ? <><a className="tab" href={`/api/messages/${detail.message.messageId}/attachments/${a.attachmentId}`} target="_blank" rel="noreferrer">View</a><a className="tab" href={`/api/messages/${detail.message.messageId}/attachments/${a.attachmentId}?download=1`}>Download</a></> : <span className="muted">QA copy purged</span>}</div></div>)}
        <h2 style={{marginTop:20}}>Replies ({detail.replies.length})</h2>{detail.replies.length === 0 && <div className="muted">No replies yet.</div>}{detail.replies.map((r) => <div className="reply-card" key={r.replyId}><span className={stampClass(r.classification)}>{r.classification}</span> <span className="mono reply-meta">from {r.from} · {formatDate(r.receivedAt)}</span>{r.responseApplicability !== "CURRENT" && <div className="warning-box">Held / review: {r.responseApplicability?.replaceAll("_", " ")}. Not applied to the current actionable offer.</div>}<div className="body">{r.classifiedText || r.plainText}</div><div className="attachment-meta mono">Event: {r.eventId || "—"} · Intent: {r.normalizedDecision || r.classification} · Applicability: {r.responseApplicability || "CURRENT"} · Applied: {r.appliedToCurrentOffer ? "Yes" : "No"}</div></div>)}
        <h2 style={{marginTop:20}}>Training reply simulation</h2><form onSubmit={submitSimulatedReply}><input className="mono form-control" value={replyFrom} onChange={(e) => setReplyFrom(e.target.value)} placeholder="from@example.test"/><textarea className="mono form-control reply-input" value={replyDraft} onChange={(e) => setReplyDraft(e.target.value)} placeholder='e.g. "Yes, please renew my policy."'/><button className="tab" type="submit" disabled={posting}>{posting ? "Submitting…" : "Submit reply"}</button></form>
      </div>}
    </>}

    {tab === "audit" && <div className="detail-panel"><div className="refresh-note">Newest first · {audit.length} entries shown</div>{audit.map((entry) => <div className="audit-row" key={entry.auditId}><div>{formatDate(entry.at)}</div><div className="type">{entry.eventType}</div><div>{entry.offerNumber || entry.messageId || entry.eventId || ""}{(entry.reason || entry.error) && <div className="audit-error">{entry.reason || entry.error}</div>}</div></div>)}</div>}

    {tab === "diagnostics" && <div className="detail-panel docs"><h2>Safe Operational Diagnostics</h2><Field label="Mock API version" mono>{health?.version || capabilities?.serviceVersion}</Field><Field label="Environment" mono>{health?.environmentMode}</Field><Field label="Service" mono>{health?.service}</Field><Field label="Email provider" mono>{health?.emailProvider}</Field><Field label="Webhook verification" mono>{health?.webhookVerification}</Field><Field label="Storage" mono>{health?.storage}</Field><Field label="Authentication" mono>{health?.authentication}</Field><Field label="Retention" mono>{health?.retentionDays ? `${health.retentionDays} days` : "—"}</Field><Field label="Attachment limit" mono>{capabilities?.maxAttachmentBytes ? `${formatBytes(capabilities.maxAttachmentBytes)} / file; ${capabilities.maxAttachmentCount} files` : "—"}</Field>{health?.problems?.length > 0 && <div className="warning-box">Configuration issues: {health.problems.join(", ")}</div>}<p>No API keys, tokens, database URLs, webhook secrets, or storage credentials are exposed here.</p></div>}

    {tab === "docs" && <div className="detail-panel docs"><h2>v0.5 API Reference</h2><p><strong>Production authentication:</strong> PAS write operations require <code>X-Mock-Api-Key</code> (or Bearer service credential). QA Inbox reads use an HttpOnly signed QA session. Production credentials remain server-only.</p><h3>Safe public discovery</h3><p><code>GET /api/health</code> and <code>GET /api/capabilities</code> report configuration/capability state without returning secrets.</p><h3>Protected resources</h3><p><code>POST /api/renewal-emails</code>, acknowledgments, message listing/detail, response history, audit, simulated replies, and Forms downloads are protected in deployed mode. Attachments are not downloadable merely by knowing IDs.</p><h3>CORS</h3><p>Configure <code>ALLOWED_ORIGINS</code> with approved PAS/QA origins. Arbitrary browser origins are rejected; CORS does not replace authentication.</p><h3>Retention</h3><p><code>MOCK_DATA_RETENTION_DAYS</code> defaults to 30 days. Stored message, attachment, response and offer records use retention TTLs where supported; stale indexes are compacted. Historical delivery evidence remains distinguishable from a purged QA copy.</p><h3>Provider webhook</h3><p><code>RESEND_WEBHOOK_SECRET</code> is mandatory in production. Unsigned local testing requires explicit <code>ALLOW_UNSIGNED_WEBHOOK_TEST=true</code>. Provider event IDs remain idempotency guards.</p><h3>PAS migration</h3><p>PAS v7.137.13 must receive a follow-up integration patch before production Mock v0.5: browser-delivered code must not embed the service API key. Use an appropriate secure proxy/backend or short-lived server-mediated credential design.</p></div>}
  </div>;
}
