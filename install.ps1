# ASCII only: wraps node install.mjs (installs the dsh-windows-notify plugin).
# All arguments pass through: --profile <name> --dsh-home <dir> --keep-legacy --uninstall ...
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$PassThruArgs)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $scriptDir 'install.mjs') @PassThruArgs
exit $LASTEXITCODE
