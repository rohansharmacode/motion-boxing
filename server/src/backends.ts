import type { AppConfig } from './config';
import { MockCortex, SnowflakeCortex, type Cortex } from './cortex';
import type { Logger } from './logger';
import { MemoryRepo } from './repo/memory';
import { SnowflakeRepo } from './repo/snowflake';
import type { Repo } from './repo/types';
import { createSnowflakeExecutor } from './snowflake/executor';

/** SNOWFLAKE_MOCK=1 -> MemoryRepo + canned Cortex; otherwise Snowflake for both. */
export async function createBackends(config: AppConfig, log: Logger): Promise<{ repo: Repo; cortex: Cortex }> {
  if (config.mock || !config.snowflake) {
    return { repo: new MemoryRepo(), cortex: new MockCortex() };
  }
  const sf = config.snowflake;
  const main = await createSnowflakeExecutor(sf, sf.role);
  // Separate pool under a SELECT-only role, used only by POST /api/ask.
  const readOnly = await createSnowflakeExecutor({ ...sf, poolMax: 2 }, sf.readOnlyRole);
  const repo = new SnowflakeRepo(main, log, readOnly, { askQueryTimeoutMs: config.ask.queryTimeoutMs });
  return { repo, cortex: new SnowflakeCortex(main, config.cortexModel) };
}
