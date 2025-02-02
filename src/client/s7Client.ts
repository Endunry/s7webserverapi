import { map, mergeMap, Observable, ObservableInput, ReplaySubject, Subject, Subscription, switchMap, take } from "rxjs";
import { CacheMethod, FlattenKeys, GetCertificateUrlParams, GetPermissionsParams, GetPermissionsResult, LoginParams, LoginResult, Params, PingParams, PlcPermissions, ReadParams, ReadResult, RPCErrorCode, RPCLoginError, RPCMethodObject, RPCMethods, RPCResponse, RPCResults, S7DataTypes, S7JsonClient, S7WebserverClientConfig, WriteParams, WriteResult } from "../util/types";
import { RxJSHttpClient } from "rxjs-http-client";
import { WriteTransaction, WriteTransactionHandler } from "./WriteTransaction";
import { CacheStructure } from "./CacheStructure";
import murmurhash = require("murmurhash");
import { SubscriberTrie } from "./Trie";


export class S7WebserverClient<T> implements S7JsonClient<T> {

    private http: RxJSHttpClient;
    private connectionErrorObservable = new Subject<VoidFunction>();
    public onPlcConnectionReady: ReplaySubject<boolean> = new ReplaySubject<boolean>();

    private loaded = false;
    private user: string = '';
    private token: string = '';

    private permissionMap: Map<PlcPermissions, boolean> = new Map();
    private permissionsSubject: ReplaySubject<PlcPermissions[]> = new ReplaySubject<PlcPermissions[]>();

    private lastPollingTime: Date = new Date();
    private pollingDelay: number;
    private slowPollingMode: boolean = false;

    private readStack: FlattenKeys<T>[] = [];
    private lastReadStack: FlattenKeys<T>[] = [];

    private cache = new CacheStructure<T>();
    private pollErrorSubject = new Subject<string>();

    private writeTransactionHandler: WriteTransactionHandler<T> = new WriteTransactionHandler<T>();

    private subscriberCountMap: Map<FlattenKeys<T>, number> = new Map();
    private rpcRequestHashedKeyMap = new Map<number, string>();

    private getRequestLoadedSubject: Subject<boolean> = new Subject<boolean>();
    /**
     * Because we use flattened keys, we use a Trie-Datastructure to keep track of the subscribers.
     * When a leaf changes its value we can use the prefix-property of the trie to also call all the parents of the leaf.
     *
     * @private
     * @type {SubscriberTrie<typeof data>}
     */
    private subscriberTrie: SubscriberTrie<T> = new SubscriberTrie();

    /**
     * Subscriber trie for non cached values.
     *
     * @private
     * @type {SubscriberTrie<typeof data>}
     */
    private ignoreCacheSubscriberTrie: SubscriberTrie<T> = new SubscriberTrie();


    private localStorage?: Storage;

    private pollTimeout: NodeJS.Timeout | undefined;

    constructor(private baseUrl: string, private config: S7WebserverClientConfig<T>) {
        this.config.localStoragePrefix = config.localStoragePrefix ?? 's7_'
        this.config.defaultUser = config.defaultUser ?? { user: 'Anonymous', password: '' };

        this.config.polling = config.polling ?? {
            slowMinDelay: 1000 * 60, // Every minute
            minDelay: 15,
            emaAlpha: 0.1,
            clamp: true
        };

        this.pollingDelay = this.config.polling.minDelay;

        this.http = new RxJSHttpClient();

        this.localStorage = undefined;
        if (Object.keys(this).includes("localStorage")) {
            this.localStorage = this.localStorage;
        }

    }

    public start() {
        this.loadInitialCacheData();
        this.initPLCPoll();
        return this.onPlcConnectionReady.asObservable();
    }

