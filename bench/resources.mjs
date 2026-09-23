// ps CPU time is cumulative per PID. Keep only intervals wholly within load,
// without treating a restarted node's counter as a continuation of its old PID.
export function cpuMilliseconds(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (!match) return null;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  if (+seconds >= 60 || (match[2] !== undefined && +minutes >= 60)) return null;
  const value = ((+days * 24 + +hours) * 3600 + +minutes * 60 + +seconds) * 1000;
  return Number.isFinite(value) ? value : null;
}

export class ServerCpuSamples {
  previous = new Map();
  totals = new Map();
  record(id, pid, cpuMs, elapsedMs, phase) {
    if (!Number.isFinite(cpuMs) || cpuMs < 0) return;
    const previous = this.previous.get(id);
    this.previous.set(id, { pid, cpuMs, elapsedMs, phase });
    if (phase !== "load" || previous?.phase !== "load" || previous.pid !== pid
      || elapsedMs <= previous.elapsedMs || cpuMs < previous.cpuMs) return;
    const total = this.totals.get(id) ?? { cpuMs: 0, sampledWallMs: 0, intervals: 0 };
    total.cpuMs += cpuMs - previous.cpuMs;
    total.sampledWallMs += elapsedMs - previous.elapsedMs;
    total.intervals++;
    this.totals.set(id, total);
  }
  snapshot() {
    return Object.fromEntries([...this.totals].map(([id, total]) => [id, {
      ...total, meanCores: total.cpuMs / total.sampledWallMs,
    }]));
  }
}
