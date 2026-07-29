import { apiEnvironmentSchema, parseEnvironment } from '@cpi/config';
import { buildApp } from './app';

const config = parseEnvironment(apiEnvironmentSchema, process.env);
const app = await buildApp(config);

const close = async (signal: string) => {
  app.log.info({ signal }, 'Stopping API');
  await app.close();
  process.exit(0);
};

process.once('SIGINT', () => void close('SIGINT'));
process.once('SIGTERM', () => void close('SIGTERM'));

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (error) {
  app.log.fatal({ error }, 'API startup failed');
  await app.close();
  process.exit(1);
}
