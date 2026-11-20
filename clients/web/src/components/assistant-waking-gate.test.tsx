import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let healthzError: Error | null = new Error("gateway down");

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  healthzGetOptions: (options: { path: { assistant_id: string } }) => ({
    queryKey: [{ _id: "healthzGet", path: options.path }],
    queryFn: async () => {
      if (healthzError) {
        throw healthzError;
      }
      return { status: "ok" };
    },
  }),
}));

mock.module("@/runtime/native-launch-screen", () => ({
  markNativeLaunchScreenReady: () => {},
}));

mock.module("@mycadet/design-library", () => ({
  Typography: ({
    children,
  }: {
    children: React.ReactNode;
    variant?: string;
  }) => <span>{children}</span>,
}));

const { AssistantWakingGate, WAKING_GATE_TITLE } = await import(
  "@/components/assistant-waking-gate"
);

function renderGate() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AssistantWakingGate>
        <div>the app</div>
      </AssistantWakingGate>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  healthzError = new Error("gateway down");
});

describe("AssistantWakingGate", () => {
  test("withholds the routes while the runtime health check fails", async () => {
    renderGate();
    expect(screen.queryByText("the app")).toBeNull();
    await waitFor(() =>
      expect(screen.queryByText(WAKING_GATE_TITLE)).not.toBeNull(),
    );
    expect(screen.queryByText("the app")).toBeNull();
  });

  test("renders the routes once the runtime answers healthy", async () => {
    healthzError = null;
    renderGate();
    await waitFor(() => expect(screen.getByText("the app")).toBeDefined());
    expect(screen.queryByText(WAKING_GATE_TITLE)).toBeNull();
  });
});
