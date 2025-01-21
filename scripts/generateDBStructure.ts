import { command, option, run, string, multioption, array, flag, boolean, } from "cmd-ts";

import * as fs from 'fs-extra';
import * as path from 'path';
import * as xml2js from 'xml2js';
import * as ts from 'typescript';
import * as vm from 'vm';


const app = command({
    name: 's7webservergen',
    args: {
        dbRoot: option({
            type: string,
            long: 'db-root-folder',
            short: 'd',
            description: 'Path of the folder in which all the PLC-DBs of the project are exported as .xml-Files. Files can be structured inside sub-folders after this path. But no other types of xml-files should be present inside this root-folder'
        }),
        udtRoot: option({
            type: string,
            long: 'udt-root-folder',
            short: 'u',
            description: 'Path of the folder in which all the PLC-UDTs (User Defined Data-Types) are exported as .xml-Files. Can be ordered in sub-folders after this path. No other types of xml-Files should be present inside this root-folder',
        }),
        hmiDBs: option({
            type: string,
            long: 'hmiDBs',
            short: 'h',
            description: 'Collection of all the DBs that should be used in the HMI (the ones that should be exported) [Without the \"\" wrapping the name], seperated by comma. Example: -h="MyDB,MyOtherDB,HMIDB,WEBDB"'
        }),
        outputPath: option({
            type: string,
            long: 'output-path',
            short: 'o',
            description: 'Outputpath where the generated files will be stored',
            defaultValue: () => './'
        }),
        force: flag({
            type: boolean,
            long: 'force',
            short: 'f',
            defaultValue: () => false
        })
    },
    handler: ({ dbRoot, udtRoot, hmiDBs, outputPath, force }) => {
        const gen = new ConfigGenerator(hmiDBs.split(','), dbRoot, udtRoot, outputPath, force);

    }

})

function main() {
    run(app, process.argv.slice(2));
}

if (require.main === module) {
    main();
}



const plcNumberDataTypes = ['DInt', 'Int', 'LInt', 'LReal', 'Real', 'SInt', 'UDInt', 'UInt', 'ULInt', 'USInt'] as const;

const plcBoolDataTypes = ['Bool'] as const;

const plcBinaryDataTypes = ['Byte', 'Word', 'DWord', 'LWord'] as const;

const plcTextDataTypes = ['Char', 'String'] as const;

const plcDateDataTypes = ['Date', 'Date_And_Time', 'LTime', 'Time', 'Time_Of_Day'] as const;

export type PLCBoolDataTypes = typeof plcBoolDataTypes[number];
export type PLCNumberDataTypes = typeof plcNumberDataTypes[number];
export type PLCBinaryDataTypes = typeof plcBinaryDataTypes[number];
export type PLCTextDataTypes = typeof plcTextDataTypes[number];
export type PLCDateDataTypes = typeof plcDateDataTypes[number];

interface ConversionConfig {
    plcDataType: PLCDataTypes | string; // Either its a PLCDataType or a user-defined datatype
    contextMember: any
    array?: boolean
    data?: any,
    ref: any
}

export type PLCDataTypes = PLCBoolDataTypes | 'Struct' | PLCNumberDataTypes | PLCBinaryDataTypes | PLCTextDataTypes | PLCDateDataTypes;


type MemberData = Uint8Array | Uint16Array | Uint32Array | BigInt64Array | boolean | number | string | Date | Array<MemberData> | Member;

interface Member {
    plcType: PLCDataTypes | 'UDT';
    udt?: string;
    isArray: boolean;
    data: MemberData;
    readonly: boolean;
}

class ConfigGenerator {

    // First goes through the xml-Files and parses and stores them in memory here for faster access.
    private dbCacheMap: Map<string, any> = new Map();
    private udtCacheMap: Map<string, any> = new Map();

    private structCacheMap: Map<string, any> = new Map();

    private parser = new xml2js.Parser();

