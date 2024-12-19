import {
  CallToolRequest,
  CallToolResultSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { log } from 'console';
import { neon } from '@neondatabase/serverless';
import { neonClient } from './index.js';
import crypto from 'crypto';
import { getMigrationFromMemory, persistMigrationToMemory } from './state.js';
import { EndpointType, ListProjectsParams } from '@neondatabase/api-client';
import { DESCRIBE_DATABASE_STATEMENTS, splitSqlStatements } from './utils.js';
import { z } from 'zod';

const NEON_ROLE_NAME = 'neondb_owner';
export const NEON_TOOLS = [
  {
    name: '__node_version' as const,
    description: `Get the Node.js version used by the MCP server`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_projects' as const,
    description: `List all Neon projects in your account.`,
    inputSchema: {
      type: 'object',
      properties: {
        cursor: {
          type: 'string',
          description:
            'Specify the cursor value from the previous response to retrieve the next batch of projects.',
        },
        limit: {
          type: 'number',
          description:
            'Specify a value from 1 to 400 to limit number of projects in the response.',
        },
        search: {
          type: 'string',
          description:
            'Search by project name or id. You can specify partial name or id values to filter results.',
        },
        orgId: {
          type: 'string',
          description: 'Search for projects by org_id.',
        },
      },
    },
  },
  {
    name: 'create_project' as const,
    description: 'Create a new Neon project',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'An optional name of the project to create.',
        },
      },
    },
  },
  {
    name: 'delete_project' as const,
    description: 'Delete a Neon project',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'The ID of the project to delete',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'describe_project' as const,
    description: 'Describes a Neon project',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'The ID of the project to describe',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'run_sql' as const,
    description: 'Execute a single SQL statement against a Neon database',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'The SQL query to execute' },
        databaseName: {
          type: 'string',
          description: 'The name of the database to execute the query against',
        },
        projectId: {
          type: 'string',
          description: 'The ID of the project to execute the query against',
        },
        branchId: {
          type: 'string',
          description:
            'An optional ID of the branch to execute the query against',
        },
      },
      required: ['sql', 'databaseName', 'projectId'],
    },
  },
  {
    name: 'run_sql_transaction' as const,
    description:
      'Execute a SQL transaction against a Neon database, should be used for multiple SQL statements',
    inputSchema: {
      type: 'object',
      properties: {
        sqlStatements: {
          type: 'array',
          items: { type: 'string' },
          description: 'The SQL statements to execute',
        },
        databaseName: {
          type: 'string',
          description: 'The name of the database to execute the query against',
        },
        projectId: {
          type: 'string',
          description: 'The ID of the project to execute the query against',
        },
        branchId: {
          type: 'string',
          description:
            'An optional ID of the branch to execute the query against',
        },
      },
      required: ['sqlStatements', 'databaseName', 'projectId'],
    },
  },

  {
    name: 'describe_table_schema' as const,
    description: 'Describe the schema of a table in a Neon database',
    inputSchema: {
      type: 'object',
      properties: {
        tableName: { type: 'string', description: 'The name of the table' },
        databaseName: {
          type: 'string',
          description: 'The name of the database to get the table schema from',
        },
        projectId: {
          type: 'string',
          description: 'The ID of the project to execute the query against',
        },
        branchId: {
          type: 'string',
          description:
            'An optional ID of the branch to execute the query against',
        },
      },
      required: ['tableName', 'databaseName', 'projectId'],
    },
  },
  {
    name: 'get_database_tables' as const,
    description: 'Get all tables in a Neon database',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'The ID of the project',
        },
        branchId: {
          type: 'string',
          description: 'An optional ID of the branch',
        },
        databaseName: {
          type: 'string',
          description: 'The name of the database',
        },
      },
      required: ['projectId', 'databaseName'],
    },
  },
  {
    name: 'create_branch' as const,
    description: 'Create a branch in a Neon project',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'The ID of the project to create the branch in',
        },
        branchName: {
          type: 'string',
          description: 'An optional name for the branch',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'prepare_database_migration' as const,
    description: `
  <use_case>
    This tool should be used to perform schema migrations such as creating
    tables, adding columns, renaming columns or any other DDL changes.
  </use_case>

  <workflow>
    1. Creates a temporary branch
    2. Applies the migration SQL in that branch
    3. Returns migration details for verification
  </workflow>

  <important_notes>
    After executing this tool, you MUST:
    1. Test the migration in the temporary branch using the 'run_sql' tool
    2. Ask for confirmation before proceeding
    3. Use 'complete_database_migration' tool to apply changes to main branch
  </important_notes>

  <example>
    For a migration like:
    ALTER TABLE users ADD COLUMN last_login TIMESTAMP;
    
    You should test it with:
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'last_login';
    
    You can use 'run_sql' to test the migration in the temporary branch that this
    tool creates.
  </example>

  <return_data>
    Migration Details:
    - Migration ID (required for commit)
    - Temporary Branch Name
    - Temporary Branch ID
    - Migration Result
  </return_data>

  <next_steps>
  After executing this tool, you MUST follow these steps:
    1. Use 'run_sql' to verify changes on temporary branch
    2. Ask client: "Would you like to commit migration [migration_id] to main branch?"
    3. If approved, use 'complete_database_migration' tool with the migration_id
  </next_steps>

          `,
    inputSchema: {
      type: 'object',
      properties: {
        migrationSql: {
          type: 'string',
          description: 'The SQL to execute to create the migration',
        },
        databaseName: {
          type: 'string',
          description: 'The name of the database to execute the query against',
        },
        projectId: {
          type: 'string',
          description: 'The ID of the project to execute the query against',
        },
      },
      required: ['migrationSql', 'databaseName', 'projectId'],
    },
  },
  {
    name: 'complete_database_migration' as const,
    description:
      'Complete a database migration when the user confirms the migration is ready to be applied to the main branch. This tool also lets the client know that the temporary branch created by the prepare_database_migration tool has been deleted.',
    inputSchema: {
      type: 'object',
      properties: {
        migrationId: { type: 'string' },
      },
      required: ['migrationId'],
    },
  },
  {
    name: 'describe_branch' as const,
    description:
      'Get a tree view of all objects in a branch, including databases, schemas, tables, views, and functions',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'The ID of the project',
        },
        branchId: {
          type: 'string',
          description: 'An ID of the branch to describe',
        },
        databaseName: {
          type: 'string',
          description: 'The name of the database',
        },
      },
      required: ['projectId', 'databaseName', 'branchId'],
    },
  },
  {
    name: 'delete_branch' as const,
    description: 'Delete a branch from a Neon project',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'The ID of the project containing the branch',
        },
        branchId: {
          type: 'string',
          description: 'The ID of the branch to delete',
        },
      },
      required: ['projectId', 'branchId'],
    },
  },
] satisfies Array<Tool>;
export type NeonToolName = (typeof NEON_TOOLS)[number]['name'];

