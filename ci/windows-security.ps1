#!/usr/bin/env pwsh
# THE FOUR WINDOWS SECURITY CHECKS — live, on NTFS, or not at all.
#
#   pwsh -NoProfile -File ci/windows-security.ps1
#
# Three of the properties this project relies on are properties of the HOST
# rather than of its own code, and on Windows they are different properties than
# on Linux: a file mode of 0600 is ignored by NTFS, a junction is not a symbolic
# link, and a drive letter is an absolute path that a POSIX check does not
# recognise. Every one of them was, until this file, a sentence in a document.
#
#   1. SECRET ACL          the §9.1 bootstrap secret is not readable by a second
#                          local account on the same machine
#   2. SQLITE READONLY     a handle opened `readOnly` refuses a write IN THE
#                          ENGINE, not by this project asking politely
#   3. REPARSE ESCAPE      a junction cannot carry a package member or an
#                          activation write outside its root
#   4. ARCHIVE CONTRACT    traversal, Windows absolute paths and normalized
#                          collisions are refused as `MALFORMED_ARCHIVE`
#
# EVERY CHECK FAILS CLOSED. A check that cannot be PERFORMED — no second account
# could be created, the probe process never ran, the daemon or the runtime is
# missing — exits non-zero with its own marker. That rule is the whole design:
# the tempting failure mode for a security check is to report "not applicable"
# and be counted as green, and a suite that counts an unperformed check is worse
# than no suite, because it produces a number (`4/4`) that nobody can read as
# anything other than four checks having happened.
#
# The marker is printed ONLY when all four passed, and it carries the count.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
# THE IMPORT SPECIFIER FOR AN INLINE MODULE. `node -e --input-type=module`
# resolves a bare `C:/...` against nothing: on Windows an absolute path is not a
# relative specifier and not a URL, so the import fails with a message about
# module resolution rather than about the check. A `file:///C:/...` URL is what
# the ESM resolver actually accepts.
$RootUrl = 'file:///' + ($Root -replace '\\', '/')
$Cli = @('--experimental-strip-types', '--no-warnings', (Join-Path $Root 'src/cli.ts'))
$Results = [ordered]@{}

function Fail-Check {
    param([string]$Marker, [string]$Message)
    Write-Host "FAIL: $Message"
    Write-Host $Marker
    exit 1
}

function Node-Eval {
    param([string]$Script, [hashtable]$Env = @{})
    foreach ($k in $Env.Keys) { [Environment]::SetEnvironmentVariable($k, $Env[$k]) }
    $out = & node --experimental-strip-types --no-warnings --input-type=module -e $Script 2>&1 | Out-String
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $out }
}

function Cli-Run {
    param([string[]]$CliArgs)
    $out = & node @($Cli + $CliArgs) 2>&1 | Out-String
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $out }
}

if (-not $IsWindows) {
    Fail-Check 'WINDOWS_SECURITY_UNRUNNABLE' @'
this host is not Windows. Every check in this file is about NTFS ACLs, reparse
points and the Windows form of an absolute path; on any other host it would be
testing a different operating system and reporting the answer as Windows'.
'@
}

# ---------------------------------------------------------------- a deployment
#
# A REAL one, in the REAL place: `%LOCALAPPDATA%` is where src/platform.ts puts a
# Windows deployment, and the ACL a file inherits is a property of the directory
# it is created in — so a check run in `C:\Temp` would be checking a different
# question with the same words.

$DataDir = Join-Path $env:LOCALAPPDATA 'Skillonomia-windows-security'
$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("skillonomia-b4-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $Work | Out-Null
if (Test-Path $DataDir) { Remove-Item -Recurse -Force $DataDir }

$serverLog = Join-Path $Work 'serve.log'
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$Port = $listener.LocalEndpoint.Port
$listener.Stop()

$serve = Start-Process -FilePath 'node' -PassThru -NoNewWindow `
    -ArgumentList ($Cli + @('serve', '--port', "$Port", '--data', $DataDir)) `
    -RedirectStandardOutput $serverLog -RedirectStandardError (Join-Path $Work 'serve.err')
$healthy = $false
foreach ($_ in 1..120) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $healthy = $true; break }
    } catch { Start-Sleep -Seconds 1 }
}
try { Stop-Process -Id $serve.Id -Force -ErrorAction SilentlyContinue } catch { }
if (-not $healthy) {
    Fail-Check 'WINDOWS_SECURITY_UNRUNNABLE' "the deployment under test never answered /health; there is nothing to check. $(Get-Content $serverLog -Raw -ErrorAction SilentlyContinue)"
}

