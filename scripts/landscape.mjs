import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const baselinePath = 'state/initial-baseline.json';
const shaPattern = /^[0-9a-f]{40}$/;
const namePattern = /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\/([a-zA-Z0-9_.-]{1,100})$/;
const readinessCapabilities = [
  'ai_content_cues_v1', 'ai_commit_drift_v1', 'ai_kind_coverage_v1',
  'activity_windows_v1', 'attention_rules_v1', 'configured_team_aggregate_v1',
  'repository_references_v1',
];
const summaryCounts = [
  'history_known_count', 'commits_since_known_count',
  'commits_since_change_known_count', 'content_scored_count',
];
const summaryRanges = [
  'min_age_days', 'max_age_days', 'min_lag_days',
  'min_commits_since', 'max_commits_since',
];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isNullableCount = (value) => value === null || isCount(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

function requireMeasurement(condition, context) {
  if (!condition) fail(`Invalid readiness measurement: ${context}.`);
}

function requireFields(value, fields, context) {
  requireMeasurement(isObject(value) && fields.every((key) => Object.hasOwn(value, key)), context);
}

function validateReadiness(entry, capabilities) {
  const context = entry.full_name;
  const claimed = (capability) => capabilities.includes(capability);
  for (const file of entry.ai_files) {
    requireMeasurement(isObject(file), `${context} AI file`);
    if (claimed('ai_commit_drift_v1')) {
      requireFields(file, ['commits_since', 'commits_since_change'], `${context} commit drift`);
    }
    for (const key of ['commits_since', 'commits_since_change']) {
      if (Object.hasOwn(file, key)) requireMeasurement(isNullableCount(file[key]), `${context} ${key}`);
    }
    if (claimed('ai_content_cues_v1')) requireFields(file, ['content_signal'], `${context} content cues`);
    if (Object.hasOwn(file, 'content_signal_reason')) {
      requireMeasurement(isText(file.content_signal_reason), `${context} content cue reason`);
    }
    if (Object.hasOwn(file, 'content_signal')) {
      const signal = file.content_signal;
      if (signal === null) {
        requireMeasurement(isText(file.content_signal_reason), `${context} unknown content cue reason`);
      } else {
        const cues = ['scope', 'actions', 'verification', 'guardrails'];
        requireFields(signal, ['score', ...cues], `${context} content signal`);
        requireMeasurement(
          Object.keys(signal).length === 5 &&
          cues.every((cue) => typeof signal[cue] === 'boolean') &&
          signal.score === cues.filter((cue) => signal[cue]).length * 25,
          `${context} static content cue score`,
        );
      }
    }
  }
  const summary = entry.ai_summary;
  if (claimed('ai_kind_coverage_v1')) {
    requireFields(summary, [...summaryCounts, ...summaryRanges, 'max_lag_days', 'status', 'content_signal_mean', 'by_kind'], `${context} summary coverage`);
  }
  requireMeasurement(
    summary.count === entry.ai_files.length &&
    isCount(summary.stale_count) && summary.stale_count <= summary.count &&
    isCount(summary.unknown_count) && summary.unknown_count <= summary.count,
    `${context} summary counts`,
  );
  const measuredCounts = {
    history_known_count: entry.ai_files.filter((file) => file.status === 'known').length,
    commits_since_known_count: entry.ai_files.filter((file) => isCount(file.commits_since)).length,
    commits_since_change_known_count: entry.ai_files.filter((file) => isCount(file.commits_since_change)).length,
    content_scored_count: entry.ai_files.filter((file) => isObject(file.content_signal)).length,
  };
  for (const key of summaryCounts) {
    if (Object.hasOwn(summary, key)) {
      requireMeasurement(isCount(summary[key]) && summary[key] === measuredCounts[key], `${context} measured ${key}`);
    }
  }
  for (const key of [...summaryRanges, 'max_lag_days']) {
    if (Object.hasOwn(summary, key)) requireMeasurement(isNullableCount(summary[key]), `${context} ${key}`);
  }
  for (const [minimum, maximum] of [
    ['min_age_days', 'max_age_days'], ['min_lag_days', 'max_lag_days'],
    ['min_commits_since', 'max_commits_since'],
  ]) {
    if (Object.hasOwn(summary, minimum) && Object.hasOwn(summary, maximum)) {
      requireMeasurement(
        (summary[minimum] === null && summary[maximum] === null) ||
        (isCount(summary[minimum]) && isCount(summary[maximum]) && summary[minimum] <= summary[maximum]),
        `${context} ${minimum}/${maximum} range`,
      );
    }
    for (const [key, fileKey, measure] of [
      ['min_age_days', 'age_days', Math.min], ['max_age_days', 'age_days', Math.max],
      ['min_lag_days', 'lag_days', Math.min], ['max_lag_days', 'lag_days', Math.max],
      ['min_commits_since', 'commits_since', Math.min], ['max_commits_since', 'commits_since', Math.max],
    ]) {
      if (Object.hasOwn(summary, key)) {
        const values = entry.ai_files.map((file) => file[fileKey]).filter(isCount);
        requireMeasurement(
          summary[key] === (values.length ? values.reduce((value, next) => measure(value, next)) : null),
          `${context} measured ${key}`,
        );
      }
    }
  }
  if (Object.hasOwn(summary, 'content_signal_mean')) {
    const mean = summary.content_signal_mean;
    requireMeasurement(
      mean === null || (typeof mean === 'number' && Number.isFinite(mean) && mean >= 0 && mean <= 100),
      `${context} content signal mean`,
    );
    if (Object.hasOwn(summary, 'content_scored_count')) {
      requireMeasurement(
        (summary.count > 0 && summary.content_scored_count === summary.count) === (mean !== null),
        `${context} content signal mean coverage`,
      );
    }
    if (mean !== null) {
      requireMeasurement(
        entry.ai_files.length > 0 && entry.ai_files.every((file) => isObject(file.content_signal)) &&
        mean === entry.ai_files.reduce((total, file) => total + file.content_signal.score, 0) / entry.ai_files.length,
        `${context} measured content signal mean`,
      );
    }
  }
  if (Object.hasOwn(summary, 'by_kind')) {
    requireMeasurement(Array.isArray(summary.by_kind), `${context} by_kind`);
    const kinds = new Set();
    for (const kind of summary.by_kind) {
      requireFields(kind, ['kind', 'count', 'known_count', 'stale_count', 'unknown_count'], `${context} kind coverage`);
      requireMeasurement(
        isText(kind.kind) && !kinds.has(kind.kind) &&
        ['count', 'known_count', 'stale_count', 'unknown_count'].every((key) => isCount(kind[key])) &&
        kind.count <= summary.count && kind.known_count + kind.unknown_count === kind.count &&
        kind.stale_count <= kind.known_count,
        `${context} kind counts`,
      );
      const files = entry.ai_files.filter((file) => file.kind === kind.kind);
      requireMeasurement(
        kind.count === files.length &&
        kind.known_count === files.filter((file) => file.status === 'known').length &&
        kind.unknown_count === files.filter((file) => file.status === 'unknown').length &&
        kind.stale_count === files.filter((file) => file.stale === true).length,
        `${context} measured kind coverage`,
      );
      kinds.add(kind.kind);
    }
    requireMeasurement(
      summary.by_kind.reduce((total, kind) => total + kind.count, 0) === summary.count,
      `${context} kind total`,
    );
  }
  if (claimed('activity_windows_v1')) requireFields(entry, ['activity'], `${context} activity capability`);
  if (Object.hasOwn(entry, 'activity')) {
    const activity = entry.activity;
    requireFields(activity, ['complete', 'commits_30d', 'commits_90d'], `${context} activity`);
    requireMeasurement(
      typeof activity.complete === 'boolean' &&
      (activity.complete
        ? isCount(activity.commits_30d) && isCount(activity.commits_90d) && activity.commits_30d <= activity.commits_90d
        : activity.commits_30d === null && activity.commits_90d === null && isText(activity.unknown_reason)),
      `${context} activity completeness`,
    );
  }
  if (claimed('configured_team_aggregate_v1')) requireFields(entry, ['team_activity'], `${context} team capability`);
  if (Object.hasOwn(entry, 'team_activity')) {
    const team = entry.team_activity;
    requireFields(team, ['available', 'complete', 'matching', 'commit_count', 'commits_30d', 'commits_90d'], `${context} team activity`);
    requireMeasurement(
      typeof team.available === 'boolean' &&
      (team.available
        ? team.complete === true && team.matching === 'exact_author_email' &&
          [team.commit_count, team.commits_30d, team.commits_90d].every(isCount) &&
          team.commits_30d <= team.commits_90d && team.commits_90d <= team.commit_count &&
          team.commit_count <= entry.git.commit_count &&
          (!entry.activity?.complete ||
            (team.commits_30d <= entry.activity.commits_30d && team.commits_90d <= entry.activity.commits_90d))
        : team.complete === false && team.matching === 'unavailable' &&
          team.commit_count === null && team.commits_30d === null && team.commits_90d === null &&
          isText(team.unknown_reason)),
      `${context} team activity completeness`,
    );
  }
  if (claimed('attention_rules_v1')) requireFields(entry, ['attention'], `${context} attention capability`);
  if (Object.hasOwn(entry, 'attention')) {
    const attention = entry.attention;
    requireFields(attention, ['activity', 'priority', 'reasons'], `${context} attention`);
    requireMeasurement(
      ['activity', 'priority'].every((key) => ['high', 'medium', 'low', 'unknown'].includes(attention[key])) &&
      Array.isArray(attention.reasons) && attention.reasons.every(isText),
      `${context} attention reasons`,
    );
  }
}

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read valid JSON from ${path}: ${error.message}`, { cause: error });
  }
}

export function validateConfig(config) {
  if (!config || config.schema_version !== 1 || !Array.isArray(config.repositories)) {
    fail('landscape.config.json needs schema_version: 1 and a repositories array.');
  }
  if (!Number.isInteger(config.stale_after_days) || config.stale_after_days < 1) {
    fail('landscape.config.json needs a positive integer stale_after_days.');
  }
  if (config.discovery !== undefined) {
    fail('This template accepts only an explicit reviewed repositories list; move any discovery selections into repositories.');
  }
  if (config.repositories.length > 500) {
    fail('A GitHub App installation token can select at most 500 repositories.');
  }
  const names = new Set();
  let owner;
  for (const fullName of config.repositories) {
    const match = typeof fullName === 'string' && namePattern.exec(fullName);
    if (!match || match[2] === '.' || match[2] === '..') {
      fail(`Invalid repository name ${JSON.stringify(fullName)}; use explicit owner/repo entries.`);
    }
    if (owner && owner.toLowerCase() !== match[1].toLowerCase()) {
      fail('All selected repositories must belong to one GitHub App installation owner.');
    }
    owner = match[1];
    const name = fullName.toLowerCase();
    if (names.has(name)) fail(`Duplicate selected repository: ${fullName}`);
    names.add(name);
  }
  return { owner, repositories: config.repositories };
}

export function validateSettings(settings) {
  if (typeof settings?.enabled !== 'boolean' || typeof settings.publish_pages !== 'boolean') {
    fail('template.settings.json needs boolean enabled and publish_pages values.');
  }
  return settings;
}

export function actionOutputs(selection, settings) {
  return `owner=${selection.owner}\nrepositories=${selection.repositories.map((name) => name.split('/')[1]).join(',')}\npublish_pages=${settings.publish_pages}\n`;
}

export function cloneDestination(runnerTemp, fullName) {
  return join(runnerTemp, 'landscape-repos', fullName);
}

export function validateSnapshot(snapshot, selected, expectedHeads) {
  if (snapshot?.schema_version !== 1 || !Array.isArray(snapshot.repositories) || !Array.isArray(snapshot.edges)) {
    fail('Scanner output must be a full v1 landscape with repositories and graph edges.');
  }
  if (
    typeof snapshot.generated_at !== 'string' ||
    !Number.isFinite(Date.parse(snapshot.generated_at)) ||
    typeof snapshot.scanner_version !== 'string' ||
    !snapshot.scanner_version ||
    !snapshot.provenance ||
    !isObject(snapshot.provenance)
  ) {
    fail('Scanner output is missing v1 generation or provenance metadata.');
  }
  const expected = new Set(selected.map((name) => name.toLowerCase()));
  const selectedNames = snapshot.selection?.selected_repositories;
  if (
    snapshot.selection?.mode !== 'explicit' ||
    !Array.isArray(selectedNames) ||
    selectedNames.some((name) => typeof name !== 'string') ||
    selectedNames.length !== expected.size ||
    new Set(selectedNames.map((name) => name.toLowerCase())).size !== expected.size ||
    selectedNames.some((name) => !expected.has(name.toLowerCase()))
  ) {
    fail('Scanner selection does not match the approved explicit repository list.');
  }
  const capabilities = snapshot.provenance.capabilities ?? [];
  requireMeasurement(
    Array.isArray(capabilities) && capabilities.every((capability) => readinessCapabilities.includes(capability)) &&
    new Set(capabilities).size === capabilities.length &&
    (!Object.hasOwn(snapshot.provenance, 'capabilities') || snapshot.provenance.capabilities !== null),
    'provenance capabilities',
  );
  if (Object.hasOwn(snapshot, 'capability_warnings')) {
    requireMeasurement(
      Array.isArray(snapshot.capability_warnings) && snapshot.capability_warnings.every(isText),
      'capability warnings',
    );
  }
  const observed = new Set();
  for (const entry of snapshot.repositories) {
    const name = entry?.full_name;
    if (typeof name !== 'string' || !expected.has(name.toLowerCase()) || observed.has(name.toLowerCase())) {
      fail(`Scanner output contains an extra or duplicate repository: ${JSON.stringify(name)}`);
    }
    if (typeof entry.head_sha !== 'string' || !shaPattern.test(entry.head_sha)) {
      fail(`Scanner output has no valid HEAD SHA for ${name}.`);
    }
    if (
      !Array.isArray(entry.ai_files) ||
      !entry.ai_summary ||
      !Number.isInteger(entry.ai_summary.count) ||
      entry.ai_summary.count < 0 ||
      !Number.isInteger(entry.ai_summary.stale_count) ||
      !Number.isInteger(entry.ai_summary.unknown_count)
    ) {
      fail(`Scanner output has incomplete v1 results for ${name}.`);
    }
    if (
      !Number.isInteger(entry.metrics?.files) ||
      entry.metrics.files < 0 ||
      !Array.isArray(entry.languages) ||
      !Number.isInteger(entry.git?.commit_count) ||
      !Number.isInteger(entry.architecture?.adr_count) ||
      !Array.isArray(entry.manifests) ||
      !Array.isArray(entry.produces) ||
      !Array.isArray(entry.consumes)
    ) {
      fail(`Scanner output has incomplete full-history landscape results for ${name}.`);
    }
    const clonedHead = expectedHeads?.get(name.toLowerCase());
    if (expectedHeads && clonedHead?.toLowerCase() !== entry.head_sha.toLowerCase()) {
      fail(`HEAD changed or differs from full-history clone for ${name}; retry the run.`);
    }
    validateReadiness(entry, capabilities);
    observed.add(name.toLowerCase());
  }
  if (observed.size !== expected.size) {
    fail(`Scanner output resolved ${observed.size} of ${expected.size} selected repositories; baseline not created.`);
  }
  if (capabilities.includes('repository_references_v1')) {
    requireFields(snapshot, ['references'], 'repository references capability');
  }
  if (Object.hasOwn(snapshot, 'references')) {
    requireMeasurement(Array.isArray(snapshot.references), 'repository references');
    const repos = new Map(snapshot.repositories.map((repo) => [repo.full_name.toLowerCase(), repo]));
    for (const reference of snapshot.references) {
      requireFields(reference, ['source', 'target', 'kind', 'confidence', 'evidence'], 'repository reference');
      const source = typeof reference.source === 'string' && repos.get(reference.source.toLowerCase());
      const target = typeof reference.target === 'string' && repos.get(reference.target.toLowerCase());
      requireFields(reference.evidence, ['path', 'line', 'head_sha'], 'repository reference evidence');
      requireMeasurement(
        source && target && source !== target &&
        reference.kind === 'repository reference' && reference.confidence === 'low' &&
        isText(reference.evidence.path) && isCount(reference.evidence.line) && reference.evidence.line > 0 &&
        reference.evidence.head_sha === source.head_sha,
        'selected repository reference and pinned HEAD',
      );
    }
  }
  if (Object.hasOwn(snapshot, 'comparison')) {
    requireFields(snapshot.comparison, ['repositories'], 'comparison repositories');
    requireMeasurement(Array.isArray(snapshot.comparison.repositories), 'comparison repositories');
  }
  for (const comparison of snapshot.comparison?.repositories ?? []) {
    requireMeasurement(isObject(comparison), 'comparison repository');
    if (Object.hasOwn(comparison, 'file_deltas')) {
      requireMeasurement(Array.isArray(comparison.file_deltas), 'comparison file deltas');
      for (const delta of comparison.file_deltas) {
        const fields = ['age_days', 'lag_days', 'commits_since', 'commits_since_change', 'content_score'];
        requireFields(delta, ['path', ...fields], 'comparison file delta');
        requireMeasurement(
          isText(delta.path) && fields.every((key) => delta[key] === null || Number.isSafeInteger(delta[key])),
          'comparison nullable signed file deltas',
        );
      }
    }
  }
  return snapshot;
}

export function validateFreshSnapshot(snapshot, selected, expectedHeads, expectedVersion) {
  if (!(expectedHeads instanceof Map)) fail('Fresh scanner output requires the full-history clone HEAD manifest.');
  validateSnapshot(snapshot, selected, expectedHeads);
  if (!isText(expectedVersion) || snapshot.scanner_version !== expectedVersion) {
    fail('Fresh scanner output version does not match the installed exact engine release.');
  }
  const provenance = snapshot.provenance;
  if (
    provenance.source !== 'local_git' || provenance.snapshot !== 'pinned_head' ||
    provenance.analysis !== 'full' || !isCount(provenance.stale_after_days) || provenance.stale_after_days < 1
  ) {
    fail('Fresh scanner output must have full local_git pinned_head provenance.');
  }
  if (expectedVersion === '0.2.0') {
    requireMeasurement(
      readinessCapabilities.every((capability) => provenance.capabilities?.includes(capability)) &&
      Array.isArray(snapshot.capability_warnings),
      '0.2.0 full-analysis capabilities and warnings',
    );
  }
  return snapshot;
}

function loadSelection(baseDir = root) {
  const settings = validateSettings(readJson(join(baseDir, 'template.settings.json')));
  const selection = validateConfig(readJson(join(baseDir, 'landscape.config.json')));
  if (!settings.enabled || !selection.repositories.length) {
    fail('Template is inactive. In your PRIVATE team repo, list reviewed owner/repo entries in landscape.config.json and set enabled: true in template.settings.json.');
  }
  return { settings, selection };
}

export function preflight(mode, outputPath, baseDir = root) {
  if (!['import', 'refresh'].includes(mode)) fail('Choose workflow mode import or refresh.');
  const { settings, selection } = loadSelection(baseDir);
  const baseline = join(baseDir, baselinePath);
  if (mode === 'import' && existsSync(baseline)) {
    fail('Initial baseline already exists. Use refresh; the baseline must never be overwritten.');
  }
  if (mode === 'refresh') {
    if (!existsSync(baseline)) {
      fail('No initial baseline yet. Run import, review its artifact, then explicitly commit state/initial-baseline.json to your PRIVATE team repo.');
    }
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', baselinePath], {
      cwd: baseDir, stdio: 'ignore',
    });
    if (tracked.error || tracked.status !== 0) {
      fail('Initial baseline must be explicitly committed in this team repository before refresh.');
    }
    validateSnapshot(readJson(baseline), selection.repositories);
  }
  appendFileSync(outputPath, actionOutputs(selection, settings));
}

function runGit(args, options) {
  const result = spawnSync('git', args, options);
  if (result.error || result.status !== 0) {
    fail(`Git ${args[0]} failed; check App installation access and full-history availability.`);
  }
  return result.stdout?.trim();
}

function cloneSelected(manifestPath) {
  if (!process.env.LANDSCAPE_APP_TOKEN || !process.env.RUNNER_TEMP) {
    fail('Cloning requires LANDSCAPE_APP_TOKEN and RUNNER_TEMP from the workflow.');
  }
  const { selection } = loadSelection();
  const entries = [];
  const askpass = join(root, 'scripts/git-askpass.sh');
  for (const fullName of selection.repositories) {
    const target = cloneDestination(process.env.RUNNER_TEMP, fullName);
    mkdirSync(dirname(target), { recursive: true });
    runGit(['clone', '--quiet', '--no-single-branch', '--', `https://github.com/${fullName}.git`, target], {
      cwd: root,
      env: {
        ...process.env,
        GIT_ASKPASS: askpass,
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: 'inherit',
    });
    const head = runGit(['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (!shaPattern.test(head)) fail(`No valid cloned HEAD for ${fullName}.`);
    entries.push({ full_name: fullName, head_sha: head });
  }
  writeFileSync(manifestPath, `${JSON.stringify(Object.fromEntries(entries.map((entry) => [entry.full_name, entry.head_sha])), null, 2)}\n`, { flag: 'wx' });
}

