/**
 * IPC channel name constants.
 *
 * Using string constants (rather than inline literals) catches typos at
 * compile time and makes the full channel surface grep-able from a single
 * location. Channels are grouped by the bridge surface they belong to.
 */

// App
export const APP_VERSION_INFO = "cadet:app:versionInfo";
export const APP_OPEN_WEBSITE = "cadet:app:openWebsite";

// Config
export const CONFIG_GET = "cadet:config:get";

// Text insertion
export const TEXT_INSERT = "cadet:text:insertIntoFrontApp";
export const TEXT_UNDO = "cadet:text:undoInFrontApp";
export const TEXT_OPEN_SETTINGS = "cadet:text:openAutomationSettings";

// System permissions
export const PERMISSION_GUIDE_CANCEL = "cadet:permissions:guide:cancel";
export const PERMISSION_SETUP_BEGIN = "cadet:permissions:setup:begin";
export const PERMISSION_GUIDE_GET = "cadet:permissions:guide:get";
export const PERMISSION_GUIDE_STATE = "cadet:permissions:guide:state";
export const PERMISSION_GUIDE_READY = "cadet:permissions:guide:ready";
export const PERMISSION_GUIDE_DISMISS = "cadet:permissions:guide:dismiss";
export const PERMISSION_GUIDE_DRAG = "cadet:permissions:guide:drag";
export const PERMISSION_GUIDE_REVEAL = "cadet:permissions:guide:reveal";

export const PERMISSIONS_GET_STATE = "cadet:permissions:getState";
export const PERMISSIONS_REQUEST = "cadet:permissions:request";
export const PERMISSIONS_OPEN_SETTINGS = "cadet:permissions:openSettings";
export const PERMISSIONS_QUIT_AND_REOPEN = "cadet:permissions:quitAndReopen";
export const PERMISSIONS_STATE_EVENT = "cadet:permissions:state";

// Auth
export const AUTH_START_OAUTH = "cadet:auth:startOAuth";
export const AUTH_CANCEL_OAUTH = "cadet:auth:cancelOAuth";
export const AUTH_GET_SESSION_TOKEN = "cadet:auth:getSessionToken";
export const AUTH_SIGN_OUT = "cadet:auth:signOut";

// Hotkeys
export const HOTKEYS_GET = "cadet:hotkeys:get";
export const HOTKEYS_SET = "cadet:hotkeys:set";
export const HOTKEYS_CHANGED = "cadet:hotkeys:changed";

// Launch at login
export const LAUNCH_AT_LOGIN_GET = "cadet:launchAtLogin:get";
export const LAUNCH_AT_LOGIN_SET = "cadet:launchAtLogin:set";

// Diagnostics
export const DIAGNOSTICS_SET_SHARE = "cadet:diagnostics:setShareDiagnostics";

// Helper (native sidecar)
export const HELPER_PING = "cadet:helper:ping";
export const HELPER_GET_STATE = "cadet:helper:state:get";
export const HELPER_RESTART = "cadet:helper:restart";
export const HELPER_STATE_EVENT = "cadet:helper:state";
export const HELPER_HOTKEY_SET_VOICE_MODE_CHORD =
  "cadet:helper:hotkey:setVoiceModeChord";
export const HELPER_HOTKEY_SET_MODIFIER_HOLD =
  "cadet:helper:hotkey:setModifierHold";
export const HELPER_HOTKEY_SET_CHORDS = "cadet:helper:hotkey:setChords";
export const HELPER_HOTKEY_READ_FRONT_SELECTION =
  "cadet:helper:hotkey:readFrontSelection";
export const HELPER_APPS_RUNNING = "cadet:helper:apps:running";
export const HELPER_APPS_QUIT = "cadet:helper:apps:quit";
export const HELPER_APPS_FRONTMOST = "cadet:helper:apps:frontmost";
export const HELPER_INPUT_SET_ACTIVITY_WATCH =
  "cadet:helper:input:setActivityWatch";
export const HELPER_INPUT_ACTIVITY_EVENT = "cadet:helper:input:activity";
export const HELPER_HOTKEY_EVENT = "cadet:helper:hotkey:event";
export const HELPER_HOTKEY_REGISTRATION_EVENT =
  "cadet:helper:hotkey:registration";
export const HELPER_DICTATION_SET_PARTIALS =
  "cadet:helper:dictation:setPartials";
export const HELPER_DICTATION_PARTIAL_EVENT = "cadet:helper:dictation:partial";
export const HELPER_DICTATION_FINALIZED_EVENT =
  "cadet:helper:dictation:finalized";
