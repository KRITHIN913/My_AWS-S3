'use client';
import useSWR from 'swr';
import { fetchProfile, type Profile } from '@/lib/api';
import { mockProfile } from '@/lib/mockData';

export function useProfile() {
  const isMock = process.env['NEXT_PUBLIC_USE_MOCK'] === 'true';

  const { data, error, isLoading, mutate } = useSWR<{ profile: Profile }>(
    isMock ? null : '/portal/profile',
    isMock ? null : fetchProfile,
    { shouldRetryOnError: false, revalidateOnFocus: false, dedupingInterval: 30_000 },
  );

  if (isMock) {
    return {
      profile: mockProfile,
      error: null,
      isLoading: false,
      mutate: async () => undefined,
    };
  }

  return { profile: data?.profile, error, isLoading, mutate };
}
