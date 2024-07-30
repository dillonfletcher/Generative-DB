'use strict';

import {BaseLanguageModelCallOptions, BaseLanguageModelInterface} from '@langchain/core/language_models/base';
import {SqlToolkit} from "langchain/agents/toolkits/sql";
import {SqlDatabase, SqlDatabaseDataSourceParams} from 'langchain/sql_db';
import {InfoSqlTool, ListTablesSqlTool, QueryCheckerTool, QuerySqlTool} from "langchain/tools/sql";
import {SqlColumn, SqlTable} from "langchain/dist/util/sql_utils";
import type {DataSource} from "typeorm";
import {LLMChain} from "langchain/chains";

export interface MSSqlTable extends SqlTable{
    tableSchema: string;
    tableDescription?: string;
    columns: MSSqlColumn[];
    constraints?: constraint[];
}

export interface MSSqlColumn extends SqlColumn{
    columnDescription?: string;
}

export interface constraint {
    constraintName: string;
    constraintType: "PRIMARY KEY" | "FOREIGN KEY" | "UNIQUE" | "CHECK" | "DEFAULT";
    columnName: string;
    referencedSchema?: string;
    referencedTable?: string;
    referencedColumn?: string;
    checkClause?: string;
    defaultValue?: string;
    ordinalPosition?: number;
}

export class MssqlDatabase extends SqlDatabase {
    public allTablesWithSchema: MSSqlTable[] = [];
    // @Deprecated - Use allTablesWithSchema instead
    public allTables: SqlTable[] = [];
    constructor(fields: any) {
        super(fields);
    }

    static async fromDataSourceParams(fields: SqlDatabaseDataSourceParams): Promise<MssqlDatabase> {
        const mssqlDatabase: MssqlDatabase = new MssqlDatabase(fields);

        if (!mssqlDatabase.appDataSource.isInitialized) {
            await mssqlDatabase.appDataSource.initialize();
        }
        // mssqlDatabase.allTables = await getTableAndColumnsName(sqlDatabase.appDataSource);
        mssqlDatabase.allTablesWithSchema = await getTablesColumnsConstraintsAndDescriptions(fields.appDataSource);

        mssqlDatabase.customDescription = Object.fromEntries(Object.entries(fields?.customDescription ?? {})
                                                                   .filter(([key, _]) => mssqlDatabase.allTablesWithSchema
                                                                   .map((table: MSSqlTable) => table.tableName)
                                                .includes(key)));
        verifyIncludeTablesExistInDatabase(mssqlDatabase.allTablesWithSchema, mssqlDatabase.includesTables);
        verifyIgnoreTablesExistInDatabase(mssqlDatabase.allTablesWithSchema, mssqlDatabase.ignoreTables);

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
        // @ts-ignore
        super.dialect = 'mssql';
        // @ts-ignore
        super.tools = [
            new QuerySqlToolWithCleanup(db),
            new InfoMssqlTool(this.mssqlDb),
            new ListTablesWithSchemaSqlTool(this.mssqlDb),
            new MsSqlQueryCheckerTool({ llm }),
        ];
    }
}

// This tool is used to execute SQL queries and return both the query and the results
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
            // Remove leading and trailing whitespace and code block markers
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

// This function formats the raw result of a SQL query to a simple table string
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

