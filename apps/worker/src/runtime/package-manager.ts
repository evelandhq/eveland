export const PNPM_RELEASE_AGE_CONFIG = "--config.minimum-release-age=0";

export const PNPM_FROZEN_INSTALL_COMMAND =
  `pnpm install --frozen-lockfile ${PNPM_RELEASE_AGE_CONFIG}`;
