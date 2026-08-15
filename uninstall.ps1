# ASCII only: uninstalls the dsh-windows-notify plugin (node install.mjs --uninstall).
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$PassThruArgs)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $scriptDir 'install.mjs') --uninstall @PassThruArgs
exit $LASTEXITCODE
