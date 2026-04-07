import ComingSoon from '@/components/ui/ComingSoon';

export default function BillingPage() {
  return (
    <ComingSoon
      title="Billing"
      description="Detailed invoice management, payment methods, and billing history coming soon."
      icon={
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ff808f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>
        </svg>
      }
    />
  );
}
