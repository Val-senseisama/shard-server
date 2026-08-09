import { makeExecutableSchema } from '@graphql-tools/schema';
const { default: typeDefs } = await import('./dist/schema/Typedefinitions.js');
const { default: resolvers } = await import('./dist/schema/Resolvers.js');
makeExecutableSchema({ typeDefs, resolvers });
console.log('✅ schema + resolvers consistent');