export const HELPER_DICTATION_TRANSCRIBE = "cadet:helper:dictation:transcribe";
export const HELPER_DICTATION_TRANSCRIBED_EVENT =
  "cadet:helper:dictation:transcribed";

// Commands
export const COMMAND_EVENT = "cadet:command";

// Status
export const STATUS_CONNECTION = "cadet:status:connection";

// Identity
export const IDENTITY_NAME = "cadet:identity:name";

// Icon / avatar
export const ICON_SET_AVATAR = "cadet:icon:setAvatar";
export const ICON_SET_CHARACTER = "cadet:icon:setCharacter";

// Dock
export const DOCK_SET_BADGE = "cadet:dock:setBadge";

// Downloads
export const DOWNLOADS_DONE_EVENT = "cadet:downloads:done";
export const DOWNLOADS_REVEAL = "cadet:downloads:reveal";

// Local mode
export const LOCAL_MODE_HATCH = "cadet:localMode:hatch";
export const LOCAL_MODE_READ_LOCKFILE = "cadet:localMode:readLockfile";
export const LOCAL_MODE_UNPAIR = "cadet:localMode:unpair";
export const LOCAL_MODE_UPGRADE = "cadet:localMode:upgrade";
export const LOCAL_MODE_STATUS = "cadet:localMode:status";
export const LOCAL_MODE_READ_ASSISTANT_AVATAR =
  "cadet:localMode:readAssistantAvatar";

// Menu
export const MENU_TITLES = "cadet:menu:titles";
export const MENU_POPUP = "cadet:menu:popup";

// Main window
export const MAIN_WINDOW_ENSURE_VISIBLE = "cadet:mainWindow:ensureVisible";
export const MAIN_WINDOW_SET_ONBOARDING = "cadet:mainWindow:setOnboarding";
export const MAIN_WINDOW_NAVIGATE_TO = "cadet:mainWindow:navigateTo";
export const MAIN_WINDOW_SET_TITLE_BAR_OVERLAY =
  "cadet:mainWindow:setTitleBarOverlay";

// Power events
export const POWER_EVENT = "cadet:power:event";

// Deep links
export const DEEP_LINKS_DRAIN = "cadet:deepLinks:drain";
export const DEEP_LINKS_SUBSCRIBE = "cadet:deepLinks:subscribe";
export const DEEP_LINKS_UNSUBSCRIBE = "cadet:deepLinks:unsubscribe";
export const DEEP_LINKS_EVENT = "cadet:deepLinks:event";

// File open
export const FILE_OPEN_DRAIN = "cadet:fileOpen:drain";
export const FILE_OPEN_SUBSCRIBE = "cadet:fileOpen:subscribe";
export const FILE_OPEN_UNSUBSCRIBE = "cadet:fileOpen:unsubscribe";
export const FILE_OPEN_EVENT = "cadet:fileOpen:event";

// Feedback
export const FEEDBACK_DIAGNOSTICS = "cadet:feedback:diagnostics";
export const FEEDBACK_LOGS = "cadet:feedback:logs";

// Connectivity
export const CONNECTIVITY_GET = "cadet:connectivity:get";
export const CONNECTIVITY_STATE = "cadet:connectivity:state";
export const CONNECTIVITY_SET_DEVICE = "cadet:connectivity:device";
export const CONNECTIVITY_RETRY = "cadet:connectivity:retry";

// Notifications
export const NOTIFICATIONS_SHOW = "cadet:notifications:show";
export const NOTIFICATIONS_ACTION = "cadet:notifications:action";
export const NOTIFICATIONS_REGISTER_IDENTITY_PUBLISHER =
  "cadet:notifications:registerIdentityPublisher";
export const NOTIFICATIONS_PREPARE_IDENTITY =
  "cadet:notifications:prepareIdentity";
export const NOTIFICATIONS_RESET_IDENTITIES =
  "cadet:notifications:resetIdentities";

// Window attention
export const WINDOW_ATTENTION = "cadet:window:attention";

// Bundle confirm
export const BUNDLE_CONFIRM_GET_DATA = "cadet:bundleConfirm:getData";
export const BUNDLE_CONFIRM_RESPOND = "cadet:bundleConfirm:respond";

// Quick input
export const QUICK_INPUT_SUBMIT = "cadet:quickInput:submit";
export const QUICK_INPUT_DISMISS = "cadet:quickInput:dismiss";

// Command palette
export const COMMAND_PALETTE_OPEN = "cadet:commandPalette:open";
export const COMMAND_PALETTE_DISMISS = "cadet:commandPalette:dismiss";
export const COMMAND_PALETTE_SELECT = "cadet:commandPalette:select";

