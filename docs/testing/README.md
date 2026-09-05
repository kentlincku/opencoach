# Testing OpenCoach

The public repository keeps reusable test procedures, but does not store raw logs containing machine paths, device identifiers, recordings, or private development metadata.

## Source suite

```bash
npm ci
npm test
```

This runs:

- Python unit and contract tests
- Node unit and integration tests
- JavaScript syntax checks
- generated web asset verification

## Platform tests

Platform-specific runbooks in this directory describe Windows, macOS, iOS, Android, browser, credential, and packaged-product checks. A runbook is not evidence that a gate was executed.

When reporting a result:

- record the exact tested commit and artifact hash
- distinguish source, unpacked app, installer, portable app, and signed release
- identify actual hardware and OS where relevant
- use `NOT_RUN` for unexecuted gates
- redact personal paths, credentials, device IDs, recordings, and internal hostnames
- keep large artifacts and raw private logs outside Git

Public release notes may include a concise sanitized verification summary and artifact hashes. Full private device evidence should remain in controlled storage.
