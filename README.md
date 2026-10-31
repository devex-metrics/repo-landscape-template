# Repository landscape team template

Create an independent **private** team repository from this public GitHub template to run [`@devex-metrics/repo-landscape`](https://github.com/devex-metrics/repo-landscape-cli). This template contains only synthetic examples and an inert workflow. Repository selections, credentials, snapshots, baselines, reports, and publication decisions belong exclusively to each team-created repository. Creating a repository from a template does **not** automatically update it when this template changes; the scanner and report behavior are versioned in the pinned npm package.

The engine produces a full landscape of repository size, languages, Git history, ADR and dependency evidence, and AI-guidance freshness; its report is a self-contained HTML dashboard.

The workflow pins the published `@devex-metrics/repo-landscape@0.1.2` package, released through npm trusted publishing (OIDC) with SLSA provenance. This release fixes clone-root ambiguity when an owner and repository have the same name, retaining the v1 JSON contract and compatibility with reviewed `0.1.0` initial baselines. Do not substitute an unpinned package or put an npm token in this template. Do not enable imports until your GitHub App has access to every selected repository.

## Set up a team repository

1. Use **Use this template** and select **Private** for the new repository. Check its actual visibility before editing configuration or running Actions. Keep it private; a public team repository is rejected before an App token is created. Require reviewed, signed changes on its default branch, especially for config and baseline changes.
2. Create/install a GitHub App on **only the repositories this team has approved**. Grant **Contents: read** (GitHub grants metadata read automatically), not write or organization-wide discovery rights. Store its App ID and PEM private key in this team's repository Actions secrets named `LANDSCAPE_APP_ID` and `LANDSCAPE_APP_PRIVATE_KEY`. Never put credentials in JSON, git remotes, a report, or an Actions log. The workflow further limits each short-lived installation token to the exact selected repositories and requests Contents: read.
3. Review and edit `landscape.config.json`: set `repositories` to explicit `owner/repo` names, all under one installation owner, and adjust `stale_after_days` if needed. The file starts with an **empty** selection. `config/landscape.example.json` is synthetic reference only, not an input. This template deliberately rejects discovery; review any candidates and put their exact names in `repositories` instead of scanning an organization by default.
4. After your App has access to every selected repository, set `"enabled": true` in `template.settings.json`, commit the changes with review, and run **Repository landscape → Run workflow → import** from the default branch. Imports clone complete Git histories of the selected repositories into ephemeral runner storage, then scan them at checked HEADs. One unreadable or changed repository fails the entire run; no partial initial baseline is accepted.
5. Download the **initial-baseline-candidate** artifact within 7 days. Review its selected repository names and results, place its `initial-baseline.json` at `state/initial-baseline.json` in the **private team repository**, and explicitly stage it with `git add -f state/initial-baseline.json`. Submit a reviewed, signed commit. The workflow does not commit generated data for you. `state/` is ignored to prevent accidental staging; only this reviewed file should be deliberately force-added. Protect the baseline from changes with branch rules and code review.
6. Run **Repository landscape → Run workflow → refresh** from the default branch only after the reviewed baseline commit is on that branch. Refresh reads that initial baseline, never writes over it, and uploads `landscape.json` and `landscape.html` in the **landscape-results** artifact with a 7-day retention period. To change the initial selection, start a separately reviewed baseline lifecycle in a new team repository; do not silently re-import over the original baseline.

The workflow does not commit generated snapshots, reports, caches, or cloned repositories. Results exist in the team's Actions artifacts for 7 days, so arrange team-controlled private retention if longer history is required. `landscape.json`, `landscape.html`, `state/`, and local caches are gitignored. The initial baseline is intentionally committed only by the team as described above.

## View and download results

Every successful **import** or **refresh** generates the self-contained HTML report and uploads **landscape-results**, even when Pages publication is disabled. To view it without deploying a site:

1. Open the private team repository's **Actions → Repository landscape**, then select the completed run.
2. In the run summary's **Artifacts** section, download **landscape-results** within 7 days and extract the ZIP.
3. Open the extracted `landscape.html` in your browser. No local server or engine installation is needed. Keep the extracted files in team-approved private storage; `landscape.json` is the machine-readable snapshot from the same run.

An **import** also uploads **initial-baseline-candidate** for the separate review and deliberate, signed baseline commit described above. Downloading or viewing a report does not adopt that baseline. The lifecycle remains **import → review and commit the initial baseline → refresh**.

With `"publish_pages": false`, the **publish** job is intentionally **skipped**; this does not prevent the **scan** job from generating and uploading results. If **landscape-results** is missing, check the scan job for failures in preflight, cloning, scanning, verification, report generation, or upload, and check whether the artifact has expired.

## Optional GitHub Pages publication

Pages is optional; use the downloaded HTML report if a hosted site is not approved. **A Pages site can be publicly accessible even when the source repository is private.** Reports can expose repository names, paths, dependency evidence, and other internal information. Review the actual Pages visibility and access controls available to your team repository and account plan, and approve the site's intended audience before opting in. Do not assume the repository's private visibility protects the site.

### Configure and opt in

There are two separate settings: the repository's Pages deployment source and this workflow's publication switch. Configuring one does not enable the other.

1. In the **private team repository**, configure **Settings → Pages → Build and deployment → Source → GitHub Actions**. If it is already configured this way, leave it in place; no separate Pages build workflow is needed.
2. After the privacy/access review, keep `"enabled": true` and change `"publish_pages": false` to `"publish_pages": true` in `template.settings.json`. Submit a reviewed, signed commit to the default branch. These are team-repository settings only; this public template keeps both values `false`.
3. Consider required reviewers and deployment restrictions under **Settings → Environments → github-pages**. Complete any required environment approval when deploying.
4. After the initial baseline has been reviewed and committed, run **Repository landscape → Run workflow → refresh** from the default branch.

The existing `.github/workflows/landscape.yml` runs **publish** only when **scan** succeeds, its preflight output `publish_pages` is `'true'`, and the selected mode is **refresh**. An **import never publishes**, even with Pages opted in. The publish job has Pages write and OIDC permissions, downloads **landscape-results**, and stages only `landscape.html` as the site's `index.html`; it does not publish the JSON snapshot or baseline.

### Find the site and troubleshoot publication

After a successful deployment, open the **github-pages** environment URL in the workflow run summary, or use the site link under **Settings → Pages**. The workflow sets the environment URL from the Pages deployment's `page_url` output; use that actual URL rather than guessing an address.

If **publish** is skipped, check these conditions in the selected run:

| Check | Expected for publication |
| --- | --- |
| Workflow mode | **refresh**, not **import** |
| Checked-out settings | `template.settings.json` on the run's default-branch commit has `"enabled": true` and `"publish_pages": true`; later or unmerged edits do not affect that run |
| Scan result | **scan** succeeded, including **Verify private team repository and approved selection**, which emits the publication setting |
| Baseline | The reviewed `state/initial-baseline.json` is committed on the default branch before refresh |

Setting the Pages source to **GitHub Actions** alone does not prevent a skipped publish job. If **publish** starts but waits for approval, inspect the **github-pages** environment's protection rules. If it fails, inspect its logs, confirm the repository remains private, and verify the Pages source and account support for Pages in that private repository. Results already uploaded by **scan** remain available even if publication fails.

To stop future deployments, commit `"publish_pages": false` in the private team repository. This skips publication on subsequent runs; it does **not** remove an already deployed site. Review or unpublish that site separately in **Settings → Pages** if access must be withdrawn.

## Maintain this template

The template is intentionally thin: `scripts/landscape.mjs` checks the selected config, refuses partial or inconsistent scans, and uses GitHub App credentials to verify the full-history clones. The engine provides the versioned scanner/report. Change the exact npm version only in a reviewed PR after validating its command and JSON contract; do not make team-specific edits to this public source. Run the local, package-independent checks with:

```sh
node --test
```

The workflow provides Node 22 and Python 3.11 and invokes the pinned engine with `scan --config ./landscape.config.json --output ./landscape.json --repos-dir "$RUNNER_TEMP/landscape-repos" --expected-heads "$RUNNER_TEMP/landscape-heads.json"` (and `--baseline ./state/initial-baseline.json` for refresh) and `report --input ./landscape.json --output ./landscape.html`. Full-history clones live under `$RUNNER_TEMP/landscape-repos/<owner>/<repo>` on the runner. The engine validates each clone's origin, history and recorded HEAD before analyzing it.
