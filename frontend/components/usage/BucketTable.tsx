'use client';
import { useBuckets } from '@/lib/hooks/useBuckets';
import { formatBytes } from '@/lib/formatters';
import Badge from '@/components/ui/Badge';
import type { ComponentProps } from 'react';

type BadgeVariant = ComponentProps<typeof Badge>['variant'];

function bucketStatusVariant(status: string): BadgeVariant {
  if (status === 'active') return 'active';
  if (status === 'suspended') return 'warning';
  if (status === 'deleted') return 'danger';
  return 'neutral';
}

export default function BucketTable() {
  const { buckets, isLoading, error, mutate } = useBuckets();

  if (isLoading) {
    return (
      <div className="bg-white border border-[#e5e7eb] rounded-[8px] p-6 animate-pulse">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-10 bg-gray-100 rounded mb-2" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white border border-[#e5e7eb] rounded-[8px] p-6 flex items-center gap-4">
        <p className="text-[13px] text-gray-500">Failed to load buckets.</p>
        <button onClick={() => mutate()} className="text-[12px] text-brand underline">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white border border-[#e5e7eb] rounded-[8px] overflow-hidden">
      <div className="px-5 py-4 border-b border-[#e5e7eb]">
        <h3 className="text-[14px] font-semibold text-gray-900">Buckets</h3>
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-[#e5e7eb]">
            {['Name', 'Size', 'Status', 'Created'].map((h) => (
              <th
                key={h}
                className="px-5 py-3 text-left text-[11px] uppercase text-gray-400 font-medium tracking-wide"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {buckets.map((bucket) => (
            <tr key={bucket.id} className="border-b border-[#e5e7eb] last:border-0 hover:bg-gray-50">
              <td className="px-5 py-3 text-[13px] text-gray-900 font-medium font-mono">
                {bucket.name}
              </td>
              <td className="px-5 py-3 text-[13px] text-gray-600">
                {formatBytes(bucket.lastKnownSizeBytes)}
              </td>
              <td className="px-5 py-3">
                <Badge variant={bucketStatusVariant(bucket.status)}>{bucket.status}</Badge>
              </td>
              <td className="px-5 py-3 text-[13px] text-gray-400">
                {new Date(bucket.createdAt).toLocaleDateString('en', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </td>
            </tr>
          ))}
          {buckets.length === 0 && (
            <tr>
              <td colSpan={4} className="px-5 py-10 text-center text-[13px] text-gray-400">
                No buckets yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
