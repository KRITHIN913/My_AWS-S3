'use client';
import { useInvoices } from '@/lib/hooks/useInvoices';
import { formatBytes, formatUcents, formatPeriod } from '@/lib/formatters';
import Badge from '@/components/ui/Badge';
import type { ComponentProps } from 'react';

type BadgeVariant = ComponentProps<typeof Badge>['variant'];

function statusVariant(status: string): BadgeVariant {
  if (status === 'finalised') return 'success';
  if (status === 'void') return 'danger';
  return 'neutral';
}

const COLS = ['Period', 'Storage avg', 'Ingress', 'Egress', 'Buckets', 'Total', 'Status', ''];

export default function InvoiceTable() {
  const { invoices, isLoading, error, mutate } = useInvoices();

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
        <p className="text-[13px] text-gray-500">Failed to load invoices.</p>
        <button onClick={() => mutate()} className="text-[12px] text-brand underline">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white border border-[#e5e7eb] rounded-[8px] overflow-hidden">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-[#e5e7eb]">
            {COLS.map((h) => (
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
          {invoices.map((inv) => (
            <tr key={inv.id} className="border-b border-[#e5e7eb] last:border-0 hover:bg-gray-50">
              <td className="px-5 py-3 text-[13px] text-gray-900 font-medium">
                {formatPeriod(inv.billingPeriod)}
              </td>
              <td className="px-5 py-3 text-[13px] text-gray-600">{formatBytes(inv.storageByteAvg)}</td>
              <td className="px-5 py-3 text-[13px] text-gray-600">{formatBytes(inv.ingressBytes)}</td>
              <td className="px-5 py-3 text-[13px] text-gray-600">{formatBytes(inv.egressBytes)}</td>
              <td className="px-5 py-3 text-[13px] text-gray-600">{inv.bucketCount}</td>
              <td className="px-5 py-3 text-[13px] text-gray-900 font-medium">
                {formatUcents(inv.totalChargeUcents)}
              </td>
              <td className="px-5 py-3">
                <Badge variant={statusVariant(inv.status)}>{inv.status}</Badge>
              </td>
              <td className="px-5 py-3">
                <button className="text-[12px] text-brand cursor-pointer hover:underline">
                  View
                </button>
              </td>
            </tr>
          ))}
          {invoices.length === 0 && (
            <tr>
              <td colSpan={8} className="px-5 py-10 text-center text-[13px] text-gray-400">
                No invoices yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
