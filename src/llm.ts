'use strict';

import * as dotenv from 'dotenv';

// Import langchain
import {ChatOpenAI, ChatOpenAICallOptions,} from "@langchain/openai";
import {DataSource} from "typeorm";
import {SqlServerConnectionOptions} from 'typeorm/driver/sqlserver/SqlServerConnectionOptions';
import {createSqlAgent } from "langchain/agents/toolkits/sql";
import {ChatPromptTemplate} from "langchain/prompts";
import {printOutput} from "./helpers";
import {MSSQL_PREFIX, MssqlDatabase, MsSqlToolkit} from "./langchainExtensions";
import {ProxyAgent} from "proxy-agent";

export abstract class Llm {
    
    private static _chatModel: ChatOpenAI; // OpenAI client
    
    static async setupChatModel(): Promise<ChatOpenAI> {
        if (this._chatModel) {
            return this._chatModel;
        }
        
        this._chatModel = new ChatOpenAI({
                model: process.env.GPT_MODEL_VERSION ?? 'gpt-4o',
                temperature: parseFloat(process.env.GPT_TEMPERATURE ?? '0'),
            },
            {
                httpAgent: new ProxyAgent(),
            });

        return this._chatModel;
    };
    
    public static async RunModelAsync(query: string) {
        // Setup OpenAI client
        const llm = await this.setupChatModel();
        printOutput('OpenAI client setup complete.\n');

        // Show Azure Data Studio user input dialog
        // const userInput = await this.showUserInputDialog()

        // HACK: Hardcoded user input for now
        const userInput = {
            query: query,
            status: 'ok',
        };
        
        // printOutput(`User Input: ${JSON.stringify(userInput)}\n`);
        // Check if the user cancelled
        if (userInput.status !== 'ok') {
            printOutput('User cancelled.\n');
            return;
        }
        // Check if the user did not enter a query
        if (userInput.query === undefined || userInput.query.length === 0) {
            printOutput('User did not enter a query.\n');
            return;
        }
        
        printOutput('Scanning Database...');

        // Convert the connectionInfo from SQL Data Studio to DataSourceOptions for our RAG chain
        const hostName = process.env.DB_HOSTNAME ?? 'localhost';
        const port = process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 1433;
        const encryption = process.env.DB_ENCRYPTION ? process.env.DB_ENCRYPTION.toLowerCase() === 'true' : false;
        const username = process.env.DB_USERNAME ?? 'sa';
        const password = process.env.DB_PASSWORD ?? "";
        const domain = process.env.DB_DOMAIN ?? "";
        const catalog = process.env.DB_CATALOG ?? 'master';
        const sqlServerConnectionOptions: SqlServerConnectionOptions = {
            type: "mssql",
            host: hostName,
            port: port,
            authentication: {
                type: "ntlm",
                options: {
                    userName: username,
                    password: password,
                    domain: domain
                }
            },
            database: catalog,
            options: {
                encrypt: encryption,
                trustServerCertificate: true,
                connectTimeout: 30000,
            },
        };
        
        // Create a datasource
        const datasource = new DataSource(
            sqlServerConnectionOptions
        );
        
        // Create a database connection
        const db = await MssqlDatabase.fromDataSourceParams({
            appDataSource: datasource,
            includesTables: [
                "vAccTable",
                "gl_relacc_table",
                "vRelTable",
                // "vAdvTable",
                // "Branches",
                "vRelPrimaryContacts"
            ],
        });

        printOutput('..Complete\n');

        // Create msSqlToolkit
        const msSqlToolkit = new MsSqlToolkit(db, llm);
        
       // Create a SQL agent
        const sqlAgent = createSqlAgent(
            llm,
            msSqlToolkit,
            { prefix: MSSQL_PREFIX }
        );
        sqlAgent.lc_kwargs = { return_intermediate_steps: true }; // Don't just return the answer, also return the intermediate steps
        sqlAgent.maxIterations = 15; // Set max iterations to limit cost

        printOutput('Invoking Agent...');
        let response= await sqlAgent.invoke({ input: userInput.query }, { });
        printOutput('...Complete\n');


        printOutput(`====GPT COMPLETION====\n${response.intermediateSteps.slice(-1)[0].observation}\n`);

        // printOutput('SQL query sent to editor.\n');
        printOutput('...SQL query generation complete.\n');
    };
}

dotenv.config({ path: __dirname + '/.env'});

Llm.RunModelAsync("Which relationships have a value of over 5000000?");