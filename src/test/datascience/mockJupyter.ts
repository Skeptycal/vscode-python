// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { JSONObject } from '@phosphor/coreutils/lib/json';
import { assert } from 'chai';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { Observable } from 'rxjs/Observable';
import { anyString, anything, instance, match, mock, when } from 'ts-mockito';
import { Matcher } from 'ts-mockito/lib/matcher/type/Matcher';
import * as TypeMoq from 'typemoq';
import * as uuid from 'uuid/v4';
import { Disposable, Event, EventEmitter } from 'vscode';

import { PythonSettings } from '../../client/common/configSettings';
import { ConfigurationService } from '../../client/common/configuration/service';
import { Logger } from '../../client/common/logger';
import { FileSystem } from '../../client/common/platform/fileSystem';
import { IFileSystem, TemporaryFile } from '../../client/common/platform/types';
import { ProcessServiceFactory } from '../../client/common/process/processFactory';
import { PythonExecutionFactory } from '../../client/common/process/pythonExecutionFactory';
import {
    ExecutionResult,
    IProcessService,
    IPythonExecutionService,
    ObservableExecutionResult,
    Output,
    IProcessServiceFactory,
    IPythonExecutionFactory
} from '../../client/common/process/types';
import { IAsyncDisposableRegistry, IConfigurationService, IDisposableRegistry, ILogger } from '../../client/common/types';
import { Architecture } from '../../client/common/utils/platform';
import { EXTENSION_ROOT_DIR } from '../../client/constants';
import { JupyterExecution } from '../../client/datascience/jupyter/jupyterExecution';
import { ICell, IConnection, IJupyterKernelSpec, INotebookServer, InterruptResult, IJupyterSessionManager, IJupyterSession, CellState } from '../../client/datascience/types';
import { InterpreterType, PythonInterpreter, IInterpreterService } from '../../client/interpreter/contracts';
import { InterpreterService } from '../../client/interpreter/interpreterService';
import { CondaService } from '../../client/interpreter/locators/services/condaService';
import { KnownSearchPathsForInterpreters } from '../../client/interpreter/locators/services/KnownPathsService';
import { ServiceContainer } from '../../client/ioc/container';
import { getOSType, OSType } from '../common';
import { noop, sleep } from '../core';
import { IServiceManager } from '../../client/ioc/types';
import { CancellationToken } from 'vscode-jsonrpc';
import { Cancellation } from '../../client/common/cancellation';
import { nbformat } from '@jupyterlab/coreutils';
import { generateCells } from '../../client/datascience/cellFactory';
import { KernelMessage, Kernel } from '@jupyterlab/services';
import { createDeferred, Deferred } from '../../client/common/utils/async';
import { MockPythonService } from './mockPythonService';
import { MockProcessService } from './mockProcessService';

// tslint:disable:no-any no-http-string no-multiline-string max-func-body-length

const MockJupyterTimeDelay = 10;

export enum SupportedCommands {
    none = 0,
    ipykernel = 1,
    nbconvert = 2,
    notebook = 4,
    kernelspec = 8,
    all = 0xFFFF
}

class MockJupyterRequest implements Kernel.IFuture {
    private deferred: Deferred<KernelMessage.IShellMessage> = createDeferred<KernelMessage.IShellMessage>();
    private failing = false;
    public msg: KernelMessage.IShellMessage;
    public onReply: (msg: KernelMessage.IShellMessage) => void | PromiseLike<void>;
    public onStdin: (msg: KernelMessage.IStdinMessage) => void | PromiseLike<void>;
    public onIOPub: (msg: KernelMessage.IIOPubMessage) => void | PromiseLike<void>;

    constructor(cell: ICell, delay: number) {
        // Start our sequence of events that is our cell running
        this.executeRequest(cell, delay);
    }

