import {
  GraphQLError,
  Kind,
  type ASTNode,
  type FragmentDefinitionNode,
  type ValidationContext,
} from 'graphql';

/**
 * Rejects queries nested deeper than `maxDepth`, before execution.
 *
 * A GraphQL schema with cycles — here `Project.tasks` → `Task.project` → `Project.tasks`
 * — lets a short query demand exponential work:
 *
 *   { projects { tasks { project { tasks { project { tasks { id } } } } } } }
 *
 * That is a denial-of-service primitive available to any authenticated user, and on a
 * pooled multi-tenant database one tenant doing it degrades every other tenant. Rate
 * limiting does not help, because the cost is in a single request.
 *
 * This runs as a validation rule, so an over-deep query is rejected without a single
 * resolver executing.
 *
 * Depth is a blunt instrument — it does not account for list widths, so a shallow query
 * fetching 10,000 items still gets through. Pagination limits cover that case
 * separately (`tasks` caps at 100). A production system at scale would want proper cost
 * analysis with per-field weights; depth plus paging limits is the honest 80% of it.
 */
export function depthLimit(maxDepth: number) {
  return (context: ValidationContext) => {
    const fragments: Record<string, FragmentDefinitionNode> = {};
    for (const def of context.getDocument().definitions) {
      if (def.kind === Kind.FRAGMENT_DEFINITION) fragments[def.name.value] = def;
    }

    /**
     * Fragment spreads are followed rather than counted as leaves. Not following them
     * would leave a trivial bypass: hide the deep part of the query inside a fragment
     * and the limit never fires.
     */
    const measure = (node: ASTNode, depth: number, seen: Set<string>): number => {
      switch (node.kind) {
        case Kind.FIELD: {
          // Introspection meta-fields are not real traversal.
          if (node.name.value.startsWith('__')) return depth;
          if (!node.selectionSet) return depth;
          return Math.max(
            ...node.selectionSet.selections.map((s) => measure(s, depth + 1, seen)),
          );
        }
        case Kind.FRAGMENT_SPREAD: {
          const name = node.name.value;
          // Guards against a cyclic fragment, which would otherwise recurse forever.
          if (seen.has(name)) return depth;
          const fragment = fragments[name];
          if (!fragment) return depth;
          const next = new Set(seen).add(name);
          return Math.max(
            ...fragment.selectionSet.selections.map((s) => measure(s, depth, next)),
          );
        }
        case Kind.INLINE_FRAGMENT:
        case Kind.OPERATION_DEFINITION:
        case Kind.FRAGMENT_DEFINITION: {
          const withSelections = node as { selectionSet?: { selections: readonly ASTNode[] } };
          if (!withSelections.selectionSet) return depth;
          return Math.max(
            ...withSelections.selectionSet.selections.map((s) => measure(s, depth, seen)),
          );
        }
        default:
          return depth;
      }
    };

    return {
      OperationDefinition(operation: ASTNode) {
        const depth = measure(operation, 0, new Set());
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(
              `Query is nested ${depth} levels deep, which exceeds the maximum of ${maxDepth}.`,
              { nodes: [operation] },
            ),
          );
        }
      },
    };
  };
}
