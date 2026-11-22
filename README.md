# Desknotch

**A calmer, smarter desktop companion for Windows.**

Desknotch brings Windows notifications, media controls, clipboard snippets and calendar reminders into a compact, animated notch at the top of your screen.

> Version 1.3.0 · Electron 38 · Windows 10 22H2 / Windows 11

## Highlights

### The notch

- Frameless, transparent, always-on-top overlay.
- Click-through outside the active notch surface.
- Animated compact-to-expanded notification cards.
- Notification queue, click-to-dismiss and upward swipe-to-dismiss.
- 50% opacity while hovered (adjustable in Settings).
- Automatically slides away after 30 seconds without a new notification (adjustable).
- Smooth **Glass** theme lighting that follows the pointer with eased motion, plus Midnight, Graphite, Arctic, Aurora and Custom themes.
- System, light and dark appearance modes.

### Desktop companion

- Windows notification capture through the existing read-only notification database watcher.
- Notification history, search, replay and retention controls.
- Per-app allow/block and priority rules.
- Focus Mode with optional quiet-hour schedule.
- Multi-monitor selection and display-change handling.
- Now Playing integration through an optional .NET Windows media bridge.
- Opt-in text clipboard history with local encryption when Windows secure storage is available.
- Read-only HTTPS iCalendar feed subscriptions and reminders.

### Release readiness

- Desknotch Windows app identity, application icon, tray icon and package logos.
- Migration from the previous Island user-data folders. Old files are copied, never moved or deleted.
- Renderer crash recovery with a bounded retry window.
- Rotating diagnostic logs (2 MB active log plus three backups).
- GitHub Releases auto-update support for packaged builds.
- GitHub Actions workflows for validation and Windows release packaging.

## Requirements

- Windows 10 version 22H2 or Windows 11 (64-bit) is recommended.
- Node.js 22 or a version compatible with Electron 38.
- npm.
- .NET 9 SDK and Windows SDK targeting pack only to build the optional media bridge.
- A trusted code-signing certificate for AppX/MSIX distribution.

The main application is an Electron app. Windows-specific capabilities are isolated in integration modules so the ordinary notification overlay does not depend on the optional media bridge.

## Quick start

```powershell
npm install
npm run check
npm test
npm start
```

The app stays in the system tray. Open the tray menu to send a test notification, open Settings, view notification history, check for updates, open diagnostics or quit.

## Build a Windows installer

```powershell
npm install
npm run check
npm test
npm run dist:win
```

The NSIS installer is written to `dist/`. Its default configuration allows users to choose an installation directory and preserves Desknotch user data when uninstalled. Windows release builds are Authenticode-signed so that Windows can identify the publisher and the updater can verify downloaded installers. Configure `WIN_CSC_LINK` (a `.pfx`/`.p12` path or base64-encoded certificate) and `WIN_CSC_KEY_PASSWORD` in your shell before building. Do not disable update signature verification for public releases.

### Windows media integration

The media bridge uses Windows Global System Media Transport Controls through a .NET 9 helper:

```powershell
npm run build:media-bridge
```

The ordinary NSIS installer does not declare the `globalMediaControl` package capability. For media control, use the AppX/MSIX route and a trusted certificate:

```powershell
npm run dist:msix
```

Before building an AppX/MSIX package, update the `build.appx.publisher` value in `package.json` to match the subject of your signing certificate, and configure the matching identity in your release environment. The sample publisher `CN=Desknotch` is a placeholder, not a real signing identity. The media capability and Windows package identity must be validated on the target machine.

## Automatic updates

Packaged builds use `electron-updater` and GitHub Releases. Before publishing:

1. Create a GitHub repository named `desknotch` (or change `build.publish.repo` in `package.json`).
2. Replace `YOUR_GITHUB_USERNAME` in `build.publish.owner` with the repository owner for local release builds. The GitHub Actions release workflow sets this value from the repository owner automatically during CI packaging.
3. Push a version tag matching `package.json`, for example `v1.3.0`.
4. The release workflow requires the `WIN_CSC_LINK` GitHub Actions secret and optionally uses `WIN_CSC_KEY_PASSWORD`; it runs checks, builds the signed NSIS installer, generates SHA-256 checksums, then attaches the installer and update metadata to the GitHub Release. Add the signing secrets under **Settings → Secrets and variables → Actions** before tagging a production release. The media-enabled AppX/MSIX package is a separate, certificate-dependent build.

Installed, packaged builds check for updates shortly after startup and then every six hours. Users can also use **Check for updates** in the tray menu. Downloads run in the background; after the download completes, choose **Restart to install update** from the tray menu.

