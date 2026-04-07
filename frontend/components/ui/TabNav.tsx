'use client';
import clsx from 'clsx';

interface TabNavProps {
  tabs: string[];
  active: string;
  onChange?: (tab: string) => void;
}

export default function TabNav({ tabs, active, onChange }: TabNavProps) {
  return (
    <div className="flex border-b border-[#e5e7eb] mb-6">
      {tabs.map((tab) => (
        <button
          key={tab}
          onClick={() => onChange?.(tab)}
          className={clsx(
            'px-4 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors',
            tab === active
              ? 'border-brand text-brand'
              : 'border-transparent text-gray-500 hover:text-gray-700',
          )}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}
