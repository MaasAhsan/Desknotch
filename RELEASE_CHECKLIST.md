# Desknotch v1.3.0 — Release checklist

This checklist is for maintainers preparing a public Windows release. A source ZIP is not a signed installer; complete the Windows validation and signing steps before publishing binaries.

## 1. Repository setup

- [ ] Create the GitHub repository (recommended name: `desknotch`).
- [ ] Push the source tree, including `.github/` workflows and templates.
- [ ] Confirm the repository owner matches `build.publish.owner` in `package.json`, or allow the release workflow to inject the GitHub Actions owner at build time.
- [ ] Decide and add an appropriate `LICENSE` before accepting external contributions or permitting redistribution. This repository intentionally does not assume an open-source license.
- [ ] Protect the default branch and require the CI workflow to pass.

## 2. Windows signing and update configuration

The NSIS updater is configured to verify Authenticode signatures. Do not publish an unsigned release and do not disable verification for public builds.

For local release builds, set these environment variables before running `npm run dist:win`:

- `WIN_CSC_LINK`: path to a `.pfx`/`.p12` certificate or its base64-encoded contents.
- `WIN_CSC_KEY_PASSWORD`: certificate password, if required.

For GitHub Actions, add repository secrets with the same names under **Settings → Secrets and variables → Actions**. The release workflow requires `WIN_CSC_LINK`; the password secret is optional when the certificate has no password.

Use the same certificate subject for future updates. A certificate change requires a planned signing-key rotation; otherwise installed copies may reject updates signed by a different publisher.

## 3. Validate the source

On Windows with Node.js 22:

```powershell
npm install
npm run check
npm test
npm start
```

Manually verify the behaviors listed in the README, especially the original v5 interactions, actual Windows toast capture, Glass pointer lighting, multi-monitor handling, and clipboard/calendar opt-in controls.

## 4. Build locally

```powershell
npm run dist:win
```

The signed NSIS installer and updater metadata should be generated in `dist/`. Inspect the installer signature:

```powershell
Get-AuthenticodeSignature .\dist\Desknotch-1.3.0-x64.exe | Format-List
```

The exact installer filename may vary by architecture and package version.

For the optional media-enabled AppX/MSIX build, install the .NET 9 SDK, set `build.appx.publisher` to the signing certificate subject, configure an AppX signing identity, then run:

```powershell
npm run dist:msix
```

The AppX build must be validated on a machine where the package identity and `globalMediaControl` capability can be granted. The ordinary NSIS build does not declare that package capability, so the optional Windows media bridge may report unavailable in NSIS installations.

## 5. Publish a release

1. Update `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. Confirm `package.json` `build.publish.repo` is correct.
3. Commit and push the release changes.
4. Create a version tag that exactly matches the package version, for example `v1.3.0`.
5. Push the tag. GitHub Actions runs static checks and tests, builds the signed NSIS installer, generates SHA-256 checksums, and publishes the release assets.
6. Inspect the GitHub Release. Confirm the installer, `latest.yml`, blockmap files and `SHA256SUMS.txt` are attached.
7. Install the release on a clean Windows profile and test update detection using a later test version before announcing it publicly.

## 6. Rollback and user data

Desknotch copies the legacy Island settings and databases into `%APPDATA%\Desknotch` on first launch when the new target files do not already exist. It does not delete the old folders. Ask users to fully exit the legacy tray app before the first Desknotch launch, and keep the old data folder until the migrated settings and history have been verified.

## 7. Release acceptance

- [ ] CI and regression tests pass.
- [ ] Installer is signed by the expected publisher.
- [ ] Clean install, upgrade and uninstall tested.
- [ ] Existing user data survives upgrade/uninstall as documented.
- [ ] Auto-update from the previous signed release tested.
- [ ] All required installer and update metadata files attached to the GitHub Release.
- [ ] SHA-256 checksums verified.
- [ ] Windows 10/11, DPI scaling, sleep/resume and multi-monitor checks completed.
- [ ] Privacy controls for notification history, clipboard and calendar tested.
- [ ] Release notes and known limitations published.
