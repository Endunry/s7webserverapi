import { Observable, Subject } from "rxjs";
import { FlattenKeys, S7DataTypes } from "../util/types";
import { CacheStructure } from "./CacheStructure";

/**
 * When we call the write function of the PLCConnector, we dont instantly get a response back. We basically want a Observable that sends a single value when the transaction is done.
 *
 * This class handles this. When writing, we create a new transaction. This is especially a shared Observable that we send back to the writing-caller and the polling-loop will collect the write-transaction here and when the transaction is done it will send a value to the Observable.
*/

export class WriteTransactionHandler<KeyObject> {

    transactions: (WriteTransaction<KeyObject> | null)[] = [];
    nextId = 0;
    freeSlots: number[] = [];


    isCurrentlyWriting(hmiKey: FlattenKeys<KeyObject> | FlattenKeys<KeyObject>[]): boolean {
        const keys = Array.isArray(hmiKey) ? hmiKey : [hmiKey];
        return this.transactions.some((transaction) => transaction !== null && keys.includes(transaction.key));
    }

    createTransaction(key: FlattenKeys<KeyObject>, value: S7DataTypes): Observable<boolean> {
        let id: number;
        if (this.freeSlots.length > 0) {
            id = this.freeSlots.pop() as number;
        } else {
            id = this.nextId++;
        }
        this.transactions[id] = new WriteTransaction(key, value, id);
        return this.transactions[id]!.subject.asObservable();
    }

    getAllTransactionsKeys(): number[] {
        return this.transactions.map((transaction, index) => transaction === null ? -1 : index).filter((index) => index !== -1);
    }

    getTransaction(id: number): WriteTransaction<KeyObject> | undefined {
        if (this.transactionExists(id)) {
            return this.transactions[id] as WriteTransaction<KeyObject>;
        }
        return undefined;
    }

    getTransactionFromKey(key: FlattenKeys<KeyObject>): WriteTransaction<KeyObject> | undefined {
        const transaction = this.transactions.find((transaction) => transaction !== null && transaction.key === key);
        return transaction as WriteTransaction<KeyObject>;
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

    resolveDependentKey(id: number, key: FlattenKeys<KeyObject>, result: boolean, cacheRef?: CacheStructure<KeyObject>): boolean {
        if (this.transactionExists(id)) {
            const transaction = this.transactions[id]!;
            transaction.resolveDependentKey(key, result);
            const [check, resultBool] = transaction.checkAndResolve();
            if (check) {
                cacheRef?.writeEntry(transaction.key, transaction.value);
                transaction.subject.next(resultBool);
                transaction.subject.complete();
                this.removeTransaction(id);
                return resultBool;
            }
        }

        return false;
    }


}

export class WriteTransaction<KeyObject> {

    key: FlattenKeys<KeyObject>;
    value: S7DataTypes;
    id: number;

    dependentKeys: Map<FlattenKeys<KeyObject>, boolean | null>;

    subject: Subject<boolean> = new Subject<boolean>();

    constructor(key: FlattenKeys<KeyObject>, value: S7DataTypes, id: number) {
        this.key = key;
        this.value = value;
        this.id = id;
        this.dependentKeys = new Map<FlattenKeys<KeyObject>, boolean | null>();
    }

    addDependentKey(key: FlattenKeys<KeyObject>): void {
        this.dependentKeys.set(key, null);
    }

    resolveDependentKey(key: FlattenKeys<KeyObject>, result: boolean) {
        if (this.dependentKeys.has(key)) {
            this.dependentKeys.set(key, result);
        } else {
            throw new Error(`Key ${key} is not a dependent key of this transaction`);
        }
    }

    checkAndResolve() {
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
