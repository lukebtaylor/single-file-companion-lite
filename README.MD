# SingleFile Companion Lite

SingleFile Companion Lite is a program that runs outside the browser. It allows
you to save pages in another folder than the browser's download folder.

It uses the
[Native Messaging API](https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)
to communicate with [SingleFile](https://www.getsinglefile.com).

## Install

Every release is built from source by [GitHub Actions](.github/workflows/release.yml) - a matrix job compiles each platform in parallel and a final job publishes the results - so what you download is traceable to a specific commit and build log.

- Grab the zip file corresponding to your OS and your browser from the [latest release](../../releases/latest):

  - Chrome, Linux: `chromium-linux.zip`
  - Chrome, Windows: `chromium-win.zip`
  - Chrome, macOS: `chromium-mac.zip`
  - Firefox, Linux: `firefox-linux.zip`
  - Firefox, Windows: `firefox-win.zip`
  - Firefox, macOS: `firefox-mac.zip`

- Unzip the file in an empty folder somewhere on your disk and run `install`
- Note: for *nix installs, you will need to `chmod +x` the `install`, `uninstall`, and `singlefile_companion_lite` files
- Note: `install` records this folder's path into the browser's native messaging registration, so don't move or delete it afterwards - if you need to relocate it, run `uninstall`, move the folder, then run `install` again from the new location

- Enable the option `Destination > save with SingleFile Companion` in SingleFile

By default, pages are saved in the `WebArchives` folder created next to the binary (see [Options](#options) below for where that is and how to change it).

### Building from source instead

If you'd rather not trust a prebuilt binary at all, build it yourself with [Deno](https://deno.land):

```bash
deno compile --allow-read --allow-write --target x86_64-unknown-linux-gnu --output singlefile_companion_lite src/index.ts
```

(swap `--target` for `x86_64-pc-windows-msvc` or `x86_64-apple-darwin` on other platforms). This is exactly what `build.sh` and the release workflow run — no hidden steps.

The source (`src/index.ts`) is TypeScript. Deno runs and compiles `.ts` files directly — there's no separate `tsc` build step; `deno compile` type-strips and bundles straight to a native binary.

## Options

The `options.json` file allows configuring SingleFile Companion Lite. It's the
copy that sits in the same folder you unzipped the release into and ran
`install` from - right next to the `singlefile_companion_lite` binary, not
anywhere in the browser's own profile or extension folder. Chrome and Firefox
both start native messaging hosts with their working directory set to that
folder, which is also why the paths below are relative to it.

Edit it with any text editor and save - there's no install step to re-run and
no need to restart the browser. Each save spawns a fresh instance of the
program, so it reads the current `options.json` from disk every time.

Entries you can edit:

- `savePath`: path where to save files, relative to the install folder unless
  you give it an absolute path (default: `./WebArchives/`)
- `errorFilePath`: path of the file where errors are logged, same relative-to-
  install-folder rule (default: unset - errors go to stderr instead, which is
  typically not visible since the browser doesn't show this process's output)

## Releasing (maintainers)

Releases are driven entirely by `package.json`'s `version` field — no manual tagging, no separate version file to keep in sync.

1. Bump `version` in `package.json` (e.g. `0.0.1` → `0.0.2`) and merge that change to `main` (normal PR, same as any other change).
2. [`.github/workflows/release.yml`](.github/workflows/release.yml) triggers on any push to `main` that touches `package.json`:
   - `check` job reads the version and checks whether that release already exists.
   - `build` job runs as a matrix - one parallel job per OS (linux/mac/win) - each compiling its binary via `deno compile --target ...` and zipping both browser installer bundles for that OS.
   - `release` job downloads all three matrix bundles, verifies all six are present, tags the commit `v<version>`, and publishes a GitHub Release with them attached.
3. Pushing to `main` without changing `version` does nothing (the existing-release check short-circuits before anything builds), so routine commits don't trigger spurious releases.
