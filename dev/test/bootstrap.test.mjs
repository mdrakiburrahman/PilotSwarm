import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const windowsScript = resolve(root, 'dev', 'bootstrap-dev-env.ps1');
const linuxScript = resolve(root, 'dev', 'bootstrap-dev-env.sh');
const windows = readFileSync(windowsScript, 'utf8');
const linux = readFileSync(linuxScript, 'utf8');
const confirmation = 'RESET ALL WSL DISTROS AND REMOVE DOCKER DESKTOP';
// Never use Windows' bash.exe alias: it launches/mutates WSL rather than Git Bash.
const bash = process.platform === 'win32'
  ? [
    resolve(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    resolve(process.env.LOCALAPPDATA ?? 'C:\\Users\\Default\\AppData\\Local', 'Programs', 'Git', 'bin', 'bash.exe'),
  ].find(existsSync)
  : 'bash';
const pwsh = process.platform === 'win32'
  ? resolve(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
  : 'pwsh';
const hasPwsh = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
  encoding: 'utf8', timeout: 10_000, shell: false,
}).status === 0;

function run(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: root, encoding: 'utf8', timeout: 20_000, shell: false,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  assert.ifError(result.error);
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function runWindows(args) {
  return run(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', windowsScript, ...args]);
}

test('Windows parser accepts the script without executing host commands', { skip: !hasPwsh }, () => {
  const expression = '$errors = $null; $tokens = $null; ' +
    '[System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$tokens, [ref]$errors) | Out-Null; ' +
    'if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }';
  const result = run(pwsh, ['-NoLogo', '-NoProfile', '-Command', `${expression.replace('$args[0]', "'dev\\bootstrap-dev-env.ps1'")}`]);
  assert.equal(result.status, 0, result.output);
});

test('Windows portable dry-run has no admin, inventory or installation side effects', { skip: !hasPwsh }, () => {
  const result = runWindows(['-VhdPath', 'D:\\VHD\\PilotSwarm', '-DryRun']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /DRY RUN: no host inventory/);
  assert.match(result.output, /ALL WSL distributions/);
  assert.match(result.output, /Docker Desktop data/);
  assert.match(result.output, /Defender/);
  assert.match(result.output, /Global .wslconfig/);
  assert.doesNotMatch(result.output, /EXACT WSL INVENTORY|Reset complete/);
  assert.ok(windows.indexOf('if ($DryRun)') < windows.indexOf("if (-not $IsWindows)"));
});

test('Windows dry-run treats shell metacharacters and spaces as path data', { skip: !hasPwsh }, () => {
  const path = 'D:\\VHD\\space ; Write-Output INJECTION_SENTINEL';
  const result = runWindows(['-VhdPath', path, '-DryRun']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Ubuntu-24.04 VHD destination: D:\\VHD\\space ; Write-Output INJECTION_SENTINEL/);
  assert.doesNotMatch(result.output, /^INJECTION_SENTINEL\r?$/m);
});

test('Windows rejects unsafe path shapes before any host inspection', { skip: !hasPwsh }, () => {
  for (const path of ['C:\\', 'relative', '\\\\server\\VHD', 'C:\\VHD\\..\\elsewhere', 'C:\\VHD\\*', 'C:\\VHD\ninject']) {
    const result = runWindows(['-VhdPath', path, '-DryRun']);
    assert.notEqual(result.status, 0, `accepted ${JSON.stringify(path)}: ${result.output}`);
    assert.match(result.output, /VhdPath must be an absolute local drive subdirectory/);
  }
});

test('Windows refuses default reset and unattended opt-in without the exact phrase', { skip: !hasPwsh }, () => {
  const missingReset = runWindows(['-VhdPath', 'D:\\VHD\\PilotSwarm']);
  assert.notEqual(missingReset.status, 0);
  assert.match(missingReset.output, /No default reset/);
  for (const args of [
    ['-Unattended'],
    ['-FullReset', '-Unattended'],
    ['-FullReset', '-Unattended', '-AcceptFullReset', confirmation.toLowerCase()],
    ['-AcceptFullReset', confirmation],
    ['-DryRun', '-PreflightOnly'],
  ]) {
    const result = runWindows(['-VhdPath', 'D:\\VHD\\PilotSwarm', '-DryRun', ...args]);
    assert.notEqual(result.status, 0, result.output);
  }
  const valid = runWindows(['-VhdPath', 'D:\\VHD\\PilotSwarm', '-DryRun',
    '-FullReset', '-Unattended', '-AcceptFullReset', confirmation]);
  assert.equal(valid.status, 0, valid.output);
});

test('Windows destructive commands are gated, checked, and exact-targeted', () => {
  assert.match(windows, /#Requires -Version 7\.0/);
  assert.match(windows, /WindowsBuiltInRole\]::Administrator/);
  assert.match(windows, /if \(\$LASTEXITCODE -notin \$AllowedExitCodes\)/);
  assert.match(windows, /if \(\$PreflightOnly\).*return/);
  const confirmationPosition = windows.indexOf('$answer = Read-Host');
  for (const operation of [
    "Invoke-Checked wsl.exe @('--update')",
    'Stop-Process -Id $process.ProcessId',
    "Invoke-Checked winget.exe @('uninstall'",
    "Invoke-Checked wsl.exe @('--unregister', $distro)",
    'Remove-Item -LiteralPath $path -Recurse -Force',
    'Add-MpPreference -ExclusionPath',
  ]) {
    assert.ok(windows.indexOf(operation) > confirmationPosition, `unguarded ${operation}`);
  }
  assert.match(windows, /ExecutablePath\.StartsWith/);
  assert.match(windows, /Assert-NoReparsePoint \$path -CheckDescendants/);
  assert.doesNotMatch(windows, /Stop-Process\s+-Name|taskkill|Invoke-Expression|cmd\.exe|Remove-Item\s+-Path/);
  assert.match(windows, /WSL inventory changed since confirmation/);
  assert.match(windows, /Unconfirmed new distribution/);
  assert.match(windows, /'--distribution', 'Ubuntu-24\.04', '--location', \$VhdPath, '--no-launch'/);
  assert.match(windows, /VhdPath must be empty/);
  assert.match(windows, /Copy-Item -LiteralPath \$wslConfig -Destination \$backup/);
});

test('Linux shell syntax parses without running commands', { skip: !bash }, () => {
  const result = run(bash, ['-n', linuxScript]);
  assert.equal(result.status, 0, result.output);
});

test('Linux portable dry-run and help never inspect or modify the host', { skip: !bash }, () => {
  const result = run(bash, [linuxScript, '--dry-run']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /DRY RUN: no inventory, sudo/);
  for (const requirement of ['Ubuntu 24.04', 'Git >=2.46', 'Node 24', 'docker-compose-plugin', 'docker-buildx-plugin', 'gh', 'jq', 'lsof', 'tmux', 'systemd']) {
    assert.ok(result.output.includes(requirement), `missing ${requirement}`);
  }
  assert.match(result.output, /Preserve existing \/etc\/docker\/daemon.json/);
  const help = run(bash, [linuxScript, '--help']);
  assert.equal(help.status, 0, help.output);
  assert.match(help.output, /Usage:/);
  assert.ok(linux.indexOf('if [[ "$mode" == dry-run ]]') < linux.indexOf('source /etc/os-release'));
});

test('Linux flags cannot inject commands or request an implicit Docker reset', { skip: !bash }, () => {
  for (const args of [
    ['--reset'], ['--dry-run; printf INJECTION_SENTINEL'],
    ['--dry-run', '--preflight-only'], ['--dry-run', '--dry-run'],
  ]) {
    const result = run(bash, [linuxScript, ...args]);
    assert.notEqual(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /^INJECTION_SENTINEL\r?$/m);
  }
});

test('Linux sudo accepts NOPASSWD and fails clearly without a non-interactive credential', { skip: !bash }, () => {
  const sudoFunction = linux.match(/^ensure_sudo\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(sudoFunction, 'Missing sudo preflight function.');
  assert.match(sudoFunction, /sudo -n true/);
  assert.match(sudoFunction, /elif \[\[ -t 0 \]\]; then\s+sudo -v/);
  for (const nonInteractiveStatus of [0, 1]) {
    // Only execute the isolated function, with sudo stubbed; never invoke host sudo.
    const stub = `sudo() {
      printf 'sudo %s\\n' "$*"
      if [[ "$*" == '-n true' ]]; then return ${nonInteractiveStatus}; fi
      echo UNEXPECTED_SUDO_VALIDATION >&2
      return 99
    }`;
    const result = run(bash, ['-c', `${stub}\n${sudoFunction}\nensure_sudo`]);
    assert.equal(result.status, nonInteractiveStatus, result.output);
    assert.match(result.output, /sudo -n true/);
    assert.doesNotMatch(result.output, /UNEXPECTED_SUDO_VALIDATION|^sudo -v$/m);
    if (nonInteractiveStatus) {
      assert.match(result.output, /Non-interactive bootstrap requires authenticated or passwordless sudo/);
    }
  }
});

test('Linux defaults are idempotent, non-destructive, native and cloud-independent', () => {
  assert.doesNotMatch(linux, /\r/, 'Linux entrypoint must use LF line endings.');
  assert.match(linux, /set -Eeuo pipefail/);
  assert.match(linux, /sudo systemctl enable --now docker/);
  assert.match(linux, /sudo usermod -aG docker "\$\(id -un\)"/);
  assert.match(linux, /sudo dockerd --validate --config-file=\/etc\/docker\/daemon.json/);
  assert.match(linux, /if sudo test -e \/etc\/docker\/daemon.json/);
  assert.match(linux, /dpkg --compare-versions "\$git_version" ge 2\.46/);
  assert.match(linux, /sudo add-apt-repository -y ppa:git-core\/ppa/);
  assert.match(linux, /node_24\.x nodistro main/);
  assert.match(linux, /process\.versions\.node\.split/);
  assert.match(linux, /Conflicting package %s: migrate it explicitly/);
  assert.match(linux, /Preserving configured repository/);
  assert.match(linux, /case "\$repo_root" in \/mnt\/\*/);
  assert.match(linux, /systemd=true/);
  assert.match(linux, /exit 2/);
  assert.doesNotMatch(linux, /^(?:sudo )?(?:docker (?:system|volume|network|container|image) prune|docker rm|chmod 666|systemctl restart|apt-get remove|npm install -g|eval |mktemp)/m);
  assert.doesNotMatch(linux, /\/tmp\//);
  assert.doesNotMatch(`${linux}\n${windows}`, /\baz (?:login|account)|InstallAzure|azure-cli/i);
  assert.doesNotMatch(`${linux}\n${windows}`, /(?:Get-Content|source|read_text)\s.*(?:\.env|\.model_providers)/);
});