Updates are intentionally disabled in development mode and while the repository owner remains the placeholder. A release needs a valid GitHub repository and published `latest.yml` metadata before the updater can find it.

## First launch and user-data migration after rebranding

Desknotch uses this data folder:

```text
%APPDATA%\Desknotch\
```

On first launch, it looks for previous data in `%APPDATA%\island-notify\` and `%APPDATA%\Island\`. Existing settings, notification history, clipboard history, calendar subscriptions and logs are copied to the Desknotch folder when a corresponding destination file does not already exist. The previous data is left intact as a rollback copy.

**Important:** Quit the old Island app completely (including its tray process) before launching Desknotch for the first time. This keeps SQLite database and WAL sidecar files quiescent during the copy. Do not delete the old folder until you have verified your Desknotch settings and history.

## Local integrations

### Local notification endpoint

Desknotch exposes a loopback-only JSON endpoint for local integrations:

```http
POST http://127.0.0.1:47321/notify
Content-Type: application/json
```

Example:

```powershell
$payload = @{
  app = 'Build Agent'
  appId = 'example.build-agent'
  title = 'Build completed'
  body = 'The release package is ready.'
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:47321/notify' `
  -ContentType 'application/json' -Body $payload
```

The listener binds to `127.0.0.1`, not a public network interface. Any process running as the logged-in user can still call this local endpoint; do not treat it as an authentication boundary.

### Clipboard

Clipboard monitoring is opt-in and disabled by default. This release stores text only; image and file formats are not collected. If Windows secure storage is available, clipboard content is encrypted before being written to the local database. Pause or disable monitoring in Settings and clear history whenever you need to.

### Calendar

Calendar support uses read-only HTTPS iCalendar (`.ics`) feed URLs. Some subscription URLs contain bearer-like private tokens. Treat them as credentials. Feed URLs are encrypted at rest when Electron's Windows secure storage is available. The app does not edit remote events or request calendar write permission.

### Notifications

Notification history is local and can be disabled or cleared. Dismissing an item from Desknotch does not automatically delete the original Windows notification. The current database watcher is Windows-build-dependent; test real notifications on each Windows version you plan to support.

## Data and diagnostics

Desknotch stores application data in `%APPDATA%\Desknotch\`:

- `settings.json` — preferences and app rules.
- `desknotch-history.db` — local notification history.
- `desknotch-clipboard.db` — optional clipboard history.
- `desknotch-calendar.db` — calendar feeds, cached events and reminder state.
- `desknotch.log` — rotating diagnostics, plus `.1`, `.2` and `.3` backups.

The tray menu's **Open log file** action opens the active log. Logs should not contain clipboard contents; still review and redact diagnostic output before sharing it.

## Development and tests

```powershell
npm run check
npm test
```

Tests cover notification parsing and database cursor behavior, renderer startup/interaction regressions, settings and notification policy, clipboard storage, calendar parsing/reminders, media-bridge protocol, data migration, log rotation, Glass pointer-light source behavior and release metadata.

Static/unit tests do not replace Windows device validation. Before a public release, manually test:

- Real toast capture with Focus Assist / Do Not Disturb on and off.
- Overlay hit testing, transparency, swipe dismissal and Glass cursor lighting.
- Single and multi-monitor arrangements, reconnection and mixed DPI scaling.
- Clipboard monitoring enabled/disabled and encrypted data access.
- Calendar feed refresh, invalid feeds, timezone and daylight-saving changes.
- The .NET media bridge using the intended package identity and capability.
- Installer, uninstall, data preservation, update download and update installation.
- Long-running memory/CPU use, sleep/resume and renderer recovery.

## Repository layout

```text
main.js                         Electron main process and app lifecycle
preload.js                      Narrow contextBridge APIs
renderer/                       Overlay and Settings Center
src/core/                       Settings, history, policies and storage
src/integrations/               Windows media, clipboard and calendar adapters
src/winNotifications.js         Windows toast database watcher
windows-bridge/media-bridge/    Optional .NET Global Media Controls helper
assets/                         Desknotch icons and artwork
build/appx/                     Windows package logo assets
scripts/                        Packaging helpers
test/                           Regression and integration unit tests
.github/workflows/              CI and release automation
```

## Security

See [SECURITY.md](SECURITY.md) for reporting instructions. The renderer uses context isolation, disabled Node integration, sandboxing and a restrictive Content Security Policy. IPC handlers validate their sender before accessing settings or integrations.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please run the full check and test suite before opening a pull request. For the production release sequence, see [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).

## License

No open-source license has been selected for this repository yet. Unless the repository owner adds a license, no permission is granted to reuse, redistribute or modify the code beyond rights provided by applicable law. Add the intended license before inviting external contributions or redistribution.
