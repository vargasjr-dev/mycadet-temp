import { beforeEach, describe, expect, it } from "bun:test";

import type { AuthUser } from "@/stores/auth-store";
import { useAuthStore } from "@/stores/auth-store";
import { useGatewaySessionStore } from "@/stores/gateway-session-store";

const STAFF_USER: AuthUser = {
  kind: "platform",
  id: "user-1",
  username: "staffer",
  email: "staffer@mycadet.ai",
  isStaff: true,
  firstName: "Staff",
  lastName: "Member",
};

const OTHER_USER: AuthUser = {
  kind: "platform",
  id: "user-2",
  username: "civilian",
  email: "civilian@example.com",
  isStaff: false,
  firstName: "Just",
  lastName: "Folk",
};

describe("the gateway-session seam", () => {
  beforeEach(() => {
    useAuthStore.setState({
      sessionStatus: "initializing",
      cloudSession: "unknown",
      user: null,
    });
  });

  it("reads the machine's boot window as all-false", () => {
    const state = useGatewaySessionStore.getState();
    expect(state.settled).toBe(false);
    expect(state.live).toBe(false);
    expect(state.cloudLive).toBe(false);
    expect(state.identityKey).toBeNull();
    expect(state.isStaff).toBe(false);
  });

  it("re-projects on every machine write", () => {
    useAuthStore.setState({
      sessionStatus: "authenticated",
      cloudSession: "present",
      user: STAFF_USER,
    });
    const state = useGatewaySessionStore.getState();
    expect(state.settled).toBe(true);
    expect(state.live).toBe(true);
    expect(state.cloudLive).toBe(true);
    expect(state.identityKey).toBe("user-1");
    expect(state.isStaff).toBe(true);
  });

  it("keeps a local session live without claiming a cloud one", () => {
    useAuthStore.setState({
      sessionStatus: "authenticated",
      cloudSession: "absent",
      user: OTHER_USER,
    });
    const state = useGatewaySessionStore.getState();
    expect(state.live).toBe(true);
    expect(state.cloudLive).toBe(false);
    expect(state.identityKey).toBe("user-2");
    expect(state.isStaff).toBe(false);
  });

  it("calls a settled probe with no session what it is", () => {
    useAuthStore.setState({
      sessionStatus: "unauthenticated",
      cloudSession: "absent",
      user: null,
    });
    const state = useGatewaySessionStore.getState();
    expect(state.settled).toBe(true);
    expect(state.live).toBe(false);
    expect(state.identityKey).toBeNull();
    expect(state.isStaff).toBe(false);
  });

  it("keeps the logout binding stable while the projection rewrites the data", () => {
    const logout = useGatewaySessionStore.getState().logout;
    useAuthStore.setState({ sessionStatus: "authenticated" });
    expect(useGatewaySessionStore.getState().logout).toBe(logout);
  });
});
