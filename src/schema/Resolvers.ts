import UserResolvers from "./resolvers/User.js";
import ShardResolvers from "./resolvers/Shard.js";
import FriendshipResolvers from "./resolvers/Friendship.js";
import ChatResolvers from "./resolvers/Chat.js";
import XPResolvers from "./resolvers/XP.js";
import ChallengeResolvers from "./resolvers/Challenge.js";
import SideQuestResolvers from "./resolvers/SideQuest.js";
import AnalyticsResolvers from "./resolvers/Analytics.js";
import NotificationResolvers from "./resolvers/Notifications.js";
import PushNotificationResolvers from "./resolvers/PushNotifications.js";
import ReportResolvers from "./resolvers/Report.js";
import SupportResolvers from "./resolvers/Support.js";
import { GraphQLScalarType, Kind } from "graphql";

// Custom JSON scalar resolver
const JSONScalar = new GraphQLScalarType({
    name: "JSON",
    description: "JSON scalar type",
    serialize(value) {
        return value; // Send to client as-is
    },
    parseValue(value) {
        return value; // Receive from client as-is
    },
    parseLiteral(ast) {
        if (ast.kind === Kind.OBJECT) {
            return ast;
        }
        return null;
    },
});

export default {
    JSON: JSONScalar,
    Query: {
        ...UserResolvers.Query,
        ...ShardResolvers.Query,
        ...FriendshipResolvers.Query,
        ...ChatResolvers.Query,
        ...XPResolvers.Query,
        ...ChallengeResolvers.Query,
        ...SideQuestResolvers.Query,
        ...AnalyticsResolvers.Query,
        ...NotificationResolvers.Query,
        ...ReportResolvers.Query,
        ...SupportResolvers.Query,
    },
    Mutation: {
        ...UserResolvers.Mutation,
        ...ShardResolvers.Mutation,
        ...FriendshipResolvers.Mutation,
        ...ChatResolvers.Mutation,
        ...XPResolvers.Mutation,
        ...ChallengeResolvers.Mutation,
        ...SideQuestResolvers.Mutation,
        ...AnalyticsResolvers.Mutation,
        ...NotificationResolvers.Mutation,
        ...PushNotificationResolvers.Mutation,
        ...ReportResolvers.Mutation,
        ...SupportResolvers.Mutation,
    },
};