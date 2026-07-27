import type { Metadata } from 'next';
import { UploadClient } from './UploadClient';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Загрузка доказательства — Squad Admin Panel',
  description: 'Одноразовая ссылка для загрузки видео или скриншота без входа в панель.',
  robots: { index: false, follow: false },
};

interface UploadPageProps {
  params: Promise<{ token: string }>;
}

/**
 * Public, no-session upload page behind a one-time link (VIDEO-3, #159). The
 * token stays entirely client-side — it is handed to `UploadClient`, which
 * passes it straight to `POST /api/v1/public/media`; the server component does
 * not validate it, so an invalid link fails at upload time with the same `410`
 * as a spent one and the page leaks nothing about which tokens exist.
 */
export default async function UploadPage({ params }: UploadPageProps) {
  const { token } = await params;
  return <UploadClient token={token} />;
}