// This function generates a string containing the schema and sample rows for the specified tables
export const generateTableInfoFromTables = async (tables: Array<MSSqlTable> | undefined, appDataSource: DataSource,
                                                  nbSampleRow: number, customDescriptions?: Record<string, string>): Promise<string> => {
    if (!tables) {
        return "";
    }
    
    let globalString = "";
    
    for (const currentTable of tables) {
        // Check if the database is mssql if not throw an error because only mssql is as part of this project
        if (appDataSource.options.type !== "mssql") {
            throw new Error("Only mssql is currently supported");
        }
        
        // If a custom description is provided, use it, else get the description from the database when available
        let tableCustomDescription = currentTable.tableDescription ? `/* ${currentTable.tableDescription} */\n` : "";
        if (customDescriptions &&
            Object.keys(customDescriptions).includes(currentTable.tableName)){
            tableCustomDescription = `/* ${customDescriptions[currentTable.tableName]} */\n`
        }

        // Generate create table query --studies show that the highest performance is obtained providing the tables in this format
        let schema = currentTable.tableSchema ?? appDataSource.options?.schema; // Use the tables schema if it exists, else use the schema from the connection
        // Add the creation of the table in SQL
        let sqlCreateTableQuery = schema // Use the tables schema if it exists, else use the schema from the connection
            ? `CREATE TABLE [${schema}].[${currentTable.tableName}] (\n`
            : `CREATE TABLE [${currentTable.tableName}] (\n`;
        for (const [key, currentColumn] of currentTable.columns.entries()) {
            if (key > 0) {
                sqlCreateTableQuery += ", \n";
            }
            
            sqlCreateTableQuery += `\t${currentColumn.columnName} ${currentColumn.dataType} ${currentColumn.isNullable ? "" : "NOT NULL"}`;
            
            // Check if there are any constraints for the current column
            if (currentTable.constraints &&
                currentTable.constraints.some((constraint) => constraint.columnName === currentColumn.columnName)) {

                // Get the constraints for the current column
                const columnConstraints: constraint[] = currentTable.constraints.filter((constraint) => constraint.columnName === currentColumn.columnName);
                
                // Group constraints by type
                const primaryKeys: constraint[] = columnConstraints.filter((constraint) => constraint.constraintType === "PRIMARY KEY");
                const foreignKeys: constraint[] = columnConstraints.filter((constraint) => constraint.constraintType === "FOREIGN KEY");
                const uniques: constraint[] = columnConstraints.filter((constraint) => constraint.constraintType === "UNIQUE");
                const checks: constraint[] = columnConstraints.filter((constraint) => constraint.constraintType === "CHECK");
                const defaults: constraint[] = columnConstraints.filter((constraint) => constraint.constraintType === "DEFAULT");

                // Add the PK constraint to the column if there is only one --otherwise it is a composite key and will be added to the end of the table
                if (primaryKeys.length === 1) {
                    const pkConstraintName = primaryKeys[0].constraintName;
                    const pkConstraintsWithSameName = currentTable.constraints
                        .filter((constraint) => constraint.constraintType === "PRIMARY KEY" && constraint.constraintName === pkConstraintName);
                    if (pkConstraintsWithSameName.length === 1) {
                        sqlCreateTableQuery += `\n\t\tCONSTRAINT ${primaryKeys[0].constraintName} PRIMARY KEY`;
                    }
                }
                
                // Add the FK constraint to the column if there is only one with the same name --otherwise it is a composite key and will be added to the end of the table
                const foreignKeysGrouped = Object.groupBy(foreignKeys, (item, index) => item.constraintName);
                for (const [key, value] of Object.entries(foreignKeysGrouped)) {
                    if (value && value.length === 1) {
                        sqlCreateTableQuery += `\n\t\tCONSTRAINT ${value[0].constraintName} REFERENCES ${value[0].referencedSchema}.${value[0].referencedTable}(${value[0].referencedColumn})`;
                    }
                }
                
                // Add the unique constraint to the column if there is only one with the same name --otherwise it is a composite key and will be added to the end of the table
                const uniquesGrouped = Object.groupBy(uniques, (item, index) => item.constraintName);
                for (const [key, value] of Object.entries(uniquesGrouped)) {
                    if (value && value.length === 1) {
                        sqlCreateTableQuery += `\n\t\tCONSTRAINT ${value[0].constraintName} UNIQUE`;
                    }
                }
                
                // Add the check constraint to the column if it exists --check constraints do not have composite keys
                if (checks.length === 1) {
                    sqlCreateTableQuery += `\n\t\tCONSTRAINT ${checks[0].constraintName} CHECK (${checks[0].checkClause})`;
                }

                // Add the default constraint to the column if it exists --default constraints do not have composite keys
                if (defaults.length === 1) {
                    sqlCreateTableQuery += `\n\t\tCONSTRAINT ${defaults[0].constraintName} DEFAULT ${defaults[0].defaultValue}`;
                }
            }
            
            if (currentColumn.columnDescription) {
                sqlCreateTableQuery += ` /* ${currentColumn.columnDescription} */`;
            }
        }
        
        // Add the constraints to the end of the table if they are composite keys
        if (currentTable.constraints) {
            sqlCreateTableQuery += "\n";
            
            const primaryKeys: constraint[] = currentTable.constraints.filter((constraint) => constraint.constraintType === "PRIMARY KEY");
            const foreignKeys: constraint[] = currentTable.constraints.filter((constraint) => constraint.constraintType === "FOREIGN KEY");
            const uniques: constraint[] = currentTable.constraints.filter((constraint) => constraint.constraintType === "UNIQUE");
            
            // Add any composite PK --it is only possible to have one composite PK
            if (primaryKeys.length > 1) {
                sqlCreateTableQuery += `\n\tCONSTRAINT ${primaryKeys[0].constraintName} PRIMARY KEY (${primaryKeys.reduce((completeString, constraint) => `${completeString} ${constraint.columnName},`, "").slice(0, -1).trim()})`;
            }
            
            // Add any composite FKs
            const foreignKeysGrouped = Object.groupBy(foreignKeys, (item, index) => item.constraintName);
            for (const [key, value] of Object.entries(foreignKeysGrouped)) {
                if (value && value.length > 1) {
                    sqlCreateTableQuery += `\n\tCONSTRAINT ${value[0].constraintName} FOREIGN KEY (${value.reduce((completeString, constraint) => `${completeString} ${constraint.columnName},`, "").slice(0, -1).trim()}) REFERENCES ${value[0].referencedSchema}.${value[0].referencedTable}(${value[0].referencedColumn})`;
                }
            }
            
            // Add any composite uniques
            const uniquesGrouped = Object.groupBy(uniques, (item, index) => item.constraintName);
            for (const [key, value] of Object.entries(uniquesGrouped)) {
                if (value && value.length > 1) {
                    sqlCreateTableQuery += `\n\tCONSTRAINT ${value[0].constraintName} UNIQUE (${value.reduce((completeString, constraint) => `${completeString} ${constraint.columnName},`, "").slice(0, -1).trim()})\n`;
                }
            }
        }
        
        sqlCreateTableQuery += "\n)\n";
        
        // Get sample data --leave the default of 3 rows. Research shows that performance goes down with more than 3 rows.
        const typesToExclude = ["binary", "image"];
        const infoColumnNamesConcatString = `\n${currentTable.columns.filter((column) => !typesToExclude.includes(column.dataType ?? ""))
                                                        .reduce((completeString, column, index) => `${completeString}${index > 0 ? ',\n' : ''}   ${column.columnName}`, "")}\n`;

        schema = currentTable.tableSchema ?? appDataSource.options?.schema; // Use the tables schema if it exists, else use the schema from the connection
        let sqlSelectInfoQuery = schema 
            ? `SELECT TOP ${nbSampleRow}${infoColumnNamesConcatString}FROM [${schema}].[${currentTable.tableName}];\n`
            : `SELECT TOP ${nbSampleRow}${infoColumnNamesConcatString}FROM [${currentTable.tableName}];\n`;
        
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
            '\n' +
            sqlSelectInfoQuery +
            '\n' +
            columnNamesConcatString +
            sample+
            '\n');
    }
    return globalString;
};

