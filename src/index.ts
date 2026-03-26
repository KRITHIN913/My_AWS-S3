import Fastify, { FastifyInstance } from 'fastify';

const server: FastifyInstance = Fastify({
  logger: true
});

server.get('/ping', async (request, reply) => {
  return { status: 'ok', service: 'multi-tenant-s3-billing-engine' };
});

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    await server.listen({ port, host: '0.0.0.0' });
    console.log(`Server listening on port ${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
