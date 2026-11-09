import { describe } from 'vitest';
import { postgresDatabase, postgresFixture, repairScenarios } from './migration-repair';

const postgresUrl = process.env.PIWI_POSTGRES_TEST_URL;

describe.skipIf(!postgresUrl)('applyMigrations on PostgreSQL (PIWI_POSTGRES_TEST_URL)', () => {
  repairScenarios(postgresFixture, () => postgresDatabase(postgresUrl!));
});
