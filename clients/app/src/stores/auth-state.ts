/** Account-facing state; local access remains distinct from a cloud account. */
export interface AccountUser {
  kind: "cloud" | "local";
  id: string | null;
  username: string | null;
  email: string | null;
  isStaff: boolean;
  firstName: string;
  lastName: string;
}
export interface AccountAuthSnapshot {
  user: AccountUser | null;
  sessionStatus: "initializing" | "authenticated" | "unauthenticated";
  cloudSession: "unknown" | "absent" | "present";
  initSession(): Promise<void>;
  refreshSession(): Promise<boolean>;
  logout(): Promise<void>;
}
export interface AccountAuthSource {
  getSnapshot(): AccountAuthSnapshot;
  subscribe(listener: () => void): () => void;
}
