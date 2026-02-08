import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigurationService } from '../services/ConfigurationService';
import { __setConfigValue, __resetConfig } from '../__mocks__/vscode';

describe('ConfigurationService', () => {
  beforeEach(() => {
    __resetConfig();
  });

  describe('getConfig', () => {
    it('should return default values when no overrides', () => {
      const cfg = ConfigurationService.getConfig();
      expect(cfg.debugPort).toBe(5005);
      expect(cfg.testTimeout).toBe(300);
      expect(cfg.debugConnectionTimeout).toBe(60);
      expect(cfg.debugRetries).toBe(3);
      expect(cfg.additionalGradleArgs).toEqual([]);
      expect(cfg.additionalMavenArgs).toEqual([]);
      expect(cfg.showDiffView).toBe(false);
    });

    it('should return overridden debugPort', () => {
      __setConfigValue('spockTestRunner.debugPort', 8888);
      const cfg = ConfigurationService.getConfig();
      expect(cfg.debugPort).toBe(8888);
    });

    it('should return overridden testTimeout', () => {
      __setConfigValue('spockTestRunner.testTimeout', 600);
      const cfg = ConfigurationService.getConfig();
      expect(cfg.testTimeout).toBe(600);
    });

    it('should return overridden debugConnectionTimeout', () => {
      __setConfigValue('spockTestRunner.debugConnectionTimeout', 120);
      const cfg = ConfigurationService.getConfig();
      expect(cfg.debugConnectionTimeout).toBe(120);
    });

    it('should return overridden debugRetries', () => {
      __setConfigValue('spockTestRunner.debugRetries', 5);
      const cfg = ConfigurationService.getConfig();
      expect(cfg.debugRetries).toBe(5);
    });

    it('should return overridden additionalGradleArgs', () => {
      __setConfigValue('spockTestRunner.additionalGradleArgs', ['--no-daemon', '-Dkey=val']);
      const cfg = ConfigurationService.getConfig();
      expect(cfg.additionalGradleArgs).toEqual(['--no-daemon', '-Dkey=val']);
    });

    it('should return overridden additionalMavenArgs', () => {
      __setConfigValue('spockTestRunner.additionalMavenArgs', ['-o', '-Dkey=val']);
      const cfg = ConfigurationService.getConfig();
      expect(cfg.additionalMavenArgs).toEqual(['-o', '-Dkey=val']);
    });

    it('should return overridden showDiffView', () => {
      __setConfigValue('spockTestRunner.showDiffView', true);
      const cfg = ConfigurationService.getConfig();
      expect(cfg.showDiffView).toBe(true);
    });
  });

  describe('onConfigChange', () => {
    it('should return a disposable', () => {
      const disposable = ConfigurationService.onConfigChange(() => {});
      expect(disposable).toBeDefined();
      expect(typeof disposable.dispose).toBe('function');
    });
  });
});