// This function verifies that the tables in the list exist in our local database list
export const verifyListTablesExistInDatabase = (tablesFromDatabase: Array<MSSqlTable>, listTables: Array<string>, errorPrefixMsg: string): void => {
    const onlyTableNames = tablesFromDatabase.map((table) => table.tableName);
    if (listTables.length > 0) {
        for (const tableName of listTables) {
            if (!onlyTableNames.includes(tableName)) {
                throw new Error(`${errorPrefixMsg} the table ${tableName} was not found in the database`);
            }
        }
    }
};

// This function verifies that the tables in the list exist in our local database list
export const verifyIncludeTablesExistInDatabase = (tablesFromDatabase: MSSqlTable[], includeTables: string[]) => {
    verifyListTablesExistInDatabase(tablesFromDatabase, includeTables, "Include tables not found in database:");
};

// This function verifies that the tables in the list exist in our local database list
export const verifyIgnoreTablesExistInDatabase = (tablesFromDatabase: MSSqlTable[], ignoreTables: string[]) => {
    verifyListTablesExistInDatabase(tablesFromDatabase, ignoreTables, "Ignore tables not found in database:");
};


// This tool is used to retrieve the schema and sample rows for the specified tables
export class InfoMssqlTool extends InfoSqlTool {
    public mssqlDb: MssqlDatabase;

