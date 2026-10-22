"""navigation-resolver.ts pass 2: the bodies that referenced the deleted helpers."""

path = "clients/web/src/lib/navigation/navigation-resolver.ts"
src = open(path).read()
orig = len(src)


def rep(old, new, label, count=1):
    global src
    assert src.count(old) == count, f"{label}: count={src.count(old)}"
    src = src.replace(old, new)


# 1. allowGatewayAuth body — the paid-return suspension check.
rep(
    """  if (!state.isGatewayAuth) {
    return null;
  }
  if (postCheckoutHatchReturnTo(pathnameWithSearch)) {
    return null;
  }""",
    """  if (!state.isGatewayAuth) {
    return null;
  }""",
    "allowGatewayAuth body",
)

# 2. consentBounceDestination body — back to the bare entrypoint.
old_cb = src[src.index("function consentBounceDestination"):]
end_idx = old_cb.index("}")
rep(
    """function consentBounceDestination(
  state: NavigationState,
  pathnameWithSearch: string,
): string {
  const entrypoint = onboardingEntrypoint(state.isLocalClient);
  if (entrypoint !== routes.onboarding.privacy) {
    return entrypoint;
  }
  const paidReturn = postCheckoutHatchReturnTo(pathnameWithSearch);
  if (!paidReturn) {
    return entrypoint;
  }
  return `${entrypoint}?returnTo=${encodeURIComponent(paidReturn)}`;
""",
    """function consentBounceDestination(state: NavigationState): string {
  return onboardingEntrypoint(state.isLocalClient);
""",
    "consentBounce body",
)

# 3. resolvePostAuth — the checkout stash machinery leaves; the destination is
#    privacy for a first-run signup, the sanitized returnTo for a login.
rep(
    """  // A returning user skips first-run privacy and research. Treat the auth as
  // a login so a pricing-CTA checkout stash is not marked for the privacy
  // screen to consume. Two funnel destinations are still real work rather
  // than a re-run, so they survive: a paid hatch, and a walk that is
  // provisioning a new assistant.
  if (state.userHasOnboardedAssistant) {
    const isRealWork =
      postCheckoutHatchReturnTo(destination) != null ||
      isNewAssistantFunnel(searchParamsOf(destination));
    const skipTarget =
      !isRealWork && isOnboardingResearchPath(destination)
        ? fallback
        : destination;
    resolveSignupCheckoutDestination({
      intent: "login",
      returnTo: skipTarget,
    });
    return { action: "redirect", to: skipTarget };
  }

  // The shared resolver stashes a pricing-CTA checkout package across signup,
  // discards a stale stash for any non-checkout auth, and picks the
  // destination (privacy for signup, the sanitized `returnTo` for login).
  const resolved = resolveSignupCheckoutDestination({
    intent: authIntent,
    returnTo: destination,
  });
  return { action: "redirect", to: resolved };""",
    """  // A returning user skips first-run privacy and research. Two funnel
  // destinations are still real work rather than a re-run, so they survive: a
  // fresh-assistant funnel entry, and a walk that is provisioning a new
  // assistant.
  if (state.userHasOnboardedAssistant) {
    const isRealWork = isNewAssistantFunnel(searchParamsOf(destination));
    const skipTarget =
      !isRealWork && isOnboardingResearchPath(destination)
        ? fallback
        : destination;
    return { action: "redirect", to: skipTarget };
  }

  // A first-run signup starts at the consent screen; a login resumes the
  // sanitized returnTo.
  return {
    action: "redirect",
    to: authIntent === "signup" ? routes.onboarding.privacy : destination,
  };""",
    "resolvePostAuth body",
)

open(path, "w").write(src)
print(f"pass 2: -{orig - len(src)} chars")

# residuals must be gone
for needle in [
    "postCheckoutHatchReturnTo",
    "isPostCheckoutReturn",
    "resolveSignupCheckoutDestination",
    "POST_CHECKOUT",
    "managedProvisioningDestination",
    "PROVISIONING_FUNNEL_PATHS",
    "requirePostCheckoutProvisioning",
    "hasCloudHostedAssistant",
]:
    assert needle not in src, f"residual: {needle}"
print("pass 2 assertions passed")
