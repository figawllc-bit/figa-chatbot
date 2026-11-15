// Allowlisted metadata only. Never serialize a grant, raw error, or SMS record.
export function discoverySafeResult(session, result, category = null, diagnostics) {
  const attempts = session?.attempts;
  return {
    authentication: session?.authenticationVerified === true ? 'verified' : 'failed_or_unverified',
    requests: { oauth: attempts?.oauth === 1 ? 1 : 0, discovery: attempts?.discovery === 1 ? 1 : 0 },
    smsDiscovered: category === null ? result?.status === 'selected' : null,
    errorCategory: category,
    safetyRestrictionsEnforced: true,
    ...(category && Number.isInteger(diagnostics?.httpStatus) && diagnostics.httpStatus >= 100 && diagnostics.httpStatus <= 599 ? { httpStatus: diagnostics.httpStatus } : {}),
    ...(category && typeof diagnostics?.oauthErrorCode === 'string' && /^(?:OAU|CMN)-\d{3}$/.test(diagnostics.oauthErrorCode) ? { oauthErrorCode: diagnostics.oauthErrorCode } : {}),
  };
}
