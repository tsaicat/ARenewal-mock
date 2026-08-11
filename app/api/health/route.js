import { NextResponse } from "next/server";
import { environmentMode, explicitBoolean, isProductionMode, retentionDays } from "@/lib/environment";
import { persistentStorageConfigured, storageBackend } from "@/lib/store";
import { securityDiagnostics } from "@/lib/security";

export const dynamic = "force-dynamic";
export async function GET() {
  const security = securityDiagnostics();
  const emailProviderConfigured = Boolean(process.env.RESEND_API_KEY);
  const webhookVerificationConfigured = Boolean(process.env.RESEND_WEBHOOK_SECRET);
  const problems = [];
  if (isProductionMode() && !persistentStorageConfigured) problems.push("PERSISTENT_STORAGE_NOT_CONFIGURED");
  if (isProductionMode() && !emailProviderConfigured) problems.push("EMAIL_PROVIDER_NOT_CONFIGURED");
  if (isProductionMode() && !webhookVerificationConfigured) problems.push("WEBHOOK_VERIFICATION_NOT_CONFIGURED");
  if (isProductionMode() && !security.serviceAuthenticationConfigured) problems.push("SERVICE_AUTH_NOT_CONFIGURED");
  if (isProductionMode() && !security.qaAuthenticationConfigured) problems.push("QA_AUTH_NOT_CONFIGURED");
  const warnings = [];
  if (explicitBoolean("ALLOW_SIMULATED_EMAIL", false)) warnings.push("SIMULATED_EMAIL_MODE_ENABLED");
  if (!webhookVerificationConfigured && explicitBoolean("ALLOW_UNSIGNED_WEBHOOK_TEST", false)) warnings.push("UNSIGNED_WEBHOOK_TEST_MODE");
  if (!persistentStorageConfigured) warnings.push("LOCAL_NON_PERSISTENT_STORAGE_MODE");
  if (!security.authenticationRequired) warnings.push("API_AUTHENTICATION_DISABLED_FOR_DEVELOPMENT");
  if (!security.qaAuthenticationRequired) warnings.push("QA_AUTHENTICATION_DISABLED_FOR_DEVELOPMENT");
  return NextResponse.json({
    service: problems.length ? "degraded" : "ok",
    version: "0.5.0",
    environmentMode: environmentMode(),
    storage: persistentStorageConfigured ? "configured" : `development-fallback:${storageBackend}`,
    emailProvider: emailProviderConfigured ? "configured" : "unavailable",
    webhookVerification: webhookVerificationConfigured ? "configured" : "unavailable",
    authentication: security.authenticationRequired ? "required" : "development-compatibility",
    retentionDays: retentionDays(),
    problems,
    warnings,
  }, { status: problems.length && isProductionMode() ? 503 : 200 });
}
