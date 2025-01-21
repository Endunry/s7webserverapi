export class GlobalGeneratorConfig {
     generatorType = 0;
     eqcConfig: eQCConfig = new eQCConfig();
     outputLabel: string[] = ["Ausgang 1","Ausgang 2"];
     pyrometerConfigs: PyrometerConfig[] = new Array<PyrometerConfig>(new PyrometerConfig(), new PyrometerConfig(), new PyrometerConfig(), new PyrometerConfig(), new PyrometerConfig(), new PyrometerConfig(), new PyrometerConfig(), new PyrometerConfig());
     pyrometerCount = 0;
     lcResonatorConfigs: SchwingkreisConfig[] = new Array<SchwingkreisConfig>(new SchwingkreisConfig(), new SchwingkreisConfig(), new SchwingkreisConfig(), new SchwingkreisConfig());
     lcResonatorCount = 0;
     temperatureUnit = 0;
     coolingSystem = false;
     delayedStart = false;
     settings: GeneratorSettings = new GeneratorSettings();
     typeLabel: TypeLabel = new TypeLabel();
     memorySize: MemoryInfo = new MemoryInfo();
     version: Version = new Version();
}



export class eQCConfig {
     ePMEnergy = false;
     ePMFlux = false;
     ePMEarthFault = false;
}



export class PyrometerConfig {
     resistanceFactor = 1.001;
     lcResonatorIndex = -1;
}



export class SchwingkreisConfig {
     type = 0;
     pyrometerIndices: number[] = [-1,-1];
     nOutputs = 0;
     switchType = 0;
     P_Rated = 0;
     P_Max = 0;
     SP_avb = false;
     frequencySwitch_avb = false;
     ISEP = false;
     energyController_avb = false;
     errorDelay = 0;
     startDelay = 0;
     symmetryControl_avb = false;
     flowmeter: FlowmeterConfig[] = new Array<FlowmeterConfig>(new FlowmeterConfig(), new FlowmeterConfig(), new FlowmeterConfig(), new FlowmeterConfig(), new FlowmeterConfig(), new FlowmeterConfig(), new FlowmeterConfig(), new FlowmeterConfig(), new FlowmeterConfig());
     i_correctionFactor = 0;
     u_correctionFactor = 0;
}



export class FlowmeterConfig {
     itemName = "";
     customerLabel = "";
     fullScaleLiter = 0;
     limit = 0;
     prewarning = 0;
     durchfluss: ValueRange = new ValueRange();
}



export class ValueRange {
     min = 0;
     max = 0;
}



export class GeneratorSettings {
     profibusControl = false;
     coolingSystem = false;
     circuitBreakerOn = false;
}



export class TypeLabel {
     serialNumber = "";
     name = "";
     kVA = "";
     spg = "";
     mainsFrequency = "";
     fab = "";
     si = "";
     typ = "";
     yearOfManufacture = "";
}



export class MemoryInfo {
     total = 0;
     free = 0;
}



export class Version {
     plcProjectName = false;
     runtimeVersion = false;
}



export class PyrometerState {
     temperature = 0;
}



export class SchwingkreisZustand {
     power = 0;
     power_controller = 0;
     frequency = 0;
     current = 0;
     voltage = 0;
     heatingTime = "1970-01-01T00:00:00.000Z";
     heatingCycles = 0;
     flowMeterValues: number[] = [0,0,0,0,0,0,0,0,0];
     targetTemp = 0;
}



export class randomVarGraphState {
     buffer1: number[] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
     buffer2: number[] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
     bufferIndex = 0;
     bufferMaxFillIndex = 0;
     startTime = "1970-01-01T00:00:00.000Z";
     timeStep = "1970-01-01T00:00:00.000Z";
     readBuffer = false;
}



