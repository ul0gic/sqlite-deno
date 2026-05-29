#!/usr/bin/env bash
# Fetches the pinned Biome binary — a dev/CI lint tool, never shipped and never a
# package dependency (no Node, nothing in deno.json/deno.lock). Same model as Semgrep.
# Idempotent: if the pinned version is already present, this is a no-op with no network.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(tr -d '[:space:]' < "$root/tools/biome-version")"
dest="$root/tools/.bin/biome"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "biome: unsupported OS '$(uname -s)'" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "biome: unsupported arch '$(uname -m)'" >&2; exit 1 ;;
esac
asset="biome-${os}-${arch}"
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
  asset="${asset}-musl"
fi

if [ -x "$dest" ] && [ "$("$dest" --version 2>/dev/null)" = "Version: $version" ]; then
  exit 0
fi

expected="$(awk -v a="$asset" '$2 == a {print $1}' "$root/tools/biome.sha256")"
if [ -z "$expected" ]; then
  echo "biome: no recorded sha256 for '$asset' in tools/biome.sha256." >&2
  echo "       Download it, verify upstream, then add: '<sha256>  $asset'." >&2
  exit 1
fi

url="https://github.com/biomejs/biome/releases/download/%40biomejs/biome%40${version}/${asset}"
mkdir -p "$root/tools/.bin"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp"
actual="$(sha256sum "$tmp" | awk '{print $1}')"
if [ "$actual" != "$expected" ]; then
  echo "biome: checksum mismatch for $asset" >&2
  echo "       expected $expected" >&2
  echo "       actual   $actual" >&2
  exit 1
fi
chmod +x "$tmp"
mv "$tmp" "$dest"
echo "biome: installed $asset $version"
