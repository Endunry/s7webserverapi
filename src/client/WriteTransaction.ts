import { Observable, ReplaySubject, Subject } from "rxjs";
import { CacheMethod, FlattenKeys, S7DataTypes } from "../util/types";
import { CacheStructure } from "./CacheStructure";

/**
 * When we call the write function of the PLCConnector, we dont instantly get a response back. We basically want a Observable that sends a single value when the transaction is done.
 *
 * This class handles this. When writing, we create a new transaction. This is especially a shared Observable that we send back to the writing-caller and the polling-loop will collect the write-transaction here and when the transaction is done it will send a value to the Observable.
*/

export abstract class RPCTransactionHandler<KeyObject, T extends RPCTransaction<KeyObject, K>, K = unknown> {

    transactions: (T | null)[] = [];
    nextId = 0;
    freeSlots: number[] = [];



    getAllTransactionsKeys(): number[] {
        return this.transactions.map((transaction, index) => transaction === null ? -1 : index).filter((index) => index !== -1);
    }

    getTransaction(id: number): T | undefined {
        if (this.transactionExists(id)) {
            return this.transactions[id] as T;
        }
        return undefined;
    }

    getTransactionFromKey(key: FlattenKeys<KeyObject>[]): T | undefined {
        const transaction = this.transactions.find((transaction) => transaction !== null && transaction.keys.toString() === key.toString());
        return transaction as T;
    }

    transactionExists(id: number): boolean {
        return id >= 0 && id < this.transactions.length && this.transactions[id] !== null
    }

    removeTransaction(id: number): void {
        if (id >= 0 && id < this.transactions.length && this.transactions[id] !== null) {
            this.transactions[id] = null;
            this.freeSlots.push(id);
        }
    }

    addDependentKey(id: number, key: FlattenKeys<KeyObject>): void {
        if (this.transactionExists(id)) {
            this.transactions[id]!.addDependentKey(key);
        }
    }



}

export class WriteTransactionHandler<KeyObject> extends RPCTransactionHandler<KeyObject, WriteTransaction<KeyObject>, boolean> {

    isCurrentlyWriting(hmiKey: FlattenKeys<KeyObject> | FlattenKeys<KeyObject>[]): boolean {
        const keys = Array.isArray(hmiKey) ? hmiKey : [hmiKey];
        return this.transactions.some((transaction) => transaction !== null && keys.includes(transaction.keys[0]));
    }


    createTransaction(key: FlattenKeys<KeyObject>[], value: S7DataTypes): Observable<boolean> {
        let id: number;
        if (this.freeSlots.length > 0) {
            id = this.freeSlots.pop() as number;
        } else {
            id = this.nextId++;
        }
        this.transactions[id] = new WriteTransaction(key, value, id);
        return this.transactions[id]!.subject.asObservable();
    }


    resolveDependentKey(id: number, key: FlattenKeys<KeyObject>, result: boolean, cacheRef?: CacheStructure<KeyObject>): boolean {
        if (this.transactionExists(id)) {
            const transaction = this.transactions[id]!;
            transaction.resolveDependentKey(key, result);
            const [check, resultBool] = transaction.checkAndResolve();
            if (check) {
                cacheRef?.writeEntry(transaction.keys[0], transaction.value);
                transaction.subject.next(resultBool);
                transaction.subject.complete();
                this.removeTransaction(id);
                return resultBool;
            }
        }

        return false;
    }


}

export class GetTransactionHandler<KeyObject> extends RPCTransactionHandler<KeyObject, GetTransaction<KeyObject>, S7DataTypes> {

    constructor(private writeTransactionHandler: WriteTransactionHandler<KeyObject>, private cacheRef: CacheStructure<KeyObject>) {
        super();
    }

    override getTransactionFromKey(keys: FlattenKeys<KeyObject>[], depth?: number, cacheMethod?: CacheMethod): GetTransaction<KeyObject> | undefined {
        const transaction = this.transactions.find((transaction) => transaction !== null && transaction.keys.toString() === keys.toString() && (depth == undefined ? true : transaction.depth === depth) && (cacheMethod == undefined ? true : transaction.cacheMethod === cacheMethod));
        return transaction as GetTransaction<KeyObject> | undefined;
    }



