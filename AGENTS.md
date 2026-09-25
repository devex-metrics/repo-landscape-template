# Repository landscape team template

This public repository is a generic template for **private**, independently operated team repositories. Never add real organization names, repository selections, credentials, snapshots, baselines, generated reports, or customer data to this template.

- The versioned engine lives in `@devex-metrics/repo-landscape`; do not duplicate its scanner or report implementation here.
- `landscape.config.json` is the engine's v1 configuration. Keep its template default empty; teams populate it only in their private copies. `template.settings.json` keeps this template inert and Pages disabled by default.
- `.github/workflows/landscape.yml` obtains a short-lived GitHub App token limited to the explicitly selected repositories, clones their complete Git histories as a preflight check, then calls the pinned engine version. Keep the private-repository and output/HEAD checks intact.
- The initial baseline is team-owned, reviewed and explicitly committed to `state/initial-baseline.json` only after a successful import; workflows never commit generated data or replace that baseline. Generated files and `state/` are ignored by default.
- Keep the npm version exact, update it deliberately when the engine contract changes, and run `node --test` before changes to the workflow or validation script.
