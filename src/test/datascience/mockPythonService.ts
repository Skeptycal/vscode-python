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
    IPythonExecutionFactory,
    InterpreterInfomation,
    SpawnOptions
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
import { MockProcessService } from './mockProcessService';

export class MockPythonService implements IPythonExecutionService  {
    private interpreter: PythonInterpreter;
    private procService: MockProcessService = new MockProcessService();

    constructor(interpreter: PythonInterpreter) {
        this.interpreter = interpreter;
    }

    public getInterpreterInformation(): Promise<InterpreterInfomation> {
        return Promise.resolve(this.interpreter);
    }

    public getExecutablePath(): Promise<string> {
        return Promise.resolve(this.interpreter.path);
    }

    public isModuleInstalled(moduleName: string): Promise<boolean> {
        return Promise.resolve(false);
    }

    public execObservable(args: string[], options: SpawnOptions): ObservableExecutionResult<string> {
        return this.procService.execObservable(this.interpreter.path, args, options);
    }
    public execModuleObservable(moduleName: string, args: string[], options: SpawnOptions): ObservableExecutionResult<string> {
        return this.procService.execObservable(this.interpreter.path, ['-m', moduleName, ...args], options);
    }
    public exec(args: string[], options: SpawnOptions): Promise<ExecutionResult<string>> {
        return this.procService.exec(this.interpreter.path, args, options);
    }

    public execModule(moduleName: string, args: string[], options: SpawnOptions): Promise<ExecutionResult<string>> {
        return this.procService.exec(this.interpreter.path, ['-m', moduleName, ...args], options);
    }

    public addExecResult(args: (string | RegExp)[], result:() => Promise<ExecutionResult<string>>) {
        this.procService.addExecResult(this.interpreter.path, args, result);
    }

    public addExecModuleResult(moduleName: string, args: (string | RegExp)[], result:() => Promise<ExecutionResult<string>>) {
        this.procService.addExecResult(this.interpreter.path, ['-m', moduleName, ...args], result);
    }

    public addExecObservableResult(args: (string | RegExp)[], result:() => ObservableExecutionResult<string>) {
        this.procService.addExecObservableResult(this.interpreter.path, args, result);
    }

    public addExecModuleObservableResult(moduleName: string, args: (string | RegExp)[], result:() => ObservableExecutionResult<string>) {
        this.procService.addExecObservableResult(this.interpreter.path, ['-m', moduleName, ...args], result);
    }
}
