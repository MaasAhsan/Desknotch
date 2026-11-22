# Changelog

## 1.3.0 — Desknotch Ultimate

### Added
- Rebranded the application, Windows identity, tray, settings center, media bridge and release assets as **Desknotch**.
- New Desknotch app icon and AppX tile artwork.
- Eased, frame-driven pointer-following specular light for the Glass theme, including a smooth return to its resting position and reduced-motion support.
- First-launch copy migration from the previous Island app-data directories; source files remain untouched for rollback.
- Bounded renderer recovery and rotating diagnostic logs.
- GitHub Releases auto-update integration with a tray check/update action.
- GitHub Actions CI and signed Windows release workflows, repository issue/PR templates, contributor/security documentation and a release checklist.
- SHA-256 checksum generation for CI-published Windows release assets.

### Changed
- Windows app ID, executable name, installer naming, package identity and app-data folder now use Desknotch branding.
- Windows update signature verification is explicitly enabled for public NSIS releases.

### Preserved
- Existing notification capture, renderer handshake, tray behavior, notification queue, hover transparency, 30-second auto-hide, swipe dismissal, Settings Center, history, per-app rules, Focus Mode, multi-monitor support and Phase 2 media/clipboard/calendar integrations.

### Known release requirements
- GitHub releases require a configured repository and Windows signing certificate secrets.
- The optional Windows media bridge requires the package identity and `globalMediaControl` capability; it is not enabled by the regular NSIS package.
- Windows runtime, installer, certificate and media-bridge validation must be completed on a real Windows machine before public distribution.
