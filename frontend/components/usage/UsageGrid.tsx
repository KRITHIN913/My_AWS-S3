'use client';
import { useUsage } from '@/lib/hooks/useUsage';
import { formatBytes } from '@/lib/formatters';
import StatCard from '@/components/ui/StatCard';
import UsageBar from '@/components/ui/UsageBar';

export default function UsageGrid() {
  const { usage, isLoading, error, mutate } = useUsage();

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-white border border-[#e5e7eb] rounded-[8px] p-5 animate-pulse">
            <div className="h-3 bg-gray-100 rounded w-1/2 mb-3" />
            <div className="h-6 bg-gray-100 rounded w-3/4 mb-2" />
            <div className="h-2 bg-gray-100 rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (error || !usage) {
    return (
      <div className="bg-white border border-[#e5e7eb] rounded-[8px] p-5 mb-6 flex items-center gap-4">
        <p className="text-[13px] text-gray-500">Failed to load usage data.</p>
        <button onClick={() => mutate()} className="text-[12px] text-brand underline">
          Retry
        </button>
      </div>
    );
  }

  const cards = [
    {
      key: 'storage',
      label: 'Storage',
      value: formatBytes(usage.storageBytes),
      sublabel: `of ${formatBytes(usage.limits.maxStorageBytes)} limit`,
      pct: usage.pctUsed.storage,
    },
    {
      key: 'ingress',
      label: 'Ingress',
      value: formatBytes(usage.ingressBytes),
      sublabel: `of ${formatBytes(usage.limits.maxMonthlyIngressBytes)} limit`,
      pct: usage.pctUsed.ingress,
    },
    {
      key: 'egress',
      label: 'Egress',
      value: formatBytes(usage.egressBytes),
      sublabel: `of ${formatBytes(usage.limits.maxMonthlyEgressBytes)} limit`,
      pct: usage.pctUsed.egress,
    },
    {
      key: 'buckets',
      label: 'Buckets',
      value: usage.bucketCount,
      sublabel: `of ${usage.limits.maxBuckets} limit`,
      pct: usage.pctUsed.buckets,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      {cards.map((card) => (
        <StatCard key={card.key} label={card.label} value={card.value} sublabel={card.sublabel}>
          <UsageBar pct={card.pct} warn={card.pct >= 80} />
        </StatCard>
      ))}
    </div>
  );
}
