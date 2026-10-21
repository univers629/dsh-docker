# Migrating to DSH 0.2.1-rc.2

0.2.1 changed four artifact shapes the patch set depends on: two patches lost their target file
or anchor (installation fails outright), and one patch keeps its anchor while calling a function
upstream deleted (it would throw on the request path once installed). This document records the
per-entry verification against the real `@deepseek-ai/dsh@0.2.1-rc.2` artifacts, plus the upgrade
order.

## Measured results

| Item | Result |
| --- | --- |
| Artifact patches | 12 entries: 9 anchors hit; `sandbox-escalation-self-mode` is built in upstream (its marker is already in the artifact); `app-boot-realpath-package-dir` and `public-local-mode-transport-owner-node` hit; two old entries removed (below) |
| `public-local-mode-transport-owner` | `exports["./client"]` now splits into `browser` and `node` conditions and `lib/client.js` is gone; the browser-side patch targets `lib/client.browser.js`, with an optional companion for `lib/client.node.js`. The module loader takes the condition's `default`, which is `client.browser.js` |
| `workspace-model-pending-attachments-create` | `reuseOrCreateBlank` became `connectBlank` → `createInWorkspace` → `createNamed`, so the old anchor disappeared; every creation path goes through `createNamed`, and the Workspace model notification moved with it |
| `trusted-proxy-auto-browser-auth` | The anchor still matches, but `requestAuthority(headers)` became `requestAudience(headers, secure)` and `isAuthenticated` / `sessionCookie` gained a `secure` parameter; not following the signature throws `ReferenceError` on the first trusted-proxy request |
| Removed entries | `public-local-mode` (its artifact shape disappeared in 0.2.0; the transport-owner patch does the job) and `app-boot-realpath-import` (app-boot imports `realpathSync` itself since 0.2.0) |
| Preflight result shape | The compatibility verdict renamed `peers` to `requirements`, keyed by `engines.dsh` or `@deepseek-ai/dsh*`; 0.2.1 also lets a plugin declare `engines.dsh`, which takes precedence over `peerDependencies` |
| Installer allow-list | The closure still has five packages with install scripts: `@deepseek-ai/dsh-subprocess-local`, `koffi`, `node-pty`, `@google/genai`, `protobufjs` |
| Layout, CLI, bundle names | `lib/bin.js`, `--dump-config*`, `--profile`, the `web` and `plugin` subcommands, the `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` bundles, the `webserver`/`web-runtime` entries and the `ctx.webStartup` service are unchanged |
| Runtime requirement | `engines` is still `^22.19.0 || >=24.0.0`; the image's `node:24-trixie-slim` satisfies it |

The three environment-variable injections and the project's own `DSH-BUILD-METADATA.json` format are
unaffected by this upgrade.

## Upgrade order

```text
1. Back up DSH_HOME (profiles/, storages/ and the credential files).
2. Rebuild the image from updated sources and upgrade the container (the patch set now follows
   0.2.1), or move to an image built for 0.2.1:
   ./install.sh upgrade
3. Read the preflight report for plugins that would be disabled and handle them as below.
4. Restart and check: the startup log should no longer contain disabling profile plugin, and
   GET /dsh-docker-control/info should show every plugin in place.
```

In-container updates (`./install.sh update` or "update now" in the panel) also carry the new
patches, but the patch definitions ship with the image: a container still running the old image
lacks this round of target-file and anchor fixes and fails before replacing `/app/dsh`.

## Preflight

`bin/preflight-profile-plugins.mjs` still takes its verdict from the target runtime tree's
`@deepseek-ai/dsh-app-boot`, and the report format is unchanged; the `未满足的要求` line now prints
the version ranges from `requirements`.

```text
Usage: preflight-profile-plugins.mjs <module-root> [profile-dir] [--json] [--fail-on-incompatible]
Exit codes: 0 done; 1 the preflight itself failed; 2 bad arguments; 3 a plugin would be disabled or
is not mounted (only with --fail-on-incompatible)
```

## Exact-version exemptions

A plugin without a compatible release can still be exempted per exact version, with the same format
as 0.2.0:

```json
{
  "dsh-cmdgo-provider@0.9.1": ["0.2.1-rc.2"]
}
```

```text
dsh plugin --profile web allow-version <name@version> --dsh-version 0.2.1-rc.2 --accept-risk
dsh plugin --profile web version-exemptions
```

## Verification commands

```text
# Artifact patches (a required miss fails)
DSH_PATCH_DIR=$PWD/patches node bin/apply-dsh-artifact-patches.mjs <tree>/node_modules --check

# Plugin compatibility
node bin/preflight-profile-plugins.mjs <tree>/node_modules [profile-dir]

# Offline smoke (patch-set self-consistency and re-entry, preflight output, PWA injection)
node tests/run-offline.mjs artifact-patches profile-preflight pwa
```

## Open items

- Plugins whose peers or `engines.dsh` still point below 0.2.0 are disabled on a 0.2.1 host:
  measured `dsh-cmdgo-provider@0.9.1` (six peers pinned on the `^0.1.0-rc.6` side) and
  `@dsh-external/dsh-normify@0.5.4` (`engines.dsh: ">=0.1.5-rc.2 <0.2.0"`). Upgrade the plugin
  first, or exempt it as above.
- The nginx manifest `sub_filter` used to match only the absolute
  `href="/manifest.webmanifest"`, while published frontends write the directory-relative
  `href="./manifest.webmanifest"`, so the rewrite had been a no-op since 0.2.0. Both shapes are
  matched now; a custom frontend still needs this string checked.
- `bin/dsh` does not exclude `--dump-config-schema`, so
  `dsh --profile web --dump-config-schema` receives an injected `--port`. Pre-existing defect,
  unrelated to this upgrade.
