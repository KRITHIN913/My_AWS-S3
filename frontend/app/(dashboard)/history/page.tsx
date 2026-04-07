import ComingSoon from '@/components/ui/ComingSoon';

export default function HistoryPage() {
  return (
    <ComingSoon
      title="Invoice History"
      description="View all past billing periods, download PDF invoices, and compare usage trends."
      icon={
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ff808f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
      }
    />
  );
}