$SecretFile = Join-Path $DataDir 'bootstrap.json'
$DbFile = Join-Path $DataDir 'skillonomia.db'
if (-not (Test-Path $SecretFile)) { Fail-Check 'WINDOWS_SECRET_ACL_FAIL' "the first start left no $SecretFile to check the ACL of" }
if (-not (Test-Path $DbFile)) { Fail-Check 'WINDOWS_SQLITE_READONLY_FAIL' "the first start left no $DbFile to open read-only" }

# =========================================================== 1. the secret ACL
#
# The §9.1 bootstrap file holds the hash of a token that mints the owner key. It
# is written with mode 0600, which NTFS ignores entirely — so what actually
# protects it is the ACL it inherits from `%LOCALAPPDATA%`, and that is a claim
# about Windows that only Windows can answer.
#
# TWO CONDITIONS, BOTH REQUIRED. The ACL must not name a group that means
# "everybody who can log in", AND a second real local account must actually fail
# to read the bytes. The first alone reads a list; the second alone could pass by
# accident on a machine where the probe never ran, which is why the probe writes
# a sentinel first and its absence is a failure.

$probeUser = 'sklo-b4-probe'
$probeOut = 'C:\Users\Public\skillonomia-b4-probe.txt'
$created = $false
try {
    $acl = Get-Acl $SecretFile
    $wideOpen = @($acl.Access | Where-Object {
        $_.IdentityReference.Value -match '(?i)\\(Everyone|Users|Authenticated Users)$' -or
        $_.IdentityReference.Value -match '(?i)^(Everyone|BUILTIN\\Users|NT AUTHORITY\\Authenticated Users)$'
    })
    if ($wideOpen.Count -gt 0) {
        Fail-Check 'WINDOWS_SECRET_ACL_FAIL' "the ACL of $SecretFile grants $($wideOpen.IdentityReference -join ', '), which is every account that can log in to this machine"
    }

    $password = ConvertTo-SecureString ([guid]::NewGuid().ToString('N') + 'aA1!') -AsPlainText -Force
    if (Get-LocalUser -Name $probeUser -ErrorAction SilentlyContinue) { Remove-LocalUser -Name $probeUser }
    New-LocalUser -Name $probeUser -Password $password -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
    $created = $true
    $credential = [System.Management.Automation.PSCredential]::new($probeUser, $password)

    Remove-Item -Force $probeOut -ErrorAction SilentlyContinue
    $command = "/c echo PROBE_RAN> `"$probeOut`" & type `"$SecretFile`" >> `"$probeOut`" 2>&1"
    Start-Process -FilePath 'cmd.exe' -ArgumentList $command -Credential $credential -Wait -WindowStyle Hidden
    if (-not (Test-Path $probeOut)) {
        Fail-Check 'WINDOWS_SECRET_ACL_FAIL' "the probe process never ran as $probeUser, so the ACL could not be PROVEN. An unperformed check is a failed check."
    }
    $probeText = Get-Content $probeOut -Raw
    if ($probeText -notmatch 'PROBE_RAN') {
        Fail-Check 'WINDOWS_SECRET_ACL_FAIL' "the probe wrote no sentinel, so nothing was actually attempted as $probeUser"
    }
    $secretText = Get-Content $SecretFile -Raw
    $secretBody = ($secretText -replace '\s', '')
    if ($secretBody.Length -gt 0 -and ($probeText -replace '\s', '').Contains($secretBody)) {
        Fail-Check 'WINDOWS_SECRET_ACL_FAIL' "$probeUser read the contents of $SecretFile"
    }
    if ($probeText -notmatch '(?i)access is denied|cannot find|The system cannot') {
        Fail-Check 'WINDOWS_SECRET_ACL_FAIL' "the probe as $probeUser neither read the secret nor was refused; what it got was: $probeText"
    }
    $Results['secret-acl'] = "refused for $probeUser; no all-users ACE"
} finally {
    Remove-Item -Force $probeOut -ErrorAction SilentlyContinue
    if ($created) { Remove-LocalUser -Name $probeUser -ErrorAction SilentlyContinue }
}

