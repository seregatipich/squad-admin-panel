/**
 * The server-detail page keeps its data current on its own: it re-requests
 * /api/v1/servers/:id without a manual reload. The page shows no
 * "обновлено Xс назад" freshness pill — the data itself is the signal.
 * This spec pins:
 *   - the page re-polls the server endpoint without a reload,
 *   - no freshness status is rendered.
 */
import { expect, test } from '@playwright/test';
import { loginAndAttachCookie, runSql, seedOwner, teardownOwner } from './helpers';

test.describe('server detail live refresh', () => {
  test('re-polls the server without manual reload and shows no freshness pill', async ({
    page,
    context,
  }) => {
    const seed = await seedOwner();
    try {
      await loginAndAttachCookie(page, context, null as never, seed);

      const anyServerId = runSql('SELECT id FROM servers LIMIT 1');
      if (!anyServerId) {
        test.skip(true, 'no server rows — create one first');
        return;
      }

      let polls = 0;
      page.on('response', (response) => {
        if (new URL(response.url()).pathname === `/api/v1/servers/${anyServerId}`) polls += 1;
      });
      await page.goto(`/servers/${anyServerId}`);

      await expect.poll(() => polls, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
      await expect(page.getByText(/обновлено \d+с назад/)).toHaveCount(0);

      // Подключение RCON подписано словом рядом с точкой — на него и опираемся,
      // а не на класс заливки.
      await expect(page.getByText('подключён').first()).toBeVisible();
    } finally {
      await teardownOwner(seed.uid);
    }
  });
});