    createTransaction(key: FlattenKeys<KeyObject>[], cacheMethod: CacheMethod, depth: number) {

        const matchingTransaction = this.getTransactionFromKey(key, depth, cacheMethod);
        let id: number;
        if (matchingTransaction == undefined) {
            if (this.freeSlots.length > 0) {
                id = this.freeSlots.pop() as number;
            } else {
                id = this.nextId++;
            }
            this.transactions[id] = new GetTransaction(key, id, cacheMethod, depth, this.writeTransactionHandler, this.cacheRef);
        } else {
            id = matchingTransaction.id;
        }

        return new Observable(subscriber => {
            // We need this wrapper here so we can delete the transaction when everything is completed.
            const trans = this.transactions[id];
            if (!trans) {
                subscriber.complete();
                return;
            }
            const x = trans!.subject.subscribe({
                complete: () => {
                    subscriber.complete();
                },
                next: (x) => { subscriber.next(x) },
                error: (x) => subscriber.error(x),
            });
            return () => {
                x.unsubscribe();
                this.removeTransaction(id);
            }
        })
    }





    resolveDependentKey(id: number, key: FlattenKeys<KeyObject>, value: S7DataTypes): boolean {
        if (this.transactionExists(id)) {
            const transaction = this.transactions[id]!;

            transaction.resolveDependentKey(key, value);
            this.cacheRef?.writeEntry(key, value);
            const check = transaction.checkAndResolve();
            if (check) {
                transaction.publishGetData();
                return true;
            }
        }

        return false;
    }


}


export abstract class RPCTransaction<KeyObject, K> {

    keys: FlattenKeys<KeyObject>[];
    value!: S7DataTypes;
    id: number;

    dependentKeys: Map<FlattenKeys<KeyObject>, boolean | null>;

    // ReplaySubject is important. When we have a UseCache-Get-Transaction we may call subject.next() before the other side even has the chance of calling .subscribe. The next-call would be lost.
    subject: Subject<K> = new ReplaySubject<K>();

    constructor(key: FlattenKeys<KeyObject>[], id: number) {
        this.keys = key;
        this.id = id;
        this.dependentKeys = new Map<FlattenKeys<KeyObject>, boolean | null>();
    }

    addDependentKey(key: FlattenKeys<KeyObject>): void {
        this.dependentKeys.set(key, null);
    }




}


export class GetTransaction<KeyObject> extends RPCTransaction<KeyObject, S7DataTypes> {

    cacheMethod: CacheMethod;
    internalReadStack: [FlattenKeys<KeyObject>, number][] = [];

    constructor(key: FlattenKeys<KeyObject>[], id: number, cacheMethod: CacheMethod, public depth: number, private writeTransactionHandler: WriteTransactionHandler<KeyObject>, private cacheRef: CacheStructure<KeyObject>) {
        super(key, id);
        this.cacheMethod = cacheMethod;
        this.initialize();
        this.publishGetData = this.publishGetData.bind(this);

    }

    initialize() {
        switch (this.cacheMethod) {
            case CacheMethod.IGNORE_CACHE:
                return this.initIgnoreCache();
            case CacheMethod.USE_CACHE:
                return this.initUseCache();
            case CacheMethod.USE_WRITE:
                return this.initUseWrite();
            case CacheMethod.WAIT_FOR_WRITE:
                return this.initWaitForWrite();
        }
    }

    initIgnoreCache() {
        this.useIgnoreCache();
    }

    useIgnoreCache() {
        for (const key of this.keys) {
            this.internalReadStack.push([key, this.depth] as [FlattenKeys<KeyObject>, number])
        }
    }



    useCache() {
        this.publishGetData();
    }

    createConcatenatedObject() {
        const concatenatedObject: { [key: string]: S7DataTypes } = {};
        for (const key of this.keys) {
            const keySplit = (key as string).split('.');
            let lastKey = keySplit[keySplit.length - 1];
            let backIndex = 1;
            while (concatenatedObject[lastKey] != undefined) {
                if (keySplit[keySplit.length - 1 - backIndex]) {
                    throw new Error('You asked for multiple keys with the same identifier in the get-function of the plc connector, this results in key conflicts')
                }
                lastKey = keySplit[keySplit.length - 1 - backIndex] + '.' + lastKey;
                backIndex++;
            }
            concatenatedObject[lastKey] = this.cacheRef.getCopy(key);
        }
        return concatenatedObject;

    }

