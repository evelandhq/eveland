import type { ProjectImportKind, SourceOrigin } from "@evelandhq/core/contracts";

/**
 * The fields every provenance-bearing shape shares: a Release's source in the
 * deployment overview, and the project's current PublicSourceRevision (whose
 * uploader is only an id, hence the loose uploader type).
 */
export type SourceProvenanceLike = {
  kind: ProjectImportKind;
  origin: SourceOrigin | null;
  commitSha: string | null;
  baseCommitSha: string | null;
  dirty: boolean | null;
  uploadedBy?: { id?: string; name: string; email: string } | string | null;
};

export function shortCommit(sha: string): string {
  return sha.slice(0, 12);
}

/**
 * One phrase for where a revision came from: "Commit abc123def456" for a git
 * sync, or "Uploaded from the CLI by Ada, based on abc123def456, with
 * uncommitted changes" for an upload. Older revisions recorded before
 * provenance existed degrade to what their kind and commit still say.
 */
export function describeSourceProvenance(source: SourceProvenanceLike): string {
  if (source.commitSha) return `Commit ${shortCommit(source.commitSha)}`;
  if (source.kind === "git") return "Git sync";
  const channel =
    source.origin === "cli-upload"
      ? "Uploaded from the CLI"
      : source.origin === "dashboard-upload"
        ? "Uploaded from the Dashboard"
        : "Uploaded";
  const uploader =
    source.uploadedBy && typeof source.uploadedBy === "object"
      ? ` by ${source.uploadedBy.name || source.uploadedBy.email}`
      : "";
  if (!source.baseCommitSha) return `${channel}${uploader}`;
  const base = `, based on ${shortCommit(source.baseCommitSha)}`;
  const state =
    source.dirty === true ? ", with uncommitted changes" : source.dirty === false ? ", clean" : "";
  return `${channel}${uploader}${base}${state}`;
}
