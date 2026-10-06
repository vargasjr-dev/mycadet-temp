import type {
  BackgroundToolStartedEvent,
  BackgroundToolCompletedEvent,
} from "@mycadet/assistant-api";

import { useBackgroundTaskStore } from "@/domains/chat/background-task-store";

export function handleBackgroundToolStarted(
  event: BackgroundToolStartedEvent,
): void {
  useBackgroundTaskStore.getState().startTask(event);
}

export function handleBackgroundToolCompleted(
  event: BackgroundToolCompletedEvent,
): void {
  useBackgroundTaskStore.getState().completeTask(event);
}
