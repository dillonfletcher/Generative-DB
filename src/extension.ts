'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

// The module 'azdata' contains the Azure Data Studio extensibility API
// This is a complementary set of APIs that add SQL / Data-specific functionality to the app
// Import the module and reference it with the alias azdata in your code below

import * as azdata from 'azdata';

// The module 'openai' contains the OpenAI API
import OpenAI from 'openai';
import { MessageCreateParams, TextContentBlock } from 'openai/resources/beta/threads/messages';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('The extension "generative-db" is now active!');

    context.subscriptions.push(vscode.commands.registerCommand('ab-generative-db.generateQuery', () => {
        let gptAPIKey: string | undefined;
        let gptBaseURL: string | undefined;
        const assistantName: string = 'MSSQL Query Writer';
        const outputChannelName: string = 'AB Generative DB';

        let _outputChannel: vscode.OutputChannel; // Output channel
        let _client: OpenAI; // OpenAI client
        let _thread: OpenAI.Beta.Threads.Thread; // OpenAI thread
        let _allSchemaMarkdown: string; // Schema for all databases
        let _allSchemaMarkdownConnectionId: string; // The connectionID that the schema was generated for
        let _currentConnection: azdata.connection.ConnectionProfile; // Current DB connection
        let _currentProcessURI: string; // Current process URI
        
        // Example of how to setup query callbacks for potential use in the future
        // const setupQueryCallbacks = (prov: azdata.QueryProvider) =>
        // {
        //     prov.registerOnMessage((message: azdata.QueryExecuteMessageParams) => accumulateMessages(message));
        //     prov.registerOnQueryComplete(async (result: azdata.QueryExecuteCompleteNotificationResult) => onResult(result));
        // };

        const getOutputChannel = (): vscode.OutputChannel => {
            if (!_outputChannel) {
                _outputChannel = vscode.window.createOutputChannel(outputChannelName);
            }
            return _outputChannel;
        };

        const setupOpenAIClient = async (): Promise<OpenAI> => {
            if (_client) {
                return _client;
            }

            if (!gptBaseURL && process.env.GPT_BASE_URL) {
                gptBaseURL = process.env.GPT_BASE_URL;
            }

            if (!gptAPIKey) {
                if (process.env.GPT_API_KEY) {
                    gptAPIKey = process.env.GPT_API_KEY;
                } else {
                    throw new Error('No OpenAI API Key found.');
                }
            }

            let client = new OpenAI({apiKey: gptAPIKey});
            if (!client) {
                throw new Error('Could not setup OpenAI client.');
            }
            _client = client;
            return client;
        };

        const getOpenAIAssistant = async (client: OpenAI): Promise<OpenAI.Beta.Assistants.Assistant> => {
             let assistantResponse = await client.beta.assistants.list();
            
            let foundAssistant = assistantResponse.data.find((assistant) => {
                if (assistant.name === assistantName) {
                    return assistant;
                }
            });

            if (foundAssistant) {
                console.log(`Found assistant '${assistantName}'.`);
                return foundAssistant;
            } else {
                throw new Error(`Assistant '${assistantName}' not found.`);
            }
        };

        const getOpenAIThread = async (client: OpenAI, schema: string): Promise<OpenAI.Beta.Thread> => {
            if (_thread) {
                return _thread;
            }

            const threadCreateParams: OpenAI.Beta.Threads.ThreadCreateParams = {
                    messages: [
                        {
                            role: "assistant",
                            content: `Please write a SQL query using the following database table rows. Please make sure to use the fully qualified name, including schema, for all database tables that are not under the default schema of dbo. Do not explain the query only provide the code. \n Database Rows: \n ${schema} \n \n `,
                            
                        }
                    ]
                };
                let thread = await client.beta.threads.create(threadCreateParams);
                _thread = thread;
                return thread;
        };

        const getCurrentDBConnectionAndProccesURI = async (): Promise<{connection: azdata.connection.ConnectionProfile, currentProcessURI: string}> => {
            if (!_currentConnection) {
                _currentConnection = await azdata.connection.getCurrentConnection();
            }

            if (_currentConnection && !_currentProcessURI) {
                _currentProcessURI = await azdata.connection.getUriForConnection(_currentConnection.connectionId);
            }

            if (!_currentConnection || !_currentProcessURI) {
                throw new Error('Could not get current connection or process uri.');
            }

            return {connection: _currentConnection, currentProcessURI: _currentProcessURI};
        };

        const executeQuery = async (prov: azdata.QueryProvider, query: string): Promise<azdata.SimpleExecuteResult> =>
            {
                return await prov.runQueryAndReturn(_currentProcessURI, query);
            };

        interface Cell {
            displayValue: string;
            isNull: boolean;
            invariantCultureDisplayValue: string | null;
            rowId: number;
        }

        function createMarkdownTable(data: Cell[][]): string {
            const headers = ['Table', 'Schema', 'Column', 'DataType', 'Nullable'];

            let markdown = `| ${headers.join(' | ')} |\n`;
            markdown += `|${headers.map(() => ' --- ').join('|')}|\n`;

            if (data.length === 0) {return '';}

            let tableData = data.map(row => {
                let rowData: { [column: string]: string } = {};
                row.forEach((cell, index) => {
                    let columnName = headers[index];
                    rowData[columnName] = cell.displayValue;
                });
                return rowData;
            });

            //build a string with the data from each row of tabledata seperated by new lines
            markdown += tableData.map(row => {
                return `| ${Object.values(row).join(' | ')} |`;
            }).join('\n');

            return markdown;
        }

        // Function to get schema for all tables in a database
        const getSchemaMarkdownForDatabase = async (databaseName: string, connection: azdata.connection.ConnectionProfile): Promise<string> => {
            const query = `SELECT TABLE_NAME, TABLE_SCHEMA, COLUMN_NAME, DATA_TYPE, IS_NULLABLE 
                           FROM INFORMATION_SCHEMA.COLUMNS 
                           WHERE TABLE_CATALOG = '${databaseName}'
                           AND TABLE_SCHEMA not like 'sys'`;

            const connectionProvider = azdata.dataprotocol.getProvider<azdata.ConnectionProvider>(connection.providerId, azdata.DataProviderType.ConnectionProvider);
            let queryProvider = azdata.dataprotocol.getProvider<azdata.QueryProvider>(connectionProvider.providerId, azdata.DataProviderType.QueryProvider);        
            let result = await executeQuery(queryProvider, query);
            let markdown = createMarkdownTable(JSON.parse(JSON.stringify(result.rows)));
            return markdown;
        };

        const getSchemaMarkdownForAllDatabases = async (connection: azdata.connection.ConnectionProfile): Promise<string> => {
            if (_allSchemaMarkdown && _currentConnection && _currentConnection.connectionId === _allSchemaMarkdownConnectionId) {
                return _allSchemaMarkdown;
            }

            const databaseNames = await azdata.connection.listDatabases(connection.connectionId);
            
            const allSchema: string[] = [];
            for (let databaseName of databaseNames) {
                if (databaseName === 'master') {continue;}
                let schema = await getSchemaMarkdownForDatabase(databaseName, connection);
                allSchema.push(schema);
            }
            let schemaMarkdown = allSchema.join('\n');
            _allSchemaMarkdown = schemaMarkdown;
            _allSchemaMarkdownConnectionId = connection.connectionId;
            return schemaMarkdown;
        };

        const getSQLCompletionFromGPT = async (client: OpenAI, assistant: OpenAI.Beta.Assistants.Assistant, thread: OpenAI.Beta.Thread, userInptut: string, query: string): Promise<string|undefined> => {
            const proccessingMessage = 'Getting completion...';
            let completionStatusBarMessage = vscode.window.setStatusBarMessage(`$(cloud-download) ${proccessingMessage}`);
            try {
                // Create a message with the user input
                var message: MessageCreateParams = { role: "user", content: userInptut, };

                // Add the message to the thread
                await client.beta.threads.messages.create(thread.id, message);

                let run = await client.beta.threads.runs.createAndPoll(
                    thread.id, 
                    { assistant_id: assistant.id }
                );

                if (run.status === 'completed') {
                    completionStatusBarMessage.dispose();
                    
                    vscode.window.setStatusBarMessage(`$(check) Completion received.`, 2000);

                    let messages = await _client.beta.threads.messages.list(
                        thread.id
                    );

                    // Get the completion from the first message and check that it is TextContentBlock
                    let completion = (messages.data[0].content[0] as TextContentBlock).text.value;
                    console.log(`Completion: ${completion}`);
                    // let strippedCompletion = completion.replace(/^\s*```sql\n|\n```$/g, '');
                    return completion;
                } else {
                    throw new Error('Could not get completion from OpenAI.');
                }
            } catch (error) {
                completionStatusBarMessage.dispose(); // Dispose the status bar message if there is an error
                throw error;
            }
        };

        const showUserInputDialog = async (): Promise<{status: 'ok' | 'close' | 'cancel', query: string | undefined}> => {
            // Use AZData API to ask for a query
            let dialog = azdata.window.createModelViewDialog('Generate SQL Query', 'Generate SQL Query', 400);
            
            let inputBox: azdata.InputBoxComponent;
            dialog.registerContent(async (view) => {
                    inputBox = view.modelBuilder.inputBox()
			            .withValidation(component => (component.value?.length ?? 0) > 0)
			            .component();

                    let formModel = view.modelBuilder.formContainer()
                        .withFormItems([
                                {
                                    component: inputBox,
                                    title: 'Enter a description of the data you want to query.'
                                },
                                // {
                                //     component: view.modelBuilder.checkBox().component(),
                                //     title: 'Refresh schema',
                                // },
                            ],
                            { horizontal: false, componentWidth: undefined, }
                        ).component();
                        
                        //inputBox.value = 'Get the products sold by year and month in the last 20 years. Include the product name, quantity sold, and total sales amount. Order the results by year and month in ascending order.';
                        inputBox.value = 'Please generate a list of all products bought by each customer and the total amount spent by each customer. Order the results by the total amount spent in descending order.';
                        
		                await view.initializeModel(formModel);
                    });

            azdata.window.openDialog(dialog);

            return new Promise((resolve, _) => {
                dialog.onClosed((e: azdata.window.CloseReason) => {
                    resolve({ status: e, query: inputBox.value });
                });
            });
        };

                // Send the code to Azuer Data Studio using AZData API
        const sendCompletionToEditor = async (connection: azdata.connection.ConnectionProfile | undefined, completion: string|undefined) => {
            if (completion) {
                //Send to azure data studio using azdata
                let queryDocument = await azdata.queryeditor.openQueryDocument({content: completion, });
                
                if(connection) {
                    await queryDocument.connect(connection);
                }
            }
        };

        // Main function to get schema for all tables in all databases
        const main = async () => {
            // Get output channel
            let outputChannel = getOutputChannel();

            outputChannel.appendLine('Starting generation of SQL query...\n');

            // Get the current DB connection
            let connectionAndProcessInfo = await getCurrentDBConnectionAndProccesURI();

            outputChannel.appendLine(`Current connection and process info:\n${JSON.stringify(connectionAndProcessInfo)})\n`);

            // Setup OpenAI client
            let client = await setupOpenAIClient();

            outputChannel.appendLine('OpenAI client setup complete.\n');

            // Show Azure Data Studio user input dialog
            const userInputPromise = showUserInputDialog().then((userInput) => { outputChannel.appendLine(`User Input: ${JSON.stringify(userInput)}\n`); return userInput; });

            // Get OpenAI assistant
            const assistantPromise = getOpenAIAssistant(client).then((assistant) => { outputChannel.appendLine('OpenAI assistant\n'); return assistant; });
            
            // Get schema for all databases
            const schemaMarkdownPromise = getSchemaMarkdownForAllDatabases(connectionAndProcessInfo.connection).then((markdown) => { outputChannel.appendLine(`DB Markdown:\n${markdown}\n`); return markdown; });

            // Wait for both promises to resolve
            const [userInput, assistant, schemaMarkdown] = await Promise.all([userInputPromise, assistantPromise, schemaMarkdownPromise]);

            // Check if the user cancelled
            if (userInput.status !== 'ok') {
                outputChannel.appendLine('User cancelled.\n');
                return;
            }

            // Get OpenAI thread
            let thread = await getOpenAIThread(client, schemaMarkdown);

            outputChannel.appendLine('Got OpenAI thread.\n');
            outputChannel.appendLine('Getting completion from GPT...\n');

            // Get completion from GPT
            const completion = await getSQLCompletionFromGPT(client, assistant, thread, userInput.query ?? '', schemaMarkdown);

            outputChannel.appendLine(`GPT Completion:\n${completion}\n`);

            // Send completion to editor
            await sendCompletionToEditor(connectionAndProcessInfo.connection, completion);

            outputChannel.appendLine('SQL query sent to editor.\n');
            outputChannel.appendLine('...SQL query generation complete.\n');
        };

        // Execute main function
        main().catch((error: Error) => {
                console.error(error);
                _outputChannel?.appendLine(`Error: ${error.message}\n`);
                vscode.window.showErrorMessage(error.message);
            }
        );
    }));
}

// this method is called when your extension is deactivated
export function deactivate() {
}