    public get done() : Promise<KernelMessage.IShellMessage> {
        return this.deferred.promise;
    }
    public registerMessageHook(hook: (msg: KernelMessage.IIOPubMessage) => boolean | PromiseLike<boolean>): void {
    }
    public removeMessageHook(hook: (msg: KernelMessage.IIOPubMessage) => boolean | PromiseLike<boolean>): void {
    }
    public sendInputReply(content: KernelMessage.IInputReply): void {
    }
    public isDisposed: boolean;
    public dispose(): void {
        if (!this.isDisposed) {
            this.isDisposed = true;
            if (this.onIOPub) {
                this.onIOPub(this.generateIOPubMessage('shutdown', {status: 'idle'}));
            }
        }
    }
    public switchToFail() {
        this.failing = true;
    }

    private generateIOPubMessage(msgType: string, result: any) : KernelMessage.IIOPubMessage {
        return this.generateMessage(msgType, result) as KernelMessage.IIOPubMessage;
    }

    private generateShellMessage(msgType: string, result: any) : KernelMessage.IShellMessage {
        return this.generateMessage(msgType, result, 'shell') as KernelMessage.IShellMessage;
    }

    private generateMessage(msgType: string, result: any, channel: string = 'iopub') : KernelMessage.IMessage {
        return {
            channel: 'iopub',
            header: {
                username: 'foo',
                version: '1.1',
                session: '1111111111',
                msg_id: '1.1',
                msg_type: msgType
            },
            parent_header: {

            },
            metadata: {

            },
            content: result
        };
    }

    private executeRequest(cell: ICell, delay: number) {
        this.sendMessages([
            () => this.generateIOPubMessage('status', { status: 'idle'}),
            () => this.generateIOPubMessage('execute_input', { status: 'idle'}),
            () => { const result = this.generateShellMessage('done', {status: 'idle'}); this.deferred.resolve(result); return result; }
        ], delay);
    }

    private sendMessages(messageFuncs: (() => KernelMessage.IMessage | undefined)[], delay: number) {
        if (messageFuncs && messageFuncs.length > 0) {
            setTimeout(() => {
                if (this.failing) {
                    // Indicate failure
                    const message = this.generateMessage('done', {status: 'failed'}, 'shell');
                    this.deferred.resolve(message as KernelMessage.IShellMessage);
                    if (this.onIOPub) {
                        this.onIOPub(message as KernelMessage.IIOPubMessage);
                    }
                } else {
                    const message = messageFuncs[0]();
                    if (this.onIOPub && message) {
                        this.onIOPub(message as KernelMessage.IIOPubMessage);
                    }
                    if (message) {
                        this.sendMessages(messageFuncs.slice(1), delay);
                    }
                }
            }, delay);
        }
    }


}

class MockJupyterSession implements IJupyterSession {
    private dict: {[index: string] : ICell};
    private restartedEvent: EventEmitter<void> = new EventEmitter<void>();
    private timedelay: number;
    private outstandingRequests: MockJupyterRequest[] = [];

    public get onRestarted() : Event<void> {
        return this.restartedEvent.event;
    }

    public async restart(): Promise<void> {
        // For every outstanding request, switch them to fail mode
        const requests = [...this.outstandingRequests];
        requests.forEach(r => r.switchToFail());
        return sleep(this.timedelay);
    }
    public interrupt(): Promise<void> {
        return sleep(this.timedelay);
    }
    public waitForIdle(): Promise<void> {
        return sleep(this.timedelay);
    }
    public requestExecute(content: KernelMessage.IExecuteRequest, disposeOnDone?: boolean, metadata?: JSONObject): Kernel.IFuture {
        // Content should have the code
        const cell = this.findCell(content.code);

        // Create a new dummy request
        const request = new MockJupyterRequest(cell, this.timedelay);
        this.outstandingRequests.push(request);

        // When it finishes, it should not be an outstanding request anymore
        const removeHandler = () => {
            this.outstandingRequests = this.outstandingRequests.filter(f => f !== request);
        };
        request.done.then(() => removeHandler()).catch(() => removeHandler());
        return request;
    }

    dispose(): Promise<void> {
        return Promise.resolve();
    }


    constructor(cellDictionary: {[index: string] : ICell}, timedelay: number) {
        this.dict = cellDictionary;
        this.timedelay = timedelay;
    }

    private findCell = (code : string) : ICell => {
        if (this.dict.hasOwnProperty(code)) {
            return this.dict[code] as ICell;
        }

        throw new Error(`Cell ${code.splitLines()[0]} not found in mock`);
    }

}


