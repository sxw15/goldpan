import { redirect } from 'next/navigation';

interface Props {
  searchParams: Promise<{ focus?: string }>;
}

export default async function LibraryEntitiesPage({ searchParams }: Props) {
  const { focus } = await searchParams;
  const qs = focus ? `?focus=${encodeURIComponent(focus)}` : '';
  redirect(`/library${qs}`);
}