export type ToolResult = z.infer<typeof CallToolResultSchema>;
type ToolHandlers = {
  [K in NeonToolName]: (request: CallToolRequest) => Promise<ToolResult>;
};

async function handleListProjects(params: ListProjectsParams) {
  log('Executing list_projects');
  const response = await neonClient.listProjects(params);
  if (response.status !== 200) {
    throw new Error(`Failed to list projects: ${response.statusText}`);
  }
  return response.data.projects;
}

async function handleCreateProject(name?: string) {
  log('Executing create_project');
  const response = await neonClient.createProject({
    project: { name },
  });
  if (response.status !== 201) {
    throw new Error(`Failed to create project: ${response.statusText}`);
  }
  return response.data;
}

async function handleDeleteProject(projectId: string) {
  log('Executing delete_project');
  const response = await neonClient.deleteProject(projectId);
  if (response.status !== 200) {
    throw new Error(`Failed to delete project: ${response.statusText}`);
  }
  return response.data;
}

async function handleDescribeProject(projectId: string) {
  log('Executing describe_project');
  const projectBranches = await neonClient.listProjectBranches({
    projectId
  });
  const projectDetails = await neonClient.getProject(projectId);
  if (projectBranches.status !== 200) {
    throw new Error(
      `Failed to get project branches: ${projectBranches.statusText}`,
    );
  }
  if (projectDetails.status !== 200) {
    throw new Error(`Failed to get project: ${projectDetails.statusText}`);
  }
  return {
    branches: projectBranches.data,
    project: projectDetails.data,
  };
}