// This class is used to mock talking to jupyter. It mocks
// the process services, the interpreter services, the python services, and the jupyter session
export class MockJupyter implements IJupyterSessionManager {
    private pythonExecutionFactory = this.createTypeMoq<IPythonExecutionFactory>('Python Exec Factory');
    private processServiceFactory = this.createTypeMoq<IProcessServiceFactory>('Process Exec Factory');;
    private processService: MockProcessService = new MockProcessService();
    private interpreterService = this.createTypeMoq<IInterpreterService>('Interpreter Service');
    private ipykernelInstallCount: number = 0;
    private asyncRegistry : IAsyncDisposableRegistry;
    private changedInterpreterEvent: EventEmitter<void> = new EventEmitter<void>();
    private installedInterpreters : PythonInterpreter[] = [];
    private activeInterpreter: PythonInterpreter | undefined;
    private sessionTimeout: number | undefined;
    private cellDictionary = {};
    private kernelSpecs : {name: string, dir: string}[] = [];

    constructor(serviceManager: IServiceManager) {
        // Save async registry. Need to stick servers created into it
        this.asyncRegistry = serviceManager.get<IAsyncDisposableRegistry>(IAsyncDisposableRegistry);

        // Make our process service factory always return this item
        this.processServiceFactory.setup(p => p.create()).returns(() => Promise.resolve(this.processService));

        // Setup our interpreter service
        this.interpreterService.setup(i => i.onDidChangeInterpreter).returns(() => this.changedInterpreterEvent.event);
        this.interpreterService.setup(i => i.getActiveInterpreter()).returns(() => Promise.resolve(this.activeInterpreter));
        this.interpreterService.setup(i => i.getInterpreters()).returns(() => Promise.resolve(this.installedInterpreters));
        this.interpreterService.setup(i => i.getInterpreterDetails(TypeMoq.It.isAnyString())).returns((p) => {
            const found = this.installedInterpreters.find(i => i.path === p);
            if (found) {
                return Promise.resolve(found);
            }
            return Promise.reject('Unknown interpreter');
        });

        // Stick our services into the service manager
        serviceManager.addSingletonInstance<IJupyterSessionManager>(IJupyterSessionManager, this);
        serviceManager.addSingletonInstance<IInterpreterService>(IInterpreterService, this.interpreterService.object);
        serviceManager.addSingletonInstance<IPythonExecutionFactory>(IPythonExecutionFactory, this.pythonExecutionFactory.object);
        serviceManager.addSingletonInstance<IProcessServiceFactory>(IProcessServiceFactory, this.processServiceFactory.object);

        // Setup our default kernel spec (this is just a dummy value)
        this.kernelSpecs.push({name: '0e8519db-0895-416c-96df-fa80131ecea0', dir: 'C:\\Users\\rchiodo\\AppData\\Roaming\\jupyter\\kernels\\0e8519db-0895-416c-96df-fa80131ecea0'});
    }

    public makeActive(interpreter: PythonInterpreter) {
        this.activeInterpreter = interpreter;
    }

    public addInterpreter(interpreter: PythonInterpreter, supportedCommands: SupportedCommands, notebookStdErr?: string[]) {
        this.installedInterpreters.push(interpreter);

        // Add the python calls first.
        const pythonService = new MockPythonService(interpreter);
        this.pythonExecutionFactory.setup(f => f.create(TypeMoq.It.is(o => {
            return o && o.pythonPath && o.pythonPath === interpreter.path;
        }))).returns(() => Promise.resolve(pythonService));
        this.setupSupportedPythonService(pythonService, interpreter, supportedCommands, notebookStdErr);

        // Then the process calls
        this.setupSupportedProcessService(interpreter, supportedCommands, notebookStdErr);

        // Default to being the new active
        this.makeActive(interpreter);
    }

    public addPath(jupyterPath: string, supportedCommands: SupportedCommands, notebookStdErr?: string[]) {
        this.setupPathProcessService(jupyterPath, this.processService, supportedCommands, notebookStdErr);
    }

