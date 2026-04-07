import Link from 'next/link';

function BoltIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}
function ChartIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}
function ServerIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" /><line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  );
}

const features = [
  {
    icon: <BoltIcon />,
    title: 'Pay per byte',
    description: 'Only pay for the exact storage and bandwidth you use — no overage surprises.',
  },
  {
    icon: <ChartIcon />,
    title: 'Real-time metering',
    description:
      'Live ingress, egress, and storage counters updated continuously as your usage changes.',
  },
  {
    icon: <ServerIcon />,
    title: 'Full S3 compatibility',
    description:
      'Drop-in S3-compatible API so any existing tool or SDK works without modification.',
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Hero section */}
      <div className="bg-[#0f1c2e] flex-1 flex flex-col">
        {/* Nav */}
        <nav className="flex items-center justify-between px-8 py-5 max-w-6xl mx-auto w-full">
          <span className="text-white font-bold text-[18px] tracking-tight">StorageOS</span>
          <Link
            href="/login"
            className="text-[14px] text-white/70 hover:text-white transition-colors"
          >
            Sign in →
          </Link>
        </nav>

        {/* Hero content */}
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-24">
          <h1 className="text-5xl md:text-6xl font-black text-white leading-tight mb-6 max-w-3xl">
            S3-compatible storage.{' '}
            <span className="text-brand">Built for scale.</span>
          </h1>
          <p className="text-[18px] text-white/60 mb-10 max-w-xl">
            Metered billing, real-time usage monitoring, and multi-tenant isolation — all in one
            platform.
          </p>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 bg-brand text-white font-semibold px-8 py-3.5 rounded-lg text-[15px] hover:opacity-90 transition-opacity"
          >
            Get started →
          </Link>
        </div>
      </div>

      {/* Feature cards */}
      <div className="bg-[#f4f6f8] px-6 py-20">
        <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-6">
          {features.map((f) => (
            <div key={f.title} className="bg-white border border-[#e5e7eb] rounded-[8px] p-6">
              <div className="text-brand mb-4">{f.icon}</div>
              <h3 className="text-[16px] font-semibold text-gray-900 mb-2">{f.title}</h3>
              <p className="text-[13px] text-gray-500 leading-relaxed">{f.description}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <footer className="bg-[#f4f6f8] border-t border-[#e5e7eb] px-6 py-6 text-center">
        <p className="text-[13px] text-gray-400">© 2026 StorageOS. All rights reserved.</p>
      </footer>
    </div>
  );
}
