// import vscode from "vscode";
//
// let _outputChannel: vscode.OutputChannel; // Output channel
import debug from "debug";

const generativeDBOutput = debug('generative-db:log');
const generativeDBDebug = debug('generative-db:debug');

export const printOutput = (message: string) => {
    // const outputChannel = getOutputChannel();
    // outputChannel?.appendLine(message);
    //
    console.log(message);
    generativeDBOutput(message);
};

export const printDebug = (message: string) => {
    // const outputChannel = getOutputChannel();
    // outputChannel?.appendLine(message);
    //
    generativeDBDebug(message);
};

export const getOutputChannel = ():  undefined => {
    // if (!_outputChannel) {
    //     _outputChannel = vscode.window.createOutputChannel(process.env.OUTPUT_CHANNEL_NAME ?? 'Generative DB');
    // }
    // return _outputChannel;
    return undefined;
};