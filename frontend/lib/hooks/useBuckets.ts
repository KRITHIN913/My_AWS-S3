'use client';
import useSWR from 'swr';
import { fetchBuckets, type Bucket } from '@/lib/api';
import { mockBuckets } from '@/lib/mockData';

export function useBuckets() {
  const isMock = process.env['NEXT_PUBLIC_USE_MOCK'] === 'true';

  const { data, error, isLoading, mutate } = useSWR<{ buckets: Bucket[] }>(
    isMock ? null : '/portal/buckets',
    isMock ? null : fetchBuckets,
    { shouldRetryOnError: false, revalidateOnFocus: false, dedupingInterval: 30_000 },
  );

  if (isMock) {
    return {
      buckets: mockBuckets,
      error: null,
      isLoading: false,
      mutate: async () => undefined,
    };
  }

  return { buckets: data?.buckets ?? [], error, isLoading, mutate };
}
