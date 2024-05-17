// 'use strict';
// // Setup dotnetenv
// import * as dotenv from 'dotenv';
//
// // The module 'vscode' contains the VS Code extensibility API
// // Import the module and reference it with the alias vscode in your code below
// import * as vscode from 'vscode';
//
// // The module 'azdata' contains the Azure Data Studio extensibility API
// // This is a complementary set of APIs that add SQL / Data-specific functionality to the app
// // Import the module and reference it with the alias azdata in your code below
//
// import * as azdata from 'azdata';
//
// // Import langchain
// import { OpenAI, ChatOpenAI, ChatOpenAICallOptions, } from "@langchain/openai";
// import {
//   RunnablePassthrough,
//   RunnableSequence,
// } from "@langchain/core/runnables";
// import { ChatPromptTemplate } from "@langchain/core/prompts";
// import { StringOutputParser } from "@langchain/core/output_parsers";
// import { createSqlQueryChain } from "langchain/chains/sql_db";
// import { SqlDatabase } from "langchain/sql_db";
// import { DataSource } from "typeorm";
// import { SqlServerConnectionOptions } from 'typeorm/driver/sqlserver/SqlServerConnectionOptions';
// import { z } from "zod";
// import {createSqlAgent} from "langchain/dist/agents/toolkits/sql";
//
//
// // The module 'openai' contains the OpenAI API
// // import { MessageCreateParams, TextContentBlock } from 'openai/resources/beta/threads/messages';
// // import { ChatModel } from 'openai/resources';
//
// // this method is called when your extension is activated
// // your extension is activated the very first time the command is executed
// export function activate(context: vscode.ExtensionContext) {
//     // Load environment variables
//     dotenv.config({ path: __dirname + '/.env'});
//
//     // Use the console to output diagnostic information (console.log) and errors (console.error)
//     // This line of code will only be executed once when your extension is activated
//     console.log('The extension "generative-db" is now active!');
//
//     context.subscriptions.push(vscode.commands.registerCommand('generative-db.generateQuery', () => {
//         const outputChannelName: string = 'AB Generative DB';
//         const schemaRefreshInterval: number = 1000 * 60 * 60 * 24; // 24 hours in milliseconds
//
//         let _outputChannel: vscode.OutputChannel; // Output channel
//
//         let _allSchemaMarkdown: string; // Schema for all databases
//         let _allSchemaMarkdownTimestamp: Date; // Timestamp of when the schema was last refreshed
//         let _allSchemaMarkdownConnectionId: string; // The connectionID that the schema was generated for
//         let _currentConnection: azdata.connection.ConnectionProfile; // Current DB connection
//         let _currentProcessURI: string; // Current process URI
//
//         const printOutput = (message: string) => {
//             const outputChannel = getOutputChannel();
//             outputChannel.appendLine(message);
//             if (process.env.DEBUG) {
//                 console.log(message);
//             }
//         };
//
//         const getOutputChannel = (): vscode.OutputChannel => {
//             if (!_outputChannel) {
//                 _outputChannel = vscode.window.createOutputChannel(outputChannelName);
//             }
//             return _outputChannel;
//         };
//
//         const setupChatModel = async (): Promise<ChatOpenAI<ChatOpenAICallOptions>> => {
//             if (_chatModel) {
//                 return _chatModel;
//             }
//
//             const chatModel = new ChatOpenAI({
//                 model: process.env.GPT_MODEL ?? 'gpt-4o',
//                 temperature: parseFloat(process.env.GPT_TEMPERATURE ?? '0'),
//             });
//
//             _chatModel = chatModel;
//
//             return _chatModel;
//         };
//
//
//         const getCurrentDBConnectionAndProcessURI = async (): Promise<{connection: azdata.connection.ConnectionProfile, currentProcessURI: string}> => {
//             if (!_currentConnection) {
//                 _currentConnection = await azdata.connection.getCurrentConnection();
//             }
//
//             if (_currentConnection && !_currentProcessURI) {
//                 _currentProcessURI = await azdata.connection.getUriForConnection(_currentConnection.connectionId);
//             }
//
//             if (!_currentConnection || !_currentProcessURI) {
//                 throw new Error('Could not get current connection or process uri.');
//             }
//
//             return {connection: _currentConnection, currentProcessURI: _currentProcessURI};
//         };
//
//         const showUserInputDialog = async (): Promise<{status: 'ok' | 'close' | 'cancel', query: string | undefined}> => {
//             // Use AZData API to ask for a query
//             let dialog = azdata.window.createModelViewDialog('Generate SQL Query', 'Generate SQL Query', 400);
//            
//             let inputBox: azdata.InputBoxComponent;
//             dialog.registerContent(async (view) => {
//                     inputBox = view.modelBuilder.inputBox()
// 			            .withValidation(component => (component.value?.length ?? 0) > 0)
// 			            .component();
//
//                     let formModel = view.modelBuilder.formContainer()
//                         .withFormItems([
//                                 {
//                                     component: inputBox,
//                                     title: 'Enter a description of the data you want to query.'
//                                 },
//                                 // {
//                                 //     component: view.modelBuilder.checkBox().component(),
//                                 //     title: 'Refresh schema',
//                                 // },
//                             ],
//                             { horizontal: false, componentWidth: undefined, }
//                         ).component();
//                        
//                         //inputBox.value = 'Get the products sold by year and month in the last 20 years. Include the product name, quantity sold, and total sales amount. Order the results by year and month in ascending order.';
//                         inputBox.value = 'Please generate a list of all products bought by each customer and the total amount spent by each customer. Order the results by the total amount spent in descending order.';
//                        
// 		                await view.initializeModel(formModel);
//                     });
//
//             azdata.window.openDialog(dialog);
//
//             return new Promise((resolve, _) => {
//                 dialog.onClosed((e: azdata.window.CloseReason) => {
//                     resolve({ status: e, query: inputBox.value });
//                 });
//             });
//         };
//
//                 // Send the code to Azuer Data Studio using AZData API
//         const sendCompletionToEditor = async (connection: azdata.connection.ConnectionProfile | undefined, completion: string|undefined) => {
//             if (completion) {
//                 //Send to azure data studio using azdata
//                 // let queryDocument = await azdata.queryeditor.openQueryDocument({content: completion, });
//                 // if(connection) {
//                 //     queryDocument.providerId = connection.providerId;
//                 //     await queryDocument.connect(connection);
//                 // }
//
//                 // Convert ConnectionProfile to IConnectionProfile
//                 let connectionProfile: azdata.IConnectionProfile = {
//                     connectionName: connection?.connectionName ?? '',
//                     serverName: connection?.serverName ?? '',
//                     databaseName: connection?.databaseName ?? '',
//                     authenticationType: connection?.authenticationType ?? '',
//                     userName: connection?.userName ?? '',
//                     password: connection?.password ?? '',
//                     savePassword: connection?.savePassword ?? false,
//                     groupFullName: connection?.groupFullName ?? '',
//                     groupId: connection?.groupId ?? '',
//                     saveProfile: connection?.saveProfile ?? false,
//                     id: connection?.connectionId ?? '',
//                     options: connection?.options ?? {},
//                     providerName: ''
//                 };
//
//                 // Create and open a notebook
//                 var notebookUri = vscode.Uri.parse('untitled:Untitled-1');
//                 let NBShowOptions: azdata.nb.NotebookShowOptions = {
//                     connectionProfile: connectionProfile,
//                     initialContent: {
//                         metadata: {},
//                         nbformat: 4,
//                         nbformat_minor: 2,
//                         cells: [{ cell_type: 'code', source: completion }]
//                     }
//                 };
//                 azdata.nb.showNotebookDocument(notebookUri, NBShowOptions);
//             }
//         };
//
//         // Main function to get schema for all tables in all databases
//         const main = async () => {
//
//         //     //#region Ignore this for now
//         //
//         //     printOutput('Starting generation of SQL query...\n');
//         //
//         //     // Get the current DB connection
//         //     let connectionAndProcessInfo = await getCurrentDBConnectionAndProcessURI();
//         //
//         //     printOutput(`Current connection and process info:\n${JSON.stringify(connectionAndProcessInfo)})\n`);
//         //
//         //     // Setup OpenAI client
//         //     const llm = await setupChatModel();
//         //
//         //     printOutput('OpenAI client setup complete.\n');
//         //
//         //     // Show Azure Data Studio user input dialog
//         //      const userInput = await showUserInputDialog()
//         //    
//         //      printOutput(`User Input: ${JSON.stringify(userInput)}\n`);
//         //
//         //     // Check if the user cancelled
//         //     if (userInput.status !== 'ok') {
//         //         printOutput('User cancelled.\n');
//         //         return;
//         //     }
//         //
//         //     // Check if the user did not enter a query
//         //     if (userInput.query === undefined || userInput.query.length === 0) {
//         //         printOutput('User did not enter a query.\n');
//         //         return;
//         //     }
//         //
//         //     printOutput('Got OpenAI thread.\n');
//         //     printOutput('Getting completion from GPT...\n');
//         //
//         //     // Convert the connectionInfo from SQL Data Studio to DataSourceOptions for our RAG chain
//         //     const hostName = connectionAndProcessInfo.connection.serverName.split(':')[1].split(',')[0];
//         //     const port = parseInt(connectionAndProcessInfo.connection.serverName.split(':')[1].split(',')[1]);
//         //     const password = connectionAndProcessInfo.connection.password.length > 0 ? connectionAndProcessInfo.connection.password : process.env.DB_PASSWORD ?? '';
//         //     const sqlServerConnectionOptions: SqlServerConnectionOptions = {
//         //         type: "mssql",
//         //         host: hostName,
//         //         port: port,
//         //         username: connectionAndProcessInfo.connection.userName,
//         //         password: password,
//         //         database: connectionAndProcessInfo.connection.databaseName,
//         //     };
//         //
//         //     // Create a datasource
//         //     const datasource = new DataSource(
//         //         sqlServerConnectionOptions
//         //     );
//         //
//         //     // #endregion Ignore this for now
//         //
//         //     // Create a database connection
//         //     const db = await SqlDatabase.fromDataSourceParams({
//         //         appDataSource: datasource,
//         //     });
//         //
//         //     // Create Zod schema for the table names
//         //     const Table = z.object({
//         //         names: z.array(z.string()).describe("Names of tables in SQL database"),
//         //     });
//         //
//         //     // Grab all the table names from the current DB connection
//         //     const tableNames = db.allTables.map((t) => t.tableName).join("\n");
//         //
//         //     const systemPrompt = 
//         //     `Return the names of ALL the SQL tables that MIGHT be relevant to the user question.
//         //     The tables are:
//         //
//         //     ${tableNames}
//         //
//         //     Remember to include ALL POTENTIALLY RELEVANT tables, even if you're not sure that they're needed.`;
//         //
//         //     const tablePrompt = ChatPromptTemplate.fromMessages([
//         //         ["system", systemPrompt],
//         //         ["human", "{userInput}"],
//         //     ]);
//         //     const tableChain = tablePrompt.pipe(llm.withStructuredOutput(Table));
//         //
//         //     // Create a chain to generate the SQL query for the db            
//         //     const sqlQueryChain = await createSqlQueryChain({
//         //         llm,
//         //         db,
//         //         dialect: "mssql",
//         //     });
//         //    
//         //     const tableChain2 = RunnableSequence.from([
//         //         {
//         //             userInput: (i: { question: string }) => i.question,
//         //         },
//         //         tableChain,
//         //     ]);
//         //
//         //     const fullChain = RunnablePassthrough.assign({
//         //         tableNamesToUse: tableChain2,
//         //     }).pipe(sqlQueryChain);
//         //
//         //     // const outputParser = new StringOutputParser();
//         //     // const chain = prompt.pipe(model).pipe(outputParser);
//         //
//         //     // Get completion from GPT
//         //     var response = await fullChain.invoke({
//         //         question: userInput.query
//         //     });
//         //
//         //     printOutput(`GPT Completion:\n${response}\n`);
//         //
//         //     await db.run(response);
//         //
//         //
//         //
//         //     //Clean up the completion
//         //     // let cleanedCompletion = completion.replace(/^\s*```sql\n|\n```$/g, '');
//         //
//         //     // Send completion to editor
//         //     await sendCompletionToEditor(connectionAndProcessInfo.connection, response);
//         //
//         //     // Print an ascii representation of the chain
//         //     // if (process.env.DEBUG) {
//         //     //     printOutput(`Chain:\n${queryChain.getGraph().toJSON()}\n`);
//         //     // }
//         //
//         //     printOutput('SQL query sent to editor.\n');
//         //     printOutput('...SQL query generation complete.\n');
//         // };
//         //
//         // // Execute main function
//         // main().catch((error: Error) => {
//         //         console.error(error);
//         //         _outputChannel?.appendLine(`Error: ${error.message}\n`);
//         //         vscode.window.showErrorMessage(error.message);
//         //     }
//         // );
//     }));
// }
//
// // this method is called when your extension is deactivated
// export function deactivate() {
// }