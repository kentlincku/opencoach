# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature for `kentlincku/opencoach` when it is available. Do not open a public issue containing an exploit, credential, private user data, or a working attack against a released build.

Include:

- affected commit or release
- platform and architecture
- reproduction steps
- expected and actual security boundary
- whether credentials or user data may have been exposed

Do not include real tokens, cookies, passwords, private keys, or personal recordings. Use redacted test credentials.

## Supported versions

OpenCoach is currently beta source software with no signed public release. Security fixes target the latest `main` branch. Historical engineering artifacts and private development branches are not supported releases.

## Security boundaries

Reports are especially useful for:

- Electron renderer-to-main privilege escalation
- unsafe WebView navigation or native bridge access
- credential disclosure or cross-provider reuse
- archive traversal, symlink, or artifact-integrity bypass
- sidecar command/environment injection
- unintended cloud fallback or audio upload
- local endpoint policy bypass

## Secrets found in Git

If a real credential is discovered, treat it as compromised even if it was later deleted. Revoke or rotate it first; history cleanup is not a substitute for rotation.