    private checkStoredToken(): Observable<string | undefined> {

        if (this.localStorage?.getItem(this.config.localStoragePrefix + 'token') != undefined && this.localStorage?.getItem(this.config.localStoragePrefix + 'user') != undefined) {
            // Check if
            const req = {
                body: JSON.stringify(this.getRPCMethodObject(RPCMethods.GetPermissions, undefined, 'GETPERMISSIONS')),
                headers: { 'Content-Type': 'application/json', 'X-Auth-Token': this.localStorage?.getItem(this.config.localStoragePrefix + 'token')! }
            }
            return this.http.post(this.baseUrl, req)
                .pipe(
                    mergeMap(response => response.json() as ObservableInput<RPCResponse<GetPermissionsResult>>)
                )
                .pipe(
                    map((response) => {
                        if (response.error) {
                            return undefined;
                        }
                        if (response.result?.length === 0) {
                            return undefined;
                        } else {
                            this.setCurrentPermissions(response.result!);
                            this.token = this.localStorage?.getItem(this.config.localStoragePrefix + 'token')!;
                            this.user = this.localStorage?.getItem(this.config.localStoragePrefix + 'user')!;
                            return this.localStorage?.getItem(this.config.localStoragePrefix + 'user')!;
                        }
                    }));
        } else {
            return new Observable((subscriber) => {
                subscriber.next();
            });
        }

    }

    /**
   * Sets the current permissions and updates the permissions subject so other components can get a live-update of the permissions.
   * E.g. if the user logs out, we may want to redirect them if theyre currently on a page they shouldnt access.
   * @param permissions
   */
    private setCurrentPermissions(permissions: GetPermissionsResult) {

        this.permissionMap.clear();
        const perms: PlcPermissions[] = [];
        for (const permission of permissions) {
            this.permissionMap.set(permission.name, true);
            perms.push(permission.name);
        }
        this.permissionsSubject.next(perms);
    }

    private getRPCMethodObject(method: RPCMethods.Ping, params: PingParams, id?: string): RPCMethodObject;
    private getRPCMethodObject(method: RPCMethods.Read, params: ReadParams, id?: string): RPCMethodObject;
    private getRPCMethodObject(method: RPCMethods.Login, params: LoginParams, id?: string): RPCMethodObject;
    private getRPCMethodObject(method: RPCMethods.GetCertificateUrl, params: GetCertificateUrlParams, id?: string): RPCMethodObject;
    private getRPCMethodObject(method: RPCMethods.Write, params: WriteParams, id?: string): RPCMethodObject;
    private getRPCMethodObject(method: RPCMethods.GetPermissions, params: GetPermissionsParams, id?: string): RPCMethodObject;
    private getRPCMethodObject(method: RPCMethods, params: Params, id: string = '0'): RPCMethodObject {
        return {
            jsonrpc: "2.0",
            method: method,
            params: params,
            id
        }
    }

    public initPLCPoll() {
        this.checkStoredToken().pipe(take(1)).subscribe({
            next: (value) => {
                if (value == undefined) {
                    this.login().pipe(take(1)).subscribe({
                        next: () => {
                            this.pollData();
                        },
                        error: () => {
                            this.connectionErrorObservable.next(() => {
                                this.initPLCPoll();
                            });
                        }
                    });
                } else {
                    this.pollData()
                }
            },
            error: () => {
                this.connectionErrorObservable.next(() => {
                    this.initPLCPoll();
                });
            }
        });

    }

    private hashRPCMethods(set: Set<RPCMethodObject>) {
        for (const setEntry of set) {
            setEntry.id = this.getHashedId(setEntry.id).toString();
        }
    }

    private getHashedId(humanReadableId: string): number {
        let hashedId = murmurhash(humanReadableId);
        let counter = 0;
        while (this.rpcRequestHashedKeyMap.has(hashedId) && this.rpcRequestHashedKeyMap.get(hashedId) !== humanReadableId) {
            counter++;
            hashedId = murmurhash(humanReadableId + counter.toString());
        }
        this.rpcRequestHashedKeyMap.set(hashedId, humanReadableId);

        return hashedId;
    }

    private handleRPCResponse(responses: RPCResponse<RPCResults>[]) {

        if (this.loaded === false) {
            this.onPlcConnectionReady.next(true);
            this.loaded = true;
        }

        for (const responseKey in responses) {

            const response = responses[responseKey];
            const unhashedId = this.rpcRequestHashedKeyMap.get(+response.id);
            if (unhashedId == undefined) {
                throw new Error(`The Webserver-API returned an RPC-Result with an id that was not configured correctly (missed hash-id)`);
            }
            const responseSplit = unhashedId.split(":");
            const command = responseSplit[0];
            const key = responseSplit[1] as FlattenKeys<T>;
            const additional = responseSplit[2] as string | undefined;
            if (response.error != undefined) {
                this.handleRPCResponseError(unhashedId, response.error);
                if (command === "WRITE") {
                    this.writeTransactionHandler.resolveDependentKey(Number(additional), key, false);
                }
                continue;
            }

            switch (command) {
                case "READ":
                    this.handleRPCResponseRead(key, response as RPCResponse<RPCMethods.Read>);
                    break;
                case "WRITE":
                    this.handleRPCResponseWrite(key, response as RPCResponse<WriteResult>, Number(additional));
                    break;
            }


        }

    }

