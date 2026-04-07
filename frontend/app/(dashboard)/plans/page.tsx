'use client';

export default function PlansPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[22px] font-semibold text-gray-900 tracking-tight">
          Subscription Plans
        </h1>
        <p className="text-gray-400 text-[13px] mt-0.5">
          Manage your subscription and usage tier.
        </p>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center py-20 border border-gray-200 rounded-xl bg-white">
        <div className="w-16 h-16 rounded-full bg-brand/10 flex items-center justify-center mb-6">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ff808f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect>
            <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path>
          </svg>
        </div>
        <h2 className="text-lg font-medium text-gray-900 mb-2">Plans coming soon</h2>
        <p className="text-gray-400 text-center max-w-md text-sm leading-relaxed mb-6">
          We are currently revamping our subscription engine to provide more flexible tiers 
          and features. In the meantime, enjoy full access on your current tier.
        </p>
        <button 
          disabled
          className="px-6 py-2.5 rounded-lg text-sm font-medium bg-gray-50 text-gray-400 border border-gray-200 cursor-not-allowed"
        >
          View Enterprise Details
        </button>
      </div>
    </div>
  );
}
