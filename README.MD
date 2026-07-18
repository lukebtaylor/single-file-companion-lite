# SingleFile Companion Lite

SingleFile Companion Lite is a program that runs outside the browser. It allows
you to save pages in another folder than the browser's download folder.

It uses the
[Native Messaging API](https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)
to communicate with [SingleFile](https://www.getsinglefile.com).

## Install

Binaries are no longer committed to this repository. Every tagged release is built from source by [GitHub Actions](.github/workflows/release.yml) and published as release assets, so what you download is traceable to a specific commit and build log instead of an untracked binary blob in git history.

- Grab the zip file corresponding to your OS and your browser from the [latest release](../../releases/latest):

  - Chrome, Linux: `chromium-linux.zip`
  - Chrome, Windows: `chromium-win.zip`
  - Chrome, macOS: `chromium-mac.zip`
  - Firefox, Linux: `firefox-linux.zip`
  - Firefox, Windows: `firefox-win.zip`
  - Firefox, macOS: `firefox-mac.zip`

- Unzip the file in an empty folder somewhere on your disk and run `install`
- Note: for *nix installs, you will need to `chmod +x` the `install`, `uninstall`, and `singlefile_companion_lite` files

- Enable the option `Destination > save with SingleFile Companion` in SingleFile

By default, pages are saved in the `./WebArchives/` folder.

### Building from source instead

If you'd rather not trust a prebuilt binary at all, build it yourself with [Deno](https://deno.land):

```bash
deno compile --allow-read --allow-write --target x86_64-unknown-linux-gnu --output singlefile_companion_lite src/index.js
```

(swap `--target` for `x86_64-pc-windows-msvc` or `x86_64-apple-darwin` on other platforms). This is exactly what `build.sh` and the release workflow run — no hidden steps.

## Options

The `options.json` file allows configuring SingleFile Companion Lite. Here are
the entries you can edit:

- `savePath`: path where to save files (default: `./WebArchives/`)
- `errorFilePath`: path of the file where errors are stored (default:
  `undefined`)

## Releasing (maintainers)

Releases are driven entirely by `package.json`'s `version` field — no manual tagging, no separate version file to keep in sync.

1. Bump `version` in `package.json` (e.g. `0.0.1` → `0.0.2`) and merge that change to `main` (normal PR, same as any other change).
2. [`.github/workflows/release.yml`](.github/workflows/release.yml) triggers on any push to `main` that touches `package.json`, checks whether a release for that version already exists, and if not: builds the binaries, zips the installer bundles, tags the commit `v<version>`, and publishes a GitHub Release with all 6 bundles attached — all automatically.
3. Pushing to `main` without changing `version` does nothing (the existing-release check short-circuits the job before it builds anything), so routine commits don't trigger spurious releases.
