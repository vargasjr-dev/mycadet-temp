/**
 * The backups table on the Doctor and debug panels: one row per snapshot with
 * its name and a copy button, a type tag, a ready or pending tag, the creation
 * time, and a restore button that stays disabled until the snapshot is ready.
 * A cloud-hosted assistant also gets an Export button beside "Create
 * Backup". The component fetches cloud backup rows through the API client.
 * `beforeEach` supplies fixtures and marks the active assistant cloud-hosted.
 * The stories cover a populated list, with enough point-in-time backups to
 * show the rotation notice, an assistant with no backups yet, and a
 * self-hosted assistant, which displays CLI backup instructions.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { AssistantBackup } from "@/assistant/api";
import { setHosting } from "@/assistant/hosting.test-helper";
import { AssistantBackups } from "@/domains/settings/components/assistant-backups";
import { client as cloudClient } from "@/generated/api/client.gen";
import { fixtureNotFound, stubClientFetch } from "@/lib/stub-client-fetch";
/**
 * The hosting answer lives on the lockfile entry's remote field: a local
 * stamp synthesizes a self-hosted entry for the story assistant's id; the
 * cloud world synthesizes none, so the active row reads cloud-hosted.
 */
const ASSISTANT_IDS = {
  established: "story-assistant",
  fresh: "story-assistant-fresh",
} as const;

const BACKUPS: AssistantBackup[] = [
  {
    snapshot_name: "story-assistant-pit-20260916-2210",
    pvc: "story-assistant-data",
    created_at: "2026-09-16T22:10:00Z",
    ready_to_use: false,
    backup_type: "point_in_time",
  },
  {
    snapshot_name: "story-assistant-pit-20260915-0904",
    pvc: "story-assistant-data",
    created_at: "2026-09-15T09:04:00Z",
    ready_to_use: true,
    backup_type: "point_in_time",
  },
  {
    snapshot_name: "story-assistant-pit-20260912-1731",
    pvc: "story-assistant-data",
    created_at: "2026-09-12T17:31:00Z",
    ready_to_use: true,
    backup_type: "point_in_time",
  },
  {
    snapshot_name: "story-assistant-scheduled-20260916-0300",
    pvc: "story-assistant-data",
    created_at: "2026-09-16T03:00:00Z",
    ready_to_use: true,
    backup_type: "scheduled",
  },
  {
    snapshot_name: "story-assistant-preview-20260914-1145",
    pvc: "story-assistant-data",
    created_at: "2026-09-14T11:45:00Z",
    ready_to_use: true,
    backup_type: "preview_channel",
  },
  {
    snapshot_name: "story-assistant-doctor-20260913-0812",
    pvc: "story-assistant-data",
    created_at: "2026-09-13T08:12:00Z",
    ready_to_use: false,
    backup_type: "doctor",
  },
];

function backupsFor(pathname: string): AssistantBackup[] {
  return pathname.startsWith(`/v1/assistants/${ASSISTANT_IDS.fresh}/`)
    ? []
    : BACKUPS;
}

/** Answers the cloud's `GET /v1/assistants/{id}/backups/`. */
async function platformFetch(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname.endsWith("/backups/") && request.method === "GET") {
    return Response.json({ backups: backupsFor(pathname) });
  }
  return fixtureNotFound();
}

const meta = {
  title: "Settings/AssistantBackups",
  component: AssistantBackups,
  parameters: {
    layout: "padded",
  },
  args: {
    assistantId: ASSISTANT_IDS.established,
  },
  argTypes: {
    assistantId: {
      control: "radio",
      options: Object.values(ASSISTANT_IDS),
    },
  },
  beforeEach: () => {
    const restorePlatform = stubClientFetch(cloudClient, platformFetch);
    return () => {
      restorePlatform();
    };
  },
  decorators: [
    (Story) => (
      <div className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AssistantBackups>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Every backup type and both readiness states. Three point-in-time backups
 * exist, so the notice that the next one replaces the oldest sits beside the
 * create button.
 */
export const Populated: Story = {};

/** No backups yet: the create button above the empty message. */
export const Empty: Story = {
  args: {
    assistantId: ASSISTANT_IDS.fresh,
  },
};

/** A self-hosted assistant: the same list without the Export button. */
export const SelfHosted: Story = {
  beforeEach: () => {
    setHosting("local");
  },
};