    private handleRPCResponseRead(key: FlattenKeys<T>, reponse: RPCResponse<ReadResult>) {
        const oldValue = this.cache.getCopy(key);
        this.cache.writeEntry(key, reponse.result);
        if (oldValue !== this.cache.getReference(key)) {
            this.subscriberTrie.notifySubscriber(key, this.cache.cacheObject);
        }
        this.ignoreCacheSubscriberTrie.notifySubscriber(key, this.cache.cacheObject);
    }

    private handleRPCResponseWrite(key: FlattenKeys<T>, response: RPCResponse<WriteResult>, writeTransactionId: number) {
        const oldValue = this.cache.getCopy(key);
        this.writeTransactionHandler.resolveDependentKey(writeTransactionId, key, response.result as boolean, this.cache);
        if (oldValue !== this.cache.getReference(key)) {
            this.subscriberTrie.notifySubscriber(key, this.cache.cacheObject);
        }
        this.ignoreCacheSubscriberTrie.notifySubscriber(key, this.cache.cacheObject);
    }

    /**
   * Or better, maybe call the subscriber on error. Maybe create a error-subject that can be subscribed to and display the error somewhere in the UI.
   * @param id rpc-id
   * @param error RPC-Error Object
   */
    private handleRPCResponseError(id: string, error: { code: RPCErrorCode, message: string }) {
        switch (error.code) {
            case RPCErrorCode.PERMISSON_DENIED: {
                this.pollErrorSubject.next(`Youre not allowed to execute this operation: ${id}`);
                break;
            }
            case RPCErrorCode.ADRESS_NOT_FOUND: {
                this.pollErrorSubject.next(`The address ${id} was not found in the PLC`);
                break;
            }
            default:
                this.pollErrorSubject.next(`Error in RPC-Response with id: ${id} and error: ${error.code}: ${error.message}`);;
        }
    }

    // MARK: Polling-Cycle
    /**
     * This is the polling-cycle that will be called recursivley. It collects all the RPC-Methods that need to be called.
     * It collects one time get- and write-requests and subscriber-requests. It then sends the requests to the PLC and collects them.
     *
     * If an network-error occurs, the connectionErrorObservable is called with a callback function. This is primarily used to retry connection attempts. Currently we display a error-toast with a retry button that calls this callback function.
     *
     *
     * @returns
     */
    pollData(once: boolean = false) {
        this.lastPollingTime = new Date();

        const headers = {
            'Content-Type': 'application/json',
            'X-Auth-Token': this.token
        }

        const jsonRPC = this.collectRPCMethodObjects();
        /**
         * The id is used for actually identifiying which logical request was made like READ:<hmi-key>
         * This is good for the code and for debug purposes, however if we send multiple requests at once this id is really big
         * An string can easily be 100+ chars long. So we hash it to a number, which reduces the data send over http.
         */
        this.hashRPCMethods(jsonRPC);
        this.http.post(this.baseUrl, { body: JSON.stringify(Array.from(jsonRPC)), headers })
            .pipe(switchMap(
                res => res.json() as ObservableInput<RPCResponse<RPCMethods.Read | RPCMethods.Write>[]>
            ))
            .pipe(take(1)).subscribe({
                next: (response) => {

                    this.handleRPCResponse(response);
                    this.getRequestLoadedSubject.next(true);
                    this.lastReadStack = [];

                },
                error: () => {
                    this.connectionErrorObservable.next(() => {
                        this.pollData(once);
                    });
                },
                complete: () => {
                    if (once) {
                        return;
                    }
                    this.recalculatePollingDelay();
                    this.pollTimeout = setTimeout(() => {
                        this.pollData();
                    }, this.pollingDelay);
                }
            });


    }

    private recalculatePollingDelay() {
        this.exponentialMovingAverage();
        if (this.config.polling.clamp === true) {
            this.clampPollingDelay();
        }
    }