    public addCell(code: string, result: string, mimeType?: string) {
        const cells = generateCells(code, 'foo.py', 1, true);
        cells.forEach(c => {
            const key = c.data.source.toString();
            if (c.data.cell_type === 'code') {
                // Update outputs based on mime type
                const output: nbformat.IStream = {
                    output_type: 'stream',
                    name: 'stdout',
                    text: result
                };
                output.data = {};
                output.data[mimeType ? mimeType : 'text/plain'] = result;
                const data: nbformat.ICodeCell = c.data as nbformat.ICodeCell;
                data.outputs = [...data.outputs, output];
                c.data = data;
            }

            // Save each in our dictionary for future use.
            // Note: Our entire setup is recreated each test so this dictionary
            // should be unique per test
            this.cellDictionary[key] = c;
        })
    }

    public setWaitTime(timeout: number | undefined) {
        this.sessionTimeout = timeout;
    }

    public startNew(connInfo: IConnection, kernelSpec: IJupyterKernelSpec, cancelToken?: CancellationToken) : Promise<IJupyterSession> {
        this.asyncRegistry.push(connInfo);
        this.asyncRegistry.push(kernelSpec);
        if (this.sessionTimeout && cancelToken) {
            return Cancellation.race(async () => {
                await sleep(this.sessionTimeout);
                return new MockJupyterSession(this.cellDictionary, MockJupyterTimeDelay);
            }, cancelToken);
        } else {
            return Promise.resolve(new MockJupyterSession(this.cellDictionary, MockJupyterTimeDelay));
        }
    }

    public getActiveKernelSpecs(connection: IConnection) : Promise<IJupyterKernelSpec[]> {
        return Promise.resolve([]);
    }

    private createTempSpec(pythonPath: string): string {
        const tempDir = os.tmpdir();
        const subDir = uuid();
        const filePath = path.join(tempDir, subDir, 'kernel.json');
        fs.ensureDirSync(path.dirname(filePath));
        fs.writeJSONSync(filePath,
            {
                display_name: 'Python 3',
                language: 'python',
                argv: [
                    pythonPath,
                    '-m',
                    'ipykernel_launcher',
                    '-f',
                    '{connection_file}'
                ]
            });
        return filePath;
    }

    private createTypeMoq<T>(tag: string): TypeMoq.IMock<T> {
        // Use typemoqs for those things that are resolved as promises. mockito doesn't allow nesting of mocks. ES6 Proxy class
        // is the problem. We still need to make it thenable though. See this issue: https://github.com/florinn/typemoq/issues/67
        const result = TypeMoq.Mock.ofType<T>();
        result['tag'] = tag;
        result.setup((x: any) => x.then).returns(() => undefined);
        return result;
    }

    private setupPythonServiceExec(service: MockPythonService, module: string, args: (string | RegExp)[], result: () => Promise<ExecutionResult<string>>) {
        service.addExecModuleResult(module, args, result);
    }

    private setupPythonServiceExecObservable(service: MockPythonService, module: string, args: (string | RegExp)[], stderr: string[], stdout: string[]) {
        service.addExecModuleObservableResult(module, args, () => {
        return {
            proc: undefined,
            out: new Observable<Output<string>>(subscriber => {
                stderr.forEach(s => subscriber.next({ source: 'stderr', out: s }));
                stdout.forEach(s => subscriber.next({ source: 'stderr', out: s }));
            }),
            dispose: () => {
                noop();
            }
        }});
    }

    private setupProcessServiceExec(service: MockProcessService, file: string, args: (string | RegExp)[], result: () => Promise<ExecutionResult<string>>) {
        service.addExecResult(file, args, result);
    }

    private setupProcessServiceExecObservable(service: MockProcessService, file: string, args: (string | RegExp)[], stderr: string[], stdout: string[]) {
        service.addExecObservableResult(file, args, () => {
        return {
            proc: undefined,
            out: new Observable<Output<string>>(subscriber => {
                stderr.forEach(s => subscriber.next({ source: 'stderr', out: s }));
                stdout.forEach(s => subscriber.next({ source: 'stderr', out: s }));
            }),
            dispose: () => {
                noop();
            }
        }});
    }

