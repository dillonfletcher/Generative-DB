'use strict';

import {BaseLanguageModelCallOptions, BaseLanguageModelInterface} from '@langchain/core/language_models/base';
import {SqlToolkit} from "langchain/agents/toolkits/sql";
import {SqlDatabase, SqlDatabaseDataSourceParams} from 'langchain/sql_db';
import {InfoSqlTool, ListTablesSqlTool, QueryCheckerTool, QuerySqlTool} from "langchain/tools/sql";
import {SqlColumn, SqlTable} from "langchain/dist/util/sql_utils";
import type {DataSource} from "typeorm";
import { Tool } from "@langchain/core/tools";
import {PromptTemplate} from "@langchain/core/prompts";
import {OpenAI} from "@langchain/openai";
import {LLMChain} from "langchain/chains";

export class QuerySqlToolWithCleanup extends QuerySqlTool {
    static lc_name() {
        return "QuerySqlToolWithCleanup";
    }
    constructor(db: SqlDatabase) {
        super(db);
    }
    
    /** @ignore */
    async _call(input: string) {
        try {
            let cleanedInput = input.replace(/^\s*```(sql)?\n|\n```$/g, '');
            return await this.db.run(cleanedInput);
        }
        catch (error) {
            return `${error}`;
        }
    }
}

export interface SqlTableWithSchema {
    tableName: string;
    tableSchema: string;
    columns: SqlColumn[];
}

const formatSqlResponseToSimpleTableString = (rawResult: any) => {
    if (!rawResult || !Array.isArray(rawResult) || rawResult.length === 0) {
        return "";
    }
    let globalString = "";
    for (const oneRow of rawResult) {
        globalString += `${Object.values(oneRow).reduce((completeString, columnValue) => `${completeString} ${columnValue}`, "")}\n`;
    }
    return globalString;
};

export const generateTableInfoFromTables = async (tables: Array<SqlTableWithSchema> | undefined, appDataSource: DataSource, nbSampleRow: number, customDescription?: Record<string, string>): Promise<string> => {
    if (!tables) {
        return "";
    }
    let globalString = "";
    for (const currentTable of tables) {
        // Add the custom info of the table
        const tableCustomDescription = customDescription &&
        Object.keys(customDescription).includes(currentTable.tableName)
            ? `${customDescription[currentTable.tableName]}\n`
            : "";
        // Add the creation of the table in SQL
        let schema = null;
        if (appDataSource.options.type === "postgres") {
            schema = appDataSource.options?.schema ?? "public";
        }
        else if (appDataSource.options.type === "mssql") {
            schema = appDataSource.options?.schema;
        }
        else if (appDataSource.options.type === "sap") {
            schema =
                appDataSource.options?.schema ??
                appDataSource.options?.username ??
                "public";
        }
        else if (appDataSource.options.type === "oracle") {
            schema = appDataSource.options.schema;
        }
        schema = currentTable.tableSchema ?? schema; // Use the tables schema if it exists, else use the schema from the connection
        let sqlCreateTableQuery = schema // Use the tables schema if it exists, else use the schema from the connection
            ? `CREATE TABLE "${schema}"."${currentTable.tableName}" (\n`
            : `CREATE TABLE ${currentTable.tableName} (\n`;
        for (const [key, currentColumn] of currentTable.columns.entries()) {
            if (key > 0) {
                sqlCreateTableQuery += ", ";
            }
            sqlCreateTableQuery += `${currentColumn.columnName} ${currentColumn.dataType} ${currentColumn.isNullable ? "" : "NOT NULL"}`;
        }
        sqlCreateTableQuery += ") \n";
        let sqlSelectInfoQuery;
        if (appDataSource.options.type === "mysql") {
            // We use backticks to quote the table names and thus allow for example spaces in table names
            sqlSelectInfoQuery = `SELECT * FROM \`${currentTable.tableName}\` LIMIT ${nbSampleRow};\n`;
        }
        else if (appDataSource.options.type === "postgres") {
            const schema = appDataSource.options?.schema ?? "public";
            sqlSelectInfoQuery = `SELECT * FROM "${schema}"."${currentTable.tableName}" LIMIT ${nbSampleRow};\n`;
        }
        else if (appDataSource.options.type === "mssql") {
            const schema = currentTable.tableSchema ?? appDataSource.options?.schema; // Use the tables schema if it exists, else use the schema from the connection
            sqlSelectInfoQuery = schema 
                ? `SELECT TOP ${nbSampleRow} * FROM ${schema}.[${currentTable.tableName}];\n`
                : `SELECT TOP ${nbSampleRow} * FROM [${currentTable.tableName}];\n`;
        }
        else if (appDataSource.options.type === "sap") {
            const schema = appDataSource.options?.schema ??
                appDataSource.options?.username ??
                "public";
            sqlSelectInfoQuery = `SELECT * FROM "${schema}"."${currentTable.tableName}" LIMIT ${nbSampleRow};\n`;
        }
        else if (appDataSource.options.type === "oracle") {
            sqlSelectInfoQuery = `SELECT * FROM "${schema}"."${currentTable.tableName}" WHERE ROWNUM <= '${nbSampleRow}'`;
        }
        else {
            sqlSelectInfoQuery = `SELECT * FROM "${currentTable.tableName}" LIMIT ${nbSampleRow};\n`;
        }
        const columnNamesConcatString = `${currentTable.columns.reduce((completeString, column) => `${completeString} ${column.columnName}`, "")}\n`;
        let sample = "";
        try {
            const infoObjectResult = nbSampleRow
                ? await appDataSource.query(sqlSelectInfoQuery)
                : null;
            sample = formatSqlResponseToSimpleTableString(infoObjectResult);
        }
        catch (error) {
            // If the request fails we catch it and only display a log message
            console.log(error);
        }
        globalString = globalString.concat(tableCustomDescription +
            sqlCreateTableQuery +
            sqlSelectInfoQuery +
            columnNamesConcatString +
            sample);
    }
    return globalString;
};

