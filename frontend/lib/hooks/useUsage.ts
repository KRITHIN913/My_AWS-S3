'use client';
import useSWR from 'swr';
import { fetchUsage, type UsageCurrent } from '@/lib/api';
import { mockUsage } from '@/lib/mockData';

export function useUsage() {
  const isMock = process.env['NEXT_PUBLIC_USE_MOCK'] === 'true';

  const { data, error, isLoading, mutate } = useSWR<UsageCurrent>(
    isMock ? null : '/portal/usage/current',
    isMock ? null : fetchUsage,
    { shouldRetryOnError: false, revalidateOnFocus: true, refreshInterval: 60_000 },
  );

  if (isMock) {
    return {
      usage: mockUsage,
      error: null,
      isLoading: false,
      mutate: async () => undefined,
    };
  }

  return { usage: data, error, isLoading, mutate };
}
