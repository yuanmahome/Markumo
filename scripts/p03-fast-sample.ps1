param([int]$RootPid, [string]$Output, [string]$StopFile, [string]$ReadyFile)
$ErrorActionPreference = 'Stop'
$p03Root = Get-Process -Id $RootPid
$p03RootStart = $p03Root.StartTime.ToUniversalTime()
$p03Pool = @{}
$p03NextTree = 0L
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Runtime.InteropServices;
public sealed class P03MemoryEntry : IDisposable {
  public Process Process; public string Role, Subtype, Start; public int Parent; public long StartTicks;
  public IntPtr Handle;
  [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  public P03MemoryEntry(Process process, string role, string subtype, string start, int parent) {
    Process=process; Role=role; Subtype=subtype; Start=start; Parent=parent;
    StartTicks=DateTime.Parse(start,CultureInfo.InvariantCulture,DateTimeStyles.RoundtripKind).ToUniversalTime().ToFileTimeUtc();
    Handle=OpenProcess(0x1000,false,process.Id);
  }
  public void Dispose(){if(Handle!=IntPtr.Zero){CloseHandle(Handle);Handle=IntPtr.Zero;}}
}
public static class P03MemorySnapshot {
  [StructLayout(LayoutKind.Sequential)] struct MemoryCounters {
    public uint cb,PageFaultCount;
    public UIntPtr PeakWorkingSetSize,WorkingSetSize,QuotaPeakPagedPoolUsage,QuotaPagedPoolUsage,QuotaPeakNonPagedPoolUsage,QuotaNonPagedPoolUsage,PagefileUsage,PeakPagefileUsage,PrivateUsage;
  }
  [StructLayout(LayoutKind.Sequential)] struct FileTime {public uint Low,High;public long Value{get{return ((long)High<<32)|Low;}}}
  [DllImport("psapi.dll",SetLastError=true)] static extern bool GetProcessMemoryInfo(IntPtr handle,ref MemoryCounters counters,uint size);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr handle,out FileTime creation,out FileTime exit,out FileTime kernel,out FileTime user);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
  static string Quote(string value) { return "\""+value.Replace("\\","\\\\").Replace("\"","\\\"")+"\""; }
  public static string Capture(int root, IEnumerable<P03MemoryEntry> entries) {
    StringBuilder b=new StringBuilder(4096);b.Append("{\"time\":").Append(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()).Append(",\"rootPid\":").Append(root).Append(",\"processes\":[");
    bool first=true;
    foreach(P03MemoryEntry entry in entries) {
      try {
        Process p=entry.Process;uint exitCode;FileTime creation,exit,kernel,user;
        if(entry.Handle==IntPtr.Zero||!GetExitCodeProcess(entry.Handle,out exitCode)||exitCode!=259||!GetProcessTimes(entry.Handle,out creation,out exit,out kernel,out user)||creation.Value!=entry.StartTicks)continue;
        MemoryCounters counters=new MemoryCounters();counters.cb=(uint)Marshal.SizeOf(typeof(MemoryCounters));if(!GetProcessMemoryInfo(entry.Handle,ref counters,counters.cb))continue;
        ulong privateBytes=counters.PrivateUsage.ToUInt64(),working=counters.WorkingSetSize.ToUInt64();double cpu=(kernel.Value+user.Value)/10000.0;
        if(!first)b.Append(',');first=false;
        b.Append("{\"pid\":").Append(p.Id).Append(",\"parentPid\":").Append(entry.Parent).Append(",\"role\":").Append(Quote(entry.Role)).Append(",\"subtype\":").Append(Quote(entry.Subtype)).Append(",\"start\":").Append(Quote(entry.Start)).Append(",\"private\":").Append(privateBytes).Append(",\"working\":").Append(working).Append(",\"cpuMs\":").Append(cpu.ToString(CultureInfo.InvariantCulture)).Append('}');
      } catch { }
    }
    return b.Append("]}").ToString();
  }
}
'@
$p03Entries = [Collections.Generic.List[P03MemoryEntry]]::new()
$p03File = [IO.File]::Open($Output, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$p03Zip = [IO.Compression.GZipStream]::new($p03File, [IO.Compression.CompressionLevel]::Optimal)
$p03Writer = [IO.StreamWriter]::new($p03Zip, [Text.UTF8Encoding]::new($false), 65536)
try {
  while (!$p03Root.HasExited -and ![IO.File]::Exists($StopFile)) {
    $p03Now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($p03Now -ge $p03NextTree) {
      $p03Rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate)
      $p03Ids = [Collections.Generic.HashSet[int]]::new()
      [void]$p03Ids.Add($RootPid)
      do {
        $p03Added = $false
        foreach ($p03Row in $p03Rows) {
          if ($p03Ids.Contains([int]$p03Row.ParentProcessId) -and $p03Row.CreationDate.ToUniversalTime() -ge $p03RootStart.AddMilliseconds(-1) -and $p03Ids.Add([int]$p03Row.ProcessId)) { $p03Added = $true }
        }
      } while ($p03Added)
      foreach ($p03Row in $p03Rows) {
        if (!$p03Ids.Contains([int]$p03Row.ProcessId) -or ($p03Row.ProcessId -ne $RootPid -and $p03Row.Name -ne 'msedgewebview2.exe')) { continue }
        $p03Key = [string]$p03Row.ProcessId
        if ($p03Pool.ContainsKey($p03Key)) { continue }
        $p03Process = Get-Process -Id $p03Row.ProcessId -ErrorAction SilentlyContinue
        if (!$p03Process) { continue }
        if ([Math]::Abs(($p03Process.StartTime.ToUniversalTime() - $p03Row.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1) { $p03Process.Dispose(); continue }
        $p03Role = if ($p03Row.ProcessId -eq $RootPid) { 'Rust' } else { 'Browser' }
        if ($p03Row.CommandLine -match '--type=([^\s"]+)') {
          $p03Role = switch ($Matches[1]) { 'renderer' {'Renderer'} 'gpu-process' {'GPU'} 'utility' {'Utility'} default {$Matches[1]} }
        }
        $p03Subtype = ''
        if ($p03Row.CommandLine -match '--utility-sub-type=([^\s"]+)') { $p03Subtype = $Matches[1] }
        $p03Start = $p03Process.StartTime.ToUniversalTime().ToString('o')
        $p03Entry = [P03MemoryEntry]::new($p03Process,$p03Role,$p03Subtype,$p03Start,$p03Row.ParentProcessId)
        $p03Pool[$p03Key] = @{process=$p03Process;entry=$p03Entry}
      }
      $p03Entries.Clear()
      foreach($p03Item in $p03Pool.Values) { $p03Entries.Add($p03Item.entry) }
      $p03NextTree = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 1000
    }
    $p03Line = [P03MemorySnapshot]::Capture($RootPid,$p03Entries)
    if (!$p03Line.Contains('"pid":' + $RootPid + ',')) { throw 'Cannot sample the expected root process' }
    $p03Writer.WriteLine($p03Line)
    if (![IO.File]::Exists($ReadyFile)) { [IO.File]::WriteAllText($ReadyFile, 'ready') }
    [Threading.Thread]::Sleep(20)
  }
} finally {
  $p03Writer.Dispose()
  $p03Zip.Dispose()
  $p03File.Dispose()
  foreach ($p03Item in $p03Pool.Values) { $p03Item.entry.Dispose(); $p03Item.process.Dispose() }
  $p03Root.Dispose()
}
