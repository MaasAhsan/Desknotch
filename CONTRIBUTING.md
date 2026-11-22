# Contributing

Thanks for helping improve Desknotch.

## Before opening an issue

- Search existing issues for duplicates.
- Include the Desknotch version and Windows build.
- For runtime failures, attach a redacted `desknotch.log` excerpt and describe the exact steps to reproduce.
- Never attach private notification text, clipboard contents, calendar feed URLs or authentication tokens.

## Development setup

1. Install Node.js 22 and npm.
2. Clone the repository and run `npm install`.
3. Run `npm run check` and `npm test`.
4. Run `npm start` on Windows to validate actual overlay behavior.

The optional media bridge requires the .NET 9 SDK and Windows SDK targeting pack.

## Pull requests

- Keep changes focused and explain the user-visible behavior.
- Preserve the existing hover, auto-hide, click-through, notification queue and swipe-dismiss interactions.
- Add or update tests for changed behavior.
- Do not add telemetry or send notification, clipboard or calendar data off-device.
- Do not add new package permissions without documenting why they are needed.
- Run `npm run check` and `npm test` before submitting.
- Include Windows manual test results when changing OS APIs, packaging, installer behavior or window placement.

## Code style

- Use CommonJS in the Electron main process and Node services.
- Keep Node APIs out of the renderer; expose narrow APIs through `preload.js`.
- Validate IPC senders and untrusted values.
- Prefer small modules in `src/core/` or `src/integrations/` over growing `main.js`.
- Keep accessibility labels and reduced-motion behavior for UI controls and animations.
