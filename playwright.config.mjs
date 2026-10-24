import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./tests/browser',workers:1,fullyParallel:false,forbidOnly:true,retries:0,timeout:60000,
  reporter:'list',use:{trace:'off',screenshot:'only-on-failure'}});
