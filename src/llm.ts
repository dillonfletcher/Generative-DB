'use strict';

import * as dotenv from 'dotenv';

// The module 'azdata' contains the Azure Data Studio extensibility API
// This is a complementary set of APIs that add SQL / Data-specific functionality to the app
// Import the module and reference it with the alias azdata in your code below
// import * as azdata from 'azdata';

// Import langchain
import {ChatOpenAI, ChatOpenAICallOptions,} from "@langchain/openai";
import {RunnablePassthrough, RunnableSequence,} from "@langchain/core/runnables";
import {ChatPromptTemplate} from "@langchain/core/prompts";
import {createSqlQueryChain} from "langchain/chains/sql_db";
import {SqlDatabase} from "langchain/sql_db";
import {DataSource} from "typeorm";
import {SqlServerConnectionOptions} from 'typeorm/driver/sqlserver/SqlServerConnectionOptions';
import {z} from "zod";
import {createSqlAgent} from "langchain/dist/agents/toolkits/sql";

import {printOutput} from "./helpers";

export abstract class Llm {
    
    private static _chatModel: ChatOpenAI<ChatOpenAICallOptions>; // OpenAI client
    
    static async setupChatModel(): Promise<ChatOpenAI<ChatOpenAICallOptions>> {
        if (this._chatModel) {
            return this._chatModel;
        }

        this._chatModel = new ChatOpenAI({
            model: process.env.GPT_MODEL ?? 'gpt-4o',
            temperature: parseFloat(process.env.GPT_TEMPERATURE ?? '0'),
        });

        return this._chatModel;
    };

    // public static async showUserInputDialog(): Promise<{status: 'ok' | 'close' | 'cancel', query: string | undefined}> {
    //     // Use AZData API to ask for a query
    //     let dialog = azdata.window.createModelViewDialog('Generate SQL Query', 'Generate SQL Query', 400);
    //
    //     let inputBox: azdata.InputBoxComponent;
    //     dialog.registerContent(async (view) => {
    //         inputBox = view.modelBuilder.inputBox()
    //             .withValidation(component => (component.value?.length ?? 0) > 0)
    //             .component();
    //
    //         let formModel = view.modelBuilder.formContainer()
    //             .withFormItems([
    //                     {
    //                         component: inputBox,
    //                         title: 'Enter a description of the data you want to query.'
    //                     },
    //                     // {
    //                     //     component: view.modelBuilder.checkBox().component(),
    //                     //     title: 'Refresh schema',
    //                     // },
    //                 ],
    //                 { horizontal: false, componentWidth: undefined, }
    //             ).component();
    //
    //         //inputBox.value = 'Get the products sold by year and month in the last 20 years. Include the product name, quantity sold, and total sales amount. Order the results by year and month in ascending order.';
    //         inputBox.value = 'Please generate a list of all products bought by each customer and the total amount spent by each customer. Order the results by the total amount spent in descending order.';
    //
    //         await view.initializeModel(formModel);
    //     });
    //
    //     azdata.window.openDialog(dialog);
    //
    //     return new Promise((resolve, _) => {
    //         dialog.onClosed((e: azdata.window.CloseReason) => {
    //             resolve({ status: e, query: inputBox.value });
    //         });
    //     });
    // };
    
    public static async Run() {
        // Setup OpenAI client
        const llm = await this.setupChatModel();
        printOutput('OpenAI client setup complete.\n');

        // Show Azure Data Studio user input dialog
        // const userInput = await this.showUserInputDialog()

        // Hardcoded user input
        const userInput = {
            query: 'Please generate a list of all products bought by each customer and the total amount spent by each customer. Order the results by the total amount spent in descending order.',
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
        };
        
        // Create a datasource
        const datasource = new DataSource(
            sqlServerConnectionOptions
        );
        
        // Create a database connection
        const db = await SqlDatabase.fromDataSourceParams({
            appDataSource: datasource,
        });

        // Create Zod schema for the table names
        const Table = z.object({
            names: z.array(z.string()).describe("Names of tables in SQL database"),
        });

        // Grab all the table names from the current DB connection
        const tableNames = db.allTables.map((t) => t.tableName).join("\n");

        const systemPartOfTablePrompt =
        `Return the names of ALL the SQL tables that MIGHT be relevant to the user question.
        The tables are:

        ${tableNames}

        Remember to include ALL POTENTIALLY RELEVANT tables, even if you're not sure that they're needed.`;

        const tablePrompt = ChatPromptTemplate.fromMessages([
            ["system", systemPartOfTablePrompt],
            ["human", "{userInput}"],
        ]);
        const tableChain = tablePrompt.pipe(llm.withStructuredOutput(Table));

        // Create a chain to generate the SQL query for the db            
        const sqlQueryChain = await createSqlQueryChain({
            llm,
            db,
            dialect: "mssql",
        });

        const tableChain2 = RunnableSequence.from([
            {
                userInput: (i: { question: string }) => i.question,
            },
            tableChain,
        ]);

        const fullChain = RunnablePassthrough.assign({
            tableNamesToUse: tableChain2,
        }).pipe(sqlQueryChain);
        
        // Get completion from GPT
        const response = await fullChain.invoke({
            question: userInput.query
        });

        printOutput(`GPT Completion:\n${response}\n`);

        let cleanedResponse = response.replace(/^\s*```sql\n|\n```$/g, '');
        
        let answer = await db.run(cleanedResponse);
        
        printOutput(`SQL Query Result:\n${JSON.stringify(answer)}\n`);
        
        //Clean up the completion
        // let cleanedCompletion = completion.replace(/^\s*```sql\n|\n```$/g, '');

        // Send completion to editor
        // await sendCompletionToEditor(connectionAndProcessInfo.connection, response);

        // Print an ascii representation of the chain
        // if (process.env.DEBUG) {
        //     printOutput(`Chain:\n${queryChain.getGraph().toJSON()}\n`);
        // }

        // printOutput('SQL query sent to editor.\n');
        printOutput('...SQL query generation complete.\n');
    };
}

dotenv.config({ path: __dirname + '/.env'});

Llm.Run();