import { Navigate } from "react-router";

import { routes } from "@app/utils/routes";

export function PasswordResetPage() {
  return <Navigate to={routes.account.login} replace />;
}