    private importantDBs: { [key: string]: { [name: string]: Member } } = {};
    private importantUDTs: { [key: string]: { [name: string]: Member } } = {};

    private udtOutFileName: string = 'udts'
    private dbOutFileName: string = 'dbs'
    private plcStructureOutFileName: string = 'plcStructure'



    constructor(private dbsToImport: string[], private dbRoot: string, private udtRoot: string, private outputPath: string, private force: boolean) {
        this.readInSubfolderXmlFiles(path.relative(process.cwd(), dbRoot), this.dbCacheMap).then(() => {
            return this.readInSubfolderXmlFiles(path.relative(process.cwd(), udtRoot), this.udtCacheMap);
        }).then(() => {
            this.parseInConfig();
            this.generateCode();
        })
    }

    private generateImportUdtsCode() {
        return `import {${Object.keys(this.importantUDTs).join(', ')
            }} from './${this.udtOutFileName}'\n\n`
    }

    private generateImportDbsCode() {
        return `import {${Object.keys(this.importantDBs).join(', ')
            }} from './${this.dbOutFileName}'\n\n`
    }


    /**
     * Now that we have parsed every key, we want to generate the code.
     * For this we first have a file with all the UDT/Struct-Definitions aswell as the DB-Definitions:
     *
     */
    private generateCode() {
        const udtFile = this.generateUDTClassesFile(true);
        this.saveWithBackup(path.resolve(process.cwd(), this.outputPath, this.udtOutFileName) + '.ts', udtFile)
        const dbFile = this.generateDBClassesFile(true);
        this.saveWithBackup(path.resolve(process.cwd(), this.outputPath, this.dbOutFileName) + '.ts', dbFile);
        const structureFile1 = this.generatePLCStructureObject(true);
        const structureFile2 = this.generatePLCStructureTypeCode();
        this.saveWithBackup(path.resolve(process.cwd(), this.outputPath, this.plcStructureOutFileName) + '.ts', structureFile1 + '\n' + structureFile2);
    }

    private saveWithBackup(path: string, content: string) {
        if (fs.existsSync(path)) {

            let i = 0;
            while (fs.existsSync(path + '.bak' + i.toString())) {
                i++;
            }
            fs.copyFileSync(path, path + '.bak' + i.toString());
        }
        fs.writeFileSync(path, content);
    }

    private generateUDTClassesFile(shouldExport: boolean = false) {
        let fileString = '';



        for (const udtKey in this.importantUDTs) {

            const udt = this.importantUDTs[udtKey];

            let classStringDefinition = `${shouldExport ? 'export ' : ''}class ${udtKey} {\n`;
            classStringDefinition += this.generateMemberCode(udt);
            classStringDefinition += '}\n';
            fileString += classStringDefinition;
            fileString += '\n\n\n';
        }
        return fileString;


    }

    private generatePLCStructureObject(shouldExport: boolean = false) {
        let fileString = '';
        if (shouldExport) {
            fileString = `${this.generateImportDbsCode()}`
        }

        fileString += `${shouldExport ? 'export ' : ''}const PLC_STRUCTURE = {\n`;

        for (const dbKey in this.importantDBs) {
            fileString += `  "\\"${dbKey}\\"": new ${dbKey}(),\n`
        }
        fileString += `}\n`


        return fileString;

    }

    private generatePLCStructureTypeCode() {
        let tsFileToRun = `
        ${this.generateUDTClassesFile()}
        ${this.generateDBClassesFile()}
        ${this.generatePLCStructureObject()}
        `

        let result = JSON.stringify(runTypeScriptCode(tsFileToRun, 'PLC_STRUCTURE'));
        result = result.replace(/\{\}/g, 'number');
        return `export type PLC_STRUCTURE_TYPE = ${result};`

    }

