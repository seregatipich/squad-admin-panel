'use client';
import { loader } from '@monaco-editor/react';
import dynamic from 'next/dynamic';

// Serve the AMD loader from our own origin rather than a public CDN. The
// pinned `monaco-editor` dependency is vendored into `public/monaco/vs` by
// `scripts/sync-monaco.mjs` at build time, so the browser still gets the
// exact build this repo's dependency pins were audited against (#242) — but
// a client that cannot reach cdn.jsdelivr.net no longer hangs the editor on
// "Loading..." forever, and the page needs no CDN in its CSP.
loader.config({ paths: { vs: '/monaco/vs' } });

export const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });
export const MonacoDiff = dynamic(
  () => import('@monaco-editor/react').then((m) => ({ default: m.DiffEditor })),
  { ssr: false },
);
