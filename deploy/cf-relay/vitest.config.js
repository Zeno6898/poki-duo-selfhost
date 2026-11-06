import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: { TOKEN_SECRET: 'test-secret-test-secret-test-secret-0123', PER_MINUTE: '30', LABEL_DAILY: '40', LEASE: '5', REQ_TIMEOUT_MS: '1500' },
      },
    }),
  ],
});
