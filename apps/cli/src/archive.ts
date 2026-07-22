import { zipSync, type Zippable } from "fflate";
import type { SnapshotFile } from "./snapshot.js";

const zipEpoch = new Date("1980-01-01T00:00:00.000Z");

export function createZipArchive(files: readonly SnapshotFile[]): Uint8Array {
  const entries: Zippable = {};
  for (const file of files) {
    entries[file.path] = [new Uint8Array(file.content), {
      attrs: file.mode << 16,
      os: 3,
      mtime: zipEpoch,
    }];
  }
  return zipSync(entries, { level: 6, mtime: zipEpoch });
}
