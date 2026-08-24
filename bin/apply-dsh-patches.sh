#!/bin/sh
set -eu

source_dir=${1:?source directory is required}
patch_dir=${2:?patch directory is required}

if [ ! -d "$source_dir/.git" ]; then
  echo "[dsh] patch source is not a Git checkout: $source_dir" >&2
  exit 2
fi

found_patch=false
for patch in "$patch_dir"/*.patch; do
  [ -e "$patch" ] || continue
  found_patch=true
  echo "[dsh] checking patch $(basename "$patch")"
  git -C "$source_dir" apply --unidiff-zero --check "$patch"
  git -C "$source_dir" apply --unidiff-zero "$patch"
done

if [ "$found_patch" = false ]; then
  echo "[dsh] no patch files found under $patch_dir" >&2
fi

# These compatibility changes are kept beside the patch files because they
# touch generated source layouts that have changed between upstream releases.
# The same helper is used by image builds and in-container DSH updates.
sed -i 's/if (!(WIDER_MODES\[effectiveMode\]/if (effectiveMode === mode) return mode as SandboxMode; if (!(WIDER_MODES[effectiveMode]/' \
  "$source_dir/packages/sandbox/sandbox/src/escalation.ts"
sed -i 's/if (justification !== undefined && justification.trim().length === 0)/if (justification !== undefined \&\& justification.trim().length === 0 \&\& sandboxPermissions !== "danger-full-access")/' \
  "$source_dir/packages/sandbox/sandbox/src/escalation.ts"
sed -i "s@return \[\.\.\.new Set(\[policy\.workspaceRoot, '\/tmp', tmpdir()\]\.map(canonicalPath))\]@return [...new Set([policy.workspaceRoot, '\/data', '\/tmp', tmpdir()].map(canonicalPath))]@" \
  "$source_dir/packages/sandbox/sandbox/src/roots.ts"
sed -i "s/readWrite\.push('\/tmp', policy\.workspaceRoot)/readWrite.push('\/tmp', '\/data', policy.workspaceRoot)/" \
  "$source_dir/packages/sandbox/sandbox-local/src/profiles.ts"
sed -i "s/args\.push('--tmpfs', '\/tmp')/args.push('--tmpfs', '\/tmp'); args.push('--bind', '\/data', '\/data')/" \
  "$source_dir/packages/sandbox/sandbox-local/src/profiles.ts"
sed -i "s/readlinkSync, symlinkSync/readlinkSync, realpathSync, symlinkSync/" \
  "$source_dir/packages/boot/app-boot/src/profile.ts"
sed -i "s/return candidate/return realpathSync(candidate)/" \
  "$source_dir/packages/boot/app-boot/src/profile.ts"
