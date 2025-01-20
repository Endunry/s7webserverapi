import { Subject } from "rxjs";
import { FlattenKeys, S7DataTypes } from "../util/types";

/**
 * Prefix-Trie implementation for storing subscribers.
 * Since we call the PLC/HMI-Vars with a flattened-key e.g. "test.key.value" but we also are able to subscribe to an object instead of a leaf value, we store the subscribers in a trie.
 *
 * With that we call all subscribers of a key, when either the key itself or a children changes.
 *
 * @export
 * @class SubscriberTrie
 * @typedef {SubscriberTrie}
 * @template FlattenKeyType
 */
export class SubscriberTrie<FlattenKeyType> {


    /**
     * Root node of the trie
     *
     * @type {SubscriberTrieNode<FlattenKeyType>}
     */
    root: SubscriberTrieNode<FlattenKeyType>;

    /**
     * Creates an instance of SubscriberTrie.
     *
     * @constructor
     */
    constructor() {
        this.root = new SubscriberTrieNode();
    }

    private parseFlattenedKey(flattenedKey: FlattenKeys<FlattenKeyType>): (string | number)[] {
        return (flattenedKey as string).split('.').map(key => {
            // Check if the key is a number and convert it if so
            return isNaN(Number(key)) ? key : Number(key);
        });

    }

    /**
     * returns the subscriber at that key, if it exists.
     *
     * @param {FlattenKeys<FlattenKeyType>} keyString
     * @returns {Subject<{value:PLCConnectorDataTypes, changedKey: string}> | undefined}
     */
    get(keyString: FlattenKeys<FlattenKeyType>) {

        let currentNode = this.root;
        const keyArray = this.parseFlattenedKey(keyString);

        for (const element of keyArray) {
            if (!currentNode.children.has(element)) {
                return;
            }
            currentNode = currentNode.children.get(element)!;
        }

        return currentNode.subscriber;
    }

    getSubscriptionCountMap(): Map<string, number> {
        const map = new Map<string, number>();
        // Go through all the children of the root and get the subscriber count
        for (const [key, value] of this.root.children) {
            this.getSubscriptionCountMapRecursive(value, key, map);
        }
        return map;
    }

    getSubscriptionCountMapRecursive(value: SubscriberTrieNode<FlattenKeyType>, key: string | number, map: Map<string, number>) {
        if (value.subscriberCount > 0) {
            map.set(key as string, value.subscriberCount);
        }
        for (const [childKey, childValue] of value.children) {
            this.getSubscriptionCountMapRecursive(childValue, key + "." + childKey, map);
        }
    }

    incrementSubscriberCount(key: FlattenKeys<FlattenKeyType>) {
        let currentNode = this.root;
        const keyArray = this.parseFlattenedKey(key);

        for (const element of keyArray) {
            if (!currentNode.children.has(element)) {
                return;
            }
            currentNode = currentNode.children.get(element)!;
        }

        currentNode.subscriberCount++;
    }

    decrementSubscriberCount(key: FlattenKeys<FlattenKeyType>) {
        let currentNode = this.root;
        const keyArray = this.parseFlattenedKey(key);

        for (const element of keyArray) {
            if (!currentNode.children.has(element)) {
                return;
            }
            currentNode = currentNode.children.get(element)!;
        }

        currentNode.subscriberCount--;
    }



    /**
     * Checks if a subscriber at the key exists.
     * Important: It checks for the subscriber, not if the key exists in the trie.
     *
     * @param {FlattenKeys<FlattenKeyType>} key
     * @returns {boolean}
     */
    has(key: FlattenKeys<FlattenKeyType>): boolean {

        let currentNode = this.root;
        const keyArray = this.parseFlattenedKey(key);

        for (const element of keyArray) {
            if (!currentNode.children.has(element)) {
                return false;
            }
            currentNode = currentNode.children.get(element)!;
        }



        return currentNode.subscriber !== undefined;

    }

    /**
     * Inserts a new key into the trie and automatically creates a subscriber.
     * Every key only has one subscriber.
     *
     * @param {FlattenKeys<FlattenKeyType>} key
     */
    insert(key: FlattenKeys<FlattenKeyType>) {

        let currentNode = this.root;
        const keyArray = this.parseFlattenedKey(key);

        for (const element of keyArray) {
            if (!currentNode.children.has(element)) {
                currentNode.children.set(element, new SubscriberTrieNode());
            }
            currentNode = currentNode.children.get(element)!;
        }

        // finally add the subscriber to the last node
        currentNode.subscriber = new Subject();

    }



    /**
     * Notifies all subscriber of the key with all its parent-prefixes.
     *
     * E.g if we call notifySubscriber("test.key.value"); We call the subscribers for test, for test.key and for test.key.value (if they exist)
     *
     * The data key is put into this function as a helper, because we need to notify the subscriber with the respective data.
     * The data-object has to follow the strucutre of the trie or rather of the key that is notified.
     *
     * If the key is "test.key.value" and the data is {test: {key: {value:1}}}. test.key is notified with {value: 1} and test.key.value is notified with 1
     *
     *
     * @param {FlattenKeys<FlattenKeyType>} key
     * @param {PLCConnectorKeys<PLCConnectorDataTypes>} data
     */
    notifySubscriber(key: FlattenKeys<FlattenKeyType>, data: S7DataTypes) {
        let currentNode = this.root;
        let reference = data;
        const keyArray = this.parseFlattenedKey(key);
        const residualKey = key as string;
        for (const element of keyArray) {
            if (!currentNode.children.has(element)) {
                return;
            }
            currentNode = currentNode.children.get(element)!;

            if (reference[element] == undefined) {
                return;
            }
            reference = reference[element] as S7DataTypes;
            currentNode.subscriber?.next({ value: JSON.parse(JSON.stringify(reference)), changedKey: residualKey });

        }

    }


}


/**
 * Node of the subscriber trie
 *
 * @export
 * @class SubscriberTrieNode
 * @typedef {SubscriberTrieNode}
 * @template FlattenKeyType
 */
export class SubscriberTrieNode<FlattenKeyType> {

    /**
     * The subscriber-subject
     *
     * @type {(Subject<PLCConnectorDataTypes> | undefined)}
     */
    subscriber: Subject<{ value: S7DataTypes, changedKey: string }> | undefined;
    /**
     * Map of the children for the trie
     *
     * @type {Map<string | number, SubscriberTrieNode<FlattenKeyType>>}
     */
    children: Map<string | number, SubscriberTrieNode<FlattenKeyType>>;

    subscriberCount: number = 0;

    /**
     * Creates an instance of SubscriberTrieNode.
     *
     * @constructor
     */
    constructor() {
        this.children = new Map();
    }

}
