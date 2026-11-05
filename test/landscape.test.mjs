import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  actionOutputs,
  cloneDestination,
  preflight,
  validateConfig,
  validateFreshSnapshot,
  validateSettings,
  validateSnapshot,
} from '../scripts/landscape.mjs';

const config = JSON.parse(readFileSync(new URL('../landscape.config.json', import.meta.url)));
const settings = JSON.parse(readFileSync(new URL('../template.settings.json', import.meta.url)));
const example = JSON.parse(readFileSync(new URL('../config/landscape.example.json', import.meta.url)));

function snapshot(repositories) {
  return {
    schema_version: 1,
    generated_at: '2026-01-01T00:00:00Z',
    scanner_version: '0.1.0',
    provenance: { mode: 'local_clones' },
    selection: {
      mode: 'explicit',
      selected_repositories: [...repositories],
    },
    edges: [],
    repositories: repositories.map((fullName, index) => ({
      full_name: fullName,
      head_sha: String(index + 1).repeat(40),
      ai_files: [],
      ai_summary: { count: 0, stale_count: 0, unknown_count: 0 },
      metrics: { files: 0 },
      languages: [],
      git: { commit_count: 1 },
      architecture: { adr_count: 0 },
      manifests: [],
      produces: [],
      consumes: [],
    })),
  };
}

function readinessSnapshot() {
  const result = snapshot(['example-org/example-api', 'example-org/example-web']);
  result.scanner_version = '0.2.0';
  result.provenance = {
    source: 'local_git', snapshot: 'pinned_head', analysis: 'full', stale_after_days: 90,
    capabilities: [
      'ai_content_cues_v1', 'ai_commit_drift_v1', 'ai_kind_coverage_v1',
      'activity_windows_v1', 'attention_rules_v1', 'configured_team_aggregate_v1',
      'repository_references_v1',
    ],
  };
  result.capability_warnings = ['Static cues are not a quality score; null is not zero.'];
  for (const repo of result.repositories) {
    repo.ai_files = [{
      path: 'AGENTS.md', kind: 'agents', sha256: 'a'.repeat(64),
      last_changed: result.generated_at, age_days: 0, lag_days: 0, stale: false, status: 'known',
      evidence: { source: 'local_git', head_sha: repo.head_sha, blob_sha: 'a'.repeat(40) },
      commits_since: 0, commits_since_change: 1,
      content_signal: { score: 75, scope: true, actions: true, verification: true, guardrails: false },
    }];
    repo.ai_summary = {
      count: 1, stale_count: 0, unknown_count: 0, max_lag_days: 0, status: 'known',
      min_age_days: 0, max_age_days: 0, min_lag_days: 0,
      min_commits_since: 0, max_commits_since: 0,
      history_known_count: 1, commits_since_known_count: 1, commits_since_change_known_count: 1,
      content_scored_count: 1, content_signal_mean: 75,
      by_kind: [{ kind: 'agents', count: 1, known_count: 1, stale_count: 0, unknown_count: 0 }],
    };
    repo.activity = { complete: true, commits_30d: 1, commits_90d: 1 };
    repo.team_activity = {
      available: false, complete: false, matching: 'unavailable',
      commit_count: null, commits_30d: null, commits_90d: null,
      unknown_reason: 'No explicit team author emails configured',
    };
    repo.attention = { activity: 'low', priority: 'low', reasons: [] };
  }
  result.references = [{
    source: result.repositories[0].full_name, target: result.repositories[1].full_name,
    kind: 'repository reference', confidence: 'low',
    evidence: { path: 'README.md', line: 1, head_sha: result.repositories[0].head_sha },
  }];
  return result;
}

function validateFixture(result, fresh = false) {
  const selected = result.selection.selected_repositories;
  const heads = new Map(result.repositories.map((repo) => [repo.full_name, repo.head_sha]));
  return fresh
    ? validateFreshSnapshot(result, selected, heads, result.scanner_version)
    : validateSnapshot(result, selected, heads);
}