    private exponentialMovingAverage() {
        const timeDiff = new Date().getTime() - this.lastPollingTime.getTime();
        const emaAlpha = this.config.polling.emaAlpha
        this.pollingDelay = emaAlpha * timeDiff + (1 - emaAlpha) * this.pollingDelay;
    }

    private clampPollingDelay() {
        if (this.slowPollingMode) {
            this.pollingDelay = Math.max(this.config.polling.slowMinDelay, this.pollingDelay);
        } else {
            this.pollingDelay = Math.max(this.config.polling.minDelay, this.pollingDelay);
        }
    }

    /**
   * Collects all the different RPC-Methods that should be called on a polling-cycle.
   *
   */
    private collectRPCMethodObjects(): Set<RPCMethodObject> {
        const set = new Set<RPCMethodObject>();
        this.collectGetRPCMethodObjects(set);
        this.collectWriteRPCMethodObjects(set);
        this.collectSubscribeRPCMethodObjects(set);
        // IMPORTANT: This function should be the last function that is called in the collection of RPC Methods.
        this.collectStaticRPCMethodObjects(set);
        return set;
    }

    private collectWriteRPCMethodObjects(objectSet: Set<RPCMethodObject>): void {
        this.writeTransactionHandler.getAllTransactionsKeys().forEach(key => {
            const transaction = this.writeTransactionHandler.getTransaction(key)!;
            this.collectChildrenKeys(transaction.key, objectSet, RPCMethods.Write, transaction.value, transaction);
        });
    }

    private collectSubscribeRPCMethodObjects(objectSet: Set<RPCMethodObject>): void {
        Array.from(this.subscriberCountMap.entries()).filter(([, value]) => value > 0).forEach(([key,]) => {
            // For every key in the subscriberCountMap that has a positive-counter value;
            this.collectChildrenKeys(key, objectSet, RPCMethods.Read);
        });
    }


    /**
     * When calling the get-Function, we just return the Subject in the subscriber-Trie and return the value once.
     * Then we append the hmi-key value to our read-Stack. Which we then collect here, by filling in the children keys and calling the get-Method on the server for the key. Later we identify the results and write it into the cache, which then triggers the subject.
     *
     * In case we never successfully read, we save the lastReadStack and delete it after a successful polling-cycle. That way, if we retry the connection, we do not lose the read information.
     * @param objectSet
     */
    private collectGetRPCMethodObjects(objectSet: Set<RPCMethodObject>): void {

        this.lastReadStack.forEach((element) => {
            this.collectChildrenKeys(element, objectSet, RPCMethods.Read);
        });

        this.readStack.forEach((element) => {
            this.collectChildrenKeys(element, objectSet, RPCMethods.Read);
        });

        // Clear the stack
        this.lastReadStack = this.readStack;
        this.readStack = [];
    }

    private collectChildrenKeys(key: FlattenKeys<T>, objectSet: Set<RPCMethodObject>, method: RPCMethods.Read | RPCMethods.Write, value?: S7DataTypes, writeTransaction?: WriteTransaction<T>): void {

        const plcKey = this.insertPrefixMapping(key);
        const keys = this.cache.parseFlattenedKey(plcKey);
        let ref = this.config.plcStructure;

        for (const key of keys) {
            ref = CacheStructure.getNextReference(ref, key.toString());
        }

        // Call the recursion-call with newKey = '', so it just takes the first key as entrance
        this._collectChildrenKeys(key, objectSet, ref, '', method, value, writeTransaction);


    }

