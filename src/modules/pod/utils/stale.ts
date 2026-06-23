export function resolvePostProcessStaleMinutes(staleMinutes?: number) {
  const value = Number(
    staleMinutes || process.env.POD_POST_PROCESS_STALE_MINUTES || 10
  );
  if (!Number.isFinite(value)) {
    return 10;
  }
  return Math.min(Math.max(value, 1), 1440);
}

export function isStaleTime(value: any, staleMinutes: number) {
  if (!value) {
    return true;
  }
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) {
    return true;
  }
  return time <= Date.now() - staleMinutes * 60 * 1000;
}
