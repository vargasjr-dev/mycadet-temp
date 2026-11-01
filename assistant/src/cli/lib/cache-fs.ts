/**
 * Wrappers of `node:fs` functions used by the cache CLI command.
 *
 * This indirection exists solely so tests can `mock.module("./cache-fs.js")`
 * without mocking all of `node:fs` — which causes bun's test runner to hang
 * on exit. These are wrappers the file defines (not re-exports), so the
 * no-re-exports rule stays quiet.
 */

import {
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
} from "node:fs";

export function existsSync(path: Parameters<typeof fsExistsSync>[0]): boolean {
  return fsExistsSync(path);
}

export function readFileSync(
  path: Parameters<typeof fsReadFileSync>[0],
  encoding: BufferEncoding,
): string;
export function readFileSync(
  path: Parameters<typeof fsReadFileSync>[0],
  encoding?: undefined,
): Buffer;
export function readFileSync(
  path: Parameters<typeof fsReadFileSync>[0],
  encoding?: BufferEncoding,
): string | Buffer {
  return fsReadFileSync(path, encoding);
}
