import ComingSoon from '@/components/ui/ComingSoon';

export default function ProfilePage() {
  return (
    <ComingSoon
      title="Profile"
      description="Manage your account details, notification preferences, and API keys."
      icon={
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ff808f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
        </svg>
      }
    />
  );
}
