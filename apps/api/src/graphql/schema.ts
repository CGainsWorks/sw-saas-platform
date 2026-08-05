/**
 * GraphQL schema.
 *
 * The same domain as the REST surface, and — importantly — the same service layer
 * underneath. GraphQL is a second front door onto one set of tenant-scoped functions,
 * not a parallel implementation. Two implementations of the same authorisation rules is
 * how one of them ends up subtly weaker than the other.
 *
 * Note the absence of any `tenantId` argument or field anywhere in this schema. There is
 * no way to express "give me tenant X's projects" as a GraphQL query, because tenant is
 * not part of the vocabulary — it comes from the token.
 */
export const typeDefs = /* GraphQL */ `
  scalar DateTime

  enum TaskStatus {
    todo
    in_progress
    blocked
    done
  }

  enum Priority {
    low
    medium
    high
    urgent
  }

  enum Role {
    owner
    admin
    member
  }

  type Tenant {
    id: ID!
    slug: String!
    name: String!
    plan: String!
  }

  type Member {
    id: ID!
    email: String!
    name: String!
    role: Role!
  }

  type Session {
    user: Member!
    tenant: Tenant!
    role: Role!
    availableTenants: [Tenant!]!
  }

  type Project {
    id: ID!
    key: String!
    name: String!
    description: String
    archived: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime!
    """
    Nested resolvers are the interesting case for isolation: they run after the
    top-level field has already been authorised, and a REST route guard has no
    equivalent. They are batched through DataLoader and scoped exactly like every
    other read.
    """
    tasks: [Task!]!
    taskCount: Int!
  }

  type Task {
    id: ID!
    title: String!
    description: String
    status: TaskStatus!
    priority: Priority!
    dueAt: DateTime
    createdAt: DateTime!
    updatedAt: DateTime!
    project: Project
    assignee: Member
    comments: [Comment!]!
  }

  type Comment {
    id: ID!
    body: String!
    createdAt: DateTime!
    author: Member
  }

  type TaskPage {
    items: [Task!]!
    nextCursor: String
  }

  input CreateProjectInput {
    key: String!
    name: String!
    description: String
  }

  input UpdateProjectInput {
    name: String
    description: String
    archived: Boolean
  }

  input CreateTaskInput {
    projectId: ID!
    title: String!
    description: String
    status: TaskStatus = todo
    priority: Priority = medium
    assigneeId: ID
    dueAt: DateTime
  }

  input UpdateTaskInput {
    title: String
    description: String
    status: TaskStatus
    priority: Priority
    assigneeId: ID
    dueAt: DateTime
  }

  type Query {
    me: Session!
    projects(includeArchived: Boolean = false): [Project!]!
    project(id: ID!): Project
    tasks(projectId: ID, status: TaskStatus, assigneeId: ID, limit: Int = 25, cursor: String): TaskPage!
    task(id: ID!): Task
    members: [Member!]!
  }

  type Mutation {
    createProject(input: CreateProjectInput!): Project!
    updateProject(id: ID!, input: UpdateProjectInput!): Project!
    deleteProject(id: ID!): Boolean!
    createTask(input: CreateTaskInput!): Task!
    updateTask(id: ID!, input: UpdateTaskInput!): Task!
    deleteTask(id: ID!): Boolean!
    addComment(taskId: ID!, body: String!): Comment!
  }
`;
