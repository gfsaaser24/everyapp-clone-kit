# Agent instructions

- To get an app repository (for example one from oss.new's "Clone to your GitHub") onto a
  person's EveryApp Gateway, follow `llms.txt` step by step. It is the source of truth.
- `prepare.mjs` must stay zero-dependency and readable, and safe to run twice.
- `templates/release.yml` is a verbatim copy of EveryApp's
  `starter/.github/workflows/release.yml`. Refresh it from there; don't edit it here.
- Never deploy or install anything while working on this kit itself.