    static lc_name(): string {
        return "InfoMssqlTool";
    }

    constructor(db: MssqlDatabase) {
        super(db);
        this.mssqlDb = db;
        // @ts-ignore
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

// This tool is used to check SQL queries against a list of common mistakes
export class MsSqlQueryCheckerTool extends QueryCheckerTool {
    static lc_name() {
        return "MsSqlQueryCheckerTool";
    }

    constructor(llmChainOrOptions?: LLMChain | QueryCheckerToolArgs) {
        super(llmChainOrOptions);
        // @ts-ignore
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


// This function formats the raw results from the database to a list of tables and columns
const formatToSqlTables = (tables: any[], columns: any[], constraints: any[]): MSSqlTable[] => {
    const msSqlTables: MSSqlTable[] = [];
    
    for (const tableResult of tables) {
        const newTable: MSSqlTable = {
            tableName: tableResult.TABLE_NAME,
            tableSchema: tableResult.TABLE_SCHEMA,
            tableDescription: tableResult.TABLE_DESCRIPTION,
            columns: [],
        };
        
        msSqlTables.push(newTable);
    }
    
    for (const columnResult of columns) {
        const newColumn: MSSqlColumn = {
            columnName: columnResult.COLUMN_NAME,
            columnDescription: columnResult.COLUMN_DESCRIPTION,
            dataType: columnResult.DATA_TYPE,
            isNullable: columnResult.IS_NULLABLE === "YES"
        };
        
        // Find the table in the list of tables
        const currentTable: MSSqlTable | undefined = msSqlTables.find((oneTable) =>
                oneTable.tableName === columnResult.TABLE_NAME && oneTable.tableSchema === columnResult.TABLE_SCHEMA
            );
        if (currentTable) {
            currentTable.columns.push(newColumn);
        }
        else
        {
            // If the table is not found, create a new table and add the column --shouldn't happen
            const tableName: string = columnResult.table_name;
            const tableSchema: string = columnResult.table_schema;
            const newTable: MSSqlTable = {
                tableName: tableName,
                tableSchema: tableSchema,
                columns: [newColumn],
            };
            msSqlTables.push(newTable);
        }
    }
    
    for (const constraintResult of constraints) {
        const newConstraint: constraint = {
            constraintName: constraintResult.CONSTRAINT_NAME,
            constraintType: constraintResult.ConstraintType as "PRIMARY KEY" | "FOREIGN KEY" | "UNIQUE" | "CHECK",
            columnName: constraintResult.COLUMN_NAME,
            referencedSchema: constraintResult.ReferencedSchema,
            referencedTable: constraintResult.ReferencedTable,
            referencedColumn: constraintResult.ReferencedColumn,
            checkClause: constraintResult.CheckClause,
            ordinalPosition: constraintResult.ORDINAL_POSITION
        };
        
        // Find the table in the list of tables
        const currentTable: MSSqlTable | undefined = msSqlTables.find((oneTable) =>
                oneTable.tableName === constraintResult.TABLE_NAME && oneTable.tableSchema === constraintResult.TABLE_SCHEMA
            );
        if (currentTable) {
            if (currentTable.constraints) {
                currentTable.constraints.push(newConstraint);
            }
            else {
                currentTable.constraints = [newConstraint];
            }
        }
        else
        {
            // If the table is not found, create a new table and add the constraint --shouldn't happen
            const tableName: string = constraintResult.TABLE_NAME;
            const tableSchema: string = constraintResult.TABLE_SCHEMA;
            const newTable: MSSqlTable = {
                tableName: tableName,
                tableSchema: tableSchema,
                constraints: [newConstraint],
                columns: [],
            };
            msSqlTables.push(newTable);
        }
    }
        
    return msSqlTables;
};

// This function retrieves the tables and columns in the database along with their schema and descriptions
export const getTablesColumnsConstraintsAndDescriptions = async (appDataSource: any) => {
    const schema = appDataSource.options?.schema;
    
    // This query is used to get the tables in the database
    const tableSql = `SELECT
    t.TABLE_SCHEMA,
    t.TABLE_NAME,
    ep.value AS [TABLE_DESCRIPTION]
FROM
    INFORMATION_SCHEMA.TABLES t
        LEFT JOIN sys.extended_properties ep ON ep.major_id = OBJECT_ID(t.TABLE_SCHEMA + '.' + t.TABLE_NAME)
                                                AND ep.minor_id = 0
                                                AND ep.name = 'MS_Description'
                                                AND ep.class = 1\n` +
(schema ? `WHERE TABLE_SCHEMA = '${schema}'\n` : '') +
`ORDER BY
    t.TABLE_SCHEMA,
    t.TABLE_NAME;`;
    const tablesQuery = appDataSource.query(tableSql);
    
    // This query is used to get the columns in the database
    const columnSql: string = `SELECT
    c.TABLE_SCHEMA,
    c.TABLE_NAME,
    c.COLUMN_NAME,
    c.DATA_TYPE,
    c.IS_NULLABLE,
    ep.value AS [COLUMN_DESCRIPTION]
FROM
    INFORMATION_SCHEMA.COLUMNS c
        LEFT JOIN sys.extended_properties ep ON ep.major_id = OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME)
                                            AND ep.minor_id = c.ORDINAL_POSITION
                                            AND ep.name = 'MS_Description'
                                            AND ep.class = 1\n` +
(schema ? `WHERE TABLE_SCHEMA = '${schema}'\n` : '') +
`ORDER BY
    c.TABLE_SCHEMA,
    c.TABLE_NAME,
    c.ORDINAL_POSITION;`
    const columnsQuery = appDataSource.query(columnSql);
    
    // This query is used to get the constraints in the database
    const constraintsSql: string = `WITH PrimaryKeys AS (
    SELECT
        'PRIMARY KEY' AS ConstraintType,
        TC.TABLE_SCHEMA,
        TC.TABLE_NAME,
        TC.CONSTRAINT_NAME,
        KCU.COLUMN_NAME,
        NULL AS CheckClause,
        NULL AS DefaultValue,
        NULL AS ReferencedSchema,
        NULL AS ReferencedTable,
        NULL AS ReferencedColumn,
        KCU.ORDINAL_POSITION
    FROM
        INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS TC
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS KCU
                 ON TC.CONSTRAINT_NAME = KCU.CONSTRAINT_NAME
                     AND TC.TABLE_SCHEMA = KCU.TABLE_SCHEMA
                     AND TC.TABLE_NAME = KCU.TABLE_NAME
    WHERE
        TC.CONSTRAINT_TYPE = 'PRIMARY KEY'
),
 ForeignKeys AS (
     SELECT
         'FOREIGN KEY' AS ConstraintType,
         TC.TABLE_SCHEMA AS FK_SCHEMA,
         TC.TABLE_NAME AS FK_TABLE,
         TC.CONSTRAINT_NAME AS FK_NAME,
         KCU.COLUMN_NAME AS FK_COLUMN,
         NULL AS CheckClause,
         NULL AS DefaultValue,
         RC.UNIQUE_CONSTRAINT_SCHEMA AS ReferencedSchema,
         KCU2.TABLE_NAME AS ReferencedTable,
         KCU2.COLUMN_NAME AS ReferencedColumn,
         KCU.ORDINAL_POSITION
     FROM
         INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS TC
             JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS KCU
                  ON TC.CONSTRAINT_NAME = KCU.CONSTRAINT_NAME
                      AND TC.TABLE_SCHEMA = KCU.TABLE_SCHEMA
                      AND TC.TABLE_NAME = KCU.TABLE_NAME
             JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS RC
                  ON TC.CONSTRAINT_NAME = RC.CONSTRAINT_NAME
             JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS KCU2
                  ON RC.UNIQUE_CONSTRAINT_NAME = KCU2.CONSTRAINT_NAME
                      AND RC.UNIQUE_CONSTRAINT_SCHEMA = KCU2.TABLE_SCHEMA
     WHERE
         TC.CONSTRAINT_TYPE = 'FOREIGN KEY'
 ),
 UniqueConstraints AS (
     SELECT
         'UNIQUE' AS ConstraintType,
         TC.TABLE_SCHEMA,
         TC.TABLE_NAME,
         TC.CONSTRAINT_NAME,
         KCU.COLUMN_NAME,
         NULL AS CheckClause,
         NULL AS DefaultValue,
         NULL AS ReferencedSchema,
         NULL AS ReferencedTable,
         NULL AS ReferencedColumn,
         KCU.ORDINAL_POSITION
     FROM
         INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS TC
             JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS KCU
                  ON TC.CONSTRAINT_NAME = KCU.CONSTRAINT_NAME
                      AND TC.TABLE_SCHEMA = KCU.TABLE_SCHEMA
                      AND TC.TABLE_NAME = KCU.TABLE_NAME
     WHERE
         TC.CONSTRAINT_TYPE = 'UNIQUE'
 ),
 CheckConstraints AS (
     SELECT
         'CHECK' AS ConstraintType,
         TC.TABLE_SCHEMA,
         TC.TABLE_NAME,
         CC.CONSTRAINT_NAME,
         NULL AS COLUMN_NAME,
         CC.CHECK_CLAUSE AS CheckClause,
         NULL AS DefaultValue,
         NULL AS ReferencedSchema,
         NULL AS ReferencedTable,
         NULL AS ReferencedColumn,
         NULL AS ORDINAL_POSITION
     FROM
         INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS TC
             JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS AS CC
                  ON TC.CONSTRAINT_NAME = CC.CONSTRAINT_NAME
                      AND TC.TABLE_SCHEMA = CC.CONSTRAINT_SCHEMA
     WHERE
         TC.CONSTRAINT_TYPE = 'CHECK'
 ),
 DefaultConstraints AS (
     SELECT
         'DEFAULT' AS ConstraintType,
         SCHEMA_NAME(TC.schema_id) AS TABLE_SCHEMA,
         T.NAME AS TABLE_NAME,
         DC.NAME AS CONSTRAINT_NAME,
         COL.NAME AS COLUMN_NAME,
         NULL AS CheckClause,
         DC.definition AS DefaultValue,
         NULL AS ReferencedSchema,
         NULL AS ReferencedTable,
         NULL AS ReferencedColumn,
         NULL AS ORDINAL_POSITION
     FROM
         sys.default_constraints AS DC
             JOIN sys.tables AS T ON DC.parent_object_id = T.object_id
             JOIN sys.columns AS COL ON DC.parent_column_id = COL.column_id AND DC.parent_object_id = COL.object_id
             JOIN sys.schemas AS TC ON T.schema_id = TC.schema_id
)
SELECT *
FROM PrimaryKeys
UNION ALL
SELECT *
FROM ForeignKeys
UNION ALL
SELECT *
FROM UniqueConstraints
UNION ALL
SELECT *
FROM CheckConstraints
UNION ALL
SELECT *
FROM DefaultConstraints\n` +
(schema ? `WHERE TABLE_SCHEMA = '${schema}'\n` : '') +
`ORDER BY
    TABLE_SCHEMA,
    TABLE_NAME,
    ConstraintType,
    CONSTRAINT_NAME,
    ORDINAL_POSITION;`;
    const constraintsQuery = appDataSource.query(constraintsSql);
    
    const [tables, columns, constraints] = await Promise.all([tablesQuery, columnsQuery, constraintsQuery]);
    
    return formatToSqlTables(tables, columns, constraints);
}

// This tool is used to list all tables in the database along with their schema
export class ListTablesWithSchemaSqlTool extends ListTablesSqlTool {
    public mssqlDb: MssqlDatabase;
    
    static lc_name() {
        return "ListTablesWithSchemaSqlTool";
    }

    constructor(db: MssqlDatabase) {
        super(db);
        this.mssqlDb = db;
        // @ts-ignore
        super.description = "`Input is an empty string, output is a list of tables in the database, one per line, along with their schema and a description (e.g. [dbo].[Table1] --Description of table1).`";
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
            const tablesWithDescriptions = selectedTables.map((table) => `${table.tableSchema}.${table.tableName}${table.tableDescription ? ` --${table.tableDescription}` : ""}`);
            return tablesWithDescriptions.join("\n");
        }
        catch (error) {
            return `${error}`;
        }
    }
}

// This is the prefix that is added to the beginning of the response for the MSSQL agent
export const MSSQL_PREFIX = 
`You are an agent designed to interact with a SQL database.
Given an input question, create a syntactically correct {dialect} query to run, then look at the results of the query and return both the answer and the query used to get the answer.
Do not write a query in any dialect other then {dialect} and do not provide advice on how to make the statements work on other dialects.
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