import { expect, test } from './_fixtures';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngBytes(payloadLength = 512): Buffer {
  const payload = Buffer.alloc(payloadLength);
  for (let i = 0; i < payloadLength; i++) payload[i] = i % 256;
  return Buffer.concat([PNG_SIGNATURE, payload]);
}

/**
 * VIDEO-3 (#159) — browser confirmation of the delegated-upload acceptance
 * criteria that only a real browser can prove: that `/upload/<token>` renders
 * and uploads with no panel cookie in the context at all, and that the link
 * dies after one use.
 *
 * Runs only via `pnpm --filter @squad/web test:e2e` against a real stack; the
 * vitest config excludes `e2e/**`, so this never runs in the unit gate.
 */
test.describe('public one-time upload page', () => {
  test('uploads once with no panel session, then refuses the spent link', async ({
    ownerPage,
    unauthedPage,
  }) => {
    const mint = await ownerPage.request.post('/api/v1/media/upload-tokens', { data: {} });
    expect(mint.status()).toBe(201);
    const { token } = (await mint.json()) as { token: string };

    // A deliberately separate, cookie-less browser context.
    const cookiesBefore = await unauthedPage.context().cookies();
    expect(cookiesBefore.filter((c) => c.name === '__Host-sid')).toHaveLength(0);

    await unauthedPage.goto(`/upload/${encodeURIComponent(token)}`);
    await expect(unauthedPage.locator('h1')).toContainText('Загрузка доказательства');
    await expect(unauthedPage.getByTestId('upload-dropzone')).toBeVisible();

    await unauthedPage.getByTestId('upload-input').setInputFiles({
      name: 'evidence.png',
      mimeType: 'image/png',
      buffer: pngBytes(),
    });
    await expect(unauthedPage.getByRole('status')).toContainText('Файл загружен');

    // Still no session cookie was ever set on the anonymous context.
    const cookiesAfter = await unauthedPage.context().cookies();
    expect(cookiesAfter.filter((c) => c.name === '__Host-sid')).toHaveLength(0);

    await unauthedPage.reload();
    await unauthedPage.getByTestId('upload-input').setInputFiles({
      name: 'evidence-again.png',
      mimeType: 'image/png',
      buffer: pngBytes(256),
    });
    await expect(unauthedPage.getByRole('alert')).toContainText('уже использована или истекла');
  });
});
