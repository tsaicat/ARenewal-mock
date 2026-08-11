export function classifyStorageError(error) {
  const text = String(error?.message || error || "").toLowerCase();
  if (/quota|limit exceeded|maxmemory|oom/.test(text)) {
    return { code: "STORAGE_QUOTA_EXCEEDED", message: "Persistent mock storage quota was exceeded." };
  }
  if (/upstash|redis|fetch failed|network|timeout|econn|unavailable/.test(text)) {
    return { code: "STORAGE_UNAVAILABLE", message: "Persistent mock storage is unavailable." };
  }
  return { code: "ATTACHMENT_STORAGE_FAILED", message: "The Forms attachment could not be persisted." };
}