    private generateDBClassesFile(shouldExport: boolean = false) {
        let fileString = '';
        if (shouldExport) {
            fileString = this.generateImportUdtsCode();
        }
        for (const dbKey in this.importantDBs) {

            const db = this.importantDBs[dbKey];

            let classStringDefinition = `${shouldExport ? 'export ' : ''}class ${dbKey} {\n`;
            classStringDefinition += this.generateMemberCode(db);
            classStringDefinition += '}\n';
            fileString += classStringDefinition;
            fileString += '\n\n\n';
        }

        return fileString;
    }

    private generateMemberCode(memberParent: any): string {
        let memberString = '';

        for (const memberKey in memberParent) {
            const member = memberParent[memberKey];
            const memberIsInteger = Number.isInteger(Number(memberKey));
            const readOnlyPrefix = member.readonly ? 'readonly ' : '';
            if (member.plcType === 'UDT') {
                memberString += this.constructUdtMember(member, memberKey, memberIsInteger, readOnlyPrefix);
            } else {
                memberString += this.constructLeafMember(member, memberKey, memberIsInteger, readOnlyPrefix);
            }
        }

        return memberString;
    }

    private constructLeafMember(member: any, memberKey: string, memberIsInteger: boolean, readonlyPrefix: string) {

        if (plcBinaryDataTypes.includes(member.plcType as PLCBinaryDataTypes)) {
            return `     ${readonlyPrefix}${memberIsInteger ? '"' + memberKey + '"' : memberKey}: number = ${member.data}();\n`
        }

        if (member.isArray) {
            let innerName = typeof (member.data as unknown as any)[0].data;
            innerName = innerName.charAt(0).toUpperCase() + innerName.slice(1);
            let constructorValue = "";
            if (member.isArray) {
                constructorValue = (member.data as any[]).map((data: any) => `${innerName}()`).join(', ');
            }
            let arrayStringValue = `new Array<${typeof (member.data as unknown as any)[0].data}>(${constructorValue})`;
            if (typeof (member.data as any[])[0].data == 'string' || typeof (member.data as any[])[0].data == 'number') {
                arrayStringValue = JSON.stringify((member.data as any[]).map(d => d.data));
            }
            return `     ${readonlyPrefix}${memberIsInteger ? '"' + memberKey + '"' : memberKey}: ${typeof (member.data as unknown as any)[0].data}[] = ${arrayStringValue};\n`;
        }
        return `     ${readonlyPrefix}${memberIsInteger ? '"' + memberKey + '"' : memberKey} = ${JSON.stringify(member.data)};\n`

    }

    private constructUdtMember(member: any, memberKey: string, memberIsInteger: boolean, readonlyPrefix: string) {
        let constructorValue = '';
        let valueValue = `new ${member.udt}`;
        if (member.isArray) {
            constructorValue = (member.data as any[]).map((data: any) => `new ${member.udt}()`).join(', ');
            valueValue = `new Array<${member.udt}>`;
        }
        valueValue += `(${constructorValue})`;

        return `     ${readonlyPrefix}${memberIsInteger ? '"' + memberKey + '"' : memberKey}: ${member.udt}${member.isArray ? '[]' : ''} = ${valueValue};\n`;
    }

    private parseInConfig() {
        for (const db of this.dbsToImport) {

            if (!this.dbCacheMap.has(db + '.xml')) {
                throw new Error(`The DB ${db} does not exist in the provided PLC-Project-Files. ${db}.xml not found in sub-folder structure of root: ${path.relative(process.cwd(), this.dbRoot)}`)
            }

            this.importantDBs[db] = {};
            const parsed = this.dbCacheMap.get(db + '.xml');

            const doc = parsed.Document;
            const tiaVersion = doc.Engineering[0].$.version;

            this.checkTiaVersion(tiaVersion)
            const attributes = doc['SW.Blocks.GlobalDB'][0].AttributeList[0];
            const vars = attributes.Interface[0].Sections[0].Section[0].Member;

            for (const section of vars) {
                this.readInMember(section, this.importantDBs[db]);
            }


        }
    }

