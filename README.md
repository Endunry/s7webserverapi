# Webserver-API Client for Simatic S7 1200/1500 PLCs

This is an unofficial Library to use with the Simatic S7 1200/1500 Series' JSON-RPC-APIs. It provides basic functionality to read and write data. But it also utilizes polling to implement the ability to "subscribe" to changes on the PLC. With that, live data can be displayed asyncrounously, without the need to reload a page.

The library has to be aware of the PLC-Structure at build-Time (which can be dynamically automated via the TIA-VCI). With that its possible to read whole Object-Like structures. The JSONRPC-Api only provides endpoints where you can read an atomic value. The library will infer all the keys it needs to request and handles the concatenation etc.

## Usage

### Providing the PLC-Structure

To use the library, the first thing you have to do is to provide information about the Structure of the PLC, or rather the structure of the PLC that is important for the HMI/Webapplication that uitilizes the PLC-Data. This can either be done by hand (When only using a few PLC-Variables), or be done by generating some Code from exported XML-Files from the TIA-Project.

There are 2 things you need to provide:

- Data-Structure of the PLC, which is a Map, where the keys are the different DBs and the value is the JSON-Representation of the DB-Data that is reachable from the WebServer
- Constant static Typescript-Type with fixed Array lengths. This type is used to validate the plc-Keys that are used in functions. As long as there are no arrays in the Data-structure, you can just use `type DB_STRUCTURE_TYPE = typeof DB_STRUCTURE`. However with arrays somewhere in the structure, the fixed array lenght is missing and the type that generates the string-keys can't halt.

#### Manual
If we take this Example:
```SL
DATA_BLOCK "fooDB"         DATA_BLOCK "barDB"
      operand1 : Int;          someArray : Array[0..3] of Real;
      operand2 : Int;          someUDT: MyUdt;
      sum : Int;

DATA_BLOCK "buzzDB"
     someStruct: STRUCT
        someint: Int;
     END_STRUCT
```

We have to translate it into JSON-Objects first:
```ts
// First create all UDT and Struct Objects. So they can be reused later on.
class SomeStruct{
    someint:number = 0; // Use the actual initial values from the TIA-Project.
}

class MyUdt{
    ... // Fill in the structure of all the UDTs you're using.
}

// Define the DB-Classes

class buzzDB{
    someStruct: SomeStruct = new SomeStruct();
}

class barDB{
    someArray: number[] = [0.0,0.0,0.0,0.0];
    someUDT: MyUdt = new MyUdt();
}

class fooDB{
    operand1: number = 0;
    operand2: number = 0;
    sum: number = 0;
}

// Generate the PLC_STRUCTURE object
export const PLC_STRUCTURE = {
    '"buzzDB"': new buzzDB();
    '"barDB"': new barDB();
    '"fooDB"': new fooDB();
}

// Now also create a custom type for it:
export type PLC_STRUCTURE_TYPE = {
    '"buzzDB"': {
        someStruct: {
            someint: number;
        }
    },
    '"barDB"': {
        someArray: [number, number, number, number];
        someUDT: {...} // The sub-structure of the udt
    },
    '"fooDB"': {
        operand1: number;
        operand2: number;
        sum: number;
    }
}

// Create the Client.
const s7 = new S7WebserverClient<PLC_STRUCTURE_TYPE>('https://<plc-ip>/api/jsonrpc', {
    plcStructure: PLC_STRUCTURE
})

```

#### Automatic

Its much more recommended to automatically generate this data from the TIA-Project. For this you only need to export the DB and UDT-Data in XML-Format.
The easiest way to do this, is to create (or utilize an existing) Version-Control-Interface (Vci)-Workspace.

To create a new one, open the TIA-Project and in the Project-Tree on the left search for the "VCI"-Entry. Open it and create a new Workspace, you must at least provide a path of where the exports are saved. Save this path for later.

After creating the workspace, export all the DBs and all the UDTs (PLC-Datatypes). And make sure they're saved in two different folders.
Now open the path you saved, you should have at least two folders here. One is the root-folder for all the exported UDTs and one for the exported DBs.
Save both paths to the root folder somewhere.

If you have installed this package via `npm install s7webserverapi`, you can utilize the script `npx s7webservergen`. To use it you only need to provide:
- Root folder to all the UDTs
- Root folder to all the DBs
- List of DBs that you will use with the Webclient

The first two things should be ready, with the step above. The List of DBs are up to you, the names must be valid and its not necessary to wrap them into quotationmarks.

For example, if we want to include the DBs "buzzDB" and "fooDB" and save the generated output to ./generated, we would call the command with these parameters:

```bash
npx s7webservergen -d="./path/to/DBs/folder" -u="./path/to/UDTs/foler" --hmiDBs "buzzDB,fooDB" -o "./generated"
```