# ====================================================== 2. engine-level readOnly
#
# `readOnly` must be the SQLite connection flag and not a rule this code keeps
# for itself: a read-only handle that is enforced by convention is enforced by
# whoever remembers the convention. So a write is attempted on such a handle and
# the ENGINE has to be the thing that refuses it.

$sqliteProbe = @"
import { openSqlite } from '$RootUrl/src/sqlite.ts';
const db = openSqlite('$(($DbFile -replace '\\','/'))', { readonly: true });
try {
  db.exec('CREATE TABLE windows_readonly_probe (x INTEGER)');
  console.log('WROTE');
  process.exit(0);
} catch (e) {
  console.log('REFUSED: ' + String(e && e.message));
  process.exit(3);
} finally {
  db.close();
}
"@
$sqlite = Node-Eval -Script $sqliteProbe
if ($sqlite.ExitCode -eq 0) {
    Fail-Check 'WINDOWS_SQLITE_READONLY_FAIL' "a CREATE TABLE succeeded on a handle opened readOnly: $($sqlite.Output)"
}
if ($sqlite.ExitCode -ne 3) {
    Fail-Check 'WINDOWS_SQLITE_READONLY_FAIL' "the read-only probe did not run to a decision (exit $($sqlite.ExitCode)): $($sqlite.Output)"
}
if ($sqlite.Output -notmatch '(?i)readonly|read.only|attempt to write') {
    Fail-Check 'WINDOWS_SQLITE_READONLY_FAIL' "the write was refused, but not by the engine's read-only rule: $($sqlite.Output)"
}
$Results['sqlite-readonly'] = ($sqlite.Output.Trim() -split "`n")[0]

# ================================================= 3. junction / reparse escape
#
# A junction is Windows' directory reparse point. It is NOT a symbolic link and
# a check written for POSIX symlinks can miss it entirely — which matters twice
# here: a package directory that carries one, and an activation root whose
# subdirectory IS one.
#
# The second is the sharper case. `.claude/skills` being a junction to a shared
# library elsewhere on the disk is an ordinary thing for a user to have done, and
# every lexical containment check passes while the write lands outside the root.

$outside = Join-Path $Work 'outside'
New-Item -ItemType Directory -Force -Path $outside | Out-Null
Set-Content -Path (Join-Path $outside 'target.txt') -Value 'SKILLONOMIA_B4_TARGET_MARKER'

$pkgDir = Join-Path $Work 'package-with-junction'
New-Item -ItemType Directory -Force -Path $pkgDir | Out-Null
Copy-Item (Join-Path $Root 'vectors/tv-01/package/*') $pkgDir -Recurse -ErrorAction SilentlyContinue
cmd /c mklink /J "$(Join-Path $pkgDir 'escape')" "$outside" | Out-Null
if (-not (Test-Path (Join-Path $pkgDir 'escape'))) {
    Fail-Check 'WINDOWS_REPARSE_ESCAPE_FAIL' 'the junction could not be created, so the escape could not be attempted at all'
}
$verified = Cli-Run @('verify', $pkgDir, '--db', $DbFile)
if ($verified.ExitCode -eq 0) {
    Fail-Check 'WINDOWS_REPARSE_ESCAPE_FAIL' "a package directory carrying a junction out of its own tree verified: $($verified.Output)"
}
if ($verified.Output -match 'SKILLONOMIA_B4_TARGET_MARKER') {
    Fail-Check 'WINDOWS_REPARSE_ESCAPE_FAIL' 'the junction target was READ before the refusal — the refusal came too late to matter'
}
if ($verified.Output -notmatch 'MALFORMED_ARCHIVE') {
    Fail-Check 'WINDOWS_REPARSE_ESCAPE_FAIL' "the junction was refused, but not as a typed §4.1b refusal: $($verified.Output)"
}

