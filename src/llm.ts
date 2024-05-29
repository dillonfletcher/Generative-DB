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

export abstract class Llm {
    
    private static _chatModel: ChatOpenAI; // OpenAI client
    
    static async setupChatModel(): Promise<ChatOpenAI> {
        if (this._chatModel) {
            return this._chatModel;
        }

        this._chatModel = new ChatOpenAI({
            model: process.env.GPT_MODEL_VERSION ?? 'gpt-4o',
            temperature: parseFloat(process.env.GPT_TEMPERATURE ?? '5'),
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
        
        printOutput('Getting completion from GPT...\n');

        // Convert the connectionInfo from SQL Data Studio to DataSourceOptions for our RAG chain
        const hostName = process.env.DB_HOSTNAME ?? 'localhost';
        const port = process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 1433;
        const username = process.env.DB_USERNAME ?? 'sa';
        const password = process.env.DB_PASSWORD ?? undefined;
        const catalog = process.env.DB_CATALOG ?? 'master';
        const sqlServerConnectionOptions: SqlServerConnectionOptions = {
            type: "mssql",
            host: hostName,
            port: port,
            username: username,
            password: password,
            database: catalog,
            options: {
                encrypt: true,
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
        });

        // Create toolkit
        const toolkit = new MsSqlToolkit(db, llm);
        
       // Create a SQL agent
        const sqlAgent = createSqlAgent(
            llm,
            toolkit,
            { prefix: MSSQL_PREFIX }
        )
        sqlAgent.lc_kwargs = { return_intermediate_steps: true }; // Don't just return the answer, also return the intermediate steps
        sqlAgent.maxIterations = 15; // Set max iterations to limit cost
        
        let response= await sqlAgent.invoke({ input: userInput.query }, { });
       
        printOutput(`====GPT COMPLETION====\n${response.intermediateSteps.slice(-1)[0].observation}\n`);

        // printOutput('SQL query sent to editor.\n');
        printOutput('...SQL query generation complete.\n');
    };
}

dotenv.config({ path: __dirname + '/.env'});

// noinspection JSIgnoredPromiseFromCall
// Llm.RunModelAsync('What is the most sold product? How much has it sold?');
// Llm.RunModelAsync('What client received the heaviest shipment in 2008?');
// Llm.RunModelAsync("Are there any products that haven't sold? If so, what are they?");
// Llm.RunModelAsync("What is the total number of products sold?");
// Llm.RunModelAsync("What is the total amount of money earned from sales?");
// Llm.RunModelAsync("Please give me all sales data that might be relevant to a presentation to decide which products we should discontinue selling.");

Llm.RunModelAsync("Please give me all the useful information about customers, their orders, and the total order amount, along with some additional details. Please write the query using as many advanced SQL features as possible including CTEs, window functions, subqueries, and string functions.");
// Llm.RunModelAsync("Please give me a list of all orders that where shipped to shopping malls.");
// Llm.RunModelAsync("Please me all useful order information for orders placed outside of the United States.");
// Llm.RunModelAsync("Please give me all orders that include bicycle handlebars.");