function verifySnapshot(snapshotPath, manifestPath, packagePath) {
  const { selection } = loadSelection();
  const manifest = readJson(manifestPath);
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object' || Object.keys(manifest).length !== selection.repositories.length) {
    fail('Clone manifest does not match the selected repositories.');
  }
  const heads = new Map(Object.entries(manifest).map(([name, sha]) => [name.toLowerCase(), sha]));
  if (heads.size !== selection.repositories.length || selection.repositories.some((name) => !shaPattern.test(heads.get(name.toLowerCase()) ?? ''))) {
    fail('Clone manifest contains missing or duplicate repositories.');
  }
  const engine = readJson(packagePath);
  if (engine?.name !== '@devex-metrics/repo-landscape') fail('Expected the installed repo-landscape package manifest.');
  validateFreshSnapshot(readJson(snapshotPath), selection.repositories, heads, engine.version);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'preflight' && args.length === 2) preflight(args[0], args[1]);
  else if (command === 'clone' && args.length === 1) cloneSelected(resolve(args[0]));
  else if (command === 'verify' && args.length === 3) verifySnapshot(resolve(args[0]), resolve(args[1]), resolve(args[2]));
  else fail('Usage: node scripts/landscape.mjs preflight <import|refresh> <github-output> | clone <manifest> | verify <snapshot> <manifest> <installed-package-json>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
