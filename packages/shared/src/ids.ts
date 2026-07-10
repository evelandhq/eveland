import { customAlphabet } from "nanoid";

export const idAlphabet = "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const createSuffix = customAlphabet(idAlphabet, 10);

export function createId(prefix: string): string {
  return `${prefix}_${createSuffix()}`;
}

const projectIdPrefix = "proj_";
// Case-sensitive: the id alphabet mixes upper and lower case, so short ids
// must be matched (and routed in URLs) without any case folding.
const projectShortIdPattern = /^[0-9a-zA-Z]{1,64}$/;

/** The public, prefix-less form of a project id used in agent URLs (`/a/<shortId>`). */
export function projectShortId(projectId: string): string {
  return projectId.startsWith(projectIdPrefix) ? projectId.slice(projectIdPrefix.length) : projectId;
}

/** Reverses {@link projectShortId}; returns null when the value cannot be a short id. */
export function projectIdFromShortId(shortId: string): string | null {
  return projectShortIdPattern.test(shortId) ? `${projectIdPrefix}${shortId}` : null;
}
