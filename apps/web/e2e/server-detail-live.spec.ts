/**
 * The server-detail page polls /api/v1/servers/:id every 3 s and surfaces
 * the freshness as "обновлено Xс назад" + a pulsing dot. Before the
 * LiveIndicator addition the only timestamp was rcon_status.ts (worker-
 * published), which barely moved → users thought the page was stale.
 * This spec pins:
 *   - indicator is rendered,
 *   - counter resets back toward 0 once a new poll lands within the
 *     polling interval.
 */
import { expect, test } from '@playwright/test';
import { loginAndAttachCookie, runSql, seedOwner, teardownOwner, uniqueEmail } from './helpers';

test.describe('server detail live-refresh indicator', () => {
  test('indicator tick/reset proves the page polls without manual reload', async ({
    page,
    context,
    request,
  }) => {
    const email = uniqueEmail();
    const uid = await seedOwner(email);
    try {
      await loginAndAttachCookie(page, context, request, email);

      const anyServerId = runSql('SELECT id FROM servers LIMIT 1');
      if (!anyServerId) {
        test.skip(true, 'no server rows — create one first');
        return;
      }
      await page.goto(`/servers/${anyServerId}`);

      const indicator = page.locator('text=/обновлено \\d+с назад/');
      await expect(indicator).toBeVisible({ timeout: 10_000 });

      let sawReset = false;
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(500);
        const t = (await indicator.textContent())?.match(/(\d+)с/)?.[1];
        if (t && Number(t) <= 1) {
          sawReset = true;
          break;
        }
      }
      expect(sawReset, 'indicator never reset — polling appears broken').toBe(true);

      const dot = page.locator('span.bg-green-500, span.bg-green-700').first();
      await expect(dot).toBeVisible();
    } finally {
      await teardownOwner(uid);
    }
  });
});
