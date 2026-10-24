/**
 * Tests for the identity middleware (authenticateRequest).
 *
 * The daemon verifies no tokens — the gateway forwards the verified
 * identity in `x-cadet-*` headers. Covers:
 * - Missing identity headers returns 401 (auth enabled)
 * - A mangled forwarded identity (bad subject, type mismatch) returns 401
 * - Forwarded identity returns an AuthContext
 * - Dev bypass returns the synthetic actor context
 */

import { describe, expect, mock, test } from "bun:test";

// Track auth bypass state for tests
let authDisabled = false;
mock.module("../../../config/env.js", () => ({
  isHttpAuthDisabled: () => authDisabled,
  hasUngatedHttpAuthDisabled: () => false,
  getGatewayInternalBaseUrl: () => "http://localhost:7822",
}));

import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../assistant-scope.js";
import { authenticateRequest } from "../middleware.js";

function identityHeaders(overrides?: {
  subject?: string;
  principalType?: string;
  scopeProfile?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (overrides?.subject !== undefined) {
    headers["x-cadet-subject"] = overrides.subject;
  }
  if (overrides?.principalType !== undefined) {
    headers["x-cadet-principal-type"] = overrides.principalType;
  }
  if (overrides?.scopeProfile !== undefined) {
    headers["x-cadet-scope-profile"] = overrides.scopeProfile;
  }
  return headers;
}

describe("authenticateRequest", () => {
  test("returns 401 when no identity headers are present", () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test("ignores a bearer token — identity is header-forwarded only", () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer whatever.relic.token" },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test("returns 401 when the subject does not parse", () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: identityHeaders({ subject: "garbage" }),
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test("returns 401 when the type header disagrees with the subject", () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: identityHeaders({
        subject: "actor:self:principal-test",
        principalType: "svc_gateway",
      }),
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test("returns AuthContext for a forwarded actor identity", () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: identityHeaders({
        subject: "actor:self:principal-test",
        principalType: "actor",
        scopeProfile: "actor_client_v1",
      }),
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.subject).toBe("actor:self:principal-test");
      expect(result.context.principalType).toBe("actor");
      expect(result.context.assistantId).toBe(DAEMON_INTERNAL_ASSISTANT_ID);
      expect(result.context.actorPrincipalId).toBe("principal-test");
      expect(result.context.scopeProfile).toBe("actor_client_v1");
      expect(result.context.scopes.has("chat.read")).toBe(true);
      expect(result.context.scopes.has("chat.write")).toBe(true);
    }
  });

  test("returns AuthContext for a forwarded gateway service identity", () => {
    const req = new Request("http://localhost/v1/channels/inbound", {
      method: "POST",
      headers: identityHeaders({
        subject: "svc:gateway:self",
        principalType: "svc_gateway",
        scopeProfile: "gateway_ingress_v1",
      }),
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.principalType).toBe("svc_gateway");
      expect(result.context.scopes.has("ingress.write")).toBe(true);
    }
  });

  test("an unrecognized scope profile resolves to no scopes", () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: identityHeaders({
        subject: "actor:self:principal-test",
        principalType: "actor",
        scopeProfile: "future_profile_v9",
      }),
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.scopes.size).toBe(0);
    }
  });

  test("dev bypass returns the synthetic actor context without identity headers", () => {
    authDisabled = true;
    try {
      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
      });

      const result = authenticateRequest(req);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.context.principalType).toBe("actor");
        expect(result.context.actorPrincipalId).toBe("dev-bypass");
        expect(result.context.scopeProfile).toBe("actor_client_v1");
        expect(result.context.scopes.has("chat.read")).toBe(true);
      }
    } finally {
      authDisabled = false;
    }
  });

  test("a forwarded identity resolves normally even when auth is bypassed", () => {
    authDisabled = true;
    try {
      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: identityHeaders({
          subject: "actor:self:principal-test",
          principalType: "actor",
          scopeProfile: "actor_client_v1",
        }),
      });

      const result = authenticateRequest(req);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.context.actorPrincipalId).toBe("principal-test");
      }
    } finally {
      authDisabled = false;
    }
  });
});
