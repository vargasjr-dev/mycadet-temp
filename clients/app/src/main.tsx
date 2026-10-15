import "@app/utils/run-storage-migrations";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { initI18n } from "@app/i18n";
import { router } from "./standalone";
import "./index.css";

await initI18n();
const root = document.getElementById("root");
if (!root) {
  throw new Error("App root element is missing.");
}
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
