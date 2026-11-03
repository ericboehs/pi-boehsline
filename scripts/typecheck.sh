#!/usr/bin/env bash
# Typecheck against the pi packages pi supplies at runtime.
#
# Locally, link the pi you actually run: a fork checkout when the `pi` on PATH
# is a wrapper that execs one (or PI_FORK_DIR names it), else the mise install,
# else npm -g, the same way dotfiles' bin/pi-ext-check does. That way the types match the runtime,
# and an npm release-age cooldown (min-release-age) can't block it.
# In CI, or with PI_VERSION set, install that pi version into .typecheck/.
# Those packages are optional peers, and npm 11 won't install optional peers
# into a project that has real dependencies, so they can't go in node_modules
# directly.
#
# --link-only: make the links and stop (tests need them at runtime too).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d node_modules ] || npm install --no-audit --no-fund

pi_pkg="" pi_deps=""

# A fork checkout: the monorepo root, whose node_modules holds pi-tui, pi-ai and
# typebox (workspace links). Its types come from dist/, so it must be built.
fork_root() {
  if [ -n "${PI_FORK_DIR:-}" ]; then echo "$PI_FORK_DIR"; return; fi
  local bin
  bin="$(command -v pi 2>/dev/null || true)"
  [ -n "$bin" ] && [ -f "$bin" ] && head -c 4096 "$bin" | LC_ALL=C grep -q '^#!.*sh' || return 0
  sed -n 's|^exec node \(.*\)/packages/coding-agent/dist/.*|\1|p' "$bin" | head -1
}

if [ -z "${PI_VERSION:-}" ]; then
  root="$(fork_root)"
  if [ -n "$root" ] && [ -f "$root/packages/coding-agent/dist/index.d.ts" ] && [ -d "$root/node_modules/@earendil-works/pi-tui" ]; then
    pi_pkg="$root/packages/coding-agent"
    pi_deps="$root/node_modules"
  fi
fi

if [ -z "${PI_VERSION:-}" ] && [ -z "$pi_pkg" ]; then
  if command -v mise >/dev/null; then
    root="$(mise where npm:@earendil-works/pi-coding-agent 2>/dev/null || true)"
    if [ -n "$root" ] && [ -d "$root/node_modules/@earendil-works/pi-coding-agent" ]; then
      pi_pkg="$root/node_modules/@earendil-works/pi-coding-agent"
      for d in "$pi_pkg/node_modules" "$root/node_modules/.mise/node_modules" "$root/node_modules"; do
        [ -d "$d/@earendil-works/pi-tui" ] && { pi_deps="$d"; break; }
      done
    fi
  fi
  if [ -z "$pi_pkg" ] && command -v npm >/dev/null && [ -d "$(npm root -g)/@earendil-works/pi-coding-agent" ]; then
    pi_pkg="$(npm root -g)/@earendil-works/pi-coding-agent"
    pi_deps="$pi_pkg/node_modules"
    [ -d "$pi_deps/@earendil-works/pi-tui" ] || pi_deps="$(npm root -g)"
  fi
fi

if [ -z "$pi_pkg" ] || [ -z "$pi_deps" ]; then
  # Pin to the pi we target: npm's "latest" tag can lag the newest release.
  PI_VERSION=${PI_VERSION:-1.3.0}
  if [ "$(cat .typecheck/.pi-version 2>/dev/null)" != "$PI_VERSION" ]; then
    npm install --prefix .typecheck --no-package-lock --no-audit --no-fund --silent \
      typebox @types/node \
      "@earendil-works/pi-coding-agent@$PI_VERSION" "@earendil-works/pi-tui@$PI_VERSION" "@earendil-works/pi-ai@$PI_VERSION"
    echo "$PI_VERSION" > .typecheck/.pi-version
  fi
  pi_pkg="$PWD/.typecheck/node_modules/@earendil-works/pi-coding-agent"
  pi_deps="$PWD/.typecheck/node_modules"
fi

mkdir -p node_modules/@earendil-works node_modules/@types
ln -sfn "$pi_pkg" node_modules/@earendil-works/pi-coding-agent
ln -sfn "$pi_deps/@earendil-works/pi-tui" node_modules/@earendil-works/pi-tui
ln -sfn "$pi_deps/@earendil-works/pi-ai" node_modules/@earendil-works/pi-ai
ln -sfn "$pi_deps/typebox" node_modules/typebox
[ -d "$pi_deps/@types/node" ] && ln -sfn "$pi_deps/@types/node" node_modules/@types/node

if [ "${1:-}" = "--link-only" ]; then
  echo "Linked pi $(node -p "require('$pi_pkg/package.json').version") ($pi_pkg)"
  exit 0
fi
echo "Typechecking against $(node -p "require('$pi_pkg/package.json').version") ($pi_pkg)"
exec npx --yes --package=typescript@5 tsc -p tsconfig.json
