import path from 'node:path';
import dotenv from 'dotenv';
import { createApp } from './app';
import { createBackends } from './backends';
import { loadConfig } from './config';
import { createLogger } from './logger';

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const log = createLogger(config.logLevel);
  const { repo, cortex } = await createBackends(config, log);
  const { app, shutdown } = createApp({ repo, cortex, config, log });

  const server = app.listen(config.port, () => {
    log.info(`motion server listening on http://localhost:${config.port}`, {
      mode: repo.mode,
      cors: config.corsOrigins,
      cortexModel: repo.mode === 'mock' ? 'mock' : config.cortexModel,
    });
  });

  if (repo.mode === 'snowflake') {
    void repo.ping().then((ok) => (ok ? log.info('snowflake: connected') : log.warn('snowflake: not reachable yet (events will be queued)')));
    if (config.keepWarmMs > 0) {
      const warm = () => repo.warm().catch((err) => log.warn('keep-warm query failed', { error: err instanceof Error ? err.message : String(err) }));
      void warm();
      setInterval(warm, config.keepWarmMs).unref();
      log.info(`keep-warm: querying MOTION_WH every ${Math.round(config.keepWarmMs / 1000)} s (warehouse stays resumed and billed)`);
    }
    if (config.cortexWarmup) {
      const t = Date.now();
      void cortex
        .complete('Reply with the single word OK.', { purpose: 'answer', timeoutMs: 60_000 })
        .then(() => log.info(`cortex warm-up: ${Date.now() - t} ms`, { model: config.cortexModel }))
        .catch((err) => log.warn('cortex warm-up failed', { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down`);
    server.close();
    await shutdown(5000);
    await repo.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((err) => {
  console.error(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
