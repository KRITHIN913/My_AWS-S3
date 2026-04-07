import React from 'react';

interface ComingSoonProps {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
}

export default function ComingSoon({
  title = 'Coming Soon',
  description = 'This page is currently under construction. Check back soon!',
  icon,
}: ComingSoonProps) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 min-h-[60vh] px-8 text-center">
      <div className="w-16 h-16 rounded-full bg-brand/10 border border-brand/20 flex items-center justify-center mb-6">
        {icon ?? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ff808f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        )}
      </div>
      <h2 className="text-xl font-semibold text-gray-900 mb-2">{title}</h2>
      <p className="text-gray-400 max-w-sm text-sm leading-relaxed">{description}</p>
    </div>
  );
}