    initUseCache() {
        const loaded = this.cacheRef.hmiKeyLoaded(this.keys);
        if (loaded) {
            this.useCache();
        } else {
            this.useIgnoreCache();
        }
    }

    initUseWrite() {
        const loaded = this.cacheRef.hmiKeyLoaded(this.keys);
        const isCurrentlyWriting = this.writeTransactionHandler.isCurrentlyWriting(this.keys);
        if (loaded && !isCurrentlyWriting) {
            this.useCache();
        } else if (isCurrentlyWriting) {
            if (this.keys.length > 1) {
                throw Error("Getting multiple vars with Cache-Method USE_WRITE is currently not supported due to unwanted behaviour, please use another Cache-Method")
            }
            const val = this.writeTransactionHandler.getTransactionFromKey(this.keys)?.value;
            if (val == undefined) {
                throw new Error(`Error while trying to get value with key: ${this.keys[0]}. The write-transaction is currently running but the value is undefined.`);
            }
            this.subject.next(val);
            this.subject.complete();

        } else {
            this.useIgnoreCache();
        }
    }

    initWaitForWrite() {
        const loaded = this.cacheRef.hmiKeyLoaded(this.keys);
        const isCurrentlyWriting = this.writeTransactionHandler.isCurrentlyWriting(this.keys);
        if (loaded && !isCurrentlyWriting) {
            this.useCache();
        } else if (isCurrentlyWriting) {
            if (this.keys.length > 1) {
                throw Error("Getting multiple vars with Cache-Method WAIT_FOR_WRITE is currently not supported due to unwanted behaviour, please use another Cache-Method")
            }
            const writeTransaction = this.writeTransactionHandler.getTransactionFromKey(this.keys);
            if (writeTransaction) {
                writeTransaction.subject.subscribe((status: boolean) => {
                    if (!status) {
                        this.subject.error(`Error while trying to wait for write. The Write Transaction was not successful for key: ${this.keys[0]}`)
                    }
                    this.subject.next(this.cacheRef.getCopy(this.keys[0]));
                    this.subject.complete();
                });
            } else {
                this.subject.error(`Error while trying to wait for write. No write-transaction found for key: ${this.keys[0]}`);
            }
        } else {
            this.useIgnoreCache();
        }
    }

    publishGetData() {

        if (this.keys.length === 1) {

            this.subject.next(this.cacheRef.getCopy(this.keys[0]));
            setTimeout(() => this.subject.complete(), 0);

            return;
        }
        const co = this.createConcatenatedObject();

        this.subject.next(co as S7DataTypes);
        setTimeout(() => this.subject.complete(), 0);


    }

    resolveDependentKey(key: FlattenKeys<KeyObject>, value: S7DataTypes) {
        if (this.dependentKeys.has(key)) {
            this.dependentKeys.set(key, true);
            this.value = value;
        } else {
            throw new Error(`Key ${key} is not a dependent key of this transaction`);
        }
    }

    checkAndResolve(): boolean {
        for (const [, result] of this.dependentKeys) {
            if (result === null) {
                return false;
            }
        }
        return true
    }

}


export class WriteTransaction<KeyObject> extends RPCTransaction<KeyObject, boolean> {

    constructor(key: FlattenKeys<KeyObject>[], value: S7DataTypes, id: number) {
        super(key, id);
        this.value = value;
    }

    resolveDependentKey(key: FlattenKeys<KeyObject>, result: boolean) {
        if (this.dependentKeys.has(key)) {
            this.dependentKeys.set(key, result);
        } else {
            throw new Error(`Key ${key} is not a dependent key of this transaction`);
        }
    }

    // Returns [boolean, boolean] where the first value means "Transaction resolved and all the keys were loaded", and the other bool is the concatenated result of all write transactions

    checkAndResolve(): [boolean, boolean] {
        let resultBool: boolean = true;
        for (const [, result] of this.dependentKeys) {
            if (result === null) {
                return [false, false];
            }
            resultBool = resultBool && result;
        }
        return [true, resultBool];
    }
}
