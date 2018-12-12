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
import { CellState, ICell, IJupyterExecution, INotebookExporter, ISysInfo, IJupyterSessionManager, IConnection, IJupyterKernelSpec, IJupyterSession } from '../types';
import { Session, SessionManager, ContentsManager, Contents, ServerConnection } from '@jupyterlab/services';
import { JupyterSession } from './jupyterSession';
import { CancellationToken } from 'vscode-jsonrpc';
import { JupyterKernelSpec } from './jupyterKernelSpec';

@injectable()
export class JupyterSessionManager implements IJupyterSessionManager {

    public async startNew(connInfo: IConnection, kernelSpec: IJupyterKernelSpec, cancelToken?: CancellationToken) : Promise<IJupyterSession> {
        // Create a new session and attempt to connect to it
        const session = new JupyterSession(connInfo, kernelSpec);
        try {
            await session.connect(cancelToken);
        } finally {
            if (!session.isConnected) {
                await session.dispose();
            }
        }
        return session;
    }

    public async getActiveKernelSpecs(connection: IConnection) : Promise<IJupyterKernelSpec[]> {
        // Use our connection to create a session manager
        const serverSettings = ServerConnection.makeSettings(
            {
                baseUrl: connection.baseUrl,
                token: connection.token,
                pageUrl: '',
                // A web socket is required to allow token authentication (what if there is no token authentication?)
                wsUrl: connection.baseUrl.replace('http', 'ws'),
                init: { cache: 'no-store', credentials: 'same-origin' }
            });
        const sessionManager = new SessionManager({ serverSettings: serverSettings });

        // Ask the session manager to refresh its list of kernel specs.
        await sessionManager.refreshSpecs();

        // Enumerate all of the kernel specs, turning each into a JupyterKernelSpec
        const kernelspecs = sessionManager.specs && sessionManager.specs.kernelspecs ? sessionManager.specs.kernelspecs : {};
        const keys = Object.keys(kernelspecs);
        return keys.map(k => {
            const spec = kernelspecs[k];
            return new JupyterKernelSpec(spec);
        });
    }

}
