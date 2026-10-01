# Migrating to DSH 0.2.0-rc.2

An in-container update (`./install.sh update`, or "update now" in the panel) only replaces
`/app/dsh` and re-applies the artifact patches; it never touches the profile. Starting with DSH
0.2.0, the runtime validates the `@deepseek-ai/dsh*` peer ranges each plugin declares before the
profile loads, and disables the plugins that do not satisfy them. The process still starts, the
health check still passes, and the update script's rollback logic cannot see the difference — only
a single `dsh: disabling profile plugin ...` line reaches stderr. Plugin features disappear while
the site looks perfectly healthy. This document records the measured 0.1.7-rc.2 → 0.2.0-rc.2
results and the upgrade order.

## Measured results

Verified against the real `@deepseek-ai/dsh@0.2.0-rc.2` artifacts rather than inferred from a
changelog:

| Item | Result |
| --- | --- |
| 13 artifact patches | 10 anchors hit; `sandbox-escalation-self-mode` is now built in upstream (its marker is already in the artifact, so it is reported as already applied and skipped); the optional `app-boot-realpath-import` and `public-local-mode` anchors miss, both harmlessly |
| Why `app-boot-realpath-import` misses | 0.2.0's `dsh-app-boot` imports `realpathSync` itself, so the patch is no longer needed |
| Why `public-local-mode` misses | The old artifact shape is gone; `public-local-mode-transport-owner`, which does the same job, still hits, and the `DSH_PUBLIC_LOCAL_MODE=1` cookie branch of the `isLoopback` check is still written to disk |
| Command-line surface | `lib/bin.js` entry, `web` and `--profile`, `--port`/`--host`/`--no-open`/`--trusted-host`, `--patch`, `--dump-config*`, and `plugin add\|update\|remove` are all unchanged |
| Directory layout | `lib/node_modules/<pkg>/node_modules` plus the relative root `node_modules` symlink are unchanged, and `bin.dsh` still points at `lib/bin.js` |
| Installer allow list | The dependency closure still contains exactly five packages with install scripts: `@deepseek-ai/dsh-subprocess-local`, `koffi`, `node-pty`, `@google/genai`, `protobufjs` |
| Profile and bundle names | `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` are still the web template's bundles; the `webserver`/`web-runtime` entries and the `ctx.webStartup` service keep their names |
| Layer composition | `schedule`, `time-context`, and `ui-schedule` moved out of the `dsh-web-app` default layer into the optional `@deepseek-ai/dsh-experimental-schedule-bundle`; `dsh-base` gained an `otel` entry, and the default telemetry endpoint moved from `harness-telemetry.deepseeksvc.com/v1/logs` to `dsh-otel-collector.deepseeksvc.com/v1/logs` |
| Config schema | `--dump-config-schema` gains one group-shaped `$defs` entry and changes no property |
| Plugin peer check | 6 of the profile's 20 bundles are disabled under 0.2.0-rc.2 (the same profile has 0 under 0.1.7-rc.2) |

Three environment-variable injections, the six patched package names, and the self-defined
`DSH-BUILD-METADATA.json` format are unaffected by this upgrade and need no change.

## Upgrade order

The order matters: the plugin manager runs the peer check before it calls pnpm, so installing a
"0.2.0-compatible" plugin version on a 0.1.7 host is rejected outright. Upgrade the host first,
then the plugins.

```text
1. Back up DSH_HOME (profiles/, storages/, and credential files). The update itself does not
   touch these directories, but plugin upgrades rewrite the profile manifest.
2. Update in the container to 0.2.0-rc.2: ./install.sh update, or "update now" in the panel.
   The preflight reports the plugins that will be disabled; those features stay off until step 3.
3. Upgrade the plugins that have a compatible release (the host is 0.2.0-rc.2 now, so the peer
   check passes): dsh plugin --profile web add <plugin>@<version>
4. Grant exact-version exemptions for the plugins that have no compatible release (next section).
5. Restart and verify: no disabling profile plugin line in the startup log, and
   GET /dsh-docker-control/info shows every plugin present.
```