// Dictation overlay
export const DICTATION_OVERLAY_SET_STATE = "cadet:dictationOverlay:setState";
export const DICTATION_OVERLAY_STATE_EVENT = "cadet:dictationOverlay:state";
export const DICTATION_OVERLAY_GET_STATE = "cadet:dictationOverlay:getState";
export const DICTATION_OVERLAY_REQUEST_STOP =
  "cadet:dictationOverlay:requestStop";
export const DICTATION_OVERLAY_STOP_REQUESTED =
  "cadet:dictationOverlay:stopRequested";
export const DICTATION_OVERLAY_SET_INTERACTIVE =
  "cadet:dictationOverlay:setInteractive";
export const DICTATION_OVERLAY_SET_HIT_REGION =
  "cadet:dictationOverlay:setHitRegion";

// Voice activity: the running live-voice session, as the companion surface
// renders it. The session's window publishes; the surface's window presses.
export const VOICE_ACTIVITY_START = "cadet:voiceActivity:start";
export const VOICE_ACTIVITY_UPDATE = "cadet:voiceActivity:update";
export const VOICE_ACTIVITY_END = "cadet:voiceActivity:end";
export const VOICE_ACTIVITY_CONTROL = "cadet:voiceActivity:control";
export const VOICE_ACTIVITY_CONTROL_EVENT = "cadet:voiceActivity:controlEvent";

// Companion surface: the always-present floating avatar
export const COMPANION_GET_STATE = "cadet:companion:getState";
export const COMPANION_STATE_EVENT = "cadet:companion:state";
export const COMPANION_SET_INTERACTIVE = "cadet:companion:setInteractive";
export const COMPANION_MOVE_BY = "cadet:companion:moveBy";
export const COMPANION_RELEASE = "cadet:companion:release";
export const COMPANION_START_VOICE = "cadet:companion:startVoice";
export const COMPANION_TOGGLE_WATCH = "cadet:companion:toggleWatch";
export const COMPANION_LIST_CAPTURE_SOURCES =
  "cadet:companion:listCaptureSources";
export const COMPANION_SET_SCREEN_SHARE = "cadet:companion:setScreenShare";
export const COMPANION_SET_ANNOTATING = "cadet:companion:setAnnotating";
export const COMPANION_TOGGLE_ANNOTATING = "cadet:companion:toggleAnnotating";
export const COMPANION_CLEAR_MARKS = "cadet:companion:clearMarks";
export const COMPANION_SET_ANNOTATION_TOOL =
  "cadet:companion:setAnnotationTool";
export const COMPANION_ANNOTATE_SHARE = "cadet:companion:annotateShare";
export const COMPANION_SET_FRAME_SCROLLING =
  "cadet:companion:setFrameScrolling";
export const COMPANION_FRAME_DRAWN = "cadet:companion:frameDrawn";
export const COMPANION_CAPTURE_SCREEN = "cadet:companion:captureScreen";
export const COMPANION_SHARED_FRAME = "cadet:companion:sharedFrame";
export const COMPANION_SHARE_TARGETS = "cadet:companion:shareTargets";
export const COMPANION_ANSWER_WATCH_RETRO = "cadet:companion:answerWatchRetro";
export const COMPANION_ANSWER_DICTATION_OFFER =
  "cadet:companion:answerDictationOffer";
export const COMPANION_SET_UNPLACED_DICTATION_OFFER =
  "cadet:companion:setUnplacedDictationOffer";
export const COMPANION_ANSWER_POPOVER = "cadet:companion:answerPopover";
export const COMPANION_SET_POPOVER_SIZE = "cadet:companion:setPopoverSize";
export const COMPANION_SET_POPOVER_VIEW = "cadet:companion:setPopoverView";
export const COMPANION_SET_ATTACHED_POPOVER_HEIGHT =
  "cadet:companion:setAttachedPopoverHeight";
export const COMPANION_TOGGLE_PICKER = "cadet:companion:togglePicker";
export const COMPANION_OPEN_LINK = "cadet:companion:openLink";
export const COMPANION_TAKES_PROMPTS = "cadet:companion:takesPrompts";
export const COMPANION_ACTIVATE = "cadet:companion:activate";
export const COMPANION_SET_CONTEXT = "cadet:companion:setContext";
export const COMPANION_ADVANCE_INTRO = "cadet:companion:advanceIntro";
export const COMPANION_CONTEXT_MENU = "cadet:companion:contextMenu";

// Popout
export const POPOUT_OPEN = "cadet:popout:open";

// Auto-update
export const UPDATE_GET_STATE = "cadet:update:getState";
export const UPDATE_CHECK = "cadet:update:check";
export const UPDATE_INSTALL = "cadet:update:install";
export const UPDATE_STATE_EVENT = "cadet:update:state";
