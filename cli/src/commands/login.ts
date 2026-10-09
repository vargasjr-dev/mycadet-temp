import { isManagedCloud } from "../lib/managed-cloud.js";

import {
  getActiveAssistant,
  loadAllAssistants,
  removeAssistantEntry,
  setActiveAssistant,
} from "../lib/assistant-config";
import {
  clearPlatformToken,
  fetchCurrentUser,
  fetchPlatformAssistants,
  readPlatformToken,
  savePlatformToken,
} from "../lib/platform-client";
import {
  describeLoginError,
  registerLocalAssistantWithPlatform,
  workosPkceLogin,
} from "../lib/cloud-login.js";
import { getPlatformUrl } from "../lib/platform-client";
import { syncCloudAssistants } from "../lib/sync-cloud-assistants";


export async function login(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: cadet login [--token <session-token>] [--force]");
    console.log("");
    console.log("Log in to Cadet Cloud.");
    console.log("");
    console.log("By default, opens a browser window for authentication.");
    console.log("Alternatively, pass a session token directly with --token.");
    console.log("");
    console.log("On success, syncs cloud-managed assistants to the local");
    console.log("lockfile so they appear in `cadet ps`.");
    console.log("");
    console.log("Options:");
    console.log("  --token <token>    Session token from Cadet Cloud");
    console.log(
      "  --force, -f        Re-authenticate even if already logged in",
    );
    console.log("");
    console.log("Examples:");
    console.log("  cadet login");
    console.log("  cadet login --token <session-token>");
    console.log("  cadet login --force");
    process.exit(0);
  }

  const forceFlag = args.includes("--force") || args.includes("-f");
  let token: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--token") {
      token = args[i + 1];
      if (!token) {
        console.error("Error: --token requires a value");
        process.exit(1);
      }
      break;
    }
  }

  // Block if already authenticated (unless --force)
  if (!forceFlag && !token) {
    const existingToken = readPlatformToken();
    if (existingToken) {
      try {
        const existingUser = await fetchCurrentUser(existingToken);
        console.error(
          `Already logged in as ${existingUser.email}. Run \`cadet logout\` first, or use \`cadet login --force\` to re-authenticate.`,
        );
        process.exit(1);
      } catch {
        // Token is stale/invalid — proceed with login
      }
    }
  }

  // If no --token flag, use app-held WorkOS PKCE login.
  if (!token) {
    try {
      token = await workosPkceLogin(getPlatformUrl());
    } catch (error) {
      console.error(`❌ ${describeLoginError(error)}`);
      process.exit(1);
    }
  }

  console.log("Validating token...");

  try {
    const user = await fetchCurrentUser(token);
    savePlatformToken(token);
    console.log(`✅ Logged in as ${user.email}`);

    // Register the local assistant with the platform (non-fatal).
    // Mirrors the desktop app's LocalAssistantBootstrapService flow.
    try {
      await registerLocalAssistantWithPlatform(token, user);
    } catch {
      // Non-fatal — login succeeded even if registration fails
    }

    // Sync cloud assistants from the platform into the local lockfile.
    // This ensures `cadet ps` shows managed assistants immediately
    // after login (e.g. after a retire-and-rehatch cycle). We've just
    // saved this token, so it's guaranteed non-empty here.
    try {
      const result = await syncCloudAssistants(token);
      if (result) {
        const total = result.added + result.removed;
        if (total > 0) {
          console.log(
            `Synced cloud assistants (${result.added} added, ${result.removed} removed).`,
          );
        }
      }

      // If no active assistant is set, activate the first cloud one.
      if (!getActiveAssistant()) {
        const platformAssistants = await fetchPlatformAssistants(token);
        if (platformAssistants.length > 0) {
          setActiveAssistant(platformAssistants[0].id);
        }
      }
    } catch {
      // Non-fatal — login succeeded even if sync fails
    }
  } catch (error) {
    console.error(
      `❌ Login failed: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }
}

export async function logout(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: cadet logout");
    console.log("");
    console.log("Log out of Cadet Cloud, remove the stored session token,");
    console.log("and remove cloud-managed assistants from the local lockfile.");
    process.exit(0);
  }

  // Remove cloud-managed assistants from the lockfile.
  const cloudAssistants = loadAllAssistants().filter((a) =>
    isManagedCloud(a.cloud),
  );
  for (const a of cloudAssistants) {
    removeAssistantEntry(a.assistantId);
  }
  if (cloudAssistants.length > 0) {
    console.log(
      `Removed ${cloudAssistants.length} cloud assistant${cloudAssistants.length > 1 ? "s" : ""} from local lockfile.`,
    );
  }

  clearPlatformToken();
  console.log("Logged out. Cadet Cloud token removed.");
}

export async function whoami(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: cadet whoami");
    console.log("");
    console.log("Show the currently logged-in Cadet Cloud user.");
    process.exit(0);
  }

  const token = readPlatformToken();
  if (!token) {
    console.error("Not logged in. Run `cadet login` first.");
    process.exit(1);
  }

  try {
    const user = await fetchCurrentUser(token);
    console.log(`Email: ${user.email}`);
    if (user.display) {
      console.log(`Name:  ${user.display}`);
    }
    console.log(`ID:    ${user.id}`);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