    private setupSupportedPythonService(service: MockPythonService, workingPython: PythonInterpreter, supportedCommands: SupportedCommands, notebookStdErr?: string[]) {
        if ((supportedCommands & SupportedCommands.ipykernel) === SupportedCommands.ipykernel) {
            this.setupPythonServiceExec(service, 'ipykernel', ['--version'], () => Promise.resolve({ stdout: '1.1.1.1' }));
            this.setupPythonServiceExec(service, 'ipykernel', ['install', '--user', '--name', /\w+-\w+-\w+-\w+-\w+/, '--display-name', `'Python Interactive'`], () => {
                const spec = this.addKernelSpec(workingPython.path);
                return Promise.resolve({ stdout: `somename ${path.dirname(spec)}` });
            })
        }
        if ((supportedCommands & SupportedCommands.nbconvert) === SupportedCommands.nbconvert) {
            this.setupPythonServiceExec(service, 'jupyter', ['nbconvert', '--version'], () => Promise.resolve({ stdout: '1.1.1.1' }));
        }
        if ((supportedCommands & SupportedCommands.notebook) === SupportedCommands.notebook) {
            this.setupPythonServiceExec(service, 'jupyter', ['notebook', '--version'], () => Promise.resolve({ stdout: '1.1.1.1' }));
            this.setupPythonServiceExecObservable(service, 'jupyter', ['notebook', '--no-browser', /--notebook-dir=.*/, /.*/], [], notebookStdErr ? notebookStdErr : ['http://localhost:8888/?token=198']);

        }
        if ((supportedCommands & SupportedCommands.kernelspec) === SupportedCommands.kernelspec) {
            this.setupPythonServiceExec(service, 'jupyter', ['kernelspec', '--version'], () => Promise.resolve({ stdout: '1.1.1.1' }));
            this.setupPythonServiceExec(service, 'jupyter', ['kernelspec', 'list'], () => {
                const results = this.kernelSpecs.map(k => {
                    return `  ${k.name}  ${k.dir}`;
                }).join(os.EOL);
                return Promise.resolve({stdout: results});
            });

        }
    }

    private addKernelSpec(pythonPath: string) : string {
        const spec = this.createTempSpec(pythonPath);
        this.kernelSpecs.push({name: `${this.kernelSpecs.length}Spec`, dir: `${path.dirname(spec)}`});
        return spec;
    }

    private setupSupportedProcessService(workingPython: PythonInterpreter, supportedCommands: SupportedCommands, notebookStdErr?: string[]) {
        if ((supportedCommands & SupportedCommands.ipykernel) === SupportedCommands.ipykernel) {
            // Don't mind the goofy path here. It's supposed to not find the item on your box. It's just testing the internal regex works
            this.setupProcessServiceExec(this.processService, workingPython.path, ['-m', 'jupyter', 'kernelspec', 'list'], () => {
                const results = this.kernelSpecs.map(k => {
                    return `  ${k.name}  ${k.dir}`;
                }).join(os.EOL);
                return Promise.resolve({stdout: results});
            });
            this.setupProcessServiceExec(this.processService, workingPython.path, ['-m', 'ipykernel', 'install', '--user', '--name', /\w+-\w+-\w+-\w+-\w+/, '--display-name', `'Python Interactive'`], () => {
                this.ipykernelInstallCount += 1;
                const spec = this.addKernelSpec(workingPython.path);
                return Promise.resolve({ stdout: `somename ${path.dirname(spec)}` });
            });
            const getServerInfoPath = path.join(EXTENSION_ROOT_DIR, 'pythonFiles', 'datascience', 'getServerInfo.py');
            this.setupProcessServiceExec(this.processService, workingPython.path, [getServerInfoPath], () => Promise.resolve({ stdout: 'failure to get server infos' }));
            this.setupProcessServiceExecObservable(this.processService, workingPython.path, ['-m', 'jupyter', 'kernelspec', 'list'], [], []);
            this.setupProcessServiceExecObservable(this.processService, workingPython.path, ['-m', 'jupyter', 'notebook', '--no-browser', /--notebook-dir=.*/, /.*/], [], notebookStdErr ? notebookStdErr : ['http://localhost:8888/?token=198']);
        } else if ((supportedCommands & SupportedCommands.notebook) === SupportedCommands.notebook) {
            this.setupProcessServiceExec(this.processService, workingPython.path, ['-m', 'jupyter', 'kernelspec', 'list'], () => {
                const results = this.kernelSpecs.map(k => {
                    return `  ${k.name}  ${k.dir}`;
                }).join(os.EOL);
                return Promise.resolve({stdout: results});
            });
            const getServerInfoPath = path.join(EXTENSION_ROOT_DIR, 'pythonFiles', 'datascience', 'getServerInfo.py');
            this.setupProcessServiceExec(this.processService, workingPython.path, [getServerInfoPath], () => Promise.resolve({ stdout: 'failure to get server infos' }));
            this.setupProcessServiceExecObservable(this.processService, workingPython.path, ['-m', 'jupyter', 'kernelspec', 'list'], [], []);
            this.setupProcessServiceExecObservable(this.processService, workingPython.path, ['-m', 'jupyter', 'notebook', '--no-browser', /--notebook-dir=.*/, /.*/], [], notebookStdErr ? notebookStdErr : ['http://localhost:8888/?token=198']);
        }
        if ((supportedCommands & SupportedCommands.nbconvert) === SupportedCommands.nbconvert) {
            this.setupProcessServiceExec(this.processService, workingPython.path, ['-m', 'jupyter', 'nbconvert', /.*/, '--to', 'python', '--stdout', '--template', /.*/], () => {
                return Promise.resolve({
                    stdout: '#%%\r\nimport os\r\nos.chdir()'
                });
            });
        }
    }