async function handleRunSql({
  sql,
  databaseName,
  projectId,
  branchId,
}: {
  sql: string;
  databaseName: string;
  projectId: string;
  branchId?: string;
}) {
  log('Executing run_sql');
  const connectionString = await neonClient.getConnectionUri({
    projectId,
    role_name: NEON_ROLE_NAME,
    database_name: databaseName,
    branch_id: branchId,
  });
  const runQuery = neon(connectionString.data.uri);
  const response = await runQuery(sql);

  return response;
}

async function handleRunSqlTransaction({
  sqlStatements,
  databaseName,
  projectId,
  branchId,
}: {
  sqlStatements: Array<string>;
  databaseName: string;
  projectId: string;
  branchId?: string;
}) {
  log('Executing run_sql_transaction');
  const connectionString = await neonClient.getConnectionUri({
    projectId,
    role_name: NEON_ROLE_NAME,
    database_name: databaseName,
    branch_id: branchId,
  });
  const runQuery = neon(connectionString.data.uri);
  const response = await runQuery.transaction(
    sqlStatements.map((sql) => runQuery(sql)),
  );

  return response;
}

async function handleGetDatabaseTables({
  projectId,
  databaseName,
  branchId,
}: {
  projectId: string;
  databaseName: string;
  branchId?: string;
}) {
  log('Executing get_database_tables');

  const connectionString = await neonClient.getConnectionUri({
    projectId,
    role_name: NEON_ROLE_NAME,
    database_name: databaseName,
    branch_id: branchId,
  });

  const runQuery = neon(connectionString.data.uri);
  const query = `
    SELECT 
      table_schema,
      table_name,
      table_type
    FROM information_schema.tables 
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name;
  `;

  const tables = await runQuery(query);
  return tables;
}

async function handleDescribeTableSchema({
  projectId,
  databaseName,
  branchId,
  tableName,
}: {
  projectId: string;
  databaseName: string;
  branchId?: string;
  tableName: string;
}) {
  log('Executing describe_table_schema');

  const result = await handleRunSql({
    sql: `SELECT 
    column_name, 
    data_type, 
    character_maximum_length, 
    is_nullable, 
    column_default 
FROM 
    information_schema.columns 
    WHERE table_name = '${tableName}'`,
    databaseName,
    projectId,
    branchId,
  });

  return result;
}

async function handleCreateBranch({
  projectId,
  branchName,
}: {
  projectId: string;
  branchName?: string;
}) {
  log('Executing create_branch');
  const response = await neonClient.createProjectBranch(projectId, {
    branch: {
      name: branchName,
    },
    endpoints: [
      {
        type: EndpointType.ReadWrite,
        autoscaling_limit_min_cu: 0.25,
        autoscaling_limit_max_cu: 0.25,
        provisioner: 'k8s-neonvm',
      },
    ],
  });

  if (response.status !== 201) {
    throw new Error(`Failed to create branch: ${response.statusText}`);
  }

  return response.data;
}

async function handleDeleteBranch({
  projectId,
  branchId,
}: {
  projectId: string;
  branchId: string;
}) {
  log('Executing delete_branch');
  const response = await neonClient.deleteProjectBranch(projectId, branchId);
  return response.data;
}

