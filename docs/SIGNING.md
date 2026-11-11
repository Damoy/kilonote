# Code signing (Windows)

KiloNote's Windows files are **not signed yet** (no Authenticode signature). Every
release file has a SHA-256 checksum and a signed build provenance instead (see
[SECURITY.md](SECURITY.md#verify-a-file)). This page lists the ways to sign them, and
what a signature would and would not change.

## What a signature changes

- **SmartScreen** shows the publisher's name instead of "Unknown publisher". The
  warning itself fades only as the signed files build a reputation (downloads over
  time). EV certificates no longer skip that warm-up either.
- **Endpoint protection and application control** (AppLocker, WDAC, Smart App
  Control) often trust a signed file more, and an IT team can allow "everything signed
  by this publisher" instead of one hash per version.
- It does **not** prove that the code is safe, and a company policy still decides
  what may run on its machines.

## The options

| Option | Cost | Name shown in the signature | Notes |
|---|---|---|---|
| [SignPath Foundation](https://signpath.org) | Free for open source projects | SignPath Foundation | The project applies and is reviewed; signing runs from GitHub Actions, and each release is approved in SignPath. |
| Azure Artifact Signing (formerly Trusted Signing) | A monthly subscription | The verified identity (a person or a company) | Identity validation by Microsoft; check that individuals of your country are accepted. Tauri supports it through `bundle.windows.signCommand`. |
| An open source code signing certificate (Certum…) | A yearly fee | "Open Source Developer, *full name*" | The developer's **full name** is published in every signed file. Usually a smart card or a cloud key, awkward in CI. |
| A company certificate | None for the project | The company | On a managed workstation, the IT team signs the file, or allows it by its SHA-256 hash. |

## Recommended

- **On a managed workstation, now:** ask the IT team to allow the file by its SHA-256
  hash (from `SHA256SUMS.txt`, checked with `gh attestation verify <file> -R Damoy/kilonote`),
  or build KiloNote locally ([SECURITY.md](SECURITY.md#building-from-source-on-a-managed-pc)).
  No certificate changes the fact that a managed PC runs only what its policy allows.
- **For the public releases:** SignPath Foundation. It is free, and the signature shows
  the foundation's name, not a person's.

## Steps for SignPath Foundation

1. Apply on [signpath.org](https://signpath.org) with the repository's address. The
   conditions (an OSI license such as MIT, public sources, builds from CI, no malware)
   are met; the review takes some time.
2. Once accepted, the SignPath project gets a signing policy for releases and an
   artifact configuration for the files to sign: `kilonote.exe` and the NSIS installer.
3. In the repository settings, add the SignPath API token as a secret and the
   organization id as a variable.
4. The release workflow then signs in two passes: the application's executable before
   the installer is made (so the installed program is signed too), then the installer
   and the portable exe. That wiring is added once the SignPath project exists: it
   cannot be tested without it.

Until then, the release notes and the [README](../README.md#install) explain the
first-launch steps of an unsigned app.
