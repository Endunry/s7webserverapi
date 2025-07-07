/* eslint-disable @typescript-eslint/no-explicit-any */

import { FlattenKeys } from "../util/types";

/**
 * Helper class that holds the cache-structure for the PLC-Connector.
 * Its used to easily access and write values in the cache given a flattened key that fits to the template T
 *
 * @export
 * @class CacheStructure
 * @typedef {CacheStructure}
 * @template T - The type of the cacheObject that is used to store the values
 */
export class CacheStructure<T> {
  /**
   * Holds the actual values of the cache
   *
   * @public
   * @type {{}}
   */
  public cacheObject = {};

  /**
   * Parses a flattened key into an array of key-elements. A number is later interpreted as an array-index. A string is interpreted as an object-key
   *
   * @public
   * @param {(FlattenKeys<T> | string)} flattenedKey
   * @returns {(string | number)[]}
   */
  public parseFlattenedKey(
    flattenedKey: FlattenKeys<T> | string
  ): (string | number)[] {
    return (flattenedKey as string).split(".").map((key) => {
      // Check if the key is a number and convert it if so
      return isNaN(Number(key)) ? key : Number(key);
    });
  }

  constructor(initObject?: any) {
    this.cacheObject = initObject ?? {};
  }

  /**
   * Static helper function that gets the next reference from a given reference and a new key.
   *
   * @public
   * @static
   * @param {*} ref
   * @param {string} newKey
   * @returns {any}
   */
  public static getNextReference(ref: any, newKey: string): any {
    if (newKey == "" || ref == undefined) {
      return ref;
    }

    if (!Number.isNaN(Number(newKey))) {
      if (Array.isArray(ref)) {
        ref = ref[Number(newKey)];
        return ref;
      } else {
        throw new Error(
          `Error in getting next reference: ${newKey} is not a valid key for the given reference, ${newKey} is a number, but the given reference is not an array`
        );
      }
    }

    if (typeof ref === "object" && !Array.isArray(ref)) {
      if (!(newKey in ref)) {
        throw new Error(
          `Error in getting next reference: ${newKey} is not a valid key for the given reference`
        );
      }
      ref = ref[newKey];
      return ref;
    }

    throw new Error(
      `Error in getting next reference: ${newKey} is not a valid key for the given ref, ${newKey} is a string, but the given reference is not an object`
    );
  }

