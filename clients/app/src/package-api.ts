import type { ReactElement } from "react";
import type { AppShellProps, EmbeddedAppProps } from "./app-shell-props";

export type { AppShellProps, EmbeddedAppProps } from "./app-shell-props";
export declare function AppShell(props: AppShellProps): ReactElement;
export declare function EmbeddedApp(
  props: EmbeddedAppProps,
): ReactElement | null;
