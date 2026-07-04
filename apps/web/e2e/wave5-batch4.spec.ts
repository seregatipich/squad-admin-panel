import { expect, test } from './_fixtures';
import { runSql } from './helpers';

test.describe('wave-5 batch 4 (Owner)', () => {
  test('server detail page shows live players + chat panels (MOD-1, CHAT-1)', async ({
    ownerPage,
  }) => {
    const id = runSql('SELECT gen_random_uuid()');
    const suffix = id.slice(0, 8);
    runSql(
      `INSERT INTO servers (id, display_name, slug, status) VALUES ('${id}', 'b4 probe ${suffix}', 'b4-probe-${suffix}', 'running')`,
    );
    try {
      await ownerPage.goto(`/servers/${id}`);
      const body = ownerPage.locator('body');
      await expect(body).toContainText(/чат/i, { timeout: 10_000 });
      await expect(body).toContainText(/игрок|онлайн/i, { timeout: 10_000 });
    } finally {
      runSql(`DELETE FROM servers WHERE id='${id}'`);
    }
  });
});
