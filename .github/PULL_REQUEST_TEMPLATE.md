## Review checklist

- [ ] This public template change contains no real team names, repository selections, snapshots, baselines, credentials, or private paths. For a team deployment, confirm the destination repository is private.
- [ ] Repository selection changes list only explicitly approved `owner/repo` names, and the GitHub App has read-only access to only those repositories.
- [ ] Any first-time initial baseline was generated after every selected repository resolved, reviewed in the private team repo, and intentionally staged there. Existing initial baselines are not overwritten.
- [ ] Generated snapshots, reports, caches, and secrets are not committed or exposed in logs.
- [ ] Any Pages opt-in has an explicit privacy/access review; a private source repository does not guarantee a private site.
- [ ] Engine package version and invocation are pinned and compatible; `node --test` passes.
