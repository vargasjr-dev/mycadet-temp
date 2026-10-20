import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ChooserCard } from "./chooser-card";

afterEach(() => cleanup());

test("renders a radio card with title, optional subtitle omitted", () => {
  const { container } = render(
    <ChooserCard icon={<span>i</span>} title="One" onSelect={() => {}} />,
  );
  expect(container.querySelector('[role="radio"]')).toBeDefined();
  expect(container.textContent).toContain("One");
  expect(container.querySelector('[class*="mt-1"]')).toBeNull();
});

test("click, Enter, and Space select", () => {
  let selected = 0;
  const { container } = render(
    <ChooserCard
      icon={<span>i</span>}
      title="One"
      onSelect={() => {
        selected++;
      }}
    />,
  );
  const card = container.querySelector('[role="radio"]');
  if (!(card instanceof HTMLElement)) {
    throw new Error("Missing card.");
  }
  fireEvent.click(card);
  fireEvent.keyDown(card, { key: "Enter" });
  fireEvent.keyDown(card, { key: " " });
  expect(selected).toBe(3);
});

test("the roving tab stop and checked state are per-card", () => {
  const { container } = render(
    <>
      <ChooserCard
        icon={<span>i</span>}
        title="One"
        tabStop
        onSelect={() => {}}
      />
      <ChooserCard
        icon={<span>i</span>}
        title="Two"
        selected
        onSelect={() => {}}
      />
    </>,
  );
  const [first, second] = Array.from(
    container.querySelectorAll('[role="radio"]'),
  );
  expect(first?.getAttribute("tabindex")).toBe("0");
  expect(first?.getAttribute("aria-checked")).toBe("false");
  expect(second?.getAttribute("tabindex")).toBe("-1");
  expect(second?.getAttribute("aria-checked")).toBe("true");
});
