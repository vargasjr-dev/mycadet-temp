import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ChooserAvatarChip } from "./chooser-avatar-chip";

afterEach(() => cleanup());

test("renders the synced thumbnail as a decorative image", () => {
  const { container } = render(
    <ChooserAvatarChip
      avatarUrl="https://cloud.example/ferry.png"
      name="Ferry"
    />,
  );
  const img = container.querySelector("img");
  if (!(img instanceof HTMLImageElement)) {
    throw new Error("Missing thumbnail.");
  }
  expect(img.getAttribute("src")).toBe("https://cloud.example/ferry.png");
  // The row's own label names the assistant; the chip carries no alt text.
  expect(img.getAttribute("alt")).toBe("");
  expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
});

test("renders the name's initial when the list carries no avatar", () => {
  const { container } = render(
    <ChooserAvatarChip avatarUrl={null} name="Ferry" />,
  );
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toBe("F");
});

test("a failed thumbnail demotes to the initial, and a new url retries", () => {
  const { container, rerender } = render(
    <ChooserAvatarChip
      avatarUrl="https://cloud.example/ferry.png"
      name="Ferry"
    />,
  );
  const img = container.querySelector("img");
  if (!(img instanceof HTMLImageElement)) {
    throw new Error("Missing thumbnail.");
  }
  fireEvent.error(img);
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toBe("F");
  // The same chip instance retries when the list carries a fresh thumbnail.
  rerender(
    <ChooserAvatarChip
      avatarUrl="https://cloud.example/new.png"
      name="Ferry"
    />,
  );
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    "https://cloud.example/new.png",
  );
});
