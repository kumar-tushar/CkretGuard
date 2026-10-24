import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./tests/browser',workers:1,retries:0,timeout:30000,
  reporter:'list',use:{trace:'off',screenshot:'only-on-failure'}});