    private setupPathProcessService(jupyterPath: string, service: MockProcessService, supportedCommands: SupportedCommands, notebookStdErr?: string[]) {
        if ((supportedCommands & SupportedCommands.kernelspec) === SupportedCommands.kernelspec) {
            this.setupProcessServiceExec(service, jupyterPath, ['kernelspec', 'list'], () => {
                const results = this.kernelSpecs.map(k => {
                    return `  ${k.name}  ${k.dir}`;
                }).join(os.EOL);
                return Promise.resolve({stdout: results});
            });
            this.setupProcessServiceExecObservable(service, jupyterPath, ['kernelspec', 'list'], [], []);
            this.setupProcessServiceExec(service, jupyterPath, ['kernelspec', '--version'],() =>  Promise.resolve({ stdout: '1.1.1.1' }));
            this.setupProcessServiceExec(service, 'jupyter', ['kernelspec', '--version'], () => Promise.resolve({ stdout: '1.1.1.1' }));
        } else {
            this.setupProcessServiceExec(service, jupyterPath, ['kernelspec', '--version'], () => Promise.reject());
            this.setupProcessServiceExec(service, 'jupyter', ['kernelspec', '--version'], () => Promise.reject());
        }

        this.setupProcessServiceExec(service, jupyterPath, ['--version'], () => Promise.resolve({ stdout: '1.1.1.1' }));
        this.setupProcessServiceExec(service, 'jupyter', ['--version'], () => Promise.resolve({ stdout: '1.1.1.1' }));

        if ((supportedCommands & SupportedCommands.kernelspec) === SupportedCommands.kernelspec) {
            this.setupProcessServiceExec(service, jupyterPath, ['notebook', '--version'], () => Promise.resolve({ stdout: '1.1.1.1' }));
            this.setupProcessServiceExecObservable(service, jupyterPath, ['notebook', '--no-browser', /--notebook-dir=.*/, /.*/], [], notebookStdErr ? notebookStdErr : ['http://localhost:8888/?token=198']);
            this.setupProcessServiceExec(service, 'jupyter', ['notebook', '--version'], () => Promise.resolve({ stdout: '1.1.1.1' }));
        } else {
            this.setupProcessServiceExec(service, 'jupyter', ['notebook', '--version'], () => Promise.reject());
            this.setupProcessServiceExec(service, jupyterPath, ['notebook', '--version'], () => Promise.reject());
        }
    }
}