    private readInMember(member: any, ref: { [name: string]: Member }) {
        let notWriteable = false;

        if (member.AttributeList && member.AttributeList[0] && member.AttributeList[0].BooleanAttribute) {
            const booleanAttributes: Array<any> = member.AttributeList[0].BooleanAttribute;
            const notReachable = booleanAttributes.some((attr: any) => attr.$.Name === 'ExternalAccessible' && attr._ === 'false');
            const notVisible = booleanAttributes.some((attr: any) => attr.$.Name === 'ExternalVisible' && attr._ === 'false');
            notWriteable = booleanAttributes.some((attr: any) => attr.$.Name === 'ExternalWritable' && attr._ === 'false');

            // If we wont be able to access this var from the Web we just exclude this key
            if (notReachable || notVisible) {
                return;
            }
        }

        ref[member.$.Name] = {} as Member;
        ref[member.$.Name].readonly = notWriteable;

        const isArray = member.$.Datatype.startsWith('Array');
        if (isArray) {
            this.readInArrayType(member, ref[member.$.Name]);
            return;
        }

        this.plcToJsDataType({
            plcDataType: member.$.Datatype, contextMember: member, data: member.StartValue ? member.StartValue[0] : undefined, ref: ref[member.$.Name]
        });

    }

    private readInArrayType(section: any, ref: Member) {
        const dataType = section.$.Datatype;

        const arrayDataType = dataType.split(' of ')[1];
        const arrayLength = Number(dataType.match(/\d+/g)[1]) + 1;
        const isUDT = arrayDataType.startsWith('"') && arrayDataType.endsWith('"');
        if (isUDT) {
            ref.plcType = 'UDT';
            ref.udt = arrayDataType.slice(1, -1);
        } else {
            ref.plcType = arrayDataType;
        }

        let arr = new Array(arrayLength).fill(undefined);
        if (section.Subelement) {
            section.Subelement.forEach((subelement: any) => {
                const ind = Number(subelement.$.Path);
                const value = subelement.StartValue ? subelement.StartValue[0] : '';
                arr[ind] = value;
            });
        }
        ref.data = [];
        ref.isArray = true;
        arr = this.plcToJsDataType({
            plcDataType: arrayDataType, contextMember: section, array: true, data: arr, ref: ref.data
        });
    }

    private cleanDataType(dataType: PLCDataTypes): PLCDataTypes {

        // Needed if the string has a fixed length, we cant represent that in js
        if (dataType.startsWith('String[')) {
            return 'String';
        }
        return dataType;

    }

    private readInStructDataType(contextMember: any, ref: any) {

        const structName = contextMember['$'].Name;
        let suffix: any = "";
        while (this.structCacheMap.has(structName + suffix)) {
            suffix = +(suffix)++;
        }

        const finalStructName = structName + suffix;
        ref.udt = finalStructName;
        ref.plcType = 'UDT'; // Handle a struct just like an UDT

        this.importantUDTs[finalStructName] = {};

        for (const member of contextMember.Member) {
            this.readInMember(member, this.importantUDTs[finalStructName]);
        }
    }

