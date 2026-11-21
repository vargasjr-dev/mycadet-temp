/**
 * The cadet CLI wrapper's surface — the symlink family the macOS and
 * Linux shells install and repair. A deep entry rather than the root
 * index so the mac bundle (which resolves the root graph) does not pull
 * the Windows launcher family or the classic-shell feature list.
 */
export { writeCliLocator } from "../cli-installer";
export { provisionCliForWrapper } from "../cli-path-installer";
