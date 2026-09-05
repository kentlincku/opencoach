## Summary

Describe the problem and the change.

- **Affected platforms:** Web / Desktop / Windows / macOS / iOS / Android
- **Related issue:**
- **Security or privacy boundary changed:** yes / no
- **Public contract or persisted data changed:** yes / no

## Verification

### Commands actually run

```text
<exact command, exit status, and test count>
```

### Platform or device verification

```text
<OS, architecture, artifact hash, and result; or NOT_RUN>
```

### Known failures and untested boundaries

- None recorded.

## Checklist

- [ ] Rebased or merged the current `main` without rewriting shared history
- [ ] Added or updated tests for behavior and trust-boundary changes
- [ ] Ran `npm test`
- [ ] Updated public documentation where behavior changed
- [ ] Preserved upstream copyright and license notices
- [ ] Added no credentials, recordings, personal paths, device identifiers, model weights, generated runtimes, installers, or private logs
- [ ] Marked signing, notarization, hardware, model, and release gates `NOT_RUN` unless actually exercised
