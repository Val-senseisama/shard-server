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
import { withErrorLogging } from "../Helpers/Helpers.js";

// Custom JSON scalar resolver
const JSONScalar = new GraphQLScalarType({
    name: "JSON",
    description: "JSON scalar type",
    serialize(value) {
        return value;
    },
    parseValue(value) {
        return value;
    },
    parseLiteral(ast) {
        if (ast.kind === Kind.OBJECT) {
            return ast;
        }
        return null;
    },
});

// Wraps every resolver function in a group with withErrorLogging
function wrapResolvers(group: Record<string, Function>, prefix: string): Record<string, Function> {
    const wrapped: Record<string, Function> = {};
    for (const [name, fn] of Object.entries(group)) {
        if (typeof fn === "function") {
            wrapped[name] = withErrorLogging(`${prefix}.${name}`, fn);
        } else {
            wrapped[name] = fn;
        }
    }
    return wrapped;
}

const allQueries: Record<string, Function> = {
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
};

const allMutations: Record<string, Function> = {
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
};

export default {
    JSON: JSONScalar,
    Query: wrapResolvers(allQueries, "Query"),
    Mutation: wrapResolvers(allMutations, "Mutation"),
};
