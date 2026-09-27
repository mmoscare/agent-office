param(
    [string]$OfficeDir = 'C:\Users\Owner\Documents\Development\Personal-Portfolio',
    [int]$Port = 4600
)
$ErrorActionPreference = 'Stop'
$codeDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$installDir = Join-Path $env:LOCALAPPDATA 'Agent Office'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$null = New-Item -ItemType Directory -Path $installDir -Force

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Agent Office.ico') -Destination (Join-Path $installDir 'Agent Office.ico') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'host.mjs') -Destination (Join-Path $installDir 'host.mjs') -Force
$exe = Join-Path $installDir 'Agent Office.exe'
$compiler = New-Object System.CodeDom.Compiler.CompilerParameters
$compiler.GenerateExecutable = $true
$compiler.GenerateInMemory = $false
$compiler.OutputAssembly = $exe
$compiler.CompilerOptions = '/target:winexe /optimize /win32icon:"' + (Join-Path $installDir 'Agent Office.ico') + '"'
foreach ($assembly in @('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Security.dll','System.Web.Extensions.dll')) {
    $null = $compiler.ReferencedAssemblies.Add($assembly)
}
$provider = New-Object Microsoft.CSharp.CSharpCodeProvider
try { $result = $provider.CompileAssemblyFromFile($compiler, (Join-Path $PSScriptRoot 'Launcher.cs')) }
finally { $provider.Dispose() }
if ($result.Errors.HasErrors) { throw (($result.Errors | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine) }
$config = @{ CodeDir = $codeDir; OfficeDir = (Resolve-Path -LiteralPath $OfficeDir).Path; NodePath = $nodePath; Port = $Port; Branch = 'personal' } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $installDir 'launcher.json'), $config, (New-Object Text.UTF8Encoding($false)))

$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    $shortcut = $shell.CreateShortcut((Join-Path $folder 'Agent Office.lnk'))
    $shortcut.TargetPath = $exe
    $shortcut.WorkingDirectory = $codeDir
    $shortcut.IconLocation = (Join-Path $installDir 'Agent Office.ico') + ',0'
    $shortcut.Description = 'Your personal Agent Office'
    $shortcut.Save()
}
Write-Output "Installed Agent Office in $installDir with Desktop and Start menu shortcuts."
