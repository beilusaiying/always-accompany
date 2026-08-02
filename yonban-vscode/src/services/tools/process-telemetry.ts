/**
 * 子进程树遥测与静默 watchdog。
 *
 * 策略只从 tool_call.transport.runtimePolicy 消费；公开工具 params 不能覆盖。
 * 采样不可用时只回报 unavailable，绝不把“看不见”当“没有活动”终止进程。
 */
import * as cp from "child_process";

export type ProcessTelemetrySample = {
  available: boolean;
  rootPid: number | null;
  alive: boolean;
  processCount: number | null;
  cpuTimeMs: number | null;
  rssBytes: number | null;
  gpuAvailable: false;
  sampledAt?: string;
  error?: string;
};

export type CommandWatchdogProgress = {
  phase: "running" | "stalled" | "telemetry_unavailable";
  pid: number | null;
  sampledAt: string;
  processCount?: number | null;
  cpuTimeMs?: number | null;
  cpuDeltaMs?: number;
  rssBytes?: number | null;
  rssDeltaBytes?: number;
  outputBytes: number;
  outputDeltaBytes?: number;
  idleForMs?: number;
  watchdogAction?: "report" | "terminate";
  gpuAvailable: false;
  errorCode?: string;
  sampleError?: string;
};

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function normalizeCommandWatchdogPolicy(raw: Record<string, unknown> = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const action = source.command_watchdog_action === "report" ? "report" as const : "terminate" as const;
  const sampleMs = Math.round(boundedNumber(source.command_watchdog_sample_ms, 5000, 500, 60000));
  return {
    enabled: source.command_watchdog_enabled === true,
    action,
    sampleMs,
    stallMs: Math.max(
      sampleMs * 2,
      Math.round(boundedNumber(source.command_watchdog_stall_ms, 60000, 3000, 3600000)),
    ),
    cpuDeltaThresholdMs: boundedNumber(source.command_watchdog_cpu_delta_ms, 10, 0, 60000),
    rssDeltaThresholdBytes: Math.round(boundedNumber(
      source.command_watchdog_rss_delta_bytes,
      1048576,
      0,
      1073741824,
    )),
    progressMs: Math.round(boundedNumber(
      source.command_watchdog_progress_ms,
      10000,
      1000,
      300000,
    )),
  };
}

function execFile(file: string, args: string[], timeout = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(
      file,
      args,
      { timeout, windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || error).trim()));
          return;
        }
        resolve(String(stdout || ""));
      },
    );
  });
}

function parseJsonOutput(text: string): Record<string, unknown> {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(lines[i]) as unknown;
      if (value && typeof value === "object") return value as Record<string, unknown>;
    } catch { /* try previous line */ }
  }
  throw new Error("process_telemetry_invalid_json");
}

