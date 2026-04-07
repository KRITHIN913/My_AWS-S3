'use client';
import { useInvoices } from '@/lib/hooks/useInvoices';
import { useUsage } from '@/lib/hooks/useUsage';
import { formatUcents, formatPeriod } from '@/lib/formatters';

export default function BillingOverview() {
  const { invoices, isLoading: invLoading, error: invError, mutate: mutateInv } = useInvoices();
  const { usage, isLoading: usageLoading } = useUsage();

  if (invLoading || usageLoading) {
    return (
      <div className="bg-white border border-[#e5e7eb] rounded-[8px] p-6 animate-pulse">
        <div className="h-4 bg-gray-100 rounded w-1/3 mb-4" />
        <div className="h-10 bg-gray-100 rounded w-1/4 mb-2" />
        <div className="h-3 bg-gray-100 rounded w-1/2" />
      </div>
    );
  }

  if (invError) {
    return (
      <div className="bg-white border border-[#e5e7eb] rounded-[8px] p-6 flex items-center gap-4">
        <p className="text-[13px] text-gray-500">Failed to load billing overview.</p>
        <button onClick={() => mutateInv()} className="text-[12px] text-brand underline">
          Retry
        </button>
      </div>
    );
  }

  const latest = invoices[0];
  const period = usage?.period ?? new Date().toISOString().slice(0, 7);
  const overdueTotal = invoices
    .filter((i) => i.status === 'past_due')
    .reduce((acc, i) => acc + BigInt(i.totalChargeUcents), 0n);

  return (
    <div className="bg-white border border-[#e5e7eb] rounded-[8px] p-6">
      <div className="flex gap-8">
        {/* Left: estimated balance */}
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-gray-700 mb-2">
            Your estimated balance for{' '}
            <span className="text-gray-900">{formatPeriod(period)}</span>
          </p>
          <p className="text-[42px] font-[800] text-gray-900 leading-none mb-2">
            {latest ? formatUcents(latest.totalChargeUcents) : '$0.00'}
          </p>
          <p className="text-[13px] text-gray-400">
            Usage is calculated daily. Final bill is generated at month end.
          </p>
        </div>

        {/* Right: key figures */}
        <div className="flex flex-col gap-4 shrink-0 min-w-[200px]">
          <div>
            <p className="text-[11px] uppercase text-gray-400 font-medium mb-0.5">Payment due</p>
            <p className="text-[13px] text-gray-900 font-medium">May 01, 2026</p>
          </div>
          <div>
            <p className="text-[11px] uppercase text-gray-400 font-medium mb-0.5">Past due</p>
            <p className="text-[13px] font-semibold text-[#dc2626]">
              {overdueTotal > 0n ? formatUcents(overdueTotal) : 'None'}
            </p>
          </div>
          <div>
            <p className="text-[11px] uppercase text-gray-400 font-medium mb-0.5">Total usage</p>
            <p className="text-[13px] text-gray-900 font-medium">
              {latest ? formatUcents(latest.totalChargeUcents) : '—'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
