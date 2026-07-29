declare module "import-in-the-middle/register-hooks.mjs" {
  export type RegisterHooksOptions = {
    include?: Array<string | RegExp>;
    exclude?: Array<string | RegExp>;
  };

  export function register(options?: RegisterHooksOptions): void;
  export function supportsSyncHooks(): boolean;
}
