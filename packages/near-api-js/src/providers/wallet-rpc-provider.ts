/**
 * @module
 * @description
 * This module contains the {@link WalletRpcProvider} client class
 * which can be used to interact with the [NEAR RPC API](https://docs.near.org/api/rpc/introduction) using provider in wallet
 * @see {@link providers/provider | providers} for a list of request and response types
 */
import {
    FinalExecutionOutcome,
} from './provider';
import { TypedError } from '../utils/errors';
import exponentialBackoff from '../utils/exponential-backoff';
import { parseRpcError } from '../utils/rpc_errors';
import { Transaction } from '../transaction';
import { JsonRpcProvider } from './json-rpc-provider';
import { Wallet, RequestParams, Events } from './wallet.types';

// Default number of retries before giving up on a request.
const REQUEST_RETRY_NUMBER = 12;

// Default wait until next retry in millis.
const REQUEST_RETRY_WAIT = 500;

// Exponential back off for waiting to retry.
const REQUEST_RETRY_WAIT_BACKOFF = 1.5;

/// Keep ids unique across all connections.
let _nextId = 123;

export class WalletRpcProvider extends JsonRpcProvider {
    /** @hidden */
    private _provider: Wallet | null = null;

    /**
     * @param provider Wallet (NEP408 standards)
     */
    constructor(provider: Wallet) {
        super({url: ''});
        this._provider = provider;
    }

    /**
     * Add a new event listener (eg: networkChanged, accountsChanged)
     */
    on(event: keyof Events, listener: (...args: any[]) => void ): void {
        if (this._provider) {
            this._provider.on(event, listener);
        }
    }

    /**
     * Remove a event listener (eg: networkChanged, accountsChanged)
     */
    off(event: keyof Events, listener: (...args: any[]) => void ): void {
        if (this._provider) {
            this._provider.off(event, listener);
        }
    }

    /**
     * Sign and Sends a transaction to the RPC and waits until transaction is fully complete
     * 
     * @see {@link }
     *
     * @param transactions The transactions being sent
     * @returns {Promise<FinalExecutionOutcome>}
     */
    async signAndSendTransaction(transactions: Transaction[]): Promise<FinalExecutionOutcome> {
        const txs = transactions.map((tx) => Buffer.from(tx.encode()).toString('base64'));
        return this.sendJsonRpc('signAndSendTransaction', txs);
    }

    /**
     * Directly call the RPC specifying the method and params
     * Unlike json-rpc-provider, use a user-injected WalletProvider when communicating with rpc. 
     * When the response is transaction hash array, call txStatusString again and wait until the transaction is fully complete, return receipts.
     *
     * @param method RPC method
     * @param params Parameters to the method
     */
    async sendJsonRpc<T>(method: string, params: object): Promise<T> {
        const response = await exponentialBackoff(REQUEST_RETRY_WAIT, REQUEST_RETRY_NUMBER, REQUEST_RETRY_WAIT_BACKOFF, async () => {
            try {
                if (this._provider) {
                    const request: RequestParams = {
                        method,
                        params,
                        id: (_nextId++),
                        jsonrpc: '2.0'
                    };
                    const response = await this._provider.request(request);
                    // if reponse is array, it means wallet rpc provider returns transaction hash array
                    // in that case, call txStatus method to get transaction status and return receipt
                    if (Array.isArray(response)) {
                        // Success when error is not exist
                        const txStatus = await this.txStatus(response[0], this._provider.accounts[0].accountId);
                        return { result: txStatus };
                    } else if ((response as any).error) {
                        const error = (response as any).error;
                        if (typeof error.data === 'object') {
                            if (typeof error.data.error_message === 'string' && typeof error.data.error_type === 'string') {
                                // if error data has error_message and error_type properties, we consider that node returned an error in the old format
                                throw new TypedError(error.data.error_message, error.data.error_type);
                            }
    
                            throw parseRpcError(error.data);
                        } else {
                            const errorMessage = `[${error.code}] ${error.message}: ${error.data}`;
                            // NOTE: All this hackery is happening because structured errors not implemented
                            // TODO: Fix when https://github.com/nearprotocol/nearcore/issues/1839 gets resolved
                            if (error.data === 'Timeout' || errorMessage.includes('Timeout error')
                                || errorMessage.includes('query has timed out')) {
                                throw new TypedError(errorMessage, 'TimeoutError');
                            }
    
                            throw new TypedError(errorMessage, error.name);
                        }
                    }
                    // Success when response.error is not exist
                    return { result: response };
                }
                throw new Error('Provider not exist');
            } catch (error) {
                if (error.type === 'TimeoutError') {
                    if (!process.env['NEAR_NO_LOGS']) {
                        console.warn(`Retrying request to ${method} as it has timed out`, params);
                    }
                    return null;
                }

                throw error;
            }
        });
        const { result } = response;
        // From jsonrpc spec:
        // result
        //   This member is REQUIRED on success.
        //   This member MUST NOT exist if there was an error invoking the method.
        if (typeof result === 'undefined') {
            throw new TypedError(
                `Exceeded ${REQUEST_RETRY_NUMBER} attempts for request to ${method}.`, 'RetriesExceeded');
        }
        return result;
    }
}