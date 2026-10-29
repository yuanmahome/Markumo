param([int]$RootPid)
$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, CreationDate)
$root = $rows | Where-Object ProcessId -eq $RootPid
if (!$root) { throw "Root process $RootPid exited" }
$ids = [Collections.Generic.HashSet[int]]::new()
[void]$ids.Add($RootPid)
do {
  $added = $false
  foreach ($row in $rows) {
    if ($ids.Contains([int]$row.ParentProcessId) -and $row.CreationDate -ge $root.CreationDate -and $ids.Add([int]$row.ProcessId)) { $added = $true }
  }
} while ($added)
$processes = @(
  foreach ($row in $rows) {
    if (!$ids.Contains([int]$row.ProcessId)) { continue }
    if ($row.ProcessId -ne $RootPid -and $row.Name -ne 'msedgewebview2.exe') { continue }
    $proc = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue
    if (!$proc) { continue }
    $role = 'Rust'
    if ($row.ProcessId -ne $RootPid) {
      $role = 'Browser'
      if ($row.CommandLine -match '--type=([^\s"]+)') {
        $role = switch ($Matches[1]) { 'renderer' {'Renderer'} 'gpu-process' {'GPU'} 'utility' {'Utility'} default {$Matches[1]} }
      }
    }
    $subtype = ''
    if ($row.CommandLine -match '--utility-sub-type=([^\s"]+)') { $subtype = $Matches[1] }
    [pscustomobject]@{pid=$proc.Id; parentPid=$row.ParentProcessId; role=$role; subtype=$subtype; private=[long]$proc.PrivateMemorySize64; working=[long]$proc.WorkingSet64; cpuMs=$proc.TotalProcessorTime.TotalMilliseconds; handles=$proc.HandleCount; start=$row.CreationDate.ToUniversalTime().ToString('o')}
  }
)
[pscustomobject]@{time=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); rootPid=$RootPid; processes=$processes} | ConvertTo-Json -Depth 5 -Compress
