# Gate 5 Controlled Pilot Install Evidence

Date: 2026-05-22

Scope decision: use the controlled technical pilot path for Gate 5. Do not register Apple Developer Program membership just to unblock this small pilot gate. This closes only the small, supported pilot install path. It does not claim no-warning public distribution.

## Distribution Position

Current package state:

- Historical artifact: `dist/MarkLab-a378a26ae6d5-controlled-pilot.zip`
- Current artifact rule: rebuild from the current release candidate with `package:app`, verify with `verify:package`, then zip `dist/MarkLab.app` with `ditto -c -k --sequesterRsrc --keepParent`.
- App bundle inside artifact: `MarkLab.app`
- Bundle id: `com.marklab.app`
- URL scheme: `marklab`
- Signing: ad-hoc
- TeamIdentifier: not set
- Gatekeeper assessment: rejected

This means:

- Controlled technical pilot distribution can proceed with an explicit per-app Gatekeeper workaround.
- No-friction install for normal non-technical users remains blocked until Developer ID signing and notarization are implemented.
- Paid/public/broader pilot distribution must not rely on this workaround.

## Pilot Install Workaround

Preferred controlled-pilot workaround:

```sh
xattr -dr com.apple.quarantine /Applications/MarkLab.app
open /Applications/MarkLab.app
```

Use the same command against the actual installed app path if the pilot user keeps the app somewhere other than `/Applications`.

Do not ask pilot users to disable Gatekeeper globally with `spctl --master-disable`.

Alternative UI path for a supported pilot user is macOS System Settings > Privacy & Security > Open Anyway after the first blocked open attempt. The Terminal `xattr` command is easier to support remotely because it is scoped to this app bundle only.

## Verification Run

Historical Gate 5 verification evidence from commit `a378a26ae6d5712e84c16650d63ff0ebb2ebd8e1`:

- `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos package:app` passed.
- `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos verify:package` passed for `dist/MarkLab.app`.
- `ditto -c -k --sequesterRsrc --keepParent dist/MarkLab.app dist/MarkLab-a378a26ae6d5-controlled-pilot.zip` produced a `932K` zip.
- `node apps/marklab-macos/scripts/verify-packaged-app.mjs /tmp/marklab-gate5-install-a378a26ae6d5/MarkLab.app` passed after unpacking the zip outside the repo checkout.
- Simulated downloaded quarantine on the unpacked app produced `spctl --assess --type execute --verbose=4` result `rejected`.
- `xattr -dr com.apple.quarantine /tmp/marklab-gate5-install-a378a26ae6d5/MarkLab.app` removed only the quarantine attribute; `com.apple.provenance` remained.
- LaunchServices started the unpacked app from `/tmp/marklab-gate5-install-a378a26ae6d5/MarkLab.app` with a repo-outside app support directory.
- The unpacked app opened `gate5-local.md` through app launch arguments and loaded the MarkEdit shell.

Historical hosted flow evidence through the unpacked app and the pre-Gate-6 operator-token/CLI bridge:

| Check | Result |
| --- | --- |
| `marklab share gate5-cli-share.md --edit --json` through unpacked `MarkLab.app` | Passed |
| `marklab share gate5-cli-share.md --view --json` through unpacked `MarkLab.app` | Passed |
| Workspace-owned hosted document | `30fb11c1-494d-4c63-9be8-ff29ac424d5f` |
| Branch | `9cd42cab-36be-4133-816b-13211ec28093` |
| Edit grant | `f426bca2-5704-49a2-b008-ce8c37df9575` |
| View grant | `551dcb79-7ba1-4491-89bc-4d7d95590cf3` |
| Host | `marklab-relay-alpha.fly.dev` |
| Share file status | `synced`, provider export `verified` |
| App-to-app join from edit link | Passed after opening the joined local file |
| Quit/reopen binding restoration | Passed; joined file reached `synced`, provider export `verified` after reopen |

Access tokens were intentionally not copied into this document.

Current Gate 6 owner onboarding changes do not change the Gate 5 distribution claim: the same packaged `.app` shape is still used, but the normal owner path is now hosted OIDC through `Settings` -> `Account` -> `Sign In` and `marklab://auth/callback`. A final pre-invite clean-install smoke should use a freshly rebuilt zip plus the live OIDC/native callback path, not the historical owner-token bridge.

Current RC package verification after Gate 5/6 review fixes:

- `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos package:app` passed.
- `npx -y pnpm@10.0.0 --filter @marklab/marklab-macos verify:package` passed for `dist/MarkLab.app`.
- Verification output reported `signingMode: "ad-hoc"`, `signature: "adhoc"`, `teamIdentifier: "not set"`, `developerIdSigned: false`, `gatekeeperAccepted: false`, `notarized: false`, and `distributionReady: false`.
- This current RC package check confirms the artifact shape and install limitation only; it does not repeat the historical repo-outside install, hosted sharing, app-to-app join, or quit/reopen smoke.

## Gate 5 Claims

Passed for the controlled technical pilot:

- A repo checkout is not required to run the packaged app.
- The package contains the executable, `Info.plist`, bundled editor `index.html`, bundled `local-editor.js`, and the `marklab://` URL scheme.
- The current unsigned/ad-hoc package behavior is understood and documented.
- A scoped per-app Gatekeeper workaround is documented and tested.
- Local file editing and saving remain covered by the Gate 1 packaged-app acceptance pass; Gate 5 rechecked repo-outside local file open and hosted projection from the install artifact.
- The historical unpacked app smoke proved hosted edit/view link creation through the operator-token/CLI bridge; current pilot owner sharing should be re-smoked through Gate 6 OIDC before inviting non-technical users.
- A second local file can join from the edit link and restore sync after app quit/reopen.

Not claimed by this gate:

- Developer ID signed and notarized distribution.
- No-warning Finder double-click install for ordinary public users.
- Completed live Google/OIDC first-run login/onboarding acceptance; this remains Gate 6 until an interactive native callback/workspace smoke passes.
- Paid/public distribution or auto-update semantics; signed distribution and update pipeline are deferred to Gate 10.5.
- A separate physical Mac or separate macOS account pass. Run that before expanding beyond the supported technical pilot audience.
