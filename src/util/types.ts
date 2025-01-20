import { Observable } from "rxjs";




/**
 * When having a nested object T, this will create a type that Flattens the keys.
 * e.g. for {a: {b: {c: 0}}} it will create the keys:
 * "a", "a.b", "a.b.c"
 *
 * @export
 * @typedef {FlattenKeys}
 * @template T
 * @template {string} [Prefix=""]
 */
export type FlattenKeys<T, Prefix extends string = ""> = T extends object
    ? {
        [K in keyof T]-?: K extends string | number
        ? `${Prefix}${K & string}` | FlattenKeys<T[K], `${Prefix}${K & string}.`>
        : never;
    }[keyof T]
    : "";


export type PlcPermissions = "read_diagnostics" | "read_value" | "write_value" | "acknowledge_alarms" | "open_user_pages" | "read_file" | "write_file" | "change_operating_mode" | "flash_leds" | "backup_plc" | "restore_plc" | "manage_user_pages" | "update_firmware" | "change_time_settings" | "download_service_data" | "change_webserver_default_page" | "read_watch_table_value" | "write_watch_table_value" | "read_syslog";

export type S7DataTypes = string | number | boolean | object | S7DataTypes[] | { [key: string]: S7DataTypes };

export interface S7JsonClient<T> {
    get<K = S7DataTypes>(key: FlattenKeys<T> | FlattenKeys<T>[], cacheMode?: CacheMethod): Observable<K>
    write(key: FlattenKeys<T>, value: S7DataTypes): Observable<S7DataTypes>;
    subscribe<K = S7DataTypes>(key: FlattenKeys<T> | FlattenKeys<T>[], ignoreCache?: boolean): Observable<{ value: K, changedKey: string }>;
    currentUser: string;
    can(permission: PlcPermissions): boolean;
    getPermissionsUpdates(): Observable<PlcPermissions[]>;
    login(user: string, password: string): Observable<true | number>;
}

export enum CacheMethod {
    USE_CACHE = 0,
    IGNORE_CACHE = 1,
    WAIT_FOR_WRITE = 2,
    USE_WRITE = 3
}


export interface S7WebserverClientConfig<T> {
    /*
    Internal Structure of the PLC. Expects a JSON-String-Map of at least one PLC-DB with its keys and default values.
    */
    plcStructure: { [key: string]: any },
    /**
     * Settings for the polling-process.
     * Uses Exponential Moving Average to control the polling-delay.
     * To fine tune it, you can set the parameters here.
     *
     */
    localStoragePrefix: string,
    defaultUser?: {
        user: string,
        password?: string
    }
    polling?: {
        clamp?: boolean;
        minDelay?: number,
        slowMinDelay?: number, // The polling cycle is always active. The only thing we then need to do is to regularly ping so the token stays active.
        emaAlpha?: number,
    },
    initialCacheKeys?: FlattenKeys<T>[];
    /**
     *
     */
    prefixSubstitutionMap?: PrefixSubstitutionMap<T>;

}

export type PrefixSubstitutionMap<T> = {
    [dbName in FlattenKeys<T>]?: string;
}

export type RPCVarTypeSimple = number | string | boolean;
export type RPCVarTypeRaw = number[];

export interface RPCMethodObject<T = Params> {
    jsonrpc: string,
    method: string,
    params?: T,
    id: string
}

export interface RPCResponse<T extends RPCResults> {
    jsonrpc: string,
    result?: T,
    error?: {
        code: RPCErrorCode,
        message: string
    }
    id: string
}

export enum RPCMethods {
    Ping = "Api.Ping",
    Login = "Api.Login",
    Read = "PlcProgram.Read",
    Write = "PlcProgram.Write",
    GetCertificateUrl = "Api.GetCertificateUrl",
    GetPermissions = "Api.GetPermissions"
}

export type RPCResults = LoginResult | WriteResult | GetCertificateUrlResult | ReadResult | GetPermissionsResult | PingResult;

export type Params = LoginParams | ReadParams | WriteParams | GetCertificateUrlParams | GetPermissionsParams | PingParams;



// Login
export type LoginParams = {
    user: string,
    password: string
}

export type LoginResult = {
    token: string;
}

// Read
export enum ReadWriteMode {
    Simple = 'simple',
    Raw = 'raw'
}

export type ReadParams = {
    var: string,
    mode?: ReadWriteMode
}

export type ReadResult = RPCVarTypeSimple | RPCVarTypeRaw;

// Write
export type WriteParams = {
    var: string,
    mode?: ReadWriteMode,
    value: RPCVarTypeSimple | RPCVarTypeRaw
}

export type WriteResult = boolean;

// GetCertificateUrl
export type GetCertificateUrlParams = undefined;

export type GetCertificateUrlResult = string;

export type GetPermissionsParams = undefined;
export type GetPermissionsResult = { name: PlcPermissions }[];

export type PingParams = undefined;
export type PingResult = string;

export enum RPCErrorCode {
    PERMISSON_DENIED = 2,
    NO_RESOURCES = 4,
    LOGIN_FAILED = 100,
    ALREADY_AUTHENTICATED = 101,
    PASSWORD_EXPIRED = 102,
    ADRESS_NOT_FOUND = 200,
    INVALID_ADRESS = 201,
    INVALID_ARRAY_INDEX = 203,
    UNSUPPORTED_ADRESS = 204
}

export type RPCLoginError = RPCErrorCode.LOGIN_FAILED | RPCErrorCode.ALREADY_AUTHENTICATED | RPCErrorCode.PASSWORD_EXPIRED | true;
