import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  actionOutputs,
  cloneDestination,
  validateConfig,
  validateSettings,
  validateSnapshot,
} from '../scripts/landscape.mjs';

const config = JSON.parse(readFileSync(new URL('../landscape.config.json', import.meta.url)));
const settings = JSON.parse(readFileSync(new URL('../template.settings.json', import.meta.url)));
const example = JSON.parse(readFileSync(new URL('../config/landscape.example.json', import.meta.url)));

function snapshot(repositories) {
  return {
    schema_version: 1,
    repositories: repositories.map((fullName, index) => ({
      full_name: fullName,
      head_sha: String(index + 1).repeat(40),
      ai_files: [],
      ai_summary: { count: 0 },
    })),
  };
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
  assert.throws(() => validateConfig({ ...example, repositories: [
    'first-org/same-name', 'second-org/same-name',
  ] }), /one GitHub App installation owner/);
});

test('initial baselines require all selected repositories and complete v1 output', () => {
  const selected = ['example-org/example-api', 'example-org/example-web'];
  assert.equal(validateSnapshot(snapshot(selected), selected).repositories.length, 2);
  assert.throws(() => validateSnapshot(snapshot([selected[0]]), selected), /resolved 1 of 2/);
  assert.throws(() => validateSnapshot(snapshot([...selected, 'example-org/unreviewed']), selected), /extra or duplicate/);
  assert.throws(() => validateSnapshot(snapshot([selected[0], selected[0]]), selected), /extra or duplicate/);
  const incomplete = snapshot(selected);
  delete incomplete.repositories[1].ai_summary;
  assert.throws(() => validateSnapshot(incomplete, selected), /incomplete v1/);
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
  const instructions = readFileSync(new URL('../.github/copilot-instructions.md', import.meta.url), 'utf8');

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /- import\s+- refresh/);
  assert.match(workflow, /gh api "repos\/\$GITHUB_REPOSITORY".*\.private/);
  assert.match(workflow, /permission-contents: read/);
  assert.match(workflow, /repositories: \$\{\{ steps\.preflight\.outputs\.repositories \}\}/);
  assert.match(workflow, /@devex-metrics\/repo-landscape@0\.1\.0/);
  assert.match(workflow, /--repos-dir "\$RUNNER_TEMP\/landscape-repos"/);
  assert.match(workflow, /--expected-heads "\$RUNNER_TEMP\/landscape-heads\.json"/);
  assert.match(workflow, /actions\/setup-python@[0-9a-f]{40}/);
  assert.match(workflow, /--baseline \.\/state\/initial-baseline\.json/);
  assert.match(workflow, /publish_pages == 'true' && inputs.mode == 'refresh'/);
  assert.doesNotMatch(workflow, /\bgit (?:commit|push)\b/);
  assert.match(script, /'--no-single-branch'/);
  assert.match(ignore, /^state\/$/m);
  assert.equal(instructions.trim(), '[AGENTS.md](../AGENTS.md)');
});