test('the public template is inert and its example is synthetic', () => {
  assert.deepEqual(config.repositories, []);
  assert.deepEqual(validateConfig(config).repositories, []);
  assert.deepEqual(validateSettings(settings), { enabled: false, publish_pages: false });
  assert.deepEqual(validateConfig(example).repositories, [
    'example-org/example-api',
    'example-org/example-web',
  ]);
});

test('a workflow preflight of the unmodified template fails with setup instructions', () => {
  const output = join(tmpdir(), `landscape-inert-${process.pid}.txt`);
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('../scripts/landscape.mjs', import.meta.url)),
    'preflight', 'import', output,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Template is inactive.*PRIVATE team repo/);
});

test('private-team preflight gates import, refresh, and baseline replacement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'landscape-template-test-'));
  try {
    writeFileSync(join(dir, 'landscape.config.json'), JSON.stringify(example));
    writeFileSync(join(dir, 'template.settings.json'), JSON.stringify({ enabled: true, publish_pages: false }));
    const output = join(dir, 'github-output');
    preflight('import', output, dir);
    assert.equal(readFileSync(output, 'utf8'), 'owner=example-org\nrepositories=example-api,example-web\npublish_pages=false\n');
    assert.throws(() => preflight('refresh', output, dir), /No initial baseline/);
    mkdirSync(join(dir, 'state'));
    writeFileSync(join(dir, 'state/initial-baseline.json'), JSON.stringify(snapshot(example.repositories)));
    assert.throws(() => preflight('import', output, dir), /must never be overwritten/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selection requires an exact, unique list under a single installation owner', () => {
  for (const repositories of [
    ['example-org/example-api', 'other-org/example-web'],
    ['example-org/example-api', 'EXAMPLE-ORG/EXAMPLE-API'],
    ['example-org/example-api', 'example-org/../other'],
    ['example-org/example-api', 'example-org/a\ninjection'],
    ['example-org/example-api', 'example-org/a,b'],
  ]) {
    assert.throws(() => validateConfig({ ...example, repositories }));
  }
  assert.throws(() => validateConfig({ ...example, discovery: [{ organization: 'example-org' }] }));
  assert.throws(() => validateConfig({ ...example, stale_after_days: 0 }));
  assert.throws(() => validateConfig({ ...example, schema_version: 2 }));
});

test('App token scope and clone paths derive only from the reviewed selection', () => {
  const selection = validateConfig(example);
  assert.equal(actionOutputs(selection, settings), 'owner=example-org\nrepositories=example-api,example-web\npublish_pages=false\n');
  assert.equal(cloneDestination('/tmp/runner', selection.repositories[0]), join('/tmp/runner', 'landscape-repos', 'example-org/example-api'));
  assert.equal(cloneDestination('/tmp/runner', 'example-org/example-org'), join('/tmp/runner', 'landscape-repos', 'example-org', 'example-org'));
  assert.throws(() => validateConfig({ ...example, repositories: [
    'first-org/same-name', 'second-org/same-name',
  ] }), /one GitHub App installation owner/);
});

test('initial baselines require all selected repositories and complete v1 output', () => {
  const selected = ['example-org/example-api', 'example-org/example-web'];
  assert.equal(validateSnapshot(snapshot(selected), selected).repositories.length, 2);
  const partial = snapshot(selected);
  partial.repositories.pop();
  assert.throws(() => validateSnapshot(partial, selected), /resolved 1 of 2/);
  const extra = snapshot(selected);
  extra.repositories.push(snapshot(['example-org/unreviewed']).repositories[0]);
  assert.throws(() => validateSnapshot(extra, selected), /extra or duplicate/);
  const duplicate = snapshot(selected);
  duplicate.repositories[1].full_name = selected[0];
  assert.throws(() => validateSnapshot(duplicate, selected), /extra or duplicate/);
  const incomplete = snapshot(selected);
  delete incomplete.repositories[1].ai_summary;
  assert.throws(() => validateSnapshot(incomplete, selected), /incomplete v1/);
  const incorrectSelection = snapshot(selected);
  incorrectSelection.selection.selected_repositories[1] = 'example-org/unreviewed';
  assert.throws(() => validateSnapshot(incorrectSelection, selected), /selection does not match/);
  const noProvenance = snapshot(selected);
  delete noProvenance.provenance;
  assert.throws(() => validateSnapshot(noProvenance, selected), /provenance metadata/);
  const aiOnly = snapshot(selected);
  delete aiOnly.repositories[0].metrics;
  assert.throws(() => validateSnapshot(aiOnly, selected), /full-history landscape/);
  const noGraph = snapshot(selected);
  delete noGraph.edges;
  assert.throws(() => validateSnapshot(noGraph, selected), /full v1 landscape/);
});

test('v1 snapshots from current and historical scanner releases remain valid baselines', () => {
  const selected = ['example-org/example-org'];
  for (const version of ['0.1.0', '0.1.2']) {
    const baseline = snapshot(selected);
    baseline.scanner_version = version;
    baseline.repositories[0].ai_files = [{
      path: 'AGENTS.md', kind: 'agents', sha256: 'a'.repeat(64),
      last_changed: '2025-12-31T00:00:00Z', age_days: 1, lag_days: 0, stale: false, status: 'known',
      evidence: {
        source: 'local_git', head_sha: baseline.repositories[0].head_sha,
        blob_sha: 'a'.repeat(40), last_commit_sha: 'b'.repeat(40),
      },
    }];
    baseline.repositories[0].ai_summary = {
      count: 1, stale_count: 0, max_lag_days: 0, unknown_count: 0, status: 'known',
    };
    const original = JSON.stringify(baseline);
    assert.equal(validateSnapshot(baseline, selected), baseline);
    assert.equal(JSON.stringify(baseline), original);
    assert.equal(Object.hasOwn(baseline.repositories[0].ai_summary, 'content_signal_mean'), false);
    assert.equal(Object.hasOwn(baseline.repositories[0].ai_files[0], 'commits_since_change'), false);
  }
});

test('empty richer readiness has null ranges and mean rather than fabricated zeros', () => {
  const result = readinessSnapshot();
  for (const repo of result.repositories) {
    repo.ai_files = [];
    Object.assign(repo.ai_summary, {
      count: 0, max_lag_days: null, min_age_days: null, max_age_days: null,
      min_lag_days: null, min_commits_since: null, max_commits_since: null,
      history_known_count: 0, commits_since_known_count: 0, commits_since_change_known_count: 0,
      content_scored_count: 0, content_signal_mean: null, by_kind: [],
    });
  }
  assert.equal(validateFixture(result, true), result);
  result.repositories[0].ai_summary.max_lag_days = 0;
  assert.throws(() => validateFixture(result), /measured max_lag_days/);
});

test('fresh output matches the installed engine and full local provenance, unlike historical baselines', () => {
  const result = readinessSnapshot();
  assert.equal(validateFixture(result, true), result);
  const selected = result.selection.selected_repositories;
  const heads = new Map(result.repositories.map((repo) => [repo.full_name, repo.head_sha]));
  assert.throws(() => validateFreshSnapshot(result, selected, heads, '0.1.2'), /version does not match/);
  assert.throws(() => validateFreshSnapshot(result, selected, undefined, '0.2.0'), /clone HEAD/);
  for (const [key, value] of [['source', 'github_api'], ['snapshot', 'latest'], ['analysis', 'ai_only'], ['stale_after_days', 0]]) {
    const invalid = structuredClone(result);
    invalid.provenance[key] = value;
    assert.throws(() => validateFreshSnapshot(invalid, selected, heads, '0.2.0'), /full local_git/);
  }
  const old = snapshot(selected);
  old.scanner_version = '0.1.2';
  old.provenance = { source: 'local_git', snapshot: 'pinned_head', analysis: 'full', stale_after_days: 90 };
  assert.equal(validateFreshSnapshot(old, selected, heads, '0.1.2'), old);
  delete result.provenance.capabilities;
  assert.equal(validateFixture(result), result);
  assert.throws(() => validateFixture(result, true), /0.2.0 full-analysis capabilities/);
});

test('richer v1 output keeps graph distance, inclusive timestamp counts and references distinct', () => {
  const result = readinessSnapshot();
  assert.equal(validateFixture(result), result);
  assert.equal(result.repositories[0].ai_files[0].commits_since, 0);
  assert.equal(result.repositories[0].ai_files[0].commits_since_change, 1);
  assert.deepEqual(result.edges, []);
  assert.equal(result.references[0].confidence, 'low');
});

test('unknown content, activity and team evidence remains null with explicit reasons', () => {
  const result = readinessSnapshot();
  const repo = result.repositories[0];
  repo.ai_files[0].content_signal = null;
  repo.ai_files[0].content_signal_reason = 'Scoring budget exceeded';
  repo.ai_files[0].commits_since = null;
  repo.ai_files[0].commits_since_change = null;
  Object.assign(repo.ai_summary, {
    content_scored_count: 0, content_signal_mean: null,
    commits_since_known_count: 0, commits_since_change_known_count: 0,
    min_commits_since: null, max_commits_since: null,
  });
  repo.activity = { complete: false, commits_30d: null, commits_90d: null, unknown_reason: 'Budget exceeded' };
  repo.attention = { activity: 'unknown', priority: 'medium', reasons: ['Readiness evidence is incomplete'] };
  const original = JSON.stringify(result);
  assert.equal(validateFixture(result, true), result);
  assert.equal(JSON.stringify(result), original);
  repo.ai_summary.content_signal_mean = 0;
  assert.throws(() => validateFixture(result), /mean coverage/);
});

test('known optional measurements are checked even without capability declarations', () => {
  const mutations = [
    (s, r, f) => { f.commits_since = -1; },
    (s, r, f) => { f.commits_since_change = 1.5; },
    (s, r, f) => { f.content_signal.score = 100; },
    (s, r, f) => { f.content_signal.scope = 1; },
    (s, r, f) => { f.content_signal = null; },
    (s, r, f) => { f.content_signal_reason = 1; },
    (s, r) => { r.ai_summary.history_known_count = 2; },
    (s, r) => { r.ai_summary.min_age_days = 4; },
    (s, r) => { r.ai_summary.min_commits_since = null; },
    (s, r) => { r.ai_summary.content_signal_mean = 101; },
    (s, r) => { r.ai_summary.content_signal_mean = 50; },
    (s, r) => { r.ai_summary.commits_since_known_count = 0; },
    (s, r) => { r.ai_summary.content_scored_count = 0; },
    (s, r) => { r.ai_summary.by_kind[0].known_count = 0; },
    (s, r) => { r.ai_summary.by_kind.push({ ...r.ai_summary.by_kind[0] }); },
    (s, r) => { r.ai_summary.by_kind = []; },
    (s, r) => { r.activity.commits_30d = 2; },
    (s, r) => { r.activity.complete = false; },
    (s, r) => { r.activity = null; },
    (s, r) => { r.team_activity.commit_count = 0; },
    (s, r) => { r.team_activity.available = true; },
    (s, r) => { r.team_activity.unknown_reason = ''; },
    (s, r) => { r.attention.priority = 'urgent'; },
    (s, r) => { r.attention.reasons = [null]; },
    (s) => { s.capability_warnings = 'warning'; },
    (s) => { s.references[0].target = 'example-org/unselected'; },
    (s) => { s.references[0].target = s.references[0].source; },
    (s) => { s.references[0].confidence = 'high'; },
    (s) => { s.references[0].kind = 'artifact dependency'; },
    (s) => { s.references[0].evidence.head_sha = 'f'.repeat(40); },
    (s) => { s.references[0].evidence.line = 0; },
    (s) => { s.references = null; },
  ];
  for (const mutate of mutations) {
    const result = readinessSnapshot();
    delete result.provenance.capabilities;
    mutate(result, result.repositories[0], result.repositories[0].ai_files[0]);
    assert.throws(() => validateFixture(result), /Invalid readiness measurement/, mutate.toString());
  }
});

test('comparison file deltas preserve unknowns and allow decreases, not malformed measurements', () => {
  const result = readinessSnapshot();
  const delta = {
    path: 'AGENTS.md', age_days: -1, lag_days: -2, commits_since: -3,
    commits_since_change: null, content_score: 25,
  };
  result.comparison = { repositories: [{ file_deltas: [delta] }] };
  assert.equal(validateFixture(result), result);
  delta.commits_since_change = 'unknown';
  assert.throws(() => validateFixture(result), /nullable signed file deltas/);
  delete delta.commits_since_change;
  assert.throws(() => validateFixture(result), /comparison file delta/);
});

test('capability declarations are unique and must contain their claimed structures', () => {
  const mutations = [
    (s) => { s.provenance.capabilities = null; },
    (s) => { s.provenance.capabilities = ['invented_v1']; },
    (s) => { s.provenance.capabilities.push(s.provenance.capabilities[0]); },
    (s, r, f) => { delete f.content_signal; },
    (s, r, f) => { delete f.commits_since_change; },
    (s, r) => { delete r.ai_summary.by_kind; },
    (s, r) => { delete r.activity; },
    (s, r) => { delete r.team_activity; },
    (s, r) => { delete r.attention; },
    (s) => { delete s.references; },
  ];
  for (const mutate of mutations) {
    const result = readinessSnapshot();
    mutate(result, result.repositories[0], result.repositories[0].ai_files[0]);
    assert.throws(() => validateFixture(result), /Invalid readiness measurement/, mutate.toString());
  }
});

test('configured team aggregates cannot exceed repository totals or windows', () => {
  const result = readinessSnapshot();
  const team = result.repositories[0].team_activity = {
    available: true, complete: true, matching: 'exact_author_email',
    commit_count: 1, commits_30d: 1, commits_90d: 1,
  };
  assert.equal(validateFixture(result), result);
  for (const key of ['commit_count', 'commits_30d', 'commits_90d']) {
    team[key] = 2;
    assert.throws(() => validateFixture(result), /team activity completeness/);
    team[key] = 1;
  }
});

test('scan HEADs must agree with every full-history clone', () => {
  const selected = ['example-org/example-api', 'example-org/example-web'];
  const heads = new Map([
    [selected[0], '1'.repeat(40)],
    [selected[1], '2'.repeat(40)],
  ]);
  assert.equal(validateSnapshot(snapshot(selected), selected, heads).repositories.length, 2);
  heads.set(selected[1], '3'.repeat(40));
  assert.throws(() => validateSnapshot(snapshot(selected), selected, heads), /HEAD changed/);
});

test('workflow gates sensitive operations and never automatically commits generated data', () => {
  const workflow = readFileSync(new URL('../.github/workflows/landscape.yml', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../scripts/landscape.mjs', import.meta.url), 'utf8');
  const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  const instructions = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /- import\s+- refresh/);
  assert.match(workflow, /gh api "repos\/\$GITHUB_REPOSITORY".*\.private/);
  assert.match(workflow, /permission-contents: read/);
  assert.match(workflow, /repositories: \$\{\{ steps\.preflight\.outputs\.repositories \}\}/);
  assert.deepEqual([...workflow.matchAll(/'(@devex-metrics\/repo-landscape@[^']+)'/g)].map((match) => match[1]), [
    '@devex-metrics/repo-landscape@0.1.2',
  ]);
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /`@devex-metrics\/repo-landscape@0\.1\.2`/);
  assert.match(workflow, /--repos-dir "\$RUNNER_TEMP\/landscape-repos"/);
  assert.match(workflow, /--expected-heads "\$RUNNER_TEMP\/landscape-heads\.json"/);
  assert.match(workflow, /verify \.\/landscape\.json "\$RUNNER_TEMP\/landscape-heads\.json" "\$RUNNER_TEMP\/repo-landscape\/node_modules\/@devex-metrics\/repo-landscape\/package\.json"/);
  assert.match(workflow, /actions\/setup-python@[0-9a-f]{40}/);
  assert.match(workflow, /--baseline \.\/state\/initial-baseline\.json/);
  assert.match(workflow, /publish_pages == 'true' && inputs.mode == 'refresh'/);
  assert.doesNotMatch(workflow, /\bgit (?:commit|push)\b/);
  assert.match(script, /'--no-single-branch'/);
  assert.match(ignore, /^state\/$/m);
  assert.match(instructions, /Never add real organization names/);
  assert.match(instructions, /workflows never commit generated data or replace that baseline/);
  assert.equal(existsSync(new URL('../.github/copilot-instructions.md', import.meta.url)), false);
});
