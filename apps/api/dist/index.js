"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const server_1 = require("./server");
const port = process.env.PORT ? Number(process.env.PORT) : 4000;
const app = (0, server_1.createServer)();
app.listen(port, () => console.log(`🚀 API listening on http://localhost:${port}`));
