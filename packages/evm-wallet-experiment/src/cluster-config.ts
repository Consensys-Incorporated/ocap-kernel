import type { ClusterConfig, VatConfig } from '@metamask/ocap-kernel';

/**
 * Options for creating a wallet cluster configuration.
 */
export type WalletClusterConfigOptions = {
  bundleBaseUrl: string;
  role?: 'home' | 'away';
  forceReset?: boolean;
  services?: string[];
  // Each admits its subdomains too.
  allowedHosts?: string[];
};

/**
 * Create a ClusterConfig for the wallet subcluster.
 *
 * @param options - Configuration options.
 * @returns The cluster configuration.
 */
export function makeWalletClusterConfig(
  options: WalletClusterConfigOptions,
): ClusterConfig {
  const {
    bundleBaseUrl,
    role = 'home',
    services = ['ocapURLIssuerService', 'ocapURLRedemptionService'],
    allowedHosts,
  } = options;

  const coordinatorBundle =
    role === 'home'
      ? `${bundleBaseUrl}/home-coordinator.bundle`
      : `${bundleBaseUrl}/away-coordinator.bundle`;

  const auxiliaryVat: Record<string, VatConfig> =
    role === 'home'
      ? {
          delegator: {
            bundleSpec: `${bundleBaseUrl}/delegator-vat.bundle`,
            globals: ['crypto'],
          },
        }
      : {
          redeemer: {
            bundleSpec: `${bundleBaseUrl}/redeemer-vat.bundle`,
            globals: [],
          },
        };

  return {
    bootstrap: 'coordinator',
    forceReset: options.forceReset ?? false,
    services,
    vats: {
      coordinator: {
        bundleSpec: coordinatorBundle,
        globals: ['Date', 'setTimeout'],
      },
      keyring: {
        bundleSpec: `${bundleBaseUrl}/keyring-vat.bundle`,
        globals: ['crypto'],
      },
      provider: {
        bundleSpec: `${bundleBaseUrl}/provider-vat.bundle`,
        globals: allowedHosts ? ['URL', 'Request', 'Headers', 'Response'] : [],
        ...(allowedHosts && {
          platformConfig: {
            http: { hosts: allowedHosts },
          },
        }),
      },
      ...auxiliaryVat,
    },
  };
}
