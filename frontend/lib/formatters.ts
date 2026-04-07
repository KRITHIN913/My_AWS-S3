
export function formatBytes(n: string | bigint): string {
  const v = typeof n === 'string' ? BigInt(n) : n;
  if (v < 1024n) return `${v} B`;
  if (v < 1048576n) return `${v / 1024n} KB`;
  if (v < 1073741824n) return `${Number(v * 10n / 1048576n) / 10} MB`;
  return `${Number(v * 10n / 1073741824n) / 10} GB`;
}

export function formatUcents(n: string | bigint): string {
  const v = typeof n === 'string' ? BigInt(n) : n;
  return `$${(Number(v) / 1_000_000).toFixed(2)}`;
}

export function formatPeriod(p: string): string {
  const parts = p.split('-');
  const y = parts[0] ?? '2026';
  const m = parts[1] ?? '01';
  return new Date(Number(y), Number(m) - 1).toLocaleString('en', {
    month: 'short',
    year: 'numeric',
  });
}