async function handleSchemaMigration({
  migrationSql,
  databaseName,
  projectId,
}: {
  databaseName: string;
  projectId: string;
  migrationSql: string;
}) {
  log('Executing schema_migration');
  const newBranch = await handleCreateBranch({ projectId });

  const result = await handleRunSqlTransaction({
    sqlStatements: splitSqlStatements(migrationSql),
    databaseName,
    projectId,
    branchId: newBranch.branch.id,
  });

  const migrationId = crypto.randomUUID();
  persistMigrationToMemory(migrationId, {
    migrationSql,
    databaseName,
    appliedBranch: newBranch.branch,
  });

  return {
    branch: newBranch.branch,
    migrationId,
    migrationResult: result,
  };
}

async function handleCommitMigration({ migrationId }: { migrationId: string }) {
  log('Executing commit_migration');
  const migration = getMigrationFromMemory(migrationId);
  if (!migration) {
    throw new Error(`Migration not found: ${migrationId}`);
  }

  const result = await handleRunSqlTransaction({
    sqlStatements: splitSqlStatements(migration.migrationSql),
    databaseName: migration.databaseName,
    projectId: migration.appliedBranch.project_id,
    branchId: migration.appliedBranch.parent_id,
  });

  await handleDeleteBranch({
    projectId: migration.appliedBranch.project_id,
    branchId: migration.appliedBranch.id,
  });

  return {
    deletedBranch: migration.appliedBranch,
    migrationResult: result,
  };
}

async function handleDescribeBranch({
  projectId,
  databaseName,
  branchId,
}: {
  projectId: string;
  databaseName: string;
  branchId?: string;
}) {
  log('Executing describe_branch');
  const connectionString = await neonClient.getConnectionUri({
    projectId,
    role_name: NEON_ROLE_NAME,
    database_name: databaseName,
    branch_id: branchId,
  });
  const runQuery = neon(connectionString.data.uri);
  const response = await runQuery.transaction(
    DESCRIBE_DATABASE_STATEMENTS.map((sql) => runQuery(sql)),
  );

  return response;
}

