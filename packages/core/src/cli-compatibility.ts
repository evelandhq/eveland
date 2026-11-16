/**
 * The eveland CLI and the platform it talks to are compatible when they share
 * a major version. The CLI names its version on every request in
 * `CLI_VERSION_HEADER`; the API answers a request whose CLI version is
 * incompatible with `cliVersionProblem`'s message instead of serving it.
 * Browser-safe: pure string handling.
 */
export const CLI_VERSION_HEADER = "x-eveland-cli-version";

/** The `error` code of the API's answer to an incompatible CLI. */
export const CLI_VERSION_UNSUPPORTED = "cli_version_unsupported";

const semver = /^(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Null when the CLI version is compatible with the platform version, else why not. */
export function cliVersionProblem(cliVersion: string, platformVersion: string): string | null {
  const platformMajor = majorOf(platformVersion);
  const install = `Install eveland@${platformMajor} (for example \`npm install eveland@${platformMajor}\`)`;
  const cliMajor = semver.test(cliVersion) ? majorOf(cliVersion) : null;
  if (cliMajor === null) {
    return `This Eveland platform (${platformVersion}) cannot read the eveland CLI version ${JSON.stringify(cliVersion)}. ${install}.`;
  }
  if (cliMajor === platformMajor) return null;
  const problem = `eveland CLI ${cliVersion} is not compatible with this Eveland platform (${platformVersion}): the CLI must have the platform's major version, ${platformMajor}.`;
  return cliMajor < platformMajor
    ? `${problem} ${install}.`
    : `${problem} ${install}, or upgrade the platform.`;
}

function majorOf(version: string): number {
  return Number(version.split(".", 1)[0]);
}
