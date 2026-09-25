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
  if (snapshot?.schema_version !== 1 || !Array.isArray(snapshot.repositories)) {
    fail('Scanner output must be a v1 JSON snapshot with a repositories array.');
  }
  const expected = new Set(selected.map((name) => name.toLowerCase()));
  const observed = new Set();
  for (const entry of snapshot.repositories) {
    const name = entry?.full_name;
    if (typeof name !== 'string' || !expected.has(name.toLowerCase()) || observed.has(name.toLowerCase())) {
      fail(`Scanner output contains an extra or duplicate repository: ${JSON.stringify(name)}`);
    }
    if (typeof entry.head_sha !== 'string' || !shaPattern.test(entry.head_sha)) {
      fail(`Scanner output has no valid HEAD SHA for ${name}.`);
    }
    if (!Array.isArray(entry.ai_files) || !entry.ai_summary || typeof entry.ai_summary.count !== 'number') {
      fail(`Scanner output has incomplete v1 results for ${name}.`);
    }
    const clonedHead = expectedHeads?.get(name.toLowerCase());
    if (expectedHeads && clonedHead?.toLowerCase() !== entry.head_sha.toLowerCase()) {
      fail(`HEAD changed or differs from full-history clone for ${name}; retry the run.`);
    }
    observed.add(name.toLowerCase());
  }
  if (observed.size !== expected.size) {
    fail(`Scanner output resolved ${observed.size} of ${expected.size} selected repositories; baseline not created.`);
  }
  return snapshot;
}

function loadSelection() {
  const settings = validateSettings(readJson(join(root, 'template.settings.json')));
  const selection = validateConfig(readJson(join(root, 'landscape.config.json')));
  if (!settings.enabled || !selection.repositories.length) {
    fail('Template is inactive. In your PRIVATE team repo, list reviewed owner/repo entries in landscape.config.json and set enabled: true in template.settings.json.');
  }
  return { settings, selection };
}

function preflight(mode, outputPath) {
  if (!['import', 'refresh'].includes(mode)) fail('Choose workflow mode import or refresh.');
  const { settings, selection } = loadSelection();
  const baseline = join(root, baselinePath);
  if (mode === 'import' && existsSync(baseline)) {
    fail('Initial baseline already exists. Use refresh; the baseline must never be overwritten.');
  }
  if (mode === 'refresh') {
    if (!existsSync(baseline)) {
      fail('No initial baseline yet. Run import, review its artifact, then explicitly commit state/initial-baseline.json to your PRIVATE team repo.');
    }
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', baselinePath], {
      cwd: root, stdio: 'ignore',
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

function verifySnapshot(snapshotPath, manifestPath) {
  const { selection } = loadSelection();
  const manifest = readJson(manifestPath);
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object' || Object.keys(manifest).length !== selection.repositories.length) {
    fail('Clone manifest does not match the selected repositories.');
  }
  const heads = new Map(Object.entries(manifest).map(([name, sha]) => [name.toLowerCase(), sha]));
  if (heads.size !== selection.repositories.length || selection.repositories.some((name) => !shaPattern.test(heads.get(name.toLowerCase()) ?? ''))) {
    fail('Clone manifest contains missing or duplicate repositories.');
  }
  validateSnapshot(readJson(snapshotPath), selection.repositories, heads);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'preflight' && args.length === 2) preflight(args[0], args[1]);
  else if (command === 'clone' && args.length === 1) cloneSelected(resolve(args[0]));
  else if (command === 'verify' && args.length === 2) verifySnapshot(resolve(args[0]), resolve(args[1]));
  else fail('Usage: node scripts/landscape.mjs preflight <import|refresh> <github-output> | clone <manifest> | verify <snapshot> <manifest>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
