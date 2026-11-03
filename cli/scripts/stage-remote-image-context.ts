// stage-remote-image-context.ts — stage a remote sandbox image build context
// for CI practice builds.
//
// Uses the CLI's own staging code so the practice build exercises the exact
// context `cadet hatch --remote <name>` uploads — not a parallel shell
// imitation that can drift. Prints the staged directory; the caller
// (cli/scripts/practice-build-remote-images.sh) owns cleanup.
//
// Usage: bun cli/scripts/stage-remote-image-context.ts --remote <name>

import { join } from "node:path";
import { resolveVersion } from "@mycadet/shared/version";
import { stageBasetenBuildContext } from "../../packages/local-mode/src/remotes/baseten/context.js";

const argv = process.argv.slice(2);
const remoteFlag = argv.indexOf("--remote");
const remote = remoteFlag >= 0 ? argv[remoteFlag + 1] : undefined;
if (!remote) {
  console.error(
    "usage: bun cli/scripts/stage-remote-image-context.ts --remote <name>",
  );
  process.exit(1);
}

switch (remote) {
  case "baseten": {
    // The same resolved version `cadet hatch --remote baseten` stamps —
    // the cli package's version, local-stamped in source checkouts.
    const staged = stageBasetenBuildContext({
      version: resolveVersion(join(import.meta.dir, "..")),
    });
    console.log(staged.dir);
    break;
  }
  default:
    console.error(`unknown remote "${remote}" — supported: baseten`);
    process.exit(1);
}
