import { AuthWaitSpinner } from "../../../components/auth-wait-spinner";
import { SignupClosedScreen } from "../../../components/signup-closed-screen";
import { SignupScreen } from "../../../components/signup-screen";
import { SignupShell } from "../../../components/signup-shell";
import { useReturnToShortCircuit } from "../../../hooks/use-return-to-short-circuit";
import { useSignupAvailability } from "../../../hooks/use-signup-availability";

/**
 * Signup entry. Renders the branded sign-up screen: a rotating headline with
 * a single CTA that hands off to the WorkOS auth flow (`intent: "signup"`);
 * the post-OAuth name/occupation step lives in `ProviderSignupPage`. While
 * the cloud is closed to new accounts it renders `SignupClosedScreen`
 * instead.
 *
 * `useReturnToShortCircuit` owns whether an existing session skips OAuth and
 * lands on the `returnTo` destination directly, the same decision `LoginPage`
 * makes, and it wins over the availability check: a signed-in visitor is not
 * signing up. Only the loading shell differs between the two pages.
 */
export function SignupPage() {
  const shortCircuit = useReturnToShortCircuit();
  const availability = useSignupAvailability({
    enabled: shortCircuit.kind !== "redirect",
  });

  if (shortCircuit.kind === "redirect") {
    return shortCircuit.node;
  }
  if (shortCircuit.kind === "wait" || availability === "pending") {
    return (
      <SignupShell>
        <AuthWaitSpinner />
      </SignupShell>
    );
  }
  if (availability === "closed") {
    return <SignupClosedScreen returnTo={shortCircuit.returnTo} />;
  }

  return <SignupScreen returnTo={shortCircuit.returnTo} />;
}