    private plcToJsDataType({ plcDataType, contextMember, array, data, ref }: ConversionConfig): any {
        if (array) {
            for (const element of data) {
                ref.push({});
                const newRef = ref[ref.length - 1];
                this.plcToJsDataType({ plcDataType, data: element, contextMember, array: false, ref: newRef });
            }
            return;
        }

        plcDataType = this.cleanDataType(plcDataType as PLCDataTypes);
        (ref as Member).plcType = plcDataType as PLCDataTypes;
        (ref as Member).isArray = false;
        (ref as Member).data = {} as Member;

        if (plcBoolDataTypes.includes(plcDataType as PLCBoolDataTypes)) {
            ref.data = this.plcBooleanToJsDataType(plcDataType as PLCBoolDataTypes, data, ref);
        } else if (plcNumberDataTypes.includes(plcDataType as PLCNumberDataTypes)) {
            ref.data = this.plcNumberToJsDataType(plcDataType as PLCNumberDataTypes, data, ref);
        } else if (plcBinaryDataTypes.includes(plcDataType as PLCBinaryDataTypes)) {
            ref.data = this.plcBinaryToJsDataType(plcDataType as PLCBinaryDataTypes, data, ref);
        } else if (plcTextDataTypes.includes(plcDataType as PLCTextDataTypes)) {
            ref.data = this.plcTextToJsDataType(plcDataType as PLCTextDataTypes, data, ref);
        } else if (plcDateDataTypes.includes(plcDataType as PLCDateDataTypes)) {
            ref.data = this.plcDateToJsDataType(plcDataType as PLCDateDataTypes, data, ref);
        } else if (plcDataType === 'Struct') {
            // A struct is created as a nested object but without any new class, is a struct used in multiple places this creates
            return this.readInStructDataType(contextMember, ref);

        } else {
            // UDTs are enclosed with "<>" so if it starts and ends with this its an UDT and we read it in
            if (plcDataType.startsWith('"') && plcDataType.endsWith('"')) {
                return this.readInPlcUserDataType(plcDataType.slice(1, -1), ref);
            }
            if (!this.force) {
                throw new Error(`The Datatype ${plcDataType} is not supported yet! Create an issue/PR on GitHub. In the meantime, you can use --force and add the data-type yourself later on.`)
            } else {
                return this.readInArbitraryDataType(plcDataType, data, ref);
            }
        }

    }

    private readInArbitraryDataType(dataType: string, data: any, ref: any) {
        ref.data = undefined;
        ref.plcType = dataType;
        return;
    }

    private checkTiaVersion(tiaVersion: string) {
        if (!this.force && !(["V19", "V20"].includes(tiaVersion))) {
            throw Error('This TIA-Version export is not yet tested and supported. You can try if it will work by using --force')
        }
    }

    private readInPlcUserDataType(dataType: string, ref: any) {
        let parsedResult;

        if (this.udtCacheMap.has(dataType + '.xml')) {
            parsedResult = JSON.parse(JSON.stringify(this.udtCacheMap.get(dataType + '.xml')));
        } else {
            throw new Error(`It appears, that an imported DB is using a User Defined Datatype (UDT): ${dataType}, but the file ${dataType}.xml is not found inside the root folder of the UDTs: ${path.relative(process.cwd(), this.udtRoot)}`);
        }

        ref.plcType = 'UDT';
        ref.udt = dataType;

        if (this.importantUDTs[dataType]) {
            return;
        }

        const doc = parsedResult.Document;
        const tiaVersion = doc.Engineering[0].$.version;
        this.checkTiaVersion(tiaVersion)

        const attributes = doc['SW.Types.PlcStruct'][0].AttributeList[0];
        const vars = attributes.Interface[0].Sections[0].Section[0].Member;

        this.importantUDTs[dataType] = {};

        for (const section of vars) {
            this.readInMember(section, this.importantUDTs[dataType]);
        }
    }

    private plcBooleanToJsDataType(plcDataType: PLCBoolDataTypes, data: any, ref: any) {
        if (data) {
            return data === 'true';
        }
        return false;
    }


