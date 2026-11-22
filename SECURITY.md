# Security policy

## Supported version

Security fixes should target the latest released Desknotch version.

## Reporting a vulnerability

Please do not open a public issue for an unpatched vulnerability. Contact the repository owner privately through the security contact configured in the GitHub repository's **Security → Advisories** page.

Include:

- A concise description and impact.
- Affected Desknotch version and Windows version.
- Reproduction steps or a proof of concept that does not expose private user data.
- Any suggested mitigation.

Do not include real notification contents, clipboard data, calendar feed URLs, access tokens or user-identifying paths in a report.

## Security design notes

- Renderer pages use context isolation, sandboxing, disabled Node integration and a restrictive Content Security Policy.
- Privileged IPC handlers verify that requests originate from the Settings window or the overlay window as appropriate.
- The local notification HTTP server binds to `127.0.0.1`; it is not an authenticated API and should not be exposed on a LAN.
- Clipboard monitoring is opt-in. Clipboard text and calendar feed URLs use Electron `safeStorage` when available.
- Logs should not include clipboard content. Review and redact logs before sharing them.
- Calendar feeds are HTTPS-only and have URL, redirect, payload-size and private-network protections.
