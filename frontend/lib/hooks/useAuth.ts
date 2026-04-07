'use client';
import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { isAuthenticated } from '@/lib/api';

/**
 * Call at the top of every dashboard layout/page.
 * Redirects to /login if no api_key in localStorage.
 */
export function useRequireAuth(): boolean {
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace(`/login?from=${encodeURIComponent(path)}`);
    }
  }, [path, router]);

  return isAuthenticated();
}

/**
 * Returns stored tenant meta (no API call — from localStorage).
 * Safe to call on server (returns null).
 */
export function useTenantMeta(): {
  displayName: string;
  email: string;
  slug: string;
} | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem('tenant_meta');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { displayName: string; email: string; slug: string };
  } catch {
    return null;
  }
}