You may run into some errors, since not all TIA-Datatypes are implemented, but you can add the flag `--force` and it should skip the error and generate an empty field for this type that you can manually fill afterwards. Feel free to open an issue for missing types or other bugs. This whole project was created on the side and especially this code-generator is not really... polished, to say the least. Right now this script is overfitted for the TIA-Project i was using, there is a really high chance, that it will not work with your TIA-Project without changing a bit on the script.


### Creating the Client

When you successfully created the PLC-Structure, you can now create and use the `S7WebserverClient`.

```ts
import { S7WebserverClient, S7WebserverClientConfig } from 's7webserverapi';
import { PLC_STRUCTURE_TYPE, PLC_STRUCTURE } from './plcStructure'; // Generated structure

const config: S7WebserverClientConfig = {
    plcStructure: PLC_STRUCTURE,
    defaultUser: {
        user: 'myuser',
        password: 'mypassword'
    }
}

const s7 = new S7WebserverClient<PLC_STRUCTURE_TYPE>('https://<plc-ip>/api/jsonrpc')

s7.start().subscribe(()=>{
    console.log("Connection ready");
    s7.subscribe('"fooDB".sum').subscribe(console.log); // Subscribe to changes on a var
    s7.write('"fooDB".operand1', 10).subscribe(console.log); // Write to a var (.subscribe must be called)
    s7.get(['"fooDB".operand2', '"fooDB".operand1']).subscribe(console.log); // Get multiple different vars -> theyre concatenated on return
    s7.get('"fooDB"').subscribe(console.log) // Calls the whole object with all the sub-keys.
})
```

### Functionalities

#### Log-In

```ts
    login(user?: string, password?: string): Observable<true | number>;
```

Logging in, currently, is the only user-action you can do. There isnt really a logging out in the classic sense. But you most likeley have a default user, which normally holds the name "Anonymous" with an empty password which holds the bare minimum rights to view a webapp on the webserver. In the Future i will implement the functionality of changing the password.

#### Variable-Getter

```ts
get<K = S7DataTypes>(key: FlattenKeys<T> | FlattenKeys<T>[], cacheMode?: CacheMethod): Observable<K>;
```

You can either request a single key, or multiple keys at once. This is just for the ease of handling the data afterwards, since they are concatenated by the library.
The JSONRPC-API only supports leaf-keys out of the box. That means you can't fetch whole arrays at once, if you want to read out an array, you have request all the keys.
With this library, all this stuff is automatically derived from the PLC-Structure. So you can request an array, and you get back an array, or even a deeply nested object.

It would actually be possible to add type-checking here, to derive which types lays at key e.g. `'"fooDB".sum'`, but this will add a lot of annoying loading time in any IDE, so i cut it out again. If you want Typechecking, you can add this yourself:

```ts
import { fooDB } from './dbs'
s7.get<fooDB>('"fooDB"').subscribe((value: fooDB)=>...);
```

An Important parameter here is the `cacheMethod`. It can have one of the following values: `USE_CACHE, IGNORE_CACHE, WAIT_FOR_WRITE, USE_WRITE`.
- `USE_CACHE`: If the cache already holds a value, dont send out a request, but instantly send back the cache-value
- `IGNORE_CACHE`: Default - always sends out a request and returns the received data back.
- `WAIT_FOR_WRITE`: There may be cases where you write a value at one place in your HMI, and instantly afterwards you want to read this value. Sometimes, the write is not finished yet and you might get an outdated result, even if youre not ignoring the cache. In this case, you can use WAIT_FOR_WRITE. If there is a write-transaction on the variable you're asking for, it will wait for the transaction to be finished and then returns the value afterwards
- `USE_WRITE`: Similar to WAIT_FOR_WRITE, but WAIT_FOR_WRITE waits for the write-transaction and returns the actual value (if the write-transaction was successful, it returns the new value, if it was not, the old one). USE_WRITE however does not wait for the transaction to finish, but just assumes that it will be successful and returns the value of the running write-transaction.

