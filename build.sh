#!/bin/sh
# Local convenience script: builds all 3 platform binaries and all 6 installer
# bundles sequentially. CI does the same work in parallel via a matrix in
# .github/workflows/release.yml - this script is for local testing only.
set -e
mkdir -p install
rm -rf install/*

targets="x86_64-unknown-linux-gnu:linux x86_64-pc-windows-msvc:win x86_64-apple-darwin:mac"

for entry in $targets; do
  target=${entry%%:*}
  dir=${entry##*:}
  ext=""
  [ "$dir" = "win" ] && ext=".exe"
  bin="./src/${dir}/singlefile_companion_lite${ext}"

  deno compile --allow-read --allow-write --target "$target" --output "$bin" ./src/index.ts

  for browser in chromium firefox; do
    zip -9 -j "install/${browser}-${dir}.zip" "$bin" ./src/options.json "./src/${dir}/${browser}"/*
  done
done
