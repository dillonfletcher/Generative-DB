// import vscode from "vscode";
//
// let _outputChannel: vscode.OutputChannel; // Output channel

export const printOutput = (message: string) => {
    // const outputChannel = getOutputChannel();
    // outputChannel?.appendLine(message);
    //
    if (process.env.DEBUG) {
        console.log(message);
    }
};

export const getOutputChannel = ():  undefined => {
    // if (!_outputChannel) {
    //     _outputChannel = vscode.window.createOutputChannel(process.env.OUTPUT_CHANNEL_NAME ?? 'Generative DB');
    // }
    // return _outputChannel;
    return undefined;
};