# everyapp-clone-kit

oss.new's "Clone to your GitHub" puts an app's source in your GitHub. As delivered, that
repository doesn't install on an EveryApp Gateway: it points at a local EveryApp checkout
that isn't there, and it has no GitHub release to install from.

This kit fixes that. Give your coding agent this prompt:

> Read https://raw.githubusercontent.com/gfsaaser24/everyapp-clone-kit/main/llms.txt and get
> https://github.com/<you>/<app> onto my EveryApp Gateway.

The agent pins the EveryApp packages to a published version, adds a Release workflow,
pushes, and installs the app with `everyapp install https://github.com/<you>/<app>`.

You may be asked to do a few things only you can: sign in to Cloudflare, enable R2 once,
turn on GitHub Actions for the repository, or fill in the app's settings.

## What's in it

- `llms.txt`: the step-by-step instructions for the agent.
- `prepare.mjs`: the script that makes the file changes. Node 22+, no dependencies.
- `templates/release.yml`: EveryApp's starter Release workflow, unchanged.

## Running the script yourself

```sh
node prepare.mjs <app-dir> --dry-run          # show what would change
node prepare.mjs <app-dir>                    # change it and run pnpm install
node prepare.mjs <app-dir> --version 0.4.2    # pin a version other than npm's latest
npx github:gfsaaser24/everyapp-clone-kit <app-dir>
```

Then commit, push, wait for the Release workflow, and run
`everyapp install https://github.com/<you>/<app>`.

## About

Made by [founder.chat](https://founder.chat). Questions or fixes: gabe@founder.chat, or open an
issue. Not affiliated with EveryApp or oss.new. MIT licensed.
