'use client';
import Link from 'next/link';
import { useProfile } from '@/lib/hooks/useProfile';
import PageHeader from '@/components/ui/PageHeader';
import UsageGrid from '@/components/usage/UsageGrid';

const quickLinks = [
  { href: '/billing', label: 'View billing', sub: 'Invoices and payments' },
  { href: '/usage', label: 'Live usage', sub: 'Real-time counters' },
  { href: '/history', label: 'Invoice history', sub: 'Past billing periods' },
];

export default function DashboardPage() {
  const { profile, isLoading } = useProfile();

  return (
    <div>
      <PageHeader title="Dashboard">
        <span className="text-[13px] text-gray-400">
          Welcome back,{' '}
          {isLoading ? (
            <span className="inline-block w-20 h-3 bg-gray-200 rounded animate-pulse align-middle" />
          ) : (
            <span className="text-gray-700 font-medium">{profile?.displayName ?? 'there'}</span>
          )}
        </span>
      </PageHeader>

      <UsageGrid />

      {/* Quick links */}
      <div className="bg-white border border-[#e5e7eb] rounded-[8px] p-5">
        <h2 className="text-[14px] font-semibold text-gray-900 mb-4">Quick links</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {quickLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="flex flex-col gap-1 border border-[#e5e7eb] rounded-[8px] p-4 hover:bg-brand-light transition-colors"
            >
              <span className="text-[13px] font-semibold text-gray-900">{link.label}</span>
              <span className="text-[12px] text-gray-400">{link.sub}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
