// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { nbformat } from '@jupyterlab/coreutils';
import { inject, injectable } from 'inversify';
import * as uuid from 'uuid/v4';

import * as os from 'os';
import * as path from 'path';
import { IWorkspaceService } from '../../common/application/types';
import { IFileSystem } from '../../common/platform/types';
import { ILogger } from '../../common/types';
import * as localize from '../../common/utils/localize';
import { noop } from '../../common/utils/misc';
import { CodeSnippits, RegExpValues } from '../constants';
import { CellState, ICell, IJupyterExecution, INotebookExporter, ISysInfo, IJupyterSessionManager, IConnection, IJupyterSession, IJupyterKernelSpec } from '../types';
import { Session, SessionManager, ContentsManager, Contents, ServerConnection, Kernel, KernelMessage } from '@jupyterlab/services';
import { CancellationToken } from 'vscode-jsonrpc';
import { Cancellation } from '../../common/cancellation';
import { Event, EventEmitter } from 'vscode';
import { Slot } from '@phosphor/signaling';
import { JSONObject } from '@phosphor/coreutils';
import { sleep } from '../../common/utils/async';

export class JupyterSession implements IJupyterSession {
    private connInfo: IConnection;
    private kernelSpec: IJupyterKernelSpec | undefined;
    private sessionManager : SessionManager | undefined;
    private session: Session.ISession;
    private contentsManager: ContentsManager | undefined;
    private notebookFile: Contents.IModel | undefined;
    private onRestartedEvent : EventEmitter<void> = new EventEmitter<void>();
    private statusHandler : Slot<Session.ISession, Kernel.Status> | undefined;
    private connected: boolean = false;

    constructor(
        connInfo: IConnection,
        kernelSpec: IJupyterKernelSpec | undefined) {
        this.connInfo = connInfo;
        this.kernelSpec = kernelSpec;
    }

    public dispose() : Promise<void> {
        return this.shutdown();
    }

    public shutdown = async () : Promise<void> => {
        await this.destroyKernelSpec();

        // Destroy the notebook file if not local. Local is cleaned up when we destroy the kernel spec.
        if (this.notebookFile && this.contentsManager && this.connInfo && !this.connInfo.localLaunch) {
            try {
                await this.contentsManager.delete(this.notebookFile.path);
            } catch {
                noop();
            }
        }
        await this.shutdownSessionAndConnection();
    }

    public get onRestarted() : Event<void> {
        return this.onRestartedEvent.event.bind(this.onRestartedEvent);
    }

    public async waitForIdle() : Promise<void> {
        if (this.session && this.session.kernel) {
            await this.session.kernel.ready;

            while (this.session.kernel.status !== 'idle') {
                await sleep(0);
            }
        }
    }

    public restart() : Promise<void> {
        return this.session && this.session.kernel ? this.session.kernel.restart() : Promise.resolve();
    }

    public interrupt() : Promise<void> {
        return this.session && this.session.kernel ? this.session.kernel.interrupt() : Promise.resolve();
    }

    public requestExecute(content: KernelMessage.IExecuteRequest, disposeOnDone?: boolean, metadata?: JSONObject) : Kernel.IFuture {
        return this.session && this.session.kernel ? this.session.kernel.requestExecute(content, disposeOnDone, metadata) : undefined;
    }

    public async connect(cancelToken?: CancellationToken) : Promise<void> {
        // First connect to the sesssion manager
        const serverSettings = ServerConnection.makeSettings(
            {
                baseUrl: this.connInfo.baseUrl,
                token: this.connInfo.token,
                pageUrl: '',
                // A web socket is required to allow token authentication
                wsUrl: this.connInfo.baseUrl.replace('http', 'ws'),
                init: { cache: 'no-store', credentials: 'same-origin' }
            });
        this.sessionManager = new SessionManager({ serverSettings: serverSettings });

        // Create a temporary .ipynb file to use
        this.contentsManager = new ContentsManager({ serverSettings: serverSettings });
        this.notebookFile = await this.contentsManager.newUntitled({type: 'notebook'});

        // Create our session options using this temporary notebook and our connection info
        const options: Session.IOptions = {
            path: this.notebookFile.path,
            kernelName: this.kernelSpec ? this.kernelSpec.name : '',
            serverSettings: serverSettings
        };

        // Start a new session
        this.session = await Cancellation.race(() => this.sessionManager!.startNew(options), cancelToken);

        // Listen for session status changes
        this.statusHandler = this.onStatusChanged.bind(this.onStatusChanged);
        this.session.statusChanged.connect(this.statusHandler);

        // Made it this far, we're connected now
        this.connected = true;
    }

    public get isConnected() : boolean {
        return this.connected;
    }

    private onStatusChanged(s: Session.ISession, a: Kernel.Status) {
        if (a === 'starting') {
            this.onRestartedEvent.fire();
        }
    }

    private async destroyKernelSpec() {
        try {
            if (this.kernelSpec) {
                await this.kernelSpec.dispose(); // This should delete any old kernel specs
            }
        } catch {
            noop();
        }
        this.kernelSpec = undefined;
    }

    private shutdownSessionAndConnection = async () => {
        if (this.contentsManager) {
            this.contentsManager.dispose();
            this.contentsManager = undefined;
        }
        if (this.session || this.sessionManager) {
            try {
                if (this.statusHandler && this.session) {
                    this.session.statusChanged.disconnect(this.statusHandler);
                    this.statusHandler = undefined;
                }
                if (this.session) {
                    await this.session.shutdown();
                    this.session.dispose();
                }
                if (this.sessionManager) {
                    this.sessionManager.dispose();
                }
            } catch {
                noop();
            }
            this.session = undefined;
            this.sessionManager = undefined;
        }
        this.onRestartedEvent.dispose();
        if (this.connInfo) {
            this.connInfo.dispose(); // This should kill the process that's running
            this.connInfo = undefined;
        }
    }

}
