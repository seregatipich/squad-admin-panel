import { describe, expect, it } from 'vitest';
import { CONFIG_SECRET_MASK, maskConfigSecrets } from '../src/lib/config-secrets.js';

describe('maskConfigSecrets (#10)', () => {
  it('masks the Rcon.cfg password and keeps CRLF line endings', () => {
    expect(maskConfigSecrets('Rcon.cfg', 'Port=21114\r\nPassword=hunter2\r\nIP=0.0.0.0\r\n')).toBe(
      `Port=21114\r\nPassword=${CONFIG_SECRET_MASK}\r\nIP=0.0.0.0\r\n`,
    );
  });

  it('matches the key case-insensitively and with surrounding whitespace', () => {
    expect(maskConfigSecrets('Rcon.cfg', '  password = s3cret\n')).toBe(
      `  password = ${CONFIG_SECRET_MASK}\n`,
    );
  });

  it('leaves an empty password and commented examples alone', () => {
    const content = 'Password=\n//Password=example\n';
    expect(maskConfigSecrets('Rcon.cfg', content)).toBe(content);
  });

  it('masks the License.cfg key but not the license id', () => {
    expect(maskConfigSecrets('License.cfg', 'LicenseId=abc\nLicenseKey=real-key\n')).toBe(
      `LicenseId=abc\nLicenseKey=${CONFIG_SECRET_MASK}\n`,
    );
  });

  it('returns other files unchanged', () => {
    const content = 'Password=not-a-secret-here\n';
    expect(maskConfigSecrets('Server.cfg', content)).toBe(content);
  });
});
