import dotenv from "dotenv";
dotenv.config();
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express5";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import express from "express";
import http from "http";
import { connectDB } from "./config/db.js";
import createContext from "./middleware/CreateContext.js";
import { formatError } from "./middleware/FormatError.js";
import typeDefs from "./schema/Typedefinitions.js";
import resolvers from "./schema/Resolvers.js";
import cors from "cors";
import { setupWebSocketServer } from "./server/WebSocketServer.js";
import { startOverdueTaskReschedule, startDeletedTaskPurge, startDeadlineReminders, startOverdueAlerts } from './Helpers/CronJobs.js';

const PORT = process.env.PORT || 4000;

const app = express();
const httpServer = http.createServer(app);

// Setup WebSocket server
const io = setupWebSocketServer(httpServer);

// Set up WebSocket in Chat resolver
import { setSocketIO } from "./schema/resolvers/Chat.js";
setSocketIO(io);

export { io }; // Export for use in other files


app.use(express.json());
app.use(express.urlencoded({ extended: true }));


const server = new ApolloServer({
    typeDefs,
    resolvers,
    formatError,
    plugins: [
        ApolloServerPluginDrainHttpServer({ httpServer }),
           ],
           
});

await server.start();

app.use(cors());

app.use("/graphql", expressMiddleware(server, {
    context: async ({ req, res }) => createContext(req, res),
}));

connectDB();

httpServer.listen(PORT, () => {
    console.log(`🚀 [SERVER] Server is running on port ${PORT}`);
    console.log(`🚀 [SERVER] GraphQL endpoint: http://localhost:${PORT}/graphql`);
    console.log(`🚀 [SERVER] WebSocket endpoint: ws://localhost:${PORT}`);
    
    // Start cron jobs
    startOverdueTaskReschedule();
    startDeletedTaskPurge();
    startDeadlineReminders();
    startOverdueAlerts();
});