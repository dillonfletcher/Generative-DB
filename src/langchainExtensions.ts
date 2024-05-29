'use strict';

import {BaseLanguageModelCallOptions, BaseLanguageModelInterface} from '@langchain/core/language_models/base';
import {SqlToolkit} from "langchain/agents/toolkits/sql";
import {SqlDatabase, SqlDatabaseDataSourceParams} from 'langchain/sql_db';
import {InfoSqlTool, ListTablesSqlTool, QueryCheckerTool, QuerySqlTool} from "langchain/tools/sql";
import {
    SqlColumn,
    SqlTable
} from "langchain/dist/util/sql_utils";
import type {DataSource} from "typeorm";
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
            let returnedData = await this.db.run(cleanedInput);
            return `SQL QUERY:
${cleanedInput}

RESULT:
${returnedData}`;
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
        if (appDataSource.options.type !== "mssql") {
            throw new Error("Only mssql is currently supported");
        }

        let tableAndColumnDescription: any;
        try {
            const tableAndColumnDescriptionQuery = `SELECT O.name [Table], c.name [Column], ep.value [Description], iif(ep.minor_id = 0, 'Table', 'Column') [Type]
FROM sys.extended_properties EP
LEFT JOIN sys.all_objects O ON ep.major_id = O.object_id
LEFT JOIN sys.columns AS c ON ep.major_id = c.object_id AND ep.minor_id = c.column_id
WHERE ep.[name] like 'MS_Description'
AND ep.major_id = OBJECT_ID('${currentTable.tableSchema}.${currentTable.tableName}');`;

            tableAndColumnDescription = await appDataSource.query(tableAndColumnDescriptionQuery);
            // Check if the result is blank??
            // tableCustomDescription = tableDescriptionResult.length > 0 ? `${tableDescriptionResult[0].value}\n` : "";
        } catch (error) {
            // tableCustomDescription = "";
            // If the request fails we catch it and only display a log message
            console.log(error);
        }
        
        // If a custom description is provided, use it, else get the description from the database when available
        let tableCustomDescription;
        if (customDescription &&
            Object.keys(customDescription).includes(currentTable.tableName)) {
            tableCustomDescription = `/* ${customDescription[currentTable.tableName]} */\n`
        } else if (tableAndColumnDescription &&
            tableAndColumnDescription.length > 0 &&
            tableAndColumnDescription.some((row: any) => row.Type === "Table")) {
            const tableDescription = tableAndColumnDescription.find((row: any) => row.Type === "Table").Description;
            tableCustomDescription = `/* ${tableDescription} */\n`;
        } else {
            tableCustomDescription = "";
        }

        // Generate create table query --studies show that the highest performance is obtained providing the tables in this format
        let schema = appDataSource.options?.schema;
        schema = currentTable.tableSchema ?? schema; // Use the tables schema if it exists, else use the schema from the connection
        // Add the creation of the table in SQL
        let sqlCreateTableQuery = schema // Use the tables schema if it exists, else use the schema from the connection
            ? `CREATE TABLE "${schema}"."${currentTable.tableName}" (\n`
            : `CREATE TABLE ${currentTable.tableName} (\n`;
        for (const [key, currentColumn] of currentTable.columns.entries()) {
            if (key > 0) {
                sqlCreateTableQuery += ", \n";
            }
            
            sqlCreateTableQuery += `${currentColumn.columnName} ${currentColumn.dataType} ${currentColumn.isNullable ? "" : "NOT NULL"}`;
            
            if (tableAndColumnDescription &&
                tableAndColumnDescription.length > 0 &&
                tableAndColumnDescription.some((row: any) => row.Type === "Column" && row.Column === currentColumn.columnName)) {
                const columnDescription = tableAndColumnDescription.find((row: any) => row.Type === "Column" && row.Column === currentColumn.columnName).Description;
                sqlCreateTableQuery += ` /* ${columnDescription} */`;
            }
        }
        sqlCreateTableQuery += "\n) \n";

        // Get sample data --leave the default of 3 rows. Research shows that performance goes down with more than 3 rows.
        let sqlSelectInfoQuery;
        schema = currentTable.tableSchema ?? appDataSource.options?.schema; // Use the tables schema if it exists, else use the schema from the connection
        sqlSelectInfoQuery = schema 
            ? `SELECT TOP ${nbSampleRow} * FROM ${schema}.[${currentTable.tableName}];\n`
            : `SELECT TOP ${nbSampleRow} * FROM [${currentTable.tableName}];\n`;
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
            sample+
            '\n');
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

export const verifyIncludeTablesExistInDatabase = (tablesFromDatabase, includeTables) => {
    verifyListTablesExistInDatabase(tablesFromDatabase, includeTables, "Include tables not found in database:");
};
export const verifyIgnoreTablesExistInDatabase = (tablesFromDatabase, ignoreTables) => {
    verifyListTablesExistInDatabase(tablesFromDatabase, ignoreTables, "Ignore tables not found in database:");
};

export class MssqlDatabase extends SqlDatabase {
    public allTablesWithSchema: Array<SqlTableWithSchema> = [];

    constructor(fields: any) {
        super(fields);
    }

    static async fromDataSourceParams(fields: SqlDatabaseDataSourceParams): Promise<MssqlDatabase> {
        const mssqlDatabase: MssqlDatabase = new MssqlDatabase(fields);
        
        if (!mssqlDatabase.appDataSource.isInitialized) {
            await mssqlDatabase.appDataSource.initialize();
        }
        // mssqlDatabase.allTables = await getTableAndColumnsName(sqlDatabase.appDataSource);
        mssqlDatabase.allTablesWithSchema = await getTablesWithSchemaAndColumnsName(fields.appDataSource);

        mssqlDatabase.customDescription = Object.fromEntries(Object.entries(fields?.customDescription ?? {}).filter(([key, _]) => mssqlDatabase.allTables
            .map((table: SqlTable) => table.tableName)
            .includes(key)));
        verifyIncludeTablesExistInDatabase(mssqlDatabase.allTables, mssqlDatabase.includesTables);
        verifyIgnoreTablesExistInDatabase(mssqlDatabase.allTables, mssqlDatabase.ignoreTables);
        
        return mssqlDatabase;
    }

    /**
     * Dillon's override of the getTableInfo method.
     */
    public override async getTableInfo(targetTables?: Array<string>): Promise<string> {
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
    mssqlDb: MssqlDatabase;
    
    constructor(db: SqlDatabase, llm: BaseLanguageModelInterface<any, BaseLanguageModelCallOptions> | undefined) {
        super(db, llm);
        this.mssqlDb = db as MssqlDatabase;
        super.dialect = 'mssql';
        super.tools = [
            new QuerySqlToolWithCleanup(db),
            new InfoMssqlTool(this.mssqlDb),
            new ListTablesWithSchemaSqlTool(this.mssqlDb),
            new MsSqlQueryCheckerTool({ llm }),
        ];
    }
}

export class InfoMssqlTool extends InfoSqlTool {
    public mssqlDb: MssqlDatabase;

    static lc_name(): string {
        return "InfoMssqlTool";
    }

    constructor(db: MssqlDatabase) {
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
    public mssqlDb: MssqlDatabase;
    
    static lc_name() {
        return "ListTablesWithSchemaSqlTool";
    }

    constructor(db: MssqlDatabase) {
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

If there is an answer please INCLUDE THE ANSWER DATA and PROVIDE THE SQL QUERY that was generated to gather the result in your response.

If the question does not seem related to the database, just return "I don't know" as the answer.`;