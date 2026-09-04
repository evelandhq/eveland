/**
 * ANSI styling for the two outputs an operator reads rather than scripts:
 * `status` and `doctor`. Both are walls of aligned monochrome text where the
 * one row that matters -- the unit that is not active, the check that failed
 * -- has to be found by reading every row. Color makes the healthy rows
 * recede and leaves the broken one as the only bright thing on the screen.
 *
 * Deliberately hand-rolled and deliberately tiny: five styles from the
 * 16-colour set, which every terminal theme (and every operator's SSH
 * session) renders. eveland-ctl takes no dependency for this.
 *
 * Off unless stdout is a terminal, so a redirect, a pipe into `grep`, or a
 * paste into an issue report carries no escape codes. `NO_COLOR` and
 * `FORCE_COLOR` override that, in that order (https://no-color.org).
 */

export type Style = (text: string) => string;

export type Palette = {
  enabled: boolean;
  bold: Style;
  dim: Style;
  green: Style;
  yellow: Style;
  red: Style;
};

const identity: Style = (text) => text;

const PLAIN: Palette = {
  enabled: false,
  bold: identity,
  dim: identity,
  green: identity,
  yellow: identity,
  red: identity,
};

function wrap(open: number, close: number): Style {
  // Column padding is computed from the plain text, so a segment that is
  // absent must stay absent rather than become two escape sequences.
  return (text) => (text === "" ? "" : `\u001b[${open}m${text}\u001b[${close}m`);
}

const STYLED: Palette = {
  enabled: true,
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  red: wrap(31, 39),
};

export function colorEnabled(env: NodeJS.ProcessEnv, isTty: boolean): boolean {
  // Presence is the signal, but an empty value is not presence -- an exported
  // but unset NO_COLOR would otherwise silently disable colour everywhere.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  const force = env.FORCE_COLOR?.trim();
  if (force !== undefined && force !== "") return force !== "0" && force !== "false";
  if (env.TERM === "dumb") return false;
  return isTty;
}

export function createPalette(
  env: NodeJS.ProcessEnv,
  isTty: boolean = process.stdout.isTTY === true,
): Palette {
  return colorEnabled(env, isTty) ? STYLED : PLAIN;
}

/** The green check / red cross that opens every `status` row. */
export function marker(palette: Palette, ok: boolean): string {
  return ok ? palette.green("✓") : palette.red("✗");
}