  /**
   * Checks if an entry with the given flattened key exists in the cache
   *
   * @public
   * @param {FlattenKeys<T>} flattenedKey
   * @returns {boolean}
   */
  public entryExists(flattenedKey: FlattenKeys<T>): boolean {
    const keys = this.parseFlattenedKey(flattenedKey);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let current: { [key: string]: any } | any[] = this.cacheObject;
    for (const key of keys) {
      if (current == null || !(key in current)) {
        return false;
      }
      if (Array.isArray(current) && typeof key === "number") {
        current = current[key];
      } else if (
        typeof key === "string" &&
        typeof current === "object" &&
        !Array.isArray(current)
      ) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        current = (current as { [key: string]: any })[key];
      }
    }
    return true;
  }

  /**
   * Gets a copy of a value in the cache. Useful if the value is an object and we need to change the value somewhere else without chaning the original value in the cache
   *
   * @public
   * @param {FlattenKeys<T>} flattenedKey
   * @returns {*}
   */
  public getCopy(flattenedKey: FlattenKeys<T>) {
    const ref = this.getReference(flattenedKey);
    if (ref == undefined) {
      return undefined;
    }
    return this.deepClone(ref);
  }

  /**
   * Recursive function to deeply clone an object. Since we only have a simple structure that is deeply nested this function should be enough.
   * @param obj Object to clone
   * @returns
   */
  private deepClone(obj: any): any {
    if (obj == undefined || typeof obj !== "object") {
      return obj;
    }

    const clone: any = Array.isArray(obj) ? [] : {};

    for (const key in obj) {
      clone[key] = this.deepClone(obj[key]);
    }

    return clone;
  }

  /**
   * Gets a reference to a value in the cache. Useful if the value is an object and we need to change the value somewhere else and want to change the original value in the cache
   *
   * @public
   * @param {FlattenKeys<T>} flattenedKey
   * @returns {any}
   */
  public getReference(flattenedKey: FlattenKeys<T>): any {
    const keys = this.parseFlattenedKey(flattenedKey);

    let current = this.cacheObject;
    for (const key of keys) {
      if (Array.isArray(current) && typeof key === "number") {
        current = current[key];
      } else if (typeof key === "string" && typeof current === "object") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        current = (current as { [key: string]: any })[key];
      } else {
        return undefined;
      }
    }
    return current;
  }

  /**
   * Writes a value to the cache given a flattened key. It also builds up the structure if it does not exist yet.
   * E.g. if the cache is completley empty {} and we call this function with ("test.someArray", [0,1,2]) the resulting cache looks liek this at the end:
   * {
   *  test: {
   *   someArray: [0,1,2]
   * }
   * }
   *
   * @public
   * @param {FlattenKeys<T>} flattenedKey
   * @param {*} value
   */
  public writeEntry(flattenedKey: FlattenKeys<T>, value: any) {
    const keys = this.parseFlattenedKey(flattenedKey);
    let current = this.checkAndFillCacheStructure(flattenedKey);
    if (Array.isArray(current) && typeof keys[keys.length - 1] === "number") {
      current[keys[keys.length - 1] as number] = value;
    } else if (
      typeof keys[keys.length - 1] === "string" &&
      typeof current === "object"
    ) {
      current = current as { [key: string]: any };
      current[keys[keys.length - 1]] = value;
    }
  }

  /**
   * Checks if the key is correct and fills up the cache structure up to the second last key. this is used before we write a value to the cache.
   * @param flattenedKey
   * @returns the reference to the second last key in the cache structure
   */
  private checkAndFillCacheStructure(flattenedKey: FlattenKeys<T>) {
    const keys = this.parseFlattenedKey(flattenedKey);
    let current: { [key: string]: any } | any[] = this.cacheObject;

    keys.slice(0, -1).forEach((key, index) => {
      current = this.ensureKeyExists(current, key, keys[index + 1]);
    });

    return current;
  }

  /**
   *
   * @param current Reference to the current level in the cache structure
   * @param key The key that should be checked, relative to the current level
   * @param nextKey The next key that should be checked. Given this key we can determine if we need to insert an array or an object
   * @returns the reference to the next level in the cache structure, given the key.
   */
  private ensureKeyExists(
    current: any,
    key: string | number,
    nextKey: string | number
  ): any {
    if (!(key in current)) {
      current[key] = this.initializeNextLevel(current, key, nextKey);
    }

    return current[key];
  }

  /**
   *
   * @param current Reference to the current level in the cache structure
   * @param key The key that should be initialized
   * @param nextKey The next key that should be initialized. Given this next key, we can determine if we need to insert an array or an object
   * @returns the initialized next level in the cache structure
   */
  private initializeNextLevel(
    current: any,
    key: string | number,
    nextKey: string | number
  ): any {
    const returnValue = this.determineNewLevelType(nextKey);
    if (Array.isArray(current) && typeof key === "number") {
      return returnValue;
    }

    if (typeof key === "string" && typeof current === "object") {
      return returnValue;
    }

    throw new Error(
      "Error while filling in the cache structure, key is not a valid key for current object. Key: " +
        key +
        ", Current: " +
        current
    );
  }

  /**
   * Determines if the next level in the cache structure should be an array or an object
   * Placeholder if in the future we want to use a different structure for the cache
   * @param nextKey
   * @returns
   */
  private determineNewLevelType(nextKey: string | number) {
    return typeof nextKey === "number" ? [] : {};
  }

  public hmiKeyLoaded(key: FlattenKeys<T> | FlattenKeys<T>[]): boolean {
    if (Array.isArray(key)) {
      for (const singleKey of key) {
        if (!this.entryExists(singleKey)) {
          return false;
        }
      }
      return true;
    }
    return this.entryExists(key);
  }
}
