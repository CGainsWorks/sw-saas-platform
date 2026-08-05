import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  createSchema,
  createYoga,
  useReadinessCheck,
  type Plugin,
  type YogaInitialContext,
} from 'graphql-yoga';
import {
  GraphQLError,
  Kind,
  specifiedRules,
  type DefinitionNode,
  type ValidationRule,
} from 'graphql';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { ApiError } from '../http/errors.js';
import { requireAuth, authOf } from '../auth/middleware.js';
import { graphqlOperationDuration, tenantScopeViolations } from '../observability/metrics.js';
import { createContext, type GraphQLContext } from './context.js';
import { depthLimit } from './depth-limit.js';
import { resolvers } from './resolvers.js';
import { typeDefs } from './schema.js';

const cfg = loadConfig();

/** What Yoga hands the Fastify integration on every request. */
type ServerContext = { req: FastifyRequest; reply: FastifyReply };

/**
 * Yoga composes the resolver context as `ServerContext & YogaInitialContext & UserContext`,
 * so the schema has to be declared over the same intersection or the two disagree.
 */
type ResolverContext = ServerContext & YogaInitialContext & GraphQLContext;

export const schema = createSchema<ResolverContext>({ typeDefs, resolvers });

/**
 * Adds the standard GraphQL validation rules plus the depth limit. Rejection happens
 * during validation, so an over-deep query never reaches a resolver.
 */
const depthLimitPlugin: Plugin<ResolverContext> = {
  onValidate({ addValidationRule }) {
    for (const rule of specifiedRules) addValidationRule(rule);
    addValidationRule(depthLimit(cfg.GRAPHQL_MAX_DEPTH) as ValidationRule);
  },
};

/**
 * Operation timing.
 *
 * `operationName` is client-supplied, so it is only used as a metric label when it looks
 * like a normal identifier. Without that check a client could mint unbounded label values
 * and exhaust the Prometheus server's memory — the same cardinality trap as labelling by
 * tenant id.
 */
const timingPlugin: Plugin<ResolverContext> = {
  onExecute({ args }) {
    const rawName = args.operationName ?? 'anonymous';
    const name = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(rawName) ? rawName : 'other';
    const operationType = args.document.definitions.some(
      (d: DefinitionNode) => d.kind === Kind.OPERATION_DEFINITION && d.operation === 'mutation',
    )
      ? 'mutation'
      : 'query';
    const stop = graphqlOperationDuration.startTimer();

    return {
      onExecuteDone({ result }) {
        const errored =
          result !== null &&
          typeof result === 'object' &&
          'errors' in result &&
          Array.isArray((result as { errors?: unknown[] }).errors);
        stop({
          operation_type: operationType,
          operation_name: name,
          outcome: errored ? 'error' : 'ok',
        });
      },
    };
  },
};

/**
 * Mounts GraphQL at /graphql inside its own encapsulated Fastify scope.
 *
 * Encapsulation matters: Yoga needs the raw request body, which means registering a
 * pass-through content-type parser. Fastify scopes parsers to the plugin they are
 * registered in, so this does not disturb the JSON parsing the REST routes rely on.
 */
export async function registerGraphql(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    // Hand Yoga the untouched body. Without this Fastify consumes the stream first and
    // Yoga sees an empty request.
    scope.addContentTypeParser('*', (_req, payload, done) => {
      done(null, payload);
    });

    const yoga = createYoga<ServerContext, GraphQLContext>({
      schema,
      graphqlEndpoint: '/graphql',
      // Fastify owns logging; letting Yoga log too produces every line twice.
      logging: false,
      graphiql: cfg.GRAPHQL_INTROSPECTION,
      // Introspection is genuinely useful and genuinely a reconnaissance aid. On by
      // default for the demo, switched off in the production overlay via env.
      maskedErrors: {
        maskError(error, message) {
          const original = (error as { originalError?: unknown }).originalError;

          // Domain errors carry a deliberate, safe message — including the 404-not-403
          // behaviour that keeps cross-tenant probes from confirming a resource exists.
          if (error instanceof ApiError || original instanceof ApiError) return error as Error;

          // A GraphQLError with no wrapped cause came from parsing, validation or the
          // depth limit. Those describe the client's own query and leak nothing about the
          // server, so masking them would only make the API harder to use.
          if (error instanceof GraphQLError && !original) return error;

          // Anything else is a bug. Log it in full; tell the client nothing — raw errors
          // leak table names, constraint names and query fragments.
          logger.error({ err: original ?? error }, 'graphql internal error');
          return new Error(message);
        },
      },
      // Parser and validation caching are on by default in Yoga; no option needed.
      plugins: [useReadinessCheck({ endpoint: '/graphql/health', check: async () => true }), depthLimitPlugin, timingPlugin],
      context: async ({ req }: { req: FastifyRequest }): Promise<GraphQLContext> => {
        // Same authentication as REST, same token verification, same source of tenant
        // identity. GraphQL does not get its own auth path.
        await requireAuth(req, undefined as unknown as FastifyReply);
        return createContext(authOf(req));
      },
    });

    scope.route({
      url: '/graphql',
      method: ['GET', 'POST', 'OPTIONS'],
      handler: async (req, reply) => {
        try {
          const response = await yoga.handleNodeRequestAndResponse(req, reply, { req, reply });

          for (const [key, value] of response.headers) reply.header(key, value);
          reply.status(response.status);
          return reply.send(response.body);
        } catch (err) {
          if (err instanceof ApiError && err.code === 'unauthorized') {
            tenantScopeViolations.inc({ surface: 'graphql', reason: 'unauthenticated' });
          }
          throw err;
        }
      },
    });
  });
}
