/**
 * Tests for `WebSearchCard`'s provider-only configuration:
 *
 *   1. No mode segmented-control renders in the card header, and saves
 *      write the provider only (no mode field).
 *   2. Provider Native and the BYOK providers fill the picker; saving
 *      writes the provider (plus apiBase for providers that take one).
 *   3. BYOK providers still gate Save on a credential.
 *
 * The design-library Select is real, driven via its combobox trigger like
 * `speech-to-text-card.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const ASSISTANT_ID = "asst-test";
mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
  useResolvedAssistantId: () => ASSISTANT_ID,
}));
mock.module("@mycadet/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {} },
  Toaster: () => null,
  ToastContent: () => null,
}));

// Controllable daemon config the config-get query resolves to; `initialData`
// makes it available synchronously like a warm cache.
let daemonConfigData: { services: Record<string, unknown> } = { services: {} };
interface SdkCall {
  path?: unknown;
  body?: unknown;
}
const configPatchCalls: SdkCall[] = [];
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configGetOptions: () => ({
    queryKey: ["config-get-test"],
    queryFn: () => Promise.resolve(daemonConfigData),
    initialData: daemonConfigData,
  }),
  configGetSetQueryData: () => {},
  useConfigPatchMutation: () => ({
    mutateAsync: (opts: SdkCall) => {
      configPatchCalls.push(opts);
      return Promise.resolve(daemonConfigData);
    },
  }),
}));

const provisionedKeys: Array<{ provider: string; key: string }> = [];
mock.module("@/domains/settings/ai/use-daemon-config", () => ({
  useProvisionProviderKey: () => (provider: string, key: string) => {
    provisionedKeys.push({ provider, key });
    return Promise.resolve();
  },
}));

let hasStoredCredential = false;
mock.module("@/domains/settings/ai/use-stored-credential-presence", () => ({
  useStoredCredentialPresence: () => ({ hasStoredCredential }),
  credentialPresenceQueryKey: (...parts: unknown[]) => [
    "credential-presence-test",
    ...parts,
  ],
}));

const { WebSearchCard } = await import("@/domains/settings/ai/web-search-card");

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <WebSearchCard />
    </QueryClientProvider>,
  );
}

function providerTrigger(): HTMLButtonElement {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-label="Web search provider"]',
  );
  if (!trigger) {
    throw new Error("expected the web search provider dropdown trigger");
  }
  return trigger;
}

function visibleOptions(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).map((o) => o.textContent?.trim() ?? "");
}

/** Click an option in the already-open listbox (the trigger toggles). */
function selectOption(label: string): void {
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim() === label);
  if (!option) {
    throw new Error(
      `expected option "${label}" — saw: ${visibleOptions().join(", ")}`,
    );
  }
  fireEvent.click(option);
}

describe("WebSearchCard — provider-only configuration", () => {
  beforeEach(() => {
    localStorage.clear();
    configPatchCalls.length = 0;
    provisionedKeys.length = 0;
    hasStoredCredential = false;
    daemonConfigData = { services: {} };
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  test("no Managed / Your Own mode toggle renders", () => {
    renderCard();

    expect(screen.queryByText("Managed")).toBeNull();
    expect(screen.queryByText("Your Own")).toBeNull();
    // The provider dropdown renders unconditionally instead.
    expect(providerTrigger()).toBeTruthy();
  });

  test("Provider Native and the BYOK providers fill the picker", () => {
    renderCard();

    fireEvent.click(providerTrigger());
    const options = visibleOptions();
    expect(options).toEqual([
      "Provider Native",
      "Perplexity",
      "Brave",
      "Tavily",
      "Firecrawl",
      "Keenable",
      "fastCRW",
      "SearXNG",
      "TinyFish",
      "Exa",
      "Serply",
    ]);
  });

  test("Provider Native needs no key and saves the provider", async () => {
    // Start from a non-default provider so Save enables on the change.
    daemonConfigData = {
      services: { "web-search": { provider: "brave", mode: "your-own" } },
    };
    renderCard();

    fireEvent.click(providerTrigger());
    selectOption("Provider Native");

    expect(screen.queryByText("API Key")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: {
        "web-search": {
          provider: "inference-provider-native",
        },
      },
    });
    expect(provisionedKeys).toHaveLength(0);
  });

  test("a BYOK provider gates Save on a key, then saves provider and key", async () => {
    renderCard();

    fireEvent.click(providerTrigger());
    selectOption("Firecrawl");

    // No stored credential and no typed key: Save must stay disabled.
    const saveButton = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    const keyInput = screen.getByPlaceholderText("fc-...");
    fireEvent.change(keyInput, { target: { value: "fc-secret" } });
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(saveButton);

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(provisionedKeys).toEqual([
      { provider: "firecrawl", key: "fc-secret" },
    ]);
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: {
        "web-search": { provider: "firecrawl" },
      },
    });
  });

  test("fastCRW shows API Base and allows save without a key when base is custom", async () => {
    renderCard();

    fireEvent.click(providerTrigger());
    selectOption("fastCRW");

    expect(screen.getByText("API Base")).toBeTruthy();
    const saveButton = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    const apiBaseInput = screen.getByPlaceholderText("https://api.fastcrw.com");
    fireEvent.change(apiBaseInput, {
      target: { value: "http://localhost:3000" },
    });
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(saveButton);

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(provisionedKeys).toHaveLength(0);
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: {
        "web-search": {
          provider: "fastcrw",
          apiBase: "http://localhost:3000",
        },
      },
    });
  });

  test("SearXNG requires API Base and allows save without a key", async () => {
    renderCard();

    fireEvent.click(providerTrigger());
    selectOption("SearXNG");

    expect(screen.getByText("API Base")).toBeTruthy();
    const saveButton = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    const apiBaseInput = screen.getByPlaceholderText("http://127.0.0.1:8888");
    fireEvent.change(apiBaseInput, {
      target: { value: "http://127.0.0.1:8888" },
    });
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(saveButton);

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(provisionedKeys).toHaveLength(0);
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: {
        "web-search": {
          provider: "searxng",
          apiBase: "http://127.0.0.1:8888",
        },
      },
    });
  });

  test("TinyFish still requires a key when API Base is custom", () => {
    renderCard();

    fireEvent.click(providerTrigger());
    selectOption("TinyFish");

    const saveButton = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    const apiBaseInput = screen.getByPlaceholderText(
      "https://api.search.tinyfish.ai",
    );
    fireEvent.change(apiBaseInput, {
      target: { value: "https://search.example.com/api" },
    });

    expect(saveButton.disabled).toBe(true);

    const keyInput = screen.getByPlaceholderText("TinyFish API key...");
    fireEvent.change(keyInput, { target: { value: "tinyfish-secret" } });
    expect(saveButton.disabled).toBe(false);
  });
});
