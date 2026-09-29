$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'pi-live.mjs'
if (Get-Command bun -ErrorAction SilentlyContinue) {
	& bun $script @args
	exit $LASTEXITCODE
}
if (Get-Command node -ErrorAction SilentlyContinue) {
	& node $script @args
	exit $LASTEXITCODE
}
Write-Error 'need bun or node to open the live dashboard'
exit 1
