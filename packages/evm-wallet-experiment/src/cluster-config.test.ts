import { describe, it, expect } from 'vitest';

import { makeWalletClusterConfig } from './cluster-config.ts';

const BUNDLE_BASE_URL = 'http://localhost:3000';

describe('cluster-config', () => {
  describe('makeWalletClusterConfig', () => {
    it('defaults to home role', () => {
      const config = makeWalletClusterConfig({
        bundleBaseUrl: BUNDLE_BASE_URL,
      });

      expect(config.bootstrap).toBe('coordinator');
      expect(config.forceReset).toBe(false);
      expect(config.vats).toHaveProperty('coordinator');
      expect(config.vats).toHaveProperty('keyring');
      expect(config.vats).toHaveProperty('provider');
      expect(config.vats).toHaveProperty('delegator');
      expect(config.vats).not.toHaveProperty('redeemer');
    });

    it('uses home-coordinator.bundle for home role', () => {
      const config = makeWalletClusterConfig({
        bundleBaseUrl: BUNDLE_BASE_URL,
        role: 'home',
      });

      const coordConfig = config.vats.coordinator as { bundleSpec: string };
      expect(coordConfig.bundleSpec).toBe(
        `${BUNDLE_BASE_URL}/home-coordinator.bundle`,
      );
    });

    it('uses away-coordinator.bundle for away role', () => {
      const config = makeWalletClusterConfig({
        bundleBaseUrl: BUNDLE_BASE_URL,
        role: 'away',
      });

      const coordConfig = config.vats.coordinator as { bundleSpec: string };
      expect(coordConfig.bundleSpec).toBe(
        `${BUNDLE_BASE_URL}/away-coordinator.bundle`,
      );
      expect(config.vats).toHaveProperty('redeemer');
      expect(config.vats).not.toHaveProperty('delegator');
    });

    it('includes OCAP URL services by default', () => {
      const config = makeWalletClusterConfig({
        bundleBaseUrl: BUNDLE_BASE_URL,
      });

      expect(config.services).toStrictEqual([
        'ocapURLIssuerService',
        'ocapURLRedemptionService',
      ]);
    });

    it('allows custom services', () => {
      const config = makeWalletClusterConfig({
        bundleBaseUrl: BUNDLE_BASE_URL,
        services: ['customService'],
      });

      expect(config.services).toStrictEqual(['customService']);
    });

    it('has four vats for home role', () => {
      const config = makeWalletClusterConfig({
        bundleBaseUrl: BUNDLE_BASE_URL,
        role: 'home',
      });
      const vatNames = Object.keys(config.vats);

      expect(vatNames).toStrictEqual([
        'coordinator',
        'keyring',
        'provider',
        'delegator',
      ]);
    });

    it('has four vats for away role', () => {
      const config = makeWalletClusterConfig({
        bundleBaseUrl: BUNDLE_BASE_URL,
        role: 'away',
      });
      const vatNames = Object.keys(config.vats);

      expect(vatNames).toStrictEqual([
        'coordinator',
        'keyring',
        'provider',
        'redeemer',
      ]);
    });

    it('requests required globals for all vats', () => {
      const config = makeWalletClusterConfig({
        bundleBaseUrl: BUNDLE_BASE_URL,
      });

      const providerConfig = config.vats.provider as { globals?: string[] };
      expect(providerConfig.globals).toStrictEqual([]);

      for (const vatName of ['keyring', 'delegator']) {
        const vatConfig = config.vats[vatName] as { globals?: string[] };
        expect(vatConfig.globals).toStrictEqual(['crypto']);
      }

      const coordConfig = config.vats.coordinator as { globals?: string[] };
      expect(coordConfig.globals).toStrictEqual(['Date', 'setTimeout']);
    });

    it('defaults forceReset to false', () => {
      const config = makeWalletClusterConfig({
        bundleBaseUrl: BUNDLE_BASE_URL,
      });
      expect(config.forceReset).toBe(false);
    });

    it('respects forceReset true', () => {
      const config = makeWalletClusterConfig({
        bundleBaseUrl: BUNDLE_BASE_URL,
        forceReset: true,
      });
      expect(config.forceReset).toBe(true);
    });

    it('designates coordinator as the bootstrap vat', () => {
      const config = makeWalletClusterConfig({
        bundleBaseUrl: BUNDLE_BASE_URL,
      });
      expect(config.bootstrap).toBe('coordinator');
      expect(config.vats).toHaveProperty(config.bootstrap);
    });
  });
});
