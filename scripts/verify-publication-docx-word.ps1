param([Parameter(Mandatory)][string]$InputDocx,[Parameter(Mandatory)][string]$OutputDirectory,[Parameter(Mandatory)][string]$ExpectedSha256,[string]$RequiredMarker='末尾标记。')
$ErrorActionPreference='Stop'
if((Get-FileHash -LiteralPath $InputDocx -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedSha256){throw 'Synthetic DOCX identity changed'}
if(Test-Path -LiteralPath $OutputDirectory){throw 'QA output already exists'}
New-Item -ItemType Directory -Path $OutputDirectory|Out-Null
$copy=Join-Path $OutputDirectory 'editable-copy.docx'
Copy-Item -LiteralPath $InputDocx -Destination $copy
$before=@(Get-Process WINWORD -ErrorAction SilentlyContinue|ForEach-Object Id)
if($before.Count){throw 'Native Word QA requires no existing Word process; refusing to touch the user session'}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ZiNovelWordOwner { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid); }
'@
$word=$null;$document=$null;$owned=$false;$wordProcess=$null
try {
 $word=New-Object -ComObject Word.Application
 $document=$word.Documents.Open($copy,$false,$false,$false)
 [uint32]$wordPid=0
 [void][ZiNovelWordOwner]::GetWindowThreadProcessId([IntPtr]$document.ActiveWindow.Hwnd,[ref]$wordPid)
 if($wordPid -le 0 -or $before -contains $wordPid){throw 'Refusing to control an existing Word process'}
 $wordProcess=Get-Process -Id $wordPid
 $owned=$true
 [ordered]@{pid=$wordPid;creationTime=$wordProcess.StartTime.ToUniversalTime().ToString('O');scope='new synthetic QA Word instance'}|ConvertTo-Json|Set-Content (Join-Path $OutputDirectory 'owned-word.json') -Encoding utf8
 $word.Visible=$false;$word.DisplayAlerts=0;$word.AutomationSecurity=3
 $body=$document.Content.Text
 if(-not $body.Contains('𠮷') -or -not $body.Contains($RequiredMarker)){throw 'Word lost required synthetic text'}
 $document.Repaginate()
 $pagesBefore=$document.ComputeStatistics(2)
 $width=$document.PageSetup.PageWidth;$height=$document.PageSetup.PageHeight
 $document.ExportAsFixedFormat((Join-Path $OutputDirectory 'original.pdf'),17,$false,0,0,1,1,0,$false)
 $document.Content.InsertAfter("`rWord editable verification marker 𠮷 🌊。")
 $document.Save()
 $document.Repaginate()
 $document.ExportAsFixedFormat((Join-Path $OutputDirectory 'edited.pdf'),17,$false,0,0,1,1,0,$false)
 $result=[ordered]@{status='passed';reader='Microsoft Word';version=$word.Version;build=$word.Build;pagesBefore=$pagesBefore;pagesAfter=$document.ComputeStatistics(2);widthPoints=$width;heightPoints=$height;originalSha256=$ExpectedSha256;originalUnchanged=((Get-FileHash -LiteralPath $InputDocx -Algorithm SHA256).Hash.ToLowerInvariant() -eq $ExpectedSha256);nativeEditableCopySaved=$true;scope='Synthetic QA only; owned new hidden Word process; no existing Word process or user document controlled'}
} finally {
 if($document){$document.Close(0);[void][Runtime.InteropServices.Marshal]::ReleaseComObject($document)}
 if($owned -and $word){$word.Quit(0)}
 if($word){[void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)}
 [GC]::Collect();[GC]::WaitForPendingFinalizers()
 if($wordProcess){if(-not $wordProcess.WaitForExit(15000)){throw 'Owned Word process did not exit'}}
}
$result.editedCopySha256=(Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLowerInvariant()
$result|ConvertTo-Json -Depth 5|Set-Content (Join-Path $OutputDirectory 'word-verification.json') -Encoding utf8
$result|ConvertTo-Json -Depth 5
