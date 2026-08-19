#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data /workspace
  chmod -R u+rwX,g+rwX /data /workspace
  if [ -d "$HOME/.ssh" ]; then
    chmod 700 "$HOME/.ssh"
    find "$HOME/.ssh" -type f -exec chmod 600 {} + 2>/dev/null || true
    find "$HOME/.ssh" -type f -name "*.pub" -exec chmod 644 {} + 2>/dev/null || true
    find "$HOME/.ssh" -type f -name "known_hosts*" -exec chmod 644 {} + 2>/dev/null || true
  fi
fi

if [ ! -f "$DSH_HOME/cordis.patch.yml" ]; then
  install -o node -g node -m 600 /etc/dsh-home/cordis.patch.yml "$DSH_HOME/cordis.patch.yml"
fi

mkdir -p "$DSH_HOME/skills/container-environment"
cp -f /etc/dsh-home/skills/container-environment/SKILL.md "$DSH_HOME/skills/container-environment/SKILL.md"
chown -R node:node "$DSH_HOME/skills"

if [ ! -f "$HOME/.npmrc" ]; then
  printf 'prefix=%s/.npm-global\n' "$HOME" > "$HOME/.npmrc"
  chown node:node "$HOME/.npmrc"
fi

if [ "$(id -u)" = "0" ]; then
  gosu node nginx -c /etc/dsh/nginx.conf -g 'daemon off;' &
  sleep 1
  exec gosu node /usr/local/bin/dsh "$@"
else
  nginx -c /etc/dsh/nginx.conf -g 'daemon off;' &
  sleep 1
  exec /usr/local/bin/dsh "$@"
fi