    private plcDateToJsDataType(plcDataType: PLCDateDataTypes, data: any, ref: any): Date {

        data = data ?? 'T#0ms';
        const withoutPrefix = data.split('#')[1];

        // The date/time is in the format #10h_20m_30s_... and this function parses it to a js-type
        let days, hours, minutes, seconds, milliseconds;
        switch (plcDataType) {
            case 'Date_And_Time':
                // Replace the 3rd '-' with 'T' to make it a valid date string
                0 as unknown as Date
            case 'Date':
                return new Date(withoutPrefix);
            case 'Time':
            case 'LTime':
                const regex = /(\d+d)?(\d+h)?(\d+m(?!s))?(\d+s)?(\d+ms)?(\d+us)?(\d+ns)?/;
                const matches = withoutPrefix.match(regex);
                if (!matches) return new Date(0);
                [, days, hours, minutes, seconds, milliseconds, , ,] = matches;
                const date = new Date(0);
                if (days) {
                    date.setUTCDate(date.getUTCDate() + days.replace('d', ''));
                }
                if (hours) {
                    date.setUTCHours(date.getUTCHours() + hours.replace('h', ''));
                }
                if (minutes) {
                    date.setUTCMinutes(date.getUTCMinutes() + minutes.replace('m', ''));
                }
                if (seconds) {
                    date.setUTCSeconds(date.getUTCSeconds() + seconds.replace('s', ''));
                }
                if (milliseconds) {
                    date.setUTCMilliseconds(date.getUTCMilliseconds() + milliseconds.replace('ms', ''));
                }


                return date;

        }
        return new Date(0);
    }

    private plcTextToJsDataType(plcDataType: PLCTextDataTypes, data: string, ref: any): string {
        if (data) {
            // return data without quotes
            return data.slice(1, -1)
        }
        return '';
    }

    private plcNumberToJsDataType(plcDataType: PLCNumberDataTypes, data: any, ref: any): number {
        if (data) {
            return Number(data);
        }
        return 0;
    }
    /**
     *
     * @param plcDataType The DataType of the plc
     * @param data the data that should be transformed if not set a empty binary-array will be returned
     * @returns The fitting data-type for the PLC, based on the size.
     */
    private plcBinaryToJsDataType(plcDataType: PLCBinaryDataTypes, data: string, ref: any) {
        // Define the mapping from PLC data types to JavaScript TypedArray constructors
        const dataTypeMapping = {
            'Byte': Uint8Array,
            'Word': Uint16Array,
            'DWord': Uint32Array,
            'LWord': BigInt64Array
        };

        // Determine the appropriate JavaScript TypedArray constructor based on the PLC data type
        const jsDataType = dataTypeMapping[plcDataType] || Uint8Array;

        if (!data) {
            return 0;
        }

        let dataString = data;

        let parsedData;
        if (dataString.startsWith('16#')) {
            parsedData = parseInt(dataString.slice(3), 16);
        } else if (dataString.startsWith('8#')) {
            parsedData = parseInt(dataString.slice(2), 8);
        } else {
            parsedData = parseInt(dataString, 2);
        }

        if (jsDataType === BigInt64Array) {
            parsedData = BigInt(parsedData);
        }

        return parsedData;
    }


    private async readInSubfolderXmlFiles(file_path: string, map: Map<string, any>) {
        const files = fs.readdirSync(file_path);

        for (const file of files) {
            const fullPath = path.join(file_path, file);
            if (fs.statSync(fullPath).isDirectory()) {
                await this.readInSubfolderXmlFiles(fullPath, map);
            } else {
                if (file.endsWith('.xml')) {
                    const xml = fs.readFileSync(fullPath, 'utf-8');
                    const parsed = await this.parser.parseStringPromise(xml);
                    map.set(file, parsed);
                }
            }
        }
    }


}

function runTypeScriptCode(tsCode: string, varName: string): any {
    const jsCode = compileTypeScript(tsCode);
    return runJavaScript(jsCode, varName);
}

function compileTypeScript(tsCode: string): string {
    const result = ts.transpileModule(tsCode, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
    return result.outputText;
}

function runJavaScript(jsCode: string, varName: string): any {
    const context: { [key: string]: any } = {}; // Initialize the context
    vm.createContext(context); // Create a new context
    const script = new vm.Script(jsCode); // Create a script from the JavaScript code
    script.runInContext(context); // Run the script in the context
    return context[varName]; // Return the value of the specified variable
}
