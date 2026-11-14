/**
 * Shared assembly-contract types for the plugin/channel surface.
 *
 * Leaf module: no intra-src imports, so plugin-facing typings can reference
 * these without dragging the runtime assembly (or its graph) along.
 */
import { TrustClass } from "@mycadet/gateway-client";
import type { ChannelId } from "@mycadet/service-contracts/channels";

/**
 * Describes the capabilities of the channel through which the user is
 * interacting.  Used to gate UI-specific references and permission asks.
 */
export interface ChannelCapabilities {
  /** The raw channel identifier (e.g. "cadet", "telegram"). */
  channel: string;
  /** Whether this channel can render the dashboard UI (apps, dynamic pages). */
  dashboardCapable: boolean;
  /** Whether the channel supports dynamic UI surfaces (ui_show / ui_update). */
  supportsDynamicUi: boolean;
  /**
   * Whether the channel's adapter can render inline tappable options — approval
   * buttons and (next) question option pickers. Distinct from `supportsDynamicUi`:
   * a text-only channel can render inline buttons without dynamic UI. Optional;
   * absent is treated as `false`.
   */
  supportsInlineOptions?: boolean;
  /** Whether this channel supports voice/microphone input. */
  supportsVoiceInput: boolean;
  /** The client OS/interface identifier (e.g. "macos", "ios", "web"). */
  clientOS?: string;
  /** Chat type from the gateway (e.g. "private", "group", "supergroup", "channel", "im", "mpim"). */
  chatType?: string;
}

/**
 * Inbound actor context for the `<turn_context>` block.
 *
 * Carries channel-agnostic identity and trust metadata resolved from
 * inbound message identity fields. This replaces the old `<guardian_context>`
 * block with richer trusted-contact-aware fields.
 */
export interface InboundActorContext {
  /** Source channel the message arrived on. */
  sourceChannel: ChannelId;
  /** Canonical (normalized) sender identity. Null when identity could not be established. */
  canonicalActorIdentity: string | null;
  /** Human-readable actor identifier (e.g. @username or phone). */
  actorIdentifier?: string;
  /** Human-readable actor display name (e.g. "Jeff"). */
  actorDisplayName?: string;
  /** Raw sender display name as provided by the channel transport. */
  actorSenderDisplayName?: string;
  /** Guardian-managed display name from the contact record. */
  actorMemberDisplayName?: string;
  /** Trust classification: see TrustClass. */
  trustClass: TrustClass;
  /** Guardian identity for this (assistant, channel) binding. */
  guardianIdentity?: string;
  /** Member status when the actor has a contact record. */
  memberStatus?: string;
  /** Member policy when the actor has a contact record. */
  memberPolicy?: string;
  /** Free-text notes about this contact. */
  contactNotes?: string;
  /** Number of prior interactions with this contact. */
  contactInteractionCount?: number;
}

/**
 * Injection depth for a turn's context assembly.
 *
 * - `'full'` (default): all injections are applied.
 * - `'minimal'`: only safety-critical context is injected (unified turn
 *   context, non-interactive marker, voice call control, channel
 *   capabilities). High-token optional blocks (workspace, channel command,
 *   active surface, NOW.md scratchpad) are skipped to reduce context pressure.
 */
export type InjectionMode = "full" | "minimal";