## Preflight

`bin/preflight-profile-plugins.mjs` computes which plugins will be disabled before the runtime is
replaced, using the judging functions shipped in the target runtime tree
(`getDshRuntimeVersion()` and `evaluatePluginCompatibility()` from `@deepseek-ai/dsh-app-boot`).
The verdict therefore comes from the same code that runs at startup; no rules are reimplemented.

```text
usage: preflight-profile-plugins.mjs <module-root> [profile-dir] [--json] [--fail-on-incompatible]
       <module-root>  node_modules directory of the target runtime tree, the same argument
                      apply-dsh-artifact-patches.mjs takes
       profile-dir    defaults to $DSH_PROFILE_ROOT, falling back to $DSH_HOME/profiles/web
exit codes: 0 done; 1 preflight itself failed; 2 bad arguments; 3 plugins would be disabled or
       are not installed (only with --fail-on-incompatible)
```

In human-readable mode the last line is always `摘要：...`. `update-dsh.sh` reads that line into
the update status, so "these plugins will disappear" is visible in the log and the panel before
the restart. The preflight only reports: neither a failure nor an incompatible verdict blocks the
update, and `--fail-on-incompatible` is deliberately absent from the update path.

## Exact-version exemptions

A plugin with no compatible release can be registered as an exact-version exemption in the
profile, at the cost of accepting that it may crash or corrupt data on the new host. The file is
`<profile>/compatibility.json`:

```json
{
  "@xxxyz/dsh-mcp-manager@2.2.7": ["0.2.0-rc.2"],
  "dsh-session-manager@0.2.2": ["0.2.0-rc.2"]
}
```

Keys must be exact `name@version` pairs and values must be exact DSH version lists. Letting the
plugin manager write the file is safer: it validates the shape and holds a lock on the file.

```text
dsh plugin --profile web allow-version <name@version> --dsh-version <current dsh version> --accept-risk
dsh plugin --profile web revoke-version <name@version>
dsh plugin --profile web version-exemptions
```

An exemption applies to that one version pair only: a plugin upgrade needs a new grant.

## Verification commands

```text
# artifact patches (run against the target runtime's node_modules; a non-optional miss fails)
DSH_PATCH_DIR=$PWD/patches node bin/apply-dsh-artifact-patches.mjs <tree>/node_modules --check

# plugin compatibility (expected: all usable on 0.1.7-rc.2; 6 reported on 0.2.0-rc.2)
node bin/preflight-profile-plugins.mjs <tree>/node_modules [profile-dir]

# check the running container
curl -s http://127.0.0.1:3081/dsh-docker-control/info | head -c 400
```

## Open items

- `@xxxyz/dsh-mcp-manager@2.2.7` is the newest release on npm and still declares `^0.1.2-rc.1`:
  exempt it, or wait for upstream.
- The 0.2.0 compatibility fix for `dsh-session-manager@0.2.2` sits in an unmerged upstream PR:
  either install a build from that branch (same version number, peers relaxed to
  `^0.1.0-rc.6 || ^0.2.0-rc.1`) or grant an exemption.
- The compatible `dsh-files` release carries no tag, so it has to be installed by commit.
- Everything here was verified at artifact level and through the judging functions: 0.2.0-rc.2 has
  never been started in this container, so the UI behaviour after the plugin upgrades needs one
  manual confirmation after a restart.
- The `nginx` `sub_filter` target strings were not compared byte-for-byte against the 0.2.0 client
  artifacts; a mismatch is silent and shows up as lost PWA metadata.
- `bin/dsh`'s argument exclusion list is missing `--dump-config-schema`, so
  `dsh --profile web --dump-config-schema` gets a `--port` injected. This is unrelated to the
  upgrade and is a pre-existing defect.