async function sampleWindows(rootPid: number): Promise<Record<string, unknown>> {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$rootPid=[int]${rootPid}`,
    "$all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize)",
    "$ids=New-Object 'System.Collections.Generic.HashSet[int]'",
    "[void]$ids.Add($rootPid)",
    "do{$added=$false;foreach($p in $all){$pp=[int]$p.ParentProcessId;$childId=[int]$p.ProcessId;if($ids.Contains($pp)-and $ids.Add($childId)){$added=$true}}}while($added)",
    "$sel=@($all|Where-Object{$ids.Contains([int]$_.ProcessId)})",
    "$cpu=0.0;$rss=0.0",
    "foreach($p in $sel){$cpu+=[double]$p.KernelModeTime+[double]$p.UserModeTime;$rss+=[double]$p.WorkingSetSize}",
    "[pscustomobject]@{rootPid=$rootPid;alive=($sel.Count-gt 0);processCount=$sel.Count;cpuTimeMs=[math]::Round($cpu/10000,3);rssBytes=[math]::Round($rss);gpuAvailable=$false}|ConvertTo-Json -Compress",
  ].join(";");
  const stdout = await execFile("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);
  return parseJsonOutput(stdout);
}

function parsePsCpuTime(value: string): number {
  const text = String(value || "").trim();
  if (!text) return 0;
  const daySplit = text.split("-");
  const clock = (daySplit.pop() || "").split(":").map(Number);
  if (clock.some((n) => !Number.isFinite(n))) return 0;
  let seconds = 0;
  if (clock.length === 3) seconds = clock[0] * 3600 + clock[1] * 60 + clock[2];
  else if (clock.length === 2) seconds = clock[0] * 60 + clock[1];
  else seconds = clock[0] || 0;
  if (daySplit.length) seconds += Number(daySplit[0]) * 86400;
  return seconds * 1000;
}

async function samplePosix(rootPid: number): Promise<Record<string, unknown>> {
  const stdout = await execFile("ps", ["-axo", "pid=,ppid=,time=,rss="]);
  const rows: Array<{ pid: number; ppid: number; cpuTimeMs: number; rssBytes: number }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuTimeMs: parsePsCpuTime(match[3]),
      rssBytes: Number(match[4]) * 1024,
    });
  }
  const ids = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (ids.has(row.ppid) && !ids.has(row.pid)) {
        ids.add(row.pid);
        changed = true;
      }
    }
  }
  const selected = rows.filter((row) => ids.has(row.pid));
  return {
    rootPid,
    alive: selected.some((row) => row.pid === rootPid),
    processCount: selected.length,
    cpuTimeMs: selected.reduce((sum, row) => sum + row.cpuTimeMs, 0),
    rssBytes: selected.reduce((sum, row) => sum + row.rssBytes, 0),
    gpuAvailable: false,
  };
}

export async function sampleProcessTree(rootPid: number): Promise<ProcessTelemetrySample> {
  const pid = Number(rootPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return {
      available: false,
      rootPid: null,
      alive: false,
      processCount: 0,
      cpuTimeMs: 0,
      rssBytes: 0,
      gpuAvailable: false,
      error: "process_telemetry_invalid_pid",
    };
  }
  try {
    const sample = process.platform === "win32"
      ? await sampleWindows(pid)
      : await samplePosix(pid);
    return {
      available: true,
      rootPid: pid,
      alive: sample.alive === true,
      processCount: Math.max(0, Number(sample.processCount) || 0),
      cpuTimeMs: Math.max(0, Number(sample.cpuTimeMs) || 0),
      rssBytes: Math.max(0, Number(sample.rssBytes) || 0),
      gpuAvailable: false,
      sampledAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      available: false,
      rootPid: pid,
      alive: true,
      processCount: null,
      cpuTimeMs: null,
      rssBytes: null,
      gpuAvailable: false,
      sampledAt: new Date().toISOString(),
      error: String(error instanceof Error ? error.message : error || "process_telemetry_unavailable").slice(0, 240),
    };
  }
}

function safeEmit<T>(callback: ((payload: T) => void) | undefined, payload: T): void {
  if (typeof callback !== "function") return;
  try { callback(payload); } catch { /* progress must not break command execution */ }
}

export function startCommandWatchdog({
  rootPid,
  runtimePolicy,
  readOutputBytes,
  onProgress,
  onStall,
  sampler = sampleProcessTree,
  now = () => Date.now(),
}: {
  rootPid: number;
  runtimePolicy?: Record<string, unknown>;
  readOutputBytes?: () => number;
  onProgress?: (progress: CommandWatchdogProgress) => void;
  onStall?: (progress: CommandWatchdogProgress) => void;
  sampler?: (pid: number) => Promise<ProcessTelemetrySample>;
  now?: () => number;
}) {
  const policy = normalizeCommandWatchdogPolicy(runtimePolicy);
  if (!policy.enabled) return { enabled: false, stop() {} };

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let previousSample: ProcessTelemetrySample | null = null;
  let previousOutputBytes = Math.max(0, Number(readOutputBytes?.()) || 0);
  let lastActivityAt = now();
  let lastProgressAt = 0;
  let stalledReported = false;
  let unavailableReported = false;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(tick, policy.sampleMs);
    timer.unref?.();
  };

  const tick = async () => {
    if (stopped) return;
    const sample = await sampler(rootPid);
    if (stopped) return;
    const sampledAtMs = now();
    const outputBytes = Math.max(0, Number(readOutputBytes?.()) || 0);
    const outputDeltaBytes = Math.max(0, outputBytes - previousOutputBytes);

    if (!sample?.available) {
      if (!unavailableReported || sampledAtMs - lastProgressAt >= policy.progressMs) {
        unavailableReported = true;
        lastProgressAt = sampledAtMs;
        safeEmit(onProgress, {
          phase: "telemetry_unavailable",
          pid: Number(rootPid) || null,
          sampledAt: sample?.sampledAt || new Date(sampledAtMs).toISOString(),
          outputBytes,
          gpuAvailable: false,
          errorCode: "process_telemetry_unavailable",
          sampleError: sample?.error || "process_telemetry_unavailable",
        });
      }
      previousOutputBytes = outputBytes;
      schedule();
      return;
    }

    unavailableReported = false;
    const cpuDeltaMs = previousSample
      ? Math.max(0, Number(sample.cpuTimeMs) - Number(previousSample.cpuTimeMs))
      : 0;
    const rssDeltaBytes = previousSample
      ? Math.abs(Number(sample.rssBytes) - Number(previousSample.rssBytes))
      : 0;
    const processCountChanged = previousSample
      ? Number(sample.processCount) !== Number(previousSample.processCount)
      : false;
    const active = outputDeltaBytes > 0
      || (previousSample !== null && cpuDeltaMs > policy.cpuDeltaThresholdMs)
      || (previousSample !== null && rssDeltaBytes > policy.rssDeltaThresholdBytes)
      || processCountChanged;
    if (active) {
      lastActivityAt = sampledAtMs;
      stalledReported = false;
    }
    const idleForMs = Math.max(0, sampledAtMs - lastActivityAt);
    const progress: CommandWatchdogProgress = {
      phase: idleForMs >= policy.stallMs ? "stalled" : "running",
      pid: Number(rootPid) || null,
      sampledAt: sample.sampledAt || new Date(sampledAtMs).toISOString(),
      processCount: sample.processCount,
      cpuTimeMs: sample.cpuTimeMs,
      cpuDeltaMs,
      rssBytes: sample.rssBytes,
      rssDeltaBytes,
      outputBytes,
      outputDeltaBytes,
      idleForMs,
      watchdogAction: policy.action,
      gpuAvailable: false,
    };

    const firstStall = progress.phase === "stalled" && !stalledReported;
    if (sampledAtMs - lastProgressAt >= policy.progressMs || firstStall) {
      lastProgressAt = sampledAtMs;
      safeEmit(onProgress, progress);
    }
    if (progress.phase === "stalled" && !stalledReported) {
      stalledReported = true;
      safeEmit(onStall, { ...progress, errorCode: "command_stalled" });
      if (policy.action === "terminate") {
        stopped = true;
        return;
      }
    }

    previousSample = sample;
    previousOutputBytes = outputBytes;
    schedule();
  };

  schedule();
  return {
    enabled: true,
    policy,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
