import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  ChatsSettingsLoadState,
  ChatsSettingsModalProps,
} from "@/domains/chat/components/chats-settings-modal";
import { ChatsSettingsChanges } from "../components/chats-settings-form";
import {
  configGetOptions,
  configGetSetQueryData,
  useConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useAssistantCapabilityQuery } from "@/hooks/use-assistant-capability";
import { captureError } from "@/lib/error-reporting/capture-error";

interface UseChatsSettingsOptions {
  assistantId: string;
  open: boolean;
  onSaved: () => void;
}

interface UseChatsSettingsResult {
  state: ChatsSettingsLoadState;
  saveStatus: ChatsSettingsModalProps["saveStatus"];
  save: (changes: ChatsSettingsChanges) => Promise<void>;
  retryLoad: () => void;
}

/** Config query and writes for one assistant-owned modal session. */
export function useChatsSettings({
  assistantId,
  open,
  onSaved,
}: UseChatsSettingsOptions): UseChatsSettingsResult {
  const capability = useAssistantCapabilityQuery("chatsSettings");
  const supported = capability.data === true;
  const queryClient = useQueryClient();
  const mounted = useRef(false);
  const saving = useRef(false);
  const [loadedForSession, setLoadedForSession] = useState(false);
  const ownsSession = () => mounted.current;
  const query = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: open && supported,
    staleTime: 0,
    refetchOnMount: "always",
  });
  const mutation = useConfigPatchMutation({
    onSuccess: (data, variables) => {
      if (!ownsSession()) {
        return;
      }
      configGetSetQueryData(queryClient, { path: variables.path }, data);
      onSaved();
    },
    onError: (error) => {
      if (ownsSession()) {
        captureError(error, { context: "chats-settings-save" });
      }
    },
  });
  const resetMutation = mutation.reset;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) {
      resetMutation();
    }
  }, [open, resetMutation]);

  const newMessageEnabled = query.data?.notifications?.newMessageEnabled;
  const validSettings = typeof newMessageEnabled === "boolean";
  useEffect(() => {
    if (query.isFetchedAfterMount && query.isSuccess && validSettings) {
      setLoadedForSession(true);
    }
  }, [query.isFetchedAfterMount, query.isSuccess, validSettings]);
  let state: ChatsSettingsLoadState;
  if (!supported && capability.isPending) {
    state = { status: "loading" };
  } else if (!supported && capability.isError) {
    state = { status: "error" };
  } else if (!supported) {
    state = { status: "unsupported" };
  } else if (loadedForSession && validSettings) {
    state = { status: "ready", values: { newMessageEnabled } };
  } else if (
    query.isError ||
    (query.isFetchedAfterMount && query.isSuccess && !validSettings)
  ) {
    state = { status: "error" };
  } else {
    state = { status: "loading" };
  }

  return {
    state,
    saveStatus: mutation.isPending
      ? "pending"
      : mutation.isError
        ? "error"
        : "idle",
    save: async (changes) => {
      if (
        !ownsSession() ||
        !open ||
        !supported ||
        state.status !== "ready" ||
        saving.current
      ) {
        return;
      }
      saving.current = true;
      try {
        await mutation.mutateAsync({
          path: { assistant_id: assistantId },
          body: { ...changes },
        });
      } catch {
        // The mutation error keeps the modal's draft available for retry.
      } finally {
        saving.current = false;
      }
    },
    retryLoad: () => {
      if (ownsSession()) {
        if (capability.isError || !supported) {
          void capability.refetch();
        }
        if (supported) {
          void query.refetch();
        }
      }
    },
  };
}
