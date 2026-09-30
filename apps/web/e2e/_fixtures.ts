import { type BrowserContext, test as base, type Page } from '@playwright/test';
import { loginAndAttachCookie, seedOwner, teardownOwner } from './helpers';

interface Fixtures {
  ownerPage: Page;
  unauthedPage: Page;
}

export const test = base.extend<Fixtures>({
  ownerPage: async ({ browser }, use) => {
    const seed = await seedOwner();
    let ctx: BrowserContext | undefined;
    try {
      ctx = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await ctx.newPage();
      await loginAndAttachCookie(ctx, seed);
      await use(page);
    } finally {
      await ctx?.close().catch(() => {});
      await teardownOwner(seed.uid);
    }
  },
  unauthedPage: async ({ browser }, use) => {
    const ctx: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await use(page);
    await ctx.close();
  },
});

export { expect } from '@playwright/test';