export const verifyListTablesExistInDatabase = (tablesFromDatabase: Array<SqlTable>, listTables: Array<string>, errorPrefixMsg: string): void => {
    const onlyTableNames = tablesFromDatabase.map((table) => table.tableName);
    if (listTables.length > 0) {
        for (const tableName of listTables) {
            if (!onlyTableNames.includes(tableName)) {
                throw new Error(`${errorPrefixMsg} the table ${tableName} was not found in the database`);
            }
        }
    }
};

export class MsSqlDatabase extends SqlDatabase {
    public allTablesWithSchema: Array<SqlTableWithSchema> = [];

    constructor(fields: any) {
        super(fields);
    }

    static async fromDataSourceParams(fields: SqlDatabaseDataSourceParams): Promise<SqlDatabase> {
        let sqlDatabase: SqlDatabase = await super.fromDataSourceParams(fields);
        let msSqlDatabase = sqlDatabase as MsSqlDatabase;
        msSqlDatabase.allTablesWithSchema = await getTablesWithSchemaAndColumnsName(fields.appDataSource);
        return sqlDatabase;
    }

    override async getTableInfo(targetTables?: Array<string>): Promise<string> {
        let selectedTables = this.includesTables.length > 0
            ? this.allTablesWithSchema.filter((currentTable) => this.includesTables.includes(currentTable.tableName))
            : this.allTablesWithSchema;
        if (this.ignoreTables.length > 0) {
            selectedTables = selectedTables.filter((currentTable) => !this.ignoreTables.includes(currentTable.tableName));
        }
        if (targetTables && targetTables.length > 0) {
            verifyListTablesExistInDatabase(this.allTablesWithSchema, targetTables, "Wrong target table name:");
            selectedTables = this.allTablesWithSchema.filter((currentTable) => targetTables.includes(currentTable.tableName));
        }
        return generateTableInfoFromTables(selectedTables, this.appDataSource, this.sampleRowsInTableInfo, this.customDescription);
    }
}

export class MsSqlToolkit extends SqlToolkit {
    constructor(db: SqlDatabase, llm: BaseLanguageModelInterface<any, BaseLanguageModelCallOptions> | undefined) {
        super(db, llm);
        const msSqlDb = db as MsSqlDatabase;
        super.dialect = 'mssql';
        super.tools = [
            new QuerySqlToolWithCleanup(db),
            new InfoMsSqlTool(msSqlDb),
            new ListTablesWithSchemaSqlTool(msSqlDb),
            new MsSqlQueryCheckerTool({ llm }),
        ];
    }
}

