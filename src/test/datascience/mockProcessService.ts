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
    SpawnOptions,
    ShellOptions
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

export class MockProcessService implements IProcessService {
    private execResults: {file: string, args: (string | RegExp)[], result: () => Promise<ExecutionResult<string>> }[] = [];
    private execObservableResults: {file: string, args: (string | RegExp)[], result: () => ObservableExecutionResult<string> }[] = [];

    public execObservable(file: string, args: string[], options: SpawnOptions): ObservableExecutionResult<string> {
        const match = this.execObservableResults.find(f => this.argsMatch(f.args, args) && f.file === file);
        if (match) {
            return match.result();
        }

        return this.defaultObservable([file, ...args]);
    }
    public exec(file:string, args: string[], options: SpawnOptions): Promise<ExecutionResult<string>> {
        const match = this.execResults.find(f => this.argsMatch(f.args, args) && f.file === file);
        if (match) {
            return match.result();
        }

        return this.defaultExecutionResult([file, ...args]);
    }

    public shellExec(command:string, options: ShellOptions) : Promise<ExecutionResult<string>> {
        // Not supported
        return this.defaultExecutionResult([command]);
    }

    public addExecResult(file:string, args: (string | RegExp)[], result:() => Promise<ExecutionResult<string>>) {
        this.execResults.push({file: file, args: args, result: result});
    }

    public addExecObservableResult(file:string, args: (string | RegExp)[], result:() => ObservableExecutionResult<string>) {
        this.execObservableResults.push({file: file, args: args, result: result});
    }

    private argsMatch(matchers: (string | RegExp)[], args: string[]): boolean {
        if (matchers.length === args.length) {
            return args.every((s, i) => {
                const r = matchers[i] as RegExp;
                return r && r.test ? r.test(s) : s === matchers[i];
            });
        }
        return false;
    }

    private defaultObservable(args: string []) : ObservableExecutionResult<string> {
        const output = new Observable<Output<string>>(subscriber => { subscriber.next({out: `Invalid call to ${args.join(' ')}`, source: 'stderr'}); });
        return {
            proc: undefined,
            out: output,
            dispose: () => {}
        };
    }

    private defaultExecutionResult(args: string[]) : Promise<ExecutionResult<string>> {
        return Promise.resolve({stderr: `Invalid call to ${args.join(' ')}`, stdout: ''});
    }

}
