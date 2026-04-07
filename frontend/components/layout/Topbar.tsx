'use client';

interface TopbarProps {
  displayName?: string;
}

export default function Topbar({ displayName }: TopbarProps) {
  const name = displayName ?? 'My Team';
  const initials = name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'MT';

  return (
    <header className="flex items-center gap-3 h-[52px] px-6 bg-white border-b border-[#e5e7eb] shrink-0">
      <input
        type="text"
        placeholder="Search resources..."
        className="h-8 px-3 bg-[#f4f6f8] border border-[#e5e7eb] rounded-md text-[13px] text-gray-700 placeholder-gray-400 outline-none focus:ring-1 focus:ring-brand w-full max-w-sm"
      />

      <div className="flex-1" />


      <span className="text-[13px] text-gray-500 whitespace-nowrap">{name}</span>

      <div
        className="w-[30px] h-[30px] rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0 select-none"
        style={{ background: '#ffecdd', color: '#ff808f' }}
      >
        {initials}
      </div>
    </header>
  );
}
