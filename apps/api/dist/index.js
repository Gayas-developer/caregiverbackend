"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const http_1 = require("http");
const server_1 = require("./server");
const hub_1 = require("./realtime/hub");
const port = process.env.PORT ? Number(process.env.PORT) : 4000;
const app = (0, server_1.createServer)();
const server = (0, http_1.createServer)(app);
(0, hub_1.setupRealtimeHub)(server);
server.listen(port, () => console.log(`🚀 API listening on http://localhost:${port}`));
