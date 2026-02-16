import dotenv from 'dotenv';
dotenv.config();
import { createServer as createHttpServer } from 'http';
import { createServer } from './server';
import { setupRealtimeHub } from './realtime/hub';

const port = process.env.PORT ? Number(process.env.PORT) : 4000;
const app = createServer();
const server = createHttpServer(app);
setupRealtimeHub(server);
server.listen(port, () => console.log(`🚀 API listening on http://localhost:${port}`));