export class InfoMsSqlTool extends InfoSqlTool {
    public mssqlDb: MsSqlDatabase;

    static lc_name(): string {
        return "InfoMsSqlTool";
    }

    constructor(db: MsSqlDatabase) {
        super(db);
        this.mssqlDb = db;
        super.description =
`Input to this tool is a comma-separated list of qualified table names in the format schema.table, output is the schema and sample rows for those tables.
Be sure that the tables actually exist by calling list-tables-sql first!

Example Input: "schema1.table1, schema1.table2, schema2.table3.`
    }

    async _call(input: string): Promise<string> {
        try {
            const tables = input.split(",")
                .map((table) => table.split(".").slice(-1)[0].trim()); // Get only the table name
            return await this.mssqlDb.getTableInfo(tables);
        }
        catch (error) {
            return `${error}`;
        }
    }
}

type QueryCheckerToolArgs = {
    llmChain?: LLMChain;
    llm?: BaseLanguageModelInterface;
    _chainType?: never;
};

export class MsSqlQueryCheckerTool extends QueryCheckerTool {
    static lc_name() {
        return "MsSqlQueryCheckerTool";
    }

    constructor(llmChainOrOptions?: LLMChain | QueryCheckerToolArgs) {
        super(llmChainOrOptions);
        super.template = 
`{query}

Double check the SQL query above for common mistakes, including:
- Being written in any SQL dialect other than mssql
- Using NOT IN with NULL values
- Using UNION when UNION ALL should have been used
- Using BETWEEN for exclusive ranges
- Data type mismatch in predicates
- Properly quoting identifiers
- Using the correct number of arguments for functions
- Casting to the correct data type
- Using the proper columns for joins
- Using the correct schema for tables that are not in the default schema (typically dbo)
- When using string_agg in a returned query and the field that is being aggregated is not of type NVARCHAR(MAX) then make sure to cast the data to be of type
NVARCHAR(MAX) to prevent LOB errors.
- Forgetting to put a ; sign in front of CTEs to ensure they run correctly
- Using Limit instead of Top to restrict the number of records returned

If there are any of the above mistakes, rewrite the query. If there are no mistakes, just reproduce the original query.`
    }
}

const formatToSqlTable = (rawResultsTableAndColumn: any): { tableName: string; tableSchema: string,  columns: { columnName: string; dataType: any; isNullable: boolean; }[]; }[] => {
    const sqlTable: { tableName: string; tableSchema: string,  columns: { columnName: string; dataType: any; isNullable: boolean; }[]; }[] = [];
    for (const oneResult of rawResultsTableAndColumn) {
        const sqlColumn = {
            columnName: oneResult.column_name,
            dataType: oneResult.data_type,
            isNullable: oneResult.is_nullable === "YES",
        };
        const currentTable = sqlTable.find((oneTable) =>
                oneTable.tableName === oneResult.table_name && oneTable.tableSchema === oneResult.table_schema
            );
        if (currentTable) {
            currentTable.columns.push(sqlColumn);
        }
        else {
            const newTable = {
                tableName: oneResult.table_name,
                tableSchema: oneResult.table_schema,
                columns: [sqlColumn],
            };
            sqlTable.push(newTable);
        }
    }
    return sqlTable;
};

export const getTablesWithSchemaAndColumnsName = async (appDataSource: any) => {
    const schema = appDataSource.options?.schema;
    const sql = `SELECT
    TABLE_NAME AS table_name,
    TABLE_SCHEMA AS table_schema,
    COLUMN_NAME AS column_name,
    DATA_TYPE AS data_type,
    IS_NULLABLE AS is_nullable
    FROM INFORMATION_SCHEMA.COLUMNS
    ${schema && `WHERE TABLE_SCHEMA = '${schema}'`} 
    ORDER BY TABLE_NAME, ORDINAL_POSITION;`;
    const rep = await appDataSource.query(sql);
    return formatToSqlTable(rep);
}

export class ListTablesWithSchemaSqlTool extends ListTablesSqlTool {
    public mssqlDb: MsSqlDatabase;
    