export const NEON_HANDLERS: ToolHandlers = {
  // for debugging reasons.
  __node_version: async (request) => ({
    content: [{ type: 'text', text: process.version }],
  }),

  list_projects: async (request) => {
    const { cursor, limit, search, orgId } = request.params.arguments as {
      cursor?: string;
      limit?: number;
      search?: string;
      orgId?: string;
    };

    const projects = await handleListProjects({
      cursor,
      limit,
      search,
      org_id: orgId,
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }],
    };
  },

  create_project: async (request) => {
    const { name } = request.params.arguments as { name?: string };
    const result = await handleCreateProject(name);

    return {
      content: [
        {
          type: 'text',
          text: [
            'Your Neon project is ready.',
            `The project_id is "${result.project.id}"`,
            `The branch name is "${result.branch.name}"`,
            `There is one database available on this branch, called "${result.databases[0].name}",`,
            'but you can create more databases using SQL commands.',
          ].join('\n'),
        },
      ],
    };
  },

  delete_project: async (request) => {
    const { projectId } = request.params.arguments as { projectId: string };
    await handleDeleteProject(projectId);

    return {
      content: [
        {
          type: 'text',
          text: [
            'Project deleted successfully.',
            `Project ID: ${projectId}`,
          ].join('\n'),
        },
      ],
    };
  },

  describe_project: async (request) => {
    const { projectId } = request.params.arguments as { projectId: string };
    const result = await handleDescribeProject(projectId);

    return {
      content: [
        {
          type: 'text',
          text: [`This project is called ${result.project.project.name}.`].join(
            '\n',
          ),
        },
        {
          type: 'text',
          text: [
            `It contains the following branches (use the describe branch tool to learn more about each branch): ${JSON.stringify(result.branches, null, 2)}`,
          ].join('\n'),
        },
      ],
    };
  },

  run_sql: async (request) => {
    const { sql, databaseName, projectId, branchId } = request.params
      .arguments as {
      sql: string;
      databaseName: string;
      projectId: string;
      branchId?: string;
    };
    const result = await handleRunSql({
      sql,
      databaseName,
      projectId,
      branchId,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },

  run_sql_transaction: async (request) => {
    const { sqlStatements, databaseName, projectId, branchId } = request.params
      .arguments as {
      sqlStatements: Array<string>;
      databaseName: string;
      projectId: string;
      branchId?: string;
    };
    const result = await handleRunSqlTransaction({
      sqlStatements,
      databaseName,
      projectId,
      branchId,
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },

  describe_table_schema: async (request) => {
    const { tableName, databaseName, projectId, branchId } = request.params
      .arguments as {
      tableName: string;
      databaseName: string;
      projectId: string;
      branchId?: string;
    };
    const result = await handleDescribeTableSchema({
      tableName,
      databaseName,
      projectId,
      branchId,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },

  get_database_tables: async (request) => {
    const { projectId, branchId, databaseName } = request.params.arguments as {
      projectId: string;
      branchId?: string;
      databaseName: string;
    };
    const result = await handleGetDatabaseTables({
      projectId,
      branchId,
      databaseName,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },

  create_branch: async (request) => {
    const { projectId, branchName } = request.params.arguments as {
      projectId: string;
      branchName?: string;
    };

    const result = await handleCreateBranch({
      projectId,
      branchName,
    });

    return {
      content: [
        {
          type: 'text',
          text: [
            'Branch created successfully.',
            `Project ID: ${result.branch.project_id}`,
            `Branch ID: ${result.branch.id}`,
            `Branch name: ${result.branch.name}`,
            `Parent branch: ${result.branch.parent_id}`,
          ].join('\n'),
        },
      ],
    };
  },

  prepare_database_migration: async (request) => {
    const { migrationSql, databaseName, projectId } = request.params
      .arguments as {
      migrationSql: string;
      databaseName: string;
      projectId: string;
    };

    const result = await handleSchemaMigration({
      migrationSql,
      databaseName,
      projectId,
    });

    return {
      content: [
        {
          type: 'text',
          text: `
            <status>Migration created successfully in temporary branch</status>
            <details>
              <migration_id>${result.migrationId}</migration_id>
              <temporary_branch>
                <name>${result.branch.name}</name>
                <id>${result.branch.id}</id>
              </temporary_branch>
            </details>
            <execution_result>${JSON.stringify(result.migrationResult, null, 2)}</execution_result>

            <next_actions>
            You MUST follow these steps:
              1. Test this migration using 'run_sql' tool on branch '${result.branch.name}'
              2. Verify the changes meet your requirements
              3. If satisfied, use 'complete_database_migration' with migration_id: ${result.migrationId}
            </next_actions>
          `,
        },
      ],
    };
  },

  complete_database_migration: async (request) => {
    const { migrationId } = request.params.arguments as { migrationId: string };
    const result = await handleCommitMigration({ migrationId });

    return {
      content: [
        {
          type: 'text',
          text: `Result: ${JSON.stringify(
            {
              deletedBranch: result.deletedBranch,
              migrationResult: result.migrationResult,
            },
            null,
            2,
          )}`,
        },
      ],
    };
  },

  describe_branch: async (request) => {
    const { projectId, branchId, databaseName } = request.params.arguments as {
      projectId: string;
      branchId?: string;
      databaseName: string;
    };

    const result = await handleDescribeBranch({
      projectId,
      branchId,
      databaseName,
    });

    return {
      content: [
        {
          type: 'text',
          text: ['Database Structure:', JSON.stringify(result, null, 2)].join(
            '\n',
          ),
        },
      ],
    };
  },

  delete_branch: async (request) => {
    const { projectId, branchId } = request.params.arguments as {
      projectId: string;
      branchId: string;
    };

    await handleDeleteBranch({
      projectId,
      branchId,
    });

    return {
      content: [
        {
          type: 'text',
          text: [
            'Branch deleted successfully.',
            `Project ID: ${projectId}`,
            `Branch ID: ${branchId}`,
          ].join('\n'),
        },
      ],
    };
  },
};
