# eveland-ctl (placeholder)

This npm package is a **defensive name registration**. It contains no
functionality.

The real `eveland-ctl` operates a local [Eveland](https://eveland.ai)
installation — it manages the install directory, the process supervisor, and
(on Linux) systemd units. It is bound to a specific installed source tree, so
distributing it as a standalone npm package would be meaningless.

Install Eveland instead:

```sh
curl -fsSL https://eveland.ai/install.sh | sh
```

The installer places `eveland-ctl` on your `PATH` for you.

## Why this package exists

Eveland's installation docs tell users to type `eveland-ctl`. Leaving the name
unclaimed on npm would let someone else publish under a name our own
documentation teaches. Registering it closes that hole.

Source: <https://github.com/evelandhq/eveland/tree/main/infra/npm-placeholders/eveland-ctl>
