# Webserver-API Client for Simatic S7 1200/1500 PLCs

This is an unofficial Library to use with the Simatic S7 1200/1500 Series' JSON-RPC-APIs. It provides the basic functionality like login/read/write and additionally uses polling to implement a "subscribing" functionality.

## Overview

This package utilizes rxjs-Subjects to handle asyncronously Data. So it may be beneficial to be familiar with [rxjs](https://rxjs.dev/guide/subject) beforehand.

This lib exists as a necessity from a project. Since the Webserver on the S71200/1500 is the only way to communicate with the PLC directly via. the Browser (no Websocket-Server) and the webserver lacks any form of bidirectional communication that would grant any "Live-Data" functionality a polling cycle and internal cache is used to watch for changes on the data.

One can now subscribe to specific keys or parent keys and be notified when the underlying data changes. Its an easy way to display sensor-data or something similar in a Web-Based HMI where you store the HMI on the Webserver and use the JSON-API aswell.

### Supported Functionality

#### Get the value of a specific PLC-Key

One can get a value once via the get-Method by specifing a PLC-Key.
```ts
s7.get('"MYDB".mykey').subscribe(data => {
    console.log(data); // > '3.141'
})
```

It is also possible to specify a parent key. E.g.:
```ts
s7.get('"MYDB"').subscribe(data => {
    console.log(data); // > {mykey: 3.141, otherkey: '', ...}
})
```

This is not a core function of the webserver, but an extentsion that is implemented in this package. For this to work, the library needs information about this structure, because internally it just calls all the children keys seperatley and concatenates them into an JSON-Object.

#### Write a value to a specific PLC-Key

One can write a value once via the write-Method with a PLC-Key and a value.
```ts
s7.write('"MYDB".mykey', 3.0).subscribe(status=>{
    if(status){
        console.log("Success");
    }else{
        console.log("Error writing");
    }
})
```

The same way, we can call the get-function with a parent key, we can call the write function. It then writes the value in the value field to the specificed key

#### Subscribe to a value of a specific PLC-Key

Instead of reading a value once, we can read a value continuously and listen for changes.
```ts
s7.subscribe('"MYDB".mykey').subscribe(result=>{
    console.log(result.value); // 3.141; 3.0; ...
})
```

Likewise, we can also just subscribe to a parent key.
```ts
s7.subscribe('"MYDB"').subscribe(({value, changedKey}) => {
    console.log(value); // {mykey: 3.141, ...}
})
```
The parent subscriber is notified everytime any of the children keys are changing (this also cascades in deeper structures). So the information which key has changed is always provided.

**It is important to correctly unsubscribe the rxjs-Subjects, otherwise the polling process unnecessarily asks and receives data form the webserver on every poll**

#### LogIn with a user and password

```ts
s7.login('MYUSER', 'mypassword').subscribe(result=>{
    if(result === true){
        console.log("Successfully logged in");
    }else{
        console.log(`Error while logging In, API-Error-Code: ${result}`);
    }
})
```

#### Gather information about the perimssions of the user

One can utilize the permissions-API to check permissions or listen for permission changes.

```ts
type PlcPermissions = "read_diagnostics" | "read_value" | "write_value" | "acknowledge_alarms" | "open_user_pages" | "read_file" | "write_file" | "change_operating_mode" | "flash_leds" | "backup_plc" | "restore_plc" | "manage_user_pages" | "update_firmware" | "change_time_settings" | "download_service_data" | "change_webserver_default_page" | "read_watch_table_value" | "write_watch_table_value" | "read_syslog";

if(s7.can("read_value")){
    s7.read('...').subscribe(...);
}

s7.getPermissionsUpdates().subscribe((updatedPermissions: PlcPermissions[]) => {
    if(!updatedPermissions.includes("write_value")){
        this.disabled = true; // e.g. grey out control elements if we cant write
    }
})
```

### Provide data about the PLC-DB-Structure

It is necessary to provide the Structure of the several DBs that are used for the Web-HMI. This is not just for providing a way of gathering array-/struct/UDT-Data directly, but also for ease of use with typescript.

With the structure, a key-Type is automatically inferred so when using an IDE its possible to see all the valid keys one can use and also an error is thrown on build if an invalid key is used.

The structure can be automatically Generated from the Version Control Interface which exports XML-Files from the DB structure. For larger projects this recommended (more on that next section). For small projects that maybe only needs a 10-20 different keys, one can manually create the Structure by hand. This consists of a JSON-Object that represents the PLC-Data and also a explicit Typescript-Type of that JSON-Object.

Example:

When we have the 2 DBs:
```SL
DATA_BLOCK "myDB"
      operand1 : Int;
      operand2 : Int;
      sum : Int;

DATA_BLOCK "fooDB"
      someArray : Array[0..3] of Real;
      someUDT: MyUdt;
```

We First create any UDTs as classes, so we could reuse it somewhere in our code, then we create the JSON-Object and lastly the type. For the json object it makes sense to use the same default value as in the PLC project in TIA:

```ts
class MyUdt{
    myField: number = 0;
    ...
}

const structure = {
    '"myDB"': {
        operand1: 0,
        operand2: 0,
        sum: 0
    },
    '"fooDB"': {
        someArray: new Array<number>(),
        someUDT: new MyUdt()
    }
}

type structureType = {
    '"myDB"': {
        operand1: number,
        operand2: number,
        sum: number
    },
    '"fooDB"': {
        someArray: [number, number, number, number],
        someUDT: {
            myField: number,
            ...
        }
    }
}

const s7 = new S7WebserverClient<structureType>(baseUrl, {DB: structure});
s7.get('"fooDB".someArray.0').subscribe(...);
s7.get('"fooDB".someArray').subscribe(...);
s7.get('someotherKey').subscribe(...); // <-- Throws an build-error

```