    private _collectChildrenKeys(wholeKey: FlattenKeys<T>, objectSet: Set<RPCMethodObject>, ref: S7DataTypes, newKey: string, method: RPCMethods.Read | RPCMethods.Write, value?: S7DataTypes, writeTransaction?: WriteTransaction<T>) {

        if (
            method === RPCMethods.Write &&
            (value == undefined || writeTransaction == undefined)
        ) { throw new Error(`Error while trying to fill in children keys for JSONRPC-Request. Trying to create JSONRPC-Method Object to write to ${wholeKey}, but the relative value or writeTransaction is undefined!`) }

        ref = CacheStructure.getNextReference(ref, newKey);
        value = CacheStructure.getNextReference(value, newKey);

        if (Array.isArray(ref)) {
            for (let i = 0; i < ref.length; i++) {
                const newKey = wholeKey + `.${i}` as FlattenKeys<T>;
                if (ref[i] === undefined) {
                    ref[i] = '';
                }
                this._collectChildrenKeys(newKey, objectSet, ref, i.toString(), method, value, writeTransaction);
            }
            return;
        }

        if (typeof ref === 'object') {
            for (const key in ref) {
                const newKey = wholeKey + `.${key}` as FlattenKeys<T>;
                this._collectChildrenKeys(newKey, objectSet, ref, key, method, value, writeTransaction);
            }
            return;
        }

        if (ref === undefined) {
            throw new Error(`Error while trying to fill in children keys for JSONRPC-Request. Trying to create JSONRPC-${method === RPCMethods.Write ? 'WRITE' : 'READ'}-Method Object to key "${newKey}" (wholeKey: ${wholeKey})! The relative reference to the PLC-DB-structure returned undefined. Which either means, a wrong key was provided that does not exist in the configured PLC-Structure, or the PLC-DB-Structure is faulty and the provided key is missing.`);
        }

        const plcVar = this.hmiKeyToPlcKey(wholeKey);

        if (method === RPCMethods.Read) {
            objectSet.add(this.getRPCMethodObject(method, { var: plcVar }, `READ:${wholeKey}`));
        } else if (method === RPCMethods.Write) {
            if (typeof value === 'object' || Array.isArray(value)) {
                throw Error(`Error while trying to fill in children keys for JSONRPC-Request. Trying to create JSONRPC-Write-Method to key "${newKey}" (wholeKey: ${wholeKey}). According to the PLC-Structure this key is atomic and shouldnt be of type Array|Object. However the provided value: ${JSON.stringify(value)} appears to not be atomic.`)
            }
            objectSet.add(this.getRPCMethodObject(RPCMethods.Write, { value: value ?? '', var: plcVar }, `WRITE:${wholeKey}:${writeTransaction?.id}`));
            writeTransaction?.addDependentKey(wholeKey);
        }



    }


