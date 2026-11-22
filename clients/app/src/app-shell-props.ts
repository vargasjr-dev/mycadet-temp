export interface AppShellProps {
  framePath?: string;
  apiBaseUrl?: string;
  assistantId?: string;
  onNavigate(path: string, options: { replace: boolean }): void;
  title?: string;
}

export interface EmbeddedAppProps {
  basename?: string;
}
