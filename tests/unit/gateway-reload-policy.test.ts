import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GATEWAY_RELOAD_POLICY,
  parseGatewayReloadPolicy,
} from '@electron/gateway/reload-policy';

describe('parseGatewayReloadPolicy', () => {
  it('returns defaults when config is missing', () => {
    expect(parseGatewayReloadPolicy(undefined)).toEqual(DEFAULT_GATEWAY_RELOAD_POLICY);
  });

  it('parses mode and debounce from gateway.reload', () => {
    const result = parseGatewayReloadPolicy({
      gateway: {
        reload: {
          mode: 'off',
          debounceMs: 3000,
        },
      },
    });

    expect(result).toEqual({ mode: 'off', debounceMs: 3000 });
  });

  it('normalizes invalid mode and debounce bounds', () => {
    const negative = parseGatewayReloadPolicy({
      gateway: { reload: { mode: 'invalid', debounceMs: -100 } },
    });
    expect(negative).toEqual({
      mode: DEFAULT_GATEWAY_RELOAD_POLICY.mode,
      debounceMs: 0,
    });

    const overMax = parseGatewayReloadPolicy({
      gateway: { reload: { mode: 'hybrid', debounceMs: 600_000 } },
    });
    expect(overMax).toEqual({ mode: 'hybrid', debounceMs: 60_000 });
  });
});

