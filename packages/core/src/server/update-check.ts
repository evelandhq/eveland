import { readFile } from "node:fs/promises";
import { parseUpdateCheck, type UpdateCheck } from "@evelandhq/core/update-check";

/**
 * Reads the update check `eveland-ctl` publishes at `EVELAND_UPDATE_CHECK_FILE`.
 *
 * Never throws and never blocks on anything but one local read: the file is
 * absent in a development checkout and on any installation whose operator
 * turned the check off, and the pages that read it must render exactly as
 * well without it.
 */
export async function readUpdateCheckFile(
  filePath: string | undefined,
): Promise<UpdateCheck | null> {
  const path = filePath?.trim();
  if (!path) return null;
  try {
    return parseUpdateCheck(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
