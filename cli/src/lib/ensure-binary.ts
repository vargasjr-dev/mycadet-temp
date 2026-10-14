import { spawnSync } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * Consolidated missing-dependency flow for interactive commands: probe for a
 * binary, and when it is absent, offer to install it — naming no commands —
 * then run the right package manager for the platform and verify. Callers
 * supply the recipes; everything else (prompt, package-manager discovery,
 * fallback copy) lives here so every command behaves the same.
 */

export interface EnsureBinaryOptions {
  /** The binary as invoked on PATH, e.g. "nginx". */
  binary: string;
  /** What the running command needs it for, e.g. "the tunnel edge". */
  purpose: string;
  /**
   * Package-manager name → full install argv (sudo included where needed),
   * e.g. `{ brew: ["brew", "install", "nginx"] }`. The first entry whose
   * package manager is available wins. Leave out a platform rather than
   * guessing at an unreliable package ID — the manual hint covers it.
   */
  packages: Record<string, string[]>;
  /** Shown when the user declines or auto-install fails. */
  manualHint: string;
  /** Probe: a version-ish string when the binary is usable, null otherwise. */
  probe: () => string | null;
  /** Check that a package manager exists. Default: `<pm> --version` probe. */
  pmAvailable?: (pm: string) => boolean;
  /** Run an install argv; true on success. Default: inherit-stdio spawnSync. */
  runInstall?: (argv: string[]) => boolean;
  /** Confirm the install. Default: promptLine "[Y/n]" on Enter-as-yes. */
  confirmInstall?: () => Promise<boolean>;
  platform?: NodeJS.Platform;
  confirmHomebrewInstall?: () => Promise<boolean>;
  streams?: {
    input?: NodeJS.ReadStream | Readable;
    output?: NodeJS.WriteStream | Writable;
  };
}

/**
 * Prompt-then-install a missing binary. Returns the probe result — the
 * existing version when the binary was already present, the fresh one after a
 * successful install — or null when the binary is missing and the user
 * declines, no package manager matches, or the install fails. Non-interactive
 * callers (no TTY) never hang: they get the manual hint and null.
 */
export async function ensureBinaryInstalled(
  opts: EnsureBinaryOptions,
): Promise<string | null> {
  const output = opts.streams?.output ?? process.stdout;

  const existing = opts.probe();
  if (existing) return existing;

  output.write(
    `\n${opts.binary} is required for ${opts.purpose}, but it isn't installed.\n`,
  );

  const confirm = opts.confirmInstall ?? defaultConfirm(opts);
  let install = false;
  try {
    install = await confirm();
  } catch {
    install = false;
  }
  if (!install) {
    output.write(`Skipping install. ${opts.manualHint}\n`);
    return null;
  }

  const pmAvailable = opts.pmAvailable ?? probePackageManager;
  let argv = Object.entries(opts.packages).find(([pm]) => pmAvailable(pm))?.[1];
  if (
    !argv &&
    (opts.platform ?? process.platform) === "darwin" &&
    opts.packages.brew
  ) {
    const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find(
      pmAvailable,
    );
    if (brew) {
      const prefix = brew.slice(0, -"/bin/brew".length);
      process.env.PATH = `${prefix}/bin:${prefix}/sbin:${process.env.PATH ?? ""}`;
      argv = [brew, ...opts.packages.brew.slice(1)];
    }
  }
  if (
    !argv &&
    (opts.platform ?? process.platform) === "darwin" &&
    opts.packages.brew
  ) {
    output.write(
      "Homebrew is required to install this dependency, but it isn't installed.\n",
    );
    const confirmHomebrew =
      opts.confirmHomebrewInstall ?? defaultConfirm(opts, "Homebrew");
    let approved = false;
    try {
      approved = await confirmHomebrew();
    } catch {
      /* No interactive approval. */
    }
    if (approved) {
      const bootstrap = [
        "/bin/bash",
        "-c",
        '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/7a3f48c7e498d7df3237fd41c30f4d492857edf4/install.sh)"',
      ];
      const installed = opts.runInstall
        ? opts.runInstall(bootstrap)
        : runInstallArgv(bootstrap);
      const brew = installed
        ? ["brew", "/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find(
            pmAvailable,
          )
        : undefined;
      if (brew) {
        const prefix =
          brew === "brew" ? "" : brew.slice(0, -"/bin/brew".length);
        if (prefix)
          process.env.PATH = `${prefix}/bin:${prefix}/sbin:${process.env.PATH ?? ""}`;
        argv = [brew, ...opts.packages.brew.slice(1)];
      }
    }
  }
  if (!argv) {
    output.write(`⚠ No supported package manager found. ${opts.manualHint}\n`);
    return null;
  }

  const ok = opts.runInstall ? opts.runInstall(argv) : runInstallArgv(argv);
  const version = ok ? opts.probe() : null;
  if (!version) {
    output.write(
      `⚠ Couldn't install ${opts.binary} automatically. ${opts.manualHint}\n`,
    );
    return null;
  }
  output.write(`✅ Installed ${opts.binary} (${version}).\n`);
  return version;
}

/** Default confirm: visible prompt, Enter = yes, non-TTY throws. */
function defaultConfirm(
  opts: EnsureBinaryOptions,
  binary = opts.binary,
): () => Promise<boolean> {
  return async () => {
    const input = opts.streams?.input ?? process.stdin;
    const output = opts.streams?.output ?? process.stdout;
    // Readable has no isTTY; only a real terminal answers the prompt.
    if (!("isTTY" in input) || !input.isTTY) {
      throw new Error("Install confirm requires an interactive terminal.");
    }
    const answer = (
      await readLineText(`Install ${binary} now? [Y/n] `, {
        input,
        output,
      })
    )
      .trim()
      .toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  };
}

/** Default installer: blocking spawn with inherited stdio (passwords flow). */
function runInstallArgv(argv: string[]): boolean {
  const [command, ...args] = argv;
  if (!command) return false;
  const result = spawnSync(command, args, {
    stdio: "inherit",
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

/** Default package-manager check: the manager answers `--version`. */
function probePackageManager(pm: string): boolean {
  const result = spawnSync(pm, ["--version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

/**
 * Read one visible line from stdin (Enter submits). Shared by the binary
 * install confirm and the ngrok authtoken paste-in, so both degrade the same
 * way on a non-interactive terminal (the caller decides what empty means).
 */
export async function readLineText(
  prompt: string,
  streams: { input?: Readable; output?: Writable } = {},
): Promise<string> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;

  output.write(prompt);

  return new Promise((resolve, reject) => {
    let line = "";
    const onData = (chunk: Buffer | string): void => {
      line += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      const newline = line.indexOf("\n");
      if (newline !== -1) {
        done(line.slice(0, newline).replace(/\r$/, ""));
      }
    };
    const cleanup = (): void => {
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      input.pause();
    };
    const done = (value: string): void => {
      cleanup();
      resolve(value);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    input.resume();
    input.on("data", onData);
    input.on("error", onError);
  });
}