(When using WAIT_FOR_WRITE and USE_WRITE, you can't request multiple keys at once, since the concatenation of multiple write-transactions are more complex and not implemented yet)

#### Variable-Setter

```ts
    write<K = S7DataTypes>(key: FlattenKeys<T>, value: K): Observable<boolean>;
```

The Observable returns the status of the write-transaction. `true`, meaning it has successfully written the value and `false` means it wasnt.
You can also write to parent keys. The JSONRPC-API itself can only read or write to leaf-keys directly. But with the library, this can be dynamically derived.
So you could do something like this:
```ts
s7.write('"myDB".someArray', [1,2,3,4,5]).subscribe();
```
or even more complex stuff like:
```ts
s7.write('"myDB"', {
    someArrray: [1,2,3,4,5],
    someStruct: {
        someInt: 10,
        someBoolean: true
    }
});
```
It is only important, that the value you provide fits the structure. And while it would be possible to create typechecking for this, i hadnt kept it, since it wastes a lot of computing time while working in an IDE... But if you want to catch runtime errors, you can add the type yourself everytime. E.g. if you want to write a complete UDT at once, you should have the class of it somewhere in your code.

```ts
const myStructObj: MyStruct = {
    ...
}
s7.write<MyStruct>('"myDB".myStruct', myStructObj).subscribe();
```

#### Value-Subscriber

```ts
    subscribe<K = S7DataTypes>(key: FlattenKeys<T> | FlattenKeys<T>[], ignoreCache?: boolean): Observable<{
        value: K;
        changedKey: string;
    }>;
```

Subscribing to a value means in the background the value of this key will be fetched continually via polling until the subscription is completed or we unsubscribe from it.
If the value changes on the PLC, we route the new value to all the subscriber of this value. The Parameter `ignoreCache` is `false` by default, if you set it to `true`, the subscriber will be notified with the new value, everytime a new polling cycle is finished.

Since you can also subscribe to multiple keys at once and also to more complex structures like arrays or objects. The return value of the subject is not just the object, but it also embeddes information about the key that has changed.

This may be interesting to know, since when subscribing to a object-like structure like a whole DB, the notifications are cascading through the whole object and the subscriber is notified a lot of times. That way we can have more fine tuning on what to do with new data, while also subscribing to a whole object-like structure.

#### Permissions

```ts
    export type PlcPermissions = "read_diagnostics" | "read_value" | "write_value" | "acknowledge_alarms" | "open_user_pages" |
    "read_file" | "write_file" | "change_operating_mode" | "flash_leds" | "backup_plc" | "restore_plc" | "manage_user_pages" |
    "update_firmware" | "change_time_settings" | "download_service_data" | "change_webserver_default_page" | "read_watch_table_value" |
    "write_watch_table_value" | "read_syslog";
    can(permission: PlcPermissions): boolean;
    getPermissionsUpdates(): Observable<PlcPermissions[]>;

```

You can either use a function to get information about the permissions of the current user, or subscribe to the updates, when a new user is logging in. With that you can control the state of the hmi, and only display some stuff if the user has enough permission.

## Configuration

When creating the Client, you need to provide a Config-Object. In which you can configure some details.

### Polling Config

Polling isnt really a good way of getting data, but in this case its the only direct way of getting pseudo-live-data from the S7-PLC via a Webapp. In some cases, you might want to change the polling-parameters, because they might be a bit "agressive". Im using Exponential Moving Average to fit the polling to the network and system, but maybe there are still moments where its polling to fast.

```ts
polling?: {
    clamp?: boolean;
    minDelay?: number;
    slowMinDelay?: number;
    emaAlpha?: number; // Default 0.1
}
```

If `clamp` is true, the polling-Cycle waits for at least `minDelay`ms before polling again. When the client isnt currently subscribing to anything there is no need to poll in a very fast way, only every Minute or so to ping the server, so the login-token stays active. With the parameter `slowMinDelay` this delay can be set. This value shouldnt really be any faster than a minute, since its not needed.

The parameter `emaAlpha` is a meta-parameter for the Exponential Moving Average function. `emaAlpha` is a value between 0 and 1 which represents a weight on recent data. The higher the weight, the faster the average is moving, the lower the weight, the smoother the pollingCycle-Time changes.

### Initial Cache Keys

A lot of time, you may have a DB with Configuration-Data, which never changes and you only need to fetch once and then use the cache afterwards, so you dont need to communicate to the server anymore. In this case, you can add these keys (even the entire DB as a key) in the `initialCacheKeys`-Array in the config. It then instantly loads in this cache on the first request, so if you need the data to hydrate the webapp, its there as fast as possible.

### Prefix Substitution Map

When working with data deep inside a DB and you need to call `s7.get('"myDB".myStruct.myOtherStruct.myInnerStruct.myValue')` but any value you use here is inside `myInnerStruct`, you can save yourself some space, by using a Prefix-Substitution, which basically is just an alias.

```ts
prefixSubstitutionMap:{
    'myStruct': '"myDB".myStruct.myOtherStruct.myInnerStruct'
}
```

This however needs you to change the PLC-Structure Data manually. The automatic way, will get a feature where it automatically changes it accordingly in the future.

The main reason why this is included isnt really to save some space thought, but so you can seperate PLC-Keys from HMI-Keys. That way, you could in theory use different PLC-Projects for the same HMI, and only change the Configuration and everything else works. This was an requirement in the project where this library was implemented and we kept it in here.


### LocalStoragePrefix

The user and token is saved in the browsers local storage, you can change the prefix of the local-Storage key if it will collide with some other key. The default prefix is: `s7_`.
