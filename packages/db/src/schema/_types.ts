import { customType } from 'drizzle-orm/pg-core';

/** Postgres `bytea` column mapped to a Node `Buffer`; shared by every table that stores binary data. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});
