// Run localStorage migrations before any other app import.
// MUST stay above the boot import — boot's module graph reads localStorage
// at module level.
import "@/utils/run-storage-migrations";

import { start } from "@/boot";
import { router } from "./routes";

start(router);
