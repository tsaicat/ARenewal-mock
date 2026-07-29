// Dedicated Upstash keyspace for the Auto-Renewal email service.
// This database may be shared with other PAS mock integrations, so no
// generic message/report/audit keys are allowed outside this namespace.
export const AUTO_RENEWAL_EMAIL_KEYSPACE = 'ar-email:v1';

export function arEmailKey(...parts) {
  const suffix = parts
    .flat()
    .filter((part) => part !== undefined && part !== null && String(part) !== '')
    .map((part) => String(part).replace(/\s+/g, '-'))
    .join(':');
  return suffix ? `${AUTO_RENEWAL_EMAIL_KEYSPACE}:${suffix}` : AUTO_RENEWAL_EMAIL_KEYSPACE;
}