$actRoot = Join-Path $Work 'activation-root'
New-Item -ItemType Directory -Force -Path (Join-Path $actRoot '.claude') | Out-Null
cmd /c mklink /J "$(Join-Path $actRoot '.claude\skills')" "$outside" | Out-Null
if (-not (Test-Path (Join-Path $actRoot '.claude\skills'))) {
    Fail-Check 'WINDOWS_REPARSE_ESCAPE_FAIL' 'the activation-root junction could not be created, so the escape could not be attempted at all'
}
$activationProbe = @"
import { FixedActivationRoots, materialize, ActivationError } from '$RootUrl/src/activation.ts';
const roots = new FixedActivationRoots('$(($actRoot -replace '\\','/'))', 'claude_code_personal');
const site = roots.rootFor('probe-agent');
try {
  materialize(site, 'probe-skill', new Map([['SKILL.md', Buffer.from('SKILLONOMIA_B4_WRITTEN')]]));
  console.log('WROTE');
  process.exit(0);
} catch (e) {
  console.log('REFUSED: ' + (e instanceof ActivationError ? e.reason : 'untyped') + ' ' + String(e && e.message));
  process.exit(3);
}
"@
$activation = Node-Eval -Script $activationProbe
if ($activation.ExitCode -eq 0) {
    Fail-Check 'WINDOWS_REPARSE_ESCAPE_FAIL' "an activation wrote through a junction that leaves the root: $($activation.Output)"
}
if ($activation.ExitCode -ne 3 -or $activation.Output -notmatch 'outside_root_refused') {
    Fail-Check 'WINDOWS_REPARSE_ESCAPE_FAIL' "the activation did not refuse with `outside_root_refused`: $($activation.Output)"
}
if (Get-ChildItem -Recurse -File $outside | Where-Object { $_.Name -ne 'target.txt' }) {
    Fail-Check 'WINDOWS_REPARSE_ESCAPE_FAIL' "something was written into $outside through the junction"
}
$Results['reparse-escape'] = 'package member and activation write both refused before the target was touched'

# ============================================== 4. the NTFS path/case contract
#
# The §4.1b vectors, run through the CLI on NTFS. They come from
# `ci/mvp-release.mjs` rather than being written again here: two copies of a
# vector set are two answers to one question, and the qualification matrix must
# be running the same archives this check runs.

$vectorProbe = @"
import { writeFileSync } from 'node:fs';
import { ARCHIVE_VECTORS, ustar } from '$RootUrl/ci/mvp-release.mjs';
const extra = [
  ['windows-absolute', [['C:\\\\Windows\\\\system32\\\\evil', Buffer.from('x')]]],
  ['backslash-traversal', [['..\\\\escape.md', Buffer.from('x')]]],
];
const out = [];
for (const [name, members] of [...ARCHIVE_VECTORS, ...extra]) {
  const file = '$(($Work -replace '\\','/'))/vector-' + name + '.tar';
  writeFileSync(file, ustar(members));
  out.push(name + '=' + file);
}
console.log(out.join('\n'));
"@
$vectors = Node-Eval -Script $vectorProbe
if ($vectors.ExitCode -ne 0) {
    Fail-Check 'WINDOWS_ARCHIVE_CONTRACT_FAIL' "the §4.1b vectors could not be written: $($vectors.Output)"
}
$names = @()
foreach ($line in ($vectors.Output -split "`r?`n" | Where-Object { $_ -match '=' })) {
    $name, $file = $line -split '=', 2
    $r = Cli-Run @('verify', $file.Trim(), '--db', $DbFile)
    if ($r.ExitCode -ne 1) {
        Fail-Check 'WINDOWS_ARCHIVE_CONTRACT_FAIL' "the $name vector exited $($r.ExitCode); a refused archive is exit 1: $($r.Output)"
    }
    if ($r.Output -notmatch 'MALFORMED_ARCHIVE') {
        Fail-Check 'WINDOWS_ARCHIVE_CONTRACT_FAIL' "the $name vector was not refused as MALFORMED_ARCHIVE: $($r.Output)"
    }
    $names += $name.Trim()
}
if ($names.Count -lt 7) {
    Fail-Check 'WINDOWS_ARCHIVE_CONTRACT_FAIL' "only $($names.Count) archive vectors were run; the set is the five in ci/mvp-release.mjs plus the two Windows forms"
}
$Results['archive-contract'] = ($names -join ', ')

# --------------------------------------------------------------------- the count

Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue

foreach ($key in $Results.Keys) { Write-Host ("  {0,-18} {1}" -f $key, $Results[$key]) }
if ($Results.Count -ne 4) {
    Fail-Check 'WINDOWS_SECURITY_INCOMPLETE' "$($Results.Count) of 4 checks reported a result; a count is only worth printing when every check produced one"
}
Write-Host "WINDOWS_SECURITY_OK 4/4"
exit 0
