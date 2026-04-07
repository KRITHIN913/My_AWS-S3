'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { logout } from '@/lib/api';

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
}

function GridIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
    </svg>
  );
}
function GlobeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}
function CardIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="4" width="22" height="16" rx="2" /><line x1="1" y1="10" x2="23" y2="10" />
    </svg>
  );
}
function ActivityIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  );
}
function UserIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
    </svg>
  );
}
function SettingsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
function LogoutIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

const storageNav: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: <GridIcon /> },
  { label: 'Buckets',   href: '/buckets',   icon: <GlobeIcon /> },
];
const billingNav: NavItem[] = [
  { label: 'Billing', href: '/billing', icon: <CardIcon /> },
  { label: 'Usage', href: '/usage', icon: <ActivityIcon /> },
  { label: 'History', href: '/history', icon: <ClockIcon /> },
];
const accountNav: NavItem[] = [
  { label: 'Profile', href: '/profile', icon: <UserIcon /> },
  { label: 'Plans', href: '/plans', icon: <SettingsIcon /> },
  { label: 'Settings', href: '/settings', icon: <SettingsIcon /> },
];

function SectionLabel({ label }: { label: string }) {
  return (
    <p
      className="px-4 mt-5 mb-1 text-[10px] uppercase tracking-[0.08em] font-medium"
      style={{ color: 'rgba(255,255,255,0.35)' }}
    >
      {label}
    </p>
  );
}

function NavLink({ item, isActive }: { item: NavItem; isActive: boolean }) {
  return (
    <Link
      href={item.href}
      className={clsx(
        'flex items-center gap-[9px] mx-[6px] my-[1px] px-[12px] py-[7px] rounded-[6px] text-[13px] transition-colors duration-150',
        isActive ? 'bg-brand text-white' : 'text-white/65 hover:bg-[#1a2e47] hover:text-white/90',
      )}
    >
      {item.icon}
      <span>{item.label}</span>
    </Link>
  );
}

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex flex-col w-[210px] shrink-0 h-full bg-sidebar overflow-y-auto">
      {/* Logo row */}
      <div className="flex items-center gap-3 px-4 py-5 shrink-0">
        <div className="w-8 h-8 rounded-full bg-brand flex items-center justify-center text-white text-sm font-bold shrink-0">
          S
        </div>
        <span className="text-white text-sm font-semibold">StorageOS</span>
      </div>

      <SectionLabel label="Storage" />
      {storageNav.map((item) => (
        <NavLink key={item.href} item={item} isActive={pathname === item.href} />
      ))}

      <SectionLabel label="Billing" />
      {billingNav.map((item) => (
        <NavLink key={item.href} item={item} isActive={pathname === item.href} />
      ))}

      <SectionLabel label="Account" />
      {accountNav.map((item) => (
        <NavLink key={item.href} item={item} isActive={pathname === item.href} />
      ))}

      {/* Bottom external links + logout */}
      <div className="mt-auto px-4 pb-6 flex flex-col gap-2 pt-4">
        <a
          href="https://docs.storageos.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[13px] transition-colors hover:text-white/90"
          style={{ color: 'rgba(255,255,255,0.45)' }}
        >
          Docs ↗
        </a>
        <a
          href="mailto:support@storageos.dev"
          className="text-[13px] transition-colors hover:text-white/90"
          style={{ color: 'rgba(255,255,255,0.45)' }}
        >
          Support ↗
        </a>

        <button
          onClick={logout}
          className="flex items-center gap-[9px] mt-2 px-0 py-[6px] rounded-[6px] text-[13px] transition-colors duration-150 bg-transparent border-none cursor-pointer"
          style={{ color: 'rgba(255,255,255,0.45)' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#ff808f'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.45)'; }}
        >
          <LogoutIcon />
          <span>Sign out</span>
        </button>
      </div>
    </aside>
  );
}