    /**
     * Turns a HMI-Key into a PLC-Key. Given the information about the mapping of the HMI to the PLC.
     * We also have to replace the Index-signatures for arrays with the correct syntax for the PLC (basically just wrapping the index in square bracktes and removing the dot before the square bracket) someObject.somearray.0 -> someObject.somearray[0]
     * @param key Hmi-Key
     * @returns
     */
    private hmiKeyToPlcKey(key: FlattenKeys<T>): string {
        const mappedKey = this.insertPrefixMapping(key);
        return mappedKey.split('.').map((element) => isNaN(Number(element)) ? element : `[${element}]`).join('.').replace(/\.\[/g, '[');

    }



    /**
       * Inserts the PLC-Prefix based on the configured mapping.
       * @param key Hmi-Key
       * @returns PLC-Key
       */
    private insertPrefixMapping(key: FlattenKeys<T>): string {
        // Go through the whole this.hmiPlcMapping and check if the key is a prefix of any key in the mapping. If it is, replace the prefix with the mapping. Go through the whole list first and look for the longest prefix. Use that one.
        let longestPrefix = "";
        for (const mappingKey in this.config.prefixSubstitutionMap) {
            if ((key as string).startsWith(mappingKey) && mappingKey.length > longestPrefix.length) {
                longestPrefix = mappingKey;
            }
        }

        if (longestPrefix === "") {
            return key as string;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (key as string).replace(longestPrefix, (this.config.prefixSubstitutionMap as any)[longestPrefix as any]);


    }

    /**
 * This function should be the last function that is called in the collection of RPC Methods.
 * If the Set is empty by the time it reaches here, a ping gets added and a "slow Mode" is activated.
 * When we dont subscribe to any values, we dont need to poll the PLC as often as usual and clamp the polling delay to a higher value. Because the only things we need to poll are errors and the ping basically.
 *
 * @param objectSet Object set that stores the RPC-Methods
 */
    private collectStaticRPCMethodObjects(objectSet: Set<RPCMethodObject>): void {
        if (objectSet.size === 0) {
            this.slowPollingMode = true;
            objectSet.add(this.getRPCMethodObject(RPCMethods.Ping, undefined, 'PING'));
        } else {
            this.slowPollingMode = false;
        }
    }

    /**
     * Calls the get-Function for each configured initial-Cache key.
     * @returns
     */
    private loadInitialCacheData() {
        if (this.config.initialCacheKeys == undefined) return;
        for (const cacheKey of this.config.initialCacheKeys) {
            this.get(cacheKey).pipe(take(1)).subscribe();
        }
    }

    private hmiKeysLoaded(key: FlattenKeys<T> | FlattenKeys<T>[]): boolean {
        if (Array.isArray(key)) {
            for (const singleKey of key) {
                if (!this.cache.entryExists(singleKey)) {
                    return false;
                }
            }
            return true;
        }
        return this.cache.entryExists(key);
    }

    private toggleBackSlowMode() {
        if (this.slowPollingMode === true) {
            // Then last poll was slowmode, so recall it with fast mode
            if (this.pollTimeout !== undefined) {
                clearTimeout(this.pollTimeout);
            }
            this.pollingDelay = this.config.polling.minDelay;
            this.pollTimeout = setTimeout(() => this.pollData(), this.pollingDelay);
        }
        this.slowPollingMode = false;
    }

    //MARK: GET

    public get<K = S7DataTypes>(key: FlattenKeys<T> | FlattenKeys<T>[], cacheMode?: CacheMethod): Observable<K> {
        const keys: FlattenKeys<T>[] = Array.isArray(key) ? key : [key];

        const loaded = this.hmiKeysLoaded(keys);

        const isCurrentlyWriting = this.writeTransactionHandler.isCurrentlyWriting(keys);

        const couldUseCache =
            cacheMode === CacheMethod.USE_CACHE ||
            ((cacheMode === CacheMethod.WAIT_FOR_WRITE || cacheMode === CacheMethod.USE_WRITE) && !isCurrentlyWriting)


        if (loaded && couldUseCache) {
            return this._getFromCache<K>(keys);
        }

        if (cacheMode === CacheMethod.USE_WRITE && isCurrentlyWriting) {
            if (keys.length > 1) {
                throw Error("Getting multiple vars with Cache-Method USE_WRITE is currently not supported.");
            }

            const fittingWriteTransaction = this.writeTransactionHandler.getTransactionFromKey(keys[0]);
            const value = fittingWriteTransaction?.value;
            if (value == undefined) {
                throw new Error(`Error while trying to get value with key: ${key} and using the USE_WRITE cache method. The write-transaction is currently running but the value is undefined`);
            }
            return new Observable<K>(sub => {
                sub.next(value as K);
                sub.complete();
            })

        }

        if (cacheMode === CacheMethod.WAIT_FOR_WRITE && isCurrentlyWriting) {
            if (keys.length > 1) {
                throw Error("Getting multiple vars with Cache-Method WAIT_FOR_WRITE is currently not supported due to unwanted behaviour, please use another Cache-Method")
            }
            return new Observable(sub => {
                const writeTransaction = this.writeTransactionHandler.getTransactionFromKey(keys[0]);
                if (writeTransaction) {
                    writeTransaction.subject.subscribe((status: boolean) => {
                        sub.next(this.cache.getCopy(keys[0]));
                        sub.complete();
                    })
                } else {
                    sub.error('Unexpected Error while trying to wait for write. Reported from WriteTransactionHandler, that the key is currently writing, but no transaction was found...');
                }
            })
        }

        // Else
        this.readStack.push(...keys);
        this.toggleBackSlowMode();
        return new Observable<K>(sub => {
            const x = this.getRequestLoadedSubject.subscribe(() => {

                let allKeysDeletedFromStack = true;
                for (const key of keys) {
                    allKeysDeletedFromStack = allKeysDeletedFromStack && !this.readStack.includes(key);
                }

                if (!allKeysDeletedFromStack || !this.hmiKeysLoaded(keys)) return;

                sub.next(this.concatenateCacheFromKeys(keys) as K)
                sub.complete();
                x.unsubscribe();
            });
        })
    }

    private _getFromCache<K>(keys: FlattenKeys<T>[]) {
        return new Observable<K>(subscriber => {
            subscriber.next(this.concatenateCacheFromKeys(keys) as K);
            subscriber.complete();
        })
    }

    private concatenateCacheFromKeys(keys: FlattenKeys<T>[]) {
        if (keys.length === 1) {
            return this.cache.getCopy(keys[0]) as S7DataTypes;
        }
        const concatenatedObject: { [key: string]: S7DataTypes } = {};
        for (const key of keys) {
            const keySplit = (key as string).split('.');
            let lastKey = keySplit[keySplit.length - 1];
            let backIndex = 1;
            while (concatenatedObject[lastKey] != undefined) {
                if (keySplit[keySplit.length - 1 - backIndex]) {

                    throw new Error(`Trying to concatenate multiple read-key-results into a single Object. Encountered the error, that at least 2 keys have the same identifier. When asking for the keys ['someparent.x', 'someparent.y'] the resulting object will be {x: ..., y: ...}.\n however, if the keys are ['someparent.y', 'someotherparent.y'] y and y collides. So the keys are {"someparent.x": ..., "someparent.y": ...}. This error is displayed if both the keys will result in the same target-plc key (when using prefix-mapping).`)
                }
                lastKey = keySplit[keySplit.length - 1 - backIndex] + '.' + lastKey;
                backIndex++;
            }
            concatenatedObject[lastKey] = this.cache.getCopy(key);
        }
        return concatenatedObject;
    }


    //MARK: WRITE

    public write<K = S7DataTypes>(key: FlattenKeys<T>, value: K): Observable<S7DataTypes> {
        this.toggleBackSlowMode();

        return this.writeTransactionHandler.createTransaction(key, value as S7DataTypes);
    }


    // MARK: SUBSCRIBE
    public subscribe<K = S7DataTypes>(key: FlattenKeys<T> | FlattenKeys<T>[], ignoreCache?: boolean): Observable<{ value: K; changedKey: string; }> {

        const keys: FlattenKeys<T>[] = Array.isArray(key) ? key : [key];

        const subscriberObject = ignoreCache ? this.ignoreCacheSubscriberTrie : this.subscriberTrie;

        return new Observable(sub => {
            const x: Subscription[] = [];
            if (!ignoreCache && this.hmiKeysLoaded(keys)) {
                sub.next({ value: this.concatenateCacheFromKeys(keys) as K, changedKey: '' });
            }
            keys.forEach(key => {
                if (!subscriberObject.has(key)) {
                    subscriberObject.insert(key);
                }
                subscriberObject.incrementSubscriberCount(key);
                if (this.subscriberCountMap.has(key)) {
                    this.subscriberCountMap.set(key, this.subscriberCountMap.get(key)! + 1);
                } else {
                    this.subscriberCountMap.set(key, 1);
                }
                const subscription = subscriberObject.get(key)!.subscribe(value => {
                    sub.next({ value: this.concatenateCacheFromKeys(keys) as K, changedKey: value.changedKey })
                });
                x.push(subscription);

            })
            this.toggleBackSlowMode();

            return () => {
                for (const key of keys) {
                    subscriberObject.decrementSubscriberCount(key);
                    if (this.subscriberCountMap.has(key)) {
                        this.subscriberCountMap.set(key, Math.max(0, this.subscriberCountMap.get(key)! - 1));
                    }
                }
                x.forEach(sub => sub.unsubscribe());
            }


        });


    }

    public get currentUser(): string {
        return this.user;
    }

    public can(permission: PlcPermissions): boolean {
        return this.permissionMap.get(permission) ?? false;
    }

    public getPermissionsUpdates(): Observable<PlcPermissions[]> {
        return this.permissionsSubject.asObservable();
    }

    public login(user: string = this.config.defaultUser.user, password: string = this.config.defaultUser.password): Observable<true | number> {

        const req = {
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify([
                this.getRPCMethodObject(RPCMethods.Login, { user, password }, 'LOGIN'), this.getRPCMethodObject(RPCMethods.GetPermissions, undefined, 'GETPERMISSIONS')
            ])
        }
        return this.http.post(this.baseUrl, req).pipe(
            switchMap(res => res.json() as ObservableInput<[RPCResponse<LoginResult>, RPCResponse<GetPermissionsResult>]>)
        ).pipe(
            map(
                response => {
                    const loginResponse = response[0];
                    if (loginResponse.error) {
                        return loginResponse.error.code as RPCLoginError;
                    }

                    const permissionResult = response[1];
                    this.token = loginResponse.result!.token;
                    this.user = user;
                    this.localStorage?.setItem(this.config.localStoragePrefix + 'token', this.token);
                    this.localStorage?.setItem(this.config.localStoragePrefix + 'user', this.user);
                    this.setCurrentPermissions(permissionResult.result!);
                    return true;
                }))
    }

}