    static lc_name() {
        return "ListTablesWithSchemaSqlTool";
    }

    constructor(db: MsSqlDatabase) {
        super(db);
        this.mssqlDb = db;
        super.description = "`Input is an empty string, output is a comma-separated list of tables in the database along with their schema (e.g. [dbo].[tablename], [dbo].[tablename2]).`";
    }

    async _call(_: string) {
        try {
            let selectedTables = this.mssqlDb.allTablesWithSchema;
            if (this.mssqlDb.includesTables.length > 0) {
                selectedTables = selectedTables.filter((currentTable) => this.mssqlDb.includesTables.includes(currentTable.tableName));
            }
            if (this.mssqlDb.ignoreTables.length > 0) {
                selectedTables = selectedTables.filter((currentTable) => !this.mssqlDb.ignoreTables.includes(currentTable.tableName));
            }
            const tables = selectedTables.map((table) => `${table.tableSchema}.${table.tableName}`);
            return tables.join(", ");
        }
        catch (error) {
            return `${error}`;
        }
    }
}

// export class ResultFormatterTool extends Tool {
//     name: string = "";
//     template: string = "";
//     llmChain: LLMChain;
//     description: string = "";
//
//     static lc_name(): string {
//         return "ResultFormatterTool";
//     }
//    
//     constructor(llmChainOrOptions?: LLMChain | QueryCheckerToolArgs) {
//         super();
//         Object.defineProperty(this, "name", {
//             enumerable: true,
//             configurable: true,
//             writable: true,
//             value: "result-formatter"
//         });
//         Object.defineProperty(this, "template", {
//             enumerable: true,
//             configurable: true,
//             writable: true,
//             value: `
//     {query}
//    
// Input to this tool is the final results from the query-sql tool.
// Output is a nicely formatted result to give to the user.
//
// Use the following format in your response:
// Question: the original question from the user
// SQL Results: a nicely formatted markdown table containing the results from executing the query
// SQL Query: the sql query that was generated
// Query Explanation: an explanation of the query and why it was generated`
//         });
//         Object.defineProperty(this, "llmChain", {
//             enumerable: true,
//             configurable: true,
//             writable: true,
//             value: void 0
//         });
//         Object.defineProperty(this, "description", {
//             enumerable: true,
//             configurable: true,
//             writable: true,
//             value: `Use this tool to format the results from query-sql before giving them to the user.
//     Always use this tool before responding to the user!`
//         });
//         if (typeof llmChainOrOptions?._chainType === "function") {
//             this.llmChain = llmChainOrOptions;
//         }
//         else {
//             const options = llmChainOrOptions;
//             if (options?.llmChain !== undefined) {
//                 this.llmChain = options.llmChain;
//             }
//             else {
//                 const prompt = new PromptTemplate({
//                     template: this.template,
//                     inputVariables: ["query"],
//                 });
//                 const llm = options?.llm ?? new OpenAI({ temperature: 0 });
//                 this.llmChain = new LLMChain({ llm, prompt });
//             }
//         }
//     }
//    
//     /** @ignore */
//     async _call(input: string) {
//         return this.llmChain.predict({ query: input });
//     }
// }

export const MSSQL_PREFIX = 
`You are an agent designed to interact with a SQL database.
Given an input question, create a syntactically correct {dialect} query to run, then look at the results of the query and return the answer.
Do not provide results in any dialect other then {dialect} and do not provide advice on how to make the statements work on other dialects.
Make sure to fully qualify any tables in your query that do not use the default schema (typically dbo).
Unless the user specifies a specific number of examples they wish to obtain, always limit your query to at most {top_k} results using the TOP clause.
You can order the results by a relevant column to return the most interesting examples in the database.
Never query for all the columns from a specific table, only ask for a the few relevant columns given the question.
You have access to tools for interacting with the database.
Only use the below tools. Only use the information returned by the below tools to construct your final answer.
You MUST double check your query before executing it. If you get an error while executing a query, rewrite the query and try again.

DO NOT make any DML statements (INSERT, UPDATE, DELETE, DROP etc.) to the database.

If the question does not seem related to the database, just return "I don't know" as the answer.`